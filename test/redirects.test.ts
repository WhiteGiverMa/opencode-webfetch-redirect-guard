import { describe, expect, test } from "bun:test"
import { resolveRedirects } from "../src/redirects.js"
import { createFetchSpy, ok, redirect, startLocalServer } from "./support.js"

const OPTIONS = { maxRedirects: 10, timeoutMs: 2_000 }

describe("resolveRedirects", () => {
  test("#given a relative redirect chain #when resolved #then it returns the final url and hop statuses", async () => {
    const server = startLocalServer((request) => {
      const path = new URL(request.url).pathname
      if (path === "/a") return redirect(302, "/b")
      if (path === "/b") return redirect(307, "../c")
      if (path === "/c") return ok("done")
      return new Response("missing", { status: 404 })
    })
    try {
      const result = await resolveRedirects(`${server.base}/a`, OPTIONS)
      expect(result.kind).toBe("resolved")
      if (result.kind !== "resolved") return
      expect(result.finalUrl).toBe(`${server.base}/c`)
      expect(result.status).toBe(200)
      expect(result.hops.map((hop) => hop.status)).toEqual([302, 307])
    } finally {
      await server.stop()
    }
  })

  for (const status of [301, 302, 303, 307, 308]) {
    test(`#given a ${status} redirect #when resolved #then the chain continues`, async () => {
      const server = startLocalServer((request) => {
        const path = new URL(request.url).pathname
        if (path === "/start") return redirect(status, "/final")
        return ok()
      })
      try {
        const result = await resolveRedirects(`${server.base}/start`, OPTIONS)
        expect(result.kind).toBe("resolved")
        if (result.kind !== "resolved") return
        expect(result.finalUrl).toBe(`${server.base}/final`)
        expect(result.hops[0]?.status).toBe(status)
      } finally {
        await server.stop()
      }
    })
  }

  test("#given a fragment-only redirect #when resolved #then it refuses the loop without fetching twice", async () => {
    let requests = 0
    const server = startLocalServer(() => {
      requests += 1
      return redirect(302, "/frag#section")
    })
    try {
      const result = await resolveRedirects(`${server.base}/frag`, OPTIONS)
      expect(result.kind).toBe("refused")
      if (result.kind !== "refused") return
      expect(result.error.code).toBe("redirect_loop")
      expect(requests).toBe(1)
    } finally {
      await server.stop()
    }
  })

  test("#given a redirect loop #when resolved #then it refuses with a deterministic error", async () => {
    const server = startLocalServer((request) => {
      const path = new URL(request.url).pathname
      if (path === "/loop-a") return redirect(302, "/loop-b")
      if (path === "/loop-b") return redirect(302, "/loop-a")
      return ok()
    })
    try {
      const result = await resolveRedirects(`${server.base}/loop-a`, OPTIONS)
      expect(result.kind).toBe("refused")
      if (result.kind !== "refused") return
      expect(result.error.code).toBe("redirect_loop")
      expect(result.error.message).toContain("redirect loop detected")
    } finally {
      await server.stop()
    }
  })

  test("#given a self redirect #when resolved #then it refuses as a loop", async () => {
    const server = startLocalServer(() => redirect(302, "/self"))
    try {
      const result = await resolveRedirects(`${server.base}/self`, OPTIONS)
      expect(result.kind).toBe("refused")
      if (result.kind !== "refused") return
      expect(result.error.code).toBe("redirect_loop")
    } finally {
      await server.stop()
    }
  })

  test("#given more hops than allowed #when resolved #then it refuses with the configured limit", async () => {
    const server = startLocalServer((request) => {
      const match = /^\/n\/(\d+)$/.exec(new URL(request.url).pathname)
      if (!match) return new Response("missing", { status: 404 })
      const index = Number(match[1])
      if (index >= 6) return ok()
      return redirect(302, `/n/${index + 1}`)
    })
    try {
      const result = await resolveRedirects(`${server.base}/n/0`, { maxRedirects: 3, timeoutMs: 2_000 })
      expect(result.kind).toBe("refused")
      if (result.kind !== "refused") return
      expect(result.error.code).toBe("redirect_limit")
      expect(result.error.message).toContain("maxRedirects=3")
    } finally {
      await server.stop()
    }
  })

  test("#given a non-http redirect target #when resolved #then it refuses without following", async () => {
    const server = startLocalServer(() => redirect(302, "file:///etc/passwd"))
    try {
      const result = await resolveRedirects(`${server.base}/a`, OPTIONS)
      expect(result.kind).toBe("refused")
      if (result.kind !== "refused") return
      expect(result.error.code).toBe("non_http_target")
    } finally {
      await server.stop()
    }
  })

  test("#given a credential-bearing redirect target #when resolved #then it refuses and hides secrets", async () => {
    const server = startLocalServer(() => redirect(302, "http://user:ultrasecret@127.0.0.1:9/final"))
    try {
      const result = await resolveRedirects(`${server.base}/a`, OPTIONS)
      expect(result.kind).toBe("refused")
      if (result.kind !== "refused") return
      expect(result.error.code).toBe("credential_target")
      expect(result.error.message).not.toContain("ultrasecret")
    } finally {
      await server.stop()
    }
  })

  test("#given an invalid Location header #when resolved #then it refuses deterministically", async () => {
    const server = startLocalServer(() => redirect(302, "http://"))
    try {
      const result = await resolveRedirects(`${server.base}/a`, OPTIONS)
      expect(result.kind).toBe("refused")
      if (result.kind !== "refused") return
      expect(result.error.code).toBe("invalid_location")
    } finally {
      await server.stop()
    }
  })

  test("#given a redirect status without Location #when resolved #then resolution stops there", async () => {
    const server = startLocalServer(() => new Response(null, { status: 302 }))
    try {
      const result = await resolveRedirects(`${server.base}/a`, OPTIONS)
      expect(result.kind).toBe("resolved")
      if (result.kind !== "resolved") return
      expect(result.finalUrl).toBe(`${server.base}/a`)
      expect(result.status).toBe(302)
    } finally {
      await server.stop()
    }
  })

  test("#given a transport failure #when resolved #then it skips instead of failing", async () => {
    const spy = createFetchSpy(() => {
      throw new Error("connection refused")
    })
    const result = await resolveRedirects("http://127.0.0.1:9/a", { ...OPTIONS, fetchImpl: spy.impl })
    expect(result.kind).toBe("skipped")
    if (result.kind !== "skipped") return
    expect(result.reason).toBe("network")
  })

  test("#given a total timeout #when the first hop stalls #then it skips after the bound", async () => {
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
      })
    }) as typeof globalThis.fetch
    const started = Date.now()
    const result = await resolveRedirects("http://127.0.0.1:9/a", { ...OPTIONS, timeoutMs: 50, fetchImpl: impl })
    expect(result.kind).toBe("skipped")
    if (result.kind !== "skipped") return
    expect(result.reason).toBe("timeout")
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("#given manual resolution #when fetching #then credentials are omitted and redirects are manual", async () => {
    const seen: RequestInit[] = []
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response(null, { status: 200 })
    }) as typeof globalThis.fetch
    const result = await resolveRedirects("http://127.0.0.1:9/a", { ...OPTIONS, fetchImpl: impl })
    expect(result.kind).toBe("resolved")
    expect(seen[0]?.redirect).toBe("manual")
    expect(seen[0]?.credentials).toBe("omit")
  })

  test("#given fetched responses #when resolution finishes #then bodies are released", async () => {
    let cancelled = 0
    const streamBody = () =>
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled += 1
        },
      })
    const spy = createFetchSpy((url) =>
      url.endsWith("/start")
        ? new Response(streamBody(), { status: 302, headers: { location: "/final" } })
        : new Response(streamBody(), { status: 200 }),
    )
    const result = await resolveRedirects("http://example.test/start", { ...OPTIONS, fetchImpl: spy.impl })
    expect(result.kind).toBe("resolved")
    expect(cancelled).toBe(2)
  })
})
