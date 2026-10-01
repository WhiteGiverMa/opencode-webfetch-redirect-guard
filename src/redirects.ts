export type RedirectErrorCode =
  | "redirect_loop"
  | "redirect_limit"
  | "non_http_target"
  | "credential_target"
  | "invalid_location"

export class RedirectGuardError extends Error {
  readonly code: RedirectErrorCode

  constructor(code: RedirectErrorCode, message: string) {
    super(`webfetch-redirect-guard: ${message}`)
    this.name = "RedirectGuardError"
    this.code = code
  }
}

export interface RedirectHop {
  readonly url: string
  readonly status: number
  readonly location: string
}

export type RedirectResolution =
  | {
      readonly kind: "resolved"
      readonly finalUrl: string
      readonly status: number
      readonly hops: readonly RedirectHop[]
    }
  | { readonly kind: "refused"; readonly error: RedirectGuardError }
  | { readonly kind: "skipped"; readonly reason: "network" | "timeout" | "permission" }

export interface ResolveRedirectOptions {
  readonly maxRedirects: number
  readonly timeoutMs: number
  readonly fetchImpl?: typeof globalThis.fetch
  readonly canVisit?: (url: string) => boolean
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const REQUEST_HEADERS: Record<string, string> = {
  accept: "*/*",
  "user-agent": "opencode-webfetch-redirect-guard/0.1",
}

function chainLabel(urls: readonly string[]): string {
  const shown = urls.length > 6 ? [...urls.slice(0, 3), "...", ...urls.slice(-2)] : urls
  return shown.join(" -> ")
}

function displayUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ""
    url.password = ""
    return url.href
  } catch {
    return "<invalid url>"
  }
}

/**
 * Loop detection key. Fragments are client-side only and never sent to the
 * server, so redirects that only change the fragment must not be re-fetched.
 */
function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ""
    return url.href
  } catch {
    return raw
  }
}

async function releaseBody(response: Response): Promise<void> {
  const body = response.body
  if (!body) return
  try {
    await body.cancel()
  } catch {
    return
  }
}

/**
 * Resolves a redirect chain with manual, bounded redirect handling.
 *
 * Network/transport failures and aborts are reported as `skipped` so callers
 * keep the native tool behavior untouched. Policy violations (loops, hop
 * limits, non-HTTP(S) or credential-bearing targets) are reported as
 * deterministic `refused` errors.
 */
export async function resolveRedirects(
  startUrl: string,
  options: ResolveRedirectOptions,
): Promise<RedirectResolution> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const visited = new Set<string>()
  const hops: RedirectHop[] = []
  let current = startUrl

  try {
    for (;;) {
      if (options.canVisit && !options.canVisit(current)) {
        return { kind: "skipped", reason: "permission" }
      }
      visited.add(canonicalUrl(current))
      let response: Response
      try {
        response = await fetchImpl(current, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          headers: REQUEST_HEADERS,
          signal: controller.signal,
        })
      } catch {
        return controller.signal.aborted ? { kind: "skipped", reason: "timeout" } : { kind: "skipped", reason: "network" }
      }

      try {
        const status = response.status
        if (!REDIRECT_STATUS.has(status)) {
          return { kind: "resolved", finalUrl: current, status, hops: [...hops] }
        }

        const location = response.headers.get("location")
        if (!location) {
          return { kind: "resolved", finalUrl: current, status, hops: [...hops] }
        }

        let target: URL
        try {
          target = new URL(location, current)
        } catch {
          const message = `invalid redirect Location header from ${displayUrl(current)}`
          return { kind: "refused", error: new RedirectGuardError("invalid_location", message) }
        }

        if (target.protocol !== "http:" && target.protocol !== "https:") {
          const message = `refusing non-HTTP(S) redirect target ${displayUrl(target.href)} from ${displayUrl(current)}`
          return { kind: "refused", error: new RedirectGuardError("non_http_target", message) }
        }

        if (target.username !== "" || target.password !== "") {
          const message = `refusing redirect target with credentials ${displayUrl(target.href)} from ${displayUrl(current)}`
          return { kind: "refused", error: new RedirectGuardError("credential_target", message) }
        }

        hops.push({ url: current, status, location: target.href })
        const nextKey = canonicalUrl(target.href)
        if (visited.has(nextKey)) {
          return {
            kind: "refused",
            error: new RedirectGuardError(
              "redirect_loop",
              `redirect loop detected: ${chainLabel([...visited, nextKey])}`,
            ),
          }
        }
        if (hops.length > options.maxRedirects) {
          return {
            kind: "refused",
            error: new RedirectGuardError(
              "redirect_limit",
              `redirect limit exceeded (maxRedirects=${options.maxRedirects}): ${chainLabel([...visited, nextKey])}`,
            ),
          }
        }

        current = target.href
      } finally {
        await releaseBody(response)
      }
    }
  } finally {
    clearTimeout(timer)
  }
}
