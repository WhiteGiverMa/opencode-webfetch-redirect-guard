export interface GuardConfig {
  readonly enabled: boolean
  readonly maxRedirects: number
  readonly timeoutMs: number
}

export const DEFAULT_MAX_REDIRECTS = 10
export const DEFAULT_TIMEOUT_MS = 5_000
export const MAX_REDIRECTS_LIMIT = 50
export const MIN_TIMEOUT_MS = 100
export const MAX_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined
  if (value < minimum || value > maximum) return undefined
  return value
}

/**
 * Reads the plugin options shared by both host adapters.
 *
 * Unknown keys are ignored. Invalid values fall back to the documented
 * defaults so a malformed option can never widen the guard beyond its bounds.
 */
export function parseGuardConfig(options: unknown): GuardConfig {
  if (!isRecord(options)) {
    return { enabled: true, maxRedirects: DEFAULT_MAX_REDIRECTS, timeoutMs: DEFAULT_TIMEOUT_MS }
  }
  return {
    enabled: options.enabled !== false,
    maxRedirects: readInteger(options.maxRedirects, 0, MAX_REDIRECTS_LIMIT) ?? DEFAULT_MAX_REDIRECTS,
    timeoutMs: readInteger(options.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
  }
}
