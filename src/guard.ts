import type { GuardConfig } from "./config.js"
import { isProvablyAllowed, type PermissionRule } from "./policy.js"
import { resolveRedirects, type RedirectGuardError } from "./redirects.js"

export type GuardOutcome =
  | { readonly action: "none" }
  | { readonly action: "rewrite"; readonly url: string }
  | { readonly action: "refuse"; readonly error: RedirectGuardError }

export interface GuardInput {
  readonly url: string
  readonly config: GuardConfig
  readonly rules: readonly PermissionRule[]
  readonly requiredRules?: readonly PermissionRule[]
  readonly fetchImpl?: typeof globalThis.fetch
}

/**
 * Native-syntax parity check. opencode v1's native webfetch only accepts URLs
 * that literally start with `http://` or `https://`; anything else is left to
 * the native tool so its validation and error stay identical.
 */
export function isNativeHttpUrl(raw: string): boolean {
  return raw.startsWith("http://") || raw.startsWith("https://")
}

function hasCredentials(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.username !== "" || url.password !== ""
  } catch {
    return false
  }
}

/**
 * Decides whether the native webfetch call may be redirected by this plugin.
 *
 * The permission gate runs BEFORE any network work: the call proceeds to
 * redirect resolution only when the effective ruleset explicitly auto-allows
 * the requested URL. Calls that would be denied or that would prompt the user
 * never trigger a preflight request.
 *
 * The rewritten URL must also be provably allowed, so the native permission
 * decision for the rewritten call is the same auto-allow it would have made for
 * the original call; otherwise the original argument is left untouched and the
 * native tool handles the redirects itself.
 */
export async function guardWebfetchCall(input: GuardInput): Promise<GuardOutcome> {
  const provablyAllowed = (url: string) =>
    isProvablyAllowed(input.rules, url) &&
    (input.requiredRules === undefined || isProvablyAllowed(input.requiredRules, url))

  if (!isNativeHttpUrl(input.url)) return { action: "none" }
  if (hasCredentials(input.url)) return { action: "none" }
  if (!provablyAllowed(input.url)) return { action: "none" }

  let resolution
  try {
    resolution = await resolveRedirects(input.url, {
      maxRedirects: input.config.maxRedirects,
      timeoutMs: input.config.timeoutMs,
      fetchImpl: input.fetchImpl,
      canVisit: provablyAllowed,
    })
  } catch {
    return { action: "none" }
  }

  if (resolution.kind === "skipped") return { action: "none" }
  if (resolution.kind === "refused") return { action: "refuse", error: resolution.error }
  if (resolution.finalUrl === input.url) return { action: "none" }
  if (!provablyAllowed(resolution.finalUrl)) return { action: "none" }
  return { action: "rewrite", url: resolution.finalUrl }
}
