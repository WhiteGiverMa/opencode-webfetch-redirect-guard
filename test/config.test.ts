import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  MAX_REDIRECTS_LIMIT,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  parseGuardConfig,
} from "../src/config.js"

describe("parseGuardConfig", () => {
  test("#given no options #when parsed #then documented defaults apply", () => {
    expect(parseGuardConfig(undefined)).toEqual({
      enabled: true,
      maxRedirects: DEFAULT_MAX_REDIRECTS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    })
  })

  test("#given enabled false #when parsed #then the guard is disabled", () => {
    expect(parseGuardConfig({ enabled: false }).enabled).toBe(false)
    expect(parseGuardConfig({ enabled: "no" }).enabled).toBe(true)
  })

  test("#given in-range values #when parsed #then they are kept", () => {
    expect(parseGuardConfig({ maxRedirects: 0, timeoutMs: MIN_TIMEOUT_MS })).toEqual({
      enabled: true,
      maxRedirects: 0,
      timeoutMs: MIN_TIMEOUT_MS,
    })
    expect(parseGuardConfig({ maxRedirects: MAX_REDIRECTS_LIMIT, timeoutMs: MAX_TIMEOUT_MS }).maxRedirects).toBe(
      MAX_REDIRECTS_LIMIT,
    )
  })

  test("#given invalid values #when parsed #then defaults are restored", () => {
    const config = parseGuardConfig({ maxRedirects: -1, timeoutMs: 1e9 })
    expect(config.maxRedirects).toBe(DEFAULT_MAX_REDIRECTS)
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
    expect(parseGuardConfig({ maxRedirects: 1.5, timeoutMs: "soon" }).maxRedirects).toBe(DEFAULT_MAX_REDIRECTS)
  })
})
