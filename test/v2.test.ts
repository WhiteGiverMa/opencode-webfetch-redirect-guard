import { describe, expect, test } from "bun:test"
import type * as V2 from "@opencode/plugin/promise/plugin"
import { createV2Plugin } from "../src/v2.js"
import { RedirectGuardError } from "../src/redirects.js"
import { createFetchSpy, ok, redirect, startLocalServer, v2Context } from "./support.js"

const ALLOW_ALL = [{ action: "*", resource: "*", effect: "allow" }]

function webfetchEvent(url: string, tool = "webfetch"): Record<string, unknown> {
  return {
    tool,
    sessionID: "ses_1",
    agent: "build",
    messageID: "msg_1",
    id: "call_1",
    input: { url, format: "markdown" },
  }
}

describe("createV2Plugin", () => {
  test("#given disabled options #when set up #then no hook is registered", async () => {
    const handle = v2Context({ options: { enabled: false } })
    const spy = createFetchSpy(() => ok())
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    expect(handle.hooks).toEqual([])
    expect(spy.calls).toEqual([])
  })

  test("#given a host without tool hooks #when set up #then it degrades without throwing", async () => {
    const context = { options: undefined } as unknown as V2.Context
    await createV2Plugin().setup(context)
  })

  test("#given an allowed redirect #when the hook fires #then the mutable input is rewritten", async () => {
    const handle = v2Context({
      options: undefined,
      agent: { permissions: ALLOW_ALL },
      session: { permissions: [] },
    })
    const spy = createFetchSpy((url) => (url === "http://start.test/a" ? redirect(302, "http://final.test/b") : ok()))
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    expect(handle.hooks.length).toBe(1)
    expect(handle.hooks[0]?.name).toBe("execute.before")
    const event = webfetchEvent("http://start.test/a")
    await handle.hooks[0]?.callback(event)
    expect((event.input as Record<string, unknown>).url).toBe("http://final.test/b")
  })

  test("#given an agent deny overridden by a session allow #when the hook fires #then no target request is made", async () => {
    const handle = v2Context({
      agent: { permissions: [{ action: "webfetch", resource: "*", effect: "deny" }] },
      session: { permissions: [{ action: "webfetch", resource: "http://start.test/*", effect: "allow" }] },
    })
    const spy = createFetchSpy(() => redirect(302, "http://final.test/b"))
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    const event = webfetchEvent("http://start.test/a")
    await handle.hooks[0]?.callback(event)
    expect(spy.calls).toEqual([])
    expect((event.input as Record<string, unknown>).url).toBe("http://start.test/a")
  })

  test("#given a real local redirect server #when the hook fires #then the mutable input points at the final url", async () => {
    const server = startLocalServer((request) => {
      const path = new URL(request.url).pathname
      if (path === "/start") return redirect(307, "/final")
      return ok()
    })
    try {
      const handle = v2Context({ agent: { permissions: ALLOW_ALL }, session: { permissions: [] } })
      await createV2Plugin().setup(handle.context)
      const event = webfetchEvent(`${server.base}/start`)
      await handle.hooks[0]?.callback(event)
      expect((event.input as Record<string, unknown>).url).toBe(`${server.base}/final`)
    } finally {
      await server.stop()
    }
  })

  test("#given an ask effect #when the hook fires #then no target request is made", async () => {
    const handle = v2Context({
      agent: { permissions: [{ action: "webfetch", resource: "*", effect: "ask" }] },
      session: { permissions: [] },
    })
    const spy = createFetchSpy(() => redirect(302, "http://final.test/b"))
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    const event = webfetchEvent("http://start.test/a")
    await handle.hooks[0]?.callback(event)
    expect((event.input as Record<string, unknown>).url).toBe("http://start.test/a")
    expect(spy.calls).toEqual([])
  })

  test("#given a deny effect #when the hook fires #then no target request is made", async () => {
    const handle = v2Context({
      agent: { permissions: [{ action: "webfetch", resource: "*", effect: "deny" }] },
      session: { permissions: [] },
    })
    const spy = createFetchSpy(() => redirect(302, "http://final.test/b"))
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    const event = webfetchEvent("http://start.test/a")
    await handle.hooks[0]?.callback(event)
    expect(spy.calls).toEqual([])
  })

  test("#given a session effect overriding the agent #when denied #then no target request is made", async () => {
    const handle = v2Context({
      agent: { permissions: ALLOW_ALL },
      session: { permissions: [{ action: "webfetch", resource: "http://start.test/*", effect: "deny" }] },
    })
    const spy = createFetchSpy(() => redirect(302, "http://final.test/b"))
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    await handle.hooks[0]?.callback(webfetchEvent("http://start.test/a"))
    expect(spy.calls).toEqual([])
  })

  test("#given an allow for the original but not the final #when the hook fires #then nothing is rewritten", async () => {
    const handle = v2Context({
      agent: { permissions: [{ action: "webfetch", resource: "http://start.test/*", effect: "allow" }] },
      session: { permissions: [] },
    })
    const spy = createFetchSpy((url) =>
      url === "http://start.test/a" ? redirect(302, "http://elsewhere.test/b") : ok(),
    )
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    const event = webfetchEvent("http://start.test/a")
    await handle.hooks[0]?.callback(event)
    expect((event.input as Record<string, unknown>).url).toBe("http://start.test/a")
  })

  test("#given an allowed loop #when the hook fires #then a deterministic error is thrown", async () => {
    const handle = v2Context({ agent: { permissions: ALLOW_ALL }, session: { permissions: [] } })
    const spy = createFetchSpy((url) =>
      url === "http://start.test/a" ? redirect(302, "http://start.test/b") : redirect(302, "http://start.test/a"),
    )
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    let caught: unknown
    try {
      await handle.hooks[0]?.callback(webfetchEvent("http://start.test/a"))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RedirectGuardError)
    expect((caught as RedirectGuardError).code).toBe("redirect_loop")
  })

  test("#given a permission lookup failure #when the hook fires #then the native call is left untouched", async () => {
    const handle = v2Context({ agentError: new Error("no agent domain"), session: { permissions: [] } })
    const spy = createFetchSpy(() => ok())
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    const event = webfetchEvent("http://start.test/a")
    await handle.hooks[0]?.callback(event)
    expect((event.input as Record<string, unknown>).url).toBe("http://start.test/a")
    expect(spy.calls).toEqual([])
  })

  test("#given another tool #when the hook fires #then nothing happens", async () => {
    const handle = v2Context({ agent: { permissions: ALLOW_ALL }, session: { permissions: [] } })
    const spy = createFetchSpy(() => ok())
    await createV2Plugin({ fetchImpl: spy.impl }).setup(handle.context)
    await handle.hooks[0]?.callback(webfetchEvent("http://start.test/a", "read"))
    expect(spy.calls).toEqual([])
  })
})
