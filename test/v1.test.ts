import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { createV1Hooks } from "../src/v1.js"
import { RedirectGuardError } from "../src/redirects.js"
import { createFetchSpy, ok, redirect, startLocalServer, v1Input } from "./support.js"

const ALLOW_ALL = [{ permission: "*", pattern: "*", action: "allow" }]

async function invoke(hooks: Hooks, args: Record<string, unknown>, tool = "webfetch"): Promise<void> {
  const before = hooks["tool.execute.before"]
  if (!before) return
  await before({ tool, sessionID: "ses_1", callID: "call_1" }, { args })
}

describe("createV1Hooks", () => {
  test("#given disabled options #when created #then no hook is registered and no work happens", async () => {
    const input = v1Input({ agents: [{ name: "build", permission: ALLOW_ALL }] })
    const spy = createFetchSpy(() => ok())
    const hooks = await createV1Hooks(input.pluginInput, { enabled: false }, { fetchImpl: spy.impl })
    expect(Object.keys(hooks)).toEqual([])
    expect(input.counts.agents).toBe(0)
    expect(input.counts.session).toBe(0)
    expect(spy.calls).toEqual([])
  })

  test("#given another tool #when invoked #then nothing is touched", async () => {
    const input = v1Input({ agents: [{ name: "build", permission: ALLOW_ALL }] })
    const spy = createFetchSpy(() => ok())
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    const args: Record<string, unknown> = { url: "http://start.test/a" }
    await invoke(hooks, args, "read")
    expect(args.url).toBe("http://start.test/a")
    expect(input.counts.session).toBe(0)
    expect(spy.calls).toEqual([])
  })

  test("#given a real local redirect server #when invoked #then the argument points at the final url", async () => {
    const server = startLocalServer((request) => {
      const path = new URL(request.url).pathname
      if (path === "/start") return redirect(302, "/final")
      return ok()
    })
    try {
      const input = v1Input({ agents: [{ name: "build", permission: ALLOW_ALL }], session: { agent: "build" } })
      const hooks = await createV1Hooks(input.pluginInput, undefined)
      const args: Record<string, unknown> = { url: `${server.base}/start` }
      await invoke(hooks, args)
      expect(args.url).toBe(`${server.base}/final`)
    } finally {
      await server.stop()
    }
  })

  test("#given an allowed redirect #when invoked #then the native argument is rewritten", async () => {
    const input = v1Input({
      agents: [{ name: "build", permission: ALLOW_ALL }],
      session: { agent: "build" },
    })
    const spy = createFetchSpy((url) => (url === "http://start.test/a" ? redirect(302, "http://final.test/b") : ok()))
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    const args: Record<string, unknown> = { url: "http://start.test/a" }
    await invoke(hooks, args)
    expect(args.url).toBe("http://final.test/b")
    expect(spy.calls).toEqual(["http://start.test/a", "http://final.test/b"])
  })

  test("#given a legacy flat agent permission #when allowed #then the redirect is still resolved", async () => {
    const input = v1Input({
      agents: [{ name: "build", permission: { webfetch: "allow" } }],
      session: { agent: "build" },
    })
    const spy = createFetchSpy((url) => (url === "http://start.test/a" ? redirect(301, "http://final.test/b") : ok()))
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    const args: Record<string, unknown> = { url: "http://start.test/a" }
    await invoke(hooks, args)
    expect(args.url).toBe("http://final.test/b")
  })

  test("#given an ask decision #when invoked #then no target request is made", async () => {
    const input = v1Input({
      agents: [{ name: "build", permission: [{ permission: "webfetch", pattern: "*", action: "ask" }] }],
      session: { agent: "build" },
    })
    const spy = createFetchSpy(() => redirect(302, "http://final.test/b"))
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    const args: Record<string, unknown> = { url: "http://start.test/a" }
    await invoke(hooks, args)
    expect(args.url).toBe("http://start.test/a")
    expect(spy.calls).toEqual([])
  })

  test("#given a deny decision #when invoked #then no target request is made", async () => {
    const input = v1Input({
      agents: [{ name: "build", permission: [{ permission: "webfetch", pattern: "*", action: "deny" }] }],
      session: { agent: "build" },
    })
    const spy = createFetchSpy(() => redirect(302, "http://final.test/b"))
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    const args: Record<string, unknown> = { url: "http://start.test/a" }
    await invoke(hooks, args)
    expect(args.url).toBe("http://start.test/a")
    expect(spy.calls).toEqual([])
  })

  test("#given a session rule overriding the agent #when denied #then no target request is made", async () => {
    const input = v1Input({
      agents: [{ name: "build", permission: ALLOW_ALL }],
      session: {
        agent: "build",
        permission: [{ permission: "webfetch", pattern: "http://start.test/*", action: "deny" }],
      },
    })
    const spy = createFetchSpy(() => redirect(302, "http://final.test/b"))
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    const args: Record<string, unknown> = { url: "http://start.test/a" }
    await invoke(hooks, args)
    expect(args.url).toBe("http://start.test/a")
    expect(spy.calls).toEqual([])
  })

  test("#given no session agent #when invoked #then the native call is left untouched", async () => {
    const input = v1Input({ agents: [{ name: "build", permission: ALLOW_ALL }], session: {} })
    const spy = createFetchSpy(() => ok())
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    const args: Record<string, unknown> = { url: "http://start.test/a" }
    await invoke(hooks, args)
    expect(args.url).toBe("http://start.test/a")
    expect(spy.calls).toEqual([])
  })

  test("#given a final url outside the allowlist #when invoked #then only the original argument survives", async () => {
    const input = v1Input({
      agents: [
        {
          name: "build",
          permission: [{ permission: "webfetch", pattern: "http://start.test/*", action: "allow" }],
        },
      ],
      session: { agent: "build" },
    })
    const spy = createFetchSpy((url) =>
      url === "http://start.test/a" ? redirect(302, "http://elsewhere.test/b") : ok(),
    )
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    const args: Record<string, unknown> = { url: "http://start.test/a" }
    await invoke(hooks, args)
    expect(args.url).toBe("http://start.test/a")
  })

  test("#given an allowed loop #when invoked #then a deterministic error is thrown", async () => {
    const input = v1Input({ agents: [{ name: "build", permission: ALLOW_ALL }], session: { agent: "build" } })
    const spy = createFetchSpy((url) =>
      url === "http://start.test/a" ? redirect(302, "http://start.test/b") : redirect(302, "http://start.test/a"),
    )
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    let caught: unknown
    try {
      await invoke(hooks, { url: "http://start.test/a" })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RedirectGuardError)
    expect((caught as RedirectGuardError).code).toBe("redirect_loop")
  })

  test("#given a policy lookup failure #when invoked #then the native call is left untouched", async () => {
    const input = v1Input({ sessionError: new Error("offline") })
    const spy = createFetchSpy(() => ok())
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    const args: Record<string, unknown> = { url: "http://start.test/a" }
    await invoke(hooks, args)
    expect(args.url).toBe("http://start.test/a")
    expect(spy.calls).toEqual([])
  })

  test("#given repeated calls #when the agent list is cached #then the agent lookup happens once", async () => {
    const input = v1Input({ agents: [{ name: "build", permission: ALLOW_ALL }], session: { agent: "build" } })
    const spy = createFetchSpy((url) => (url.endsWith("/a") ? redirect(302, "http://final.test/b") : ok()))
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: spy.impl })
    await invoke(hooks, { url: "http://start.test/a" })
    await invoke(hooks, { url: "http://start.test/a" })
    expect(input.counts.agents).toBe(1)
    expect(input.counts.session).toBe(2)
  })

  test("#given a disposed guard #when invoked again #then the agent cache is reloaded", async () => {
    const input = v1Input({ agents: [{ name: "build", permission: ALLOW_ALL }], session: { agent: "build" } })
    const hooks = await createV1Hooks(input.pluginInput, undefined, { fetchImpl: createFetchSpy(() => ok()).impl })
    await invoke(hooks, { url: "http://start.test/a" })
    const dispose = hooks.dispose
    if (dispose) await dispose()
    await invoke(hooks, { url: "http://start.test/a" })
    expect(input.counts.agents).toBe(2)
  })

  test("#given a zero redirect budget #when a redirect is met #then it refuses with the limit error", async () => {
    const input = v1Input({ agents: [{ name: "build", permission: ALLOW_ALL }], session: { agent: "build" } })
    const spy = createFetchSpy(() => redirect(302, "http://final.test/b"))
    const hooks = await createV1Hooks(input.pluginInput, { maxRedirects: 0 }, { fetchImpl: spy.impl })
    let caught: unknown
    try {
      await invoke(hooks, { url: "http://start.test/a" })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RedirectGuardError)
    expect((caught as RedirectGuardError).code).toBe("redirect_limit")
  })
})
