import { describe, expect, test } from "bun:test"
import { parseGuardConfig } from "../src/config.js"
import { guardWebfetchCall } from "../src/guard.js"
import type { PermissionRule } from "../src/policy.js"
import { createFetchSpy, ok, redirect } from "./support.js"

const CONFIG = parseGuardConfig(undefined)
const ALLOW_ALL: PermissionRule[] = [{ permission: "*", pattern: "*", action: "allow" }]

describe("guardWebfetchCall", () => {
  test("#given an allowed fragment-only self-redirect #when guarded #then it refuses rather than deferring a loop", async () => {
    const spy = createFetchSpy(() => redirect(302, "/loop#again"))
    const outcome = await guardWebfetchCall({
      url: "http://start.test/loop",
      config: CONFIG,
      rules: ALLOW_ALL,
      fetchImpl: spy.impl,
    })
    expect(outcome.action).toBe("refuse")
    if (outcome.action !== "refuse") return
    expect(outcome.error.code).toBe("redirect_loop")
    expect(spy.calls).toEqual(["http://start.test/loop"])
  })

  test("#given an explicitly allowed redirect #when guarded #then the final url replaces the original", async () => {
    const spy = createFetchSpy((url) => (url === "http://start.test/a" ? redirect(302, "http://final.test/b") : ok()))
    const outcome = await guardWebfetchCall({
      url: "http://start.test/a",
      config: CONFIG,
      rules: ALLOW_ALL,
      fetchImpl: spy.impl,
    })
    expect(outcome).toEqual({ action: "rewrite", url: "http://final.test/b" })
  })

  test("#given an ask rule #when guarded #then no preflight request is made", async () => {
    const spy = createFetchSpy(() => ok())
    const outcome = await guardWebfetchCall({
      url: "http://start.test/a",
      config: CONFIG,
      rules: [{ permission: "webfetch", pattern: "*", action: "ask" }],
      fetchImpl: spy.impl,
    })
    expect(outcome).toEqual({ action: "none" })
    expect(spy.calls).toEqual([])
  })

  test("#given a deny rule #when guarded #then no preflight request is made", async () => {
    const spy = createFetchSpy(() => ok())
    const outcome = await guardWebfetchCall({
      url: "http://start.test/a",
      config: CONFIG,
      rules: [{ permission: "webfetch", pattern: "*", action: "deny" }],
      fetchImpl: spy.impl,
    })
    expect(outcome).toEqual({ action: "none" })
    expect(spy.calls).toEqual([])
  })

  test("#given no matching rule #when guarded #then no preflight request is made", async () => {
    const spy = createFetchSpy(() => ok())
    const outcome = await guardWebfetchCall({
      url: "http://start.test/a",
      config: CONFIG,
      rules: [],
      fetchImpl: spy.impl,
    })
    expect(outcome).toEqual({ action: "none" })
    expect(spy.calls).toEqual([])
  })

  test("#given an allowed original but unapproved final url #when guarded #then the original argument is kept", async () => {
    const spy = createFetchSpy((url) => (url === "http://start.test/a" ? redirect(302, "http://elsewhere.test/b") : ok()))
    const outcome = await guardWebfetchCall({
      url: "http://start.test/a",
      config: CONFIG,
      rules: [{ permission: "webfetch", pattern: "http://start.test/*", action: "allow" }],
      fetchImpl: spy.impl,
    })
    expect(outcome).toEqual({ action: "none" })
    expect(spy.calls).toEqual(["http://start.test/a"])
  })

  test("#given an allowed loop #when guarded #then it refuses with a deterministic error", async () => {
    const spy = createFetchSpy((url) =>
      url === "http://start.test/a" ? redirect(302, "http://start.test/b") : redirect(302, "http://start.test/a"),
    )
    const outcome = await guardWebfetchCall({
      url: "http://start.test/a",
      config: CONFIG,
      rules: ALLOW_ALL,
      fetchImpl: spy.impl,
    })
    expect(outcome.action).toBe("refuse")
    if (outcome.action !== "refuse") return
    expect(outcome.error.code).toBe("redirect_loop")
  })

  test("#given a non-http url #when guarded #then nothing happens and no request is made", async () => {
    const spy = createFetchSpy(() => ok())
    const outcome = await guardWebfetchCall({
      url: "ftp://example.com/file",
      config: CONFIG,
      rules: ALLOW_ALL,
      fetchImpl: spy.impl,
    })
    expect(outcome).toEqual({ action: "none" })
    expect(spy.calls).toEqual([])
  })

  test("#given a url with credentials #when guarded #then nothing happens and no request is made", async () => {
    const spy = createFetchSpy(() => ok())
    const outcome = await guardWebfetchCall({
      url: "https://user:secret@example.com/",
      config: CONFIG,
      rules: ALLOW_ALL,
      fetchImpl: spy.impl,
    })
    expect(outcome).toEqual({ action: "none" })
    expect(spy.calls).toEqual([])
  })

  test("#given a transport failure #when guarded #then the native call is left untouched", async () => {
    const spy = createFetchSpy(() => {
      throw new Error("boom")
    })
    const outcome = await guardWebfetchCall({
      url: "http://start.test/a",
      config: CONFIG,
      rules: ALLOW_ALL,
      fetchImpl: spy.impl,
    })
    expect(outcome).toEqual({ action: "none" })
  })

  test("#given more hops than configured #when guarded #then it refuses with the configured limit", async () => {
    const spy = createFetchSpy((url) => {
      const index = Number(new URL(url).pathname.slice(1))
      return index >= 4 ? ok() : redirect(302, `http://start.test/${index + 1}`)
    })
    const outcome = await guardWebfetchCall({
      url: "http://start.test/0",
      config: parseGuardConfig({ maxRedirects: 2 }),
      rules: ALLOW_ALL,
      fetchImpl: spy.impl,
    })
    expect(outcome.action).toBe("refuse")
    if (outcome.action !== "refuse") return
    expect(outcome.error.code).toBe("redirect_limit")
  })
})
