import { describe, expect, test } from "bun:test"
import {
  evaluatePermission,
  isProvablyAllowed,
  parseAnyRuleset,
  parseFlatPermissions,
  parseRuleset,
  parseV2Ruleset,
  wildcardMatch,
  type PermissionRule,
} from "../src/policy.js"

describe("wildcardMatch", () => {
  test("#given a star pattern #when matching #then any run of characters matches", () => {
    expect(wildcardMatch("https://example.com/a/b", "https://example.com/*")).toBe(true)
    expect(wildcardMatch("https://example.com", "https://other.com/*")).toBe(false)
  })

  test("#given a question mark #when matching #then exactly one character matches", () => {
    expect(wildcardMatch("ab", "a?")).toBe(true)
    expect(wildcardMatch("a", "a?")).toBe(false)
  })

  test("#given backslashes #when matching #then they normalize to forward slashes", () => {
    expect(wildcardMatch("C:\\dir\\file", "C:/dir/*")).toBe(true)
  })
})

describe("ruleset parsing", () => {
  test("#given a v1 ruleset #when parsed #then rules keep host order", () => {
    const rules = parseRuleset([
      { permission: "webfetch", pattern: "*", action: "ask" },
      { permission: "*", pattern: "*", action: "allow" },
    ])
    expect(rules).toEqual([
      { permission: "webfetch", pattern: "*", action: "ask" },
      { permission: "*", pattern: "*", action: "allow" },
    ])
  })

  test("#given a v2 ruleset #when parsed #then action/resource/effect map to the neutral shape", () => {
    const rules = parseV2Ruleset([{ action: "webfetch", resource: "https://example.com/*", effect: "deny" }])
    expect(rules).toEqual([
      { permission: "webfetch", pattern: "https://example.com/*", action: "deny" },
    ])
  })

  test("#given the legacy flat shape #when parsed #then each entry becomes a star pattern", () => {
    expect(parseFlatPermissions({ webfetch: "allow", bash: "ask" })).toEqual([
      { permission: "webfetch", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
    ])
  })

  test("#given malformed entries #when parsed #then they are ignored", () => {
    expect(parseRuleset([{ permission: "webfetch" }, "nope", null, { permission: "x", pattern: "*", action: "yes" }])).toEqual([])
    expect(parseV2Ruleset([{ action: "webfetch", resource: "*", effect: "maybe" }])).toEqual([])
    expect(parseAnyRuleset(42)).toEqual([])
  })
})

describe("evaluatePermission", () => {
  const rules: PermissionRule[] = [
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "https://blocked.example/*", action: "deny" },
  ]

  test("#given a later matching rule #when evaluated #then the last match wins", () => {
    expect(evaluatePermission(rules, "webfetch", "https://blocked.example/page")).toBe("deny")
    expect(evaluatePermission(rules, "webfetch", "https://allowed.example/page")).toBe("allow")
  })

  test("#given no matching rule #when evaluated #then it reports undefined", () => {
    expect(evaluatePermission([], "webfetch", "https://example.com")).toBeUndefined()
    expect(evaluatePermission([{ permission: "bash", pattern: "*", action: "allow" }], "webfetch", "https://x")).toBeUndefined()
  })

  test("#given agent rules overridden by session rules #when evaluated #then the session decision wins", () => {
    const agent: PermissionRule[] = [{ permission: "webfetch", pattern: "*", action: "allow" }]
    const session: PermissionRule[] = [{ permission: "webfetch", pattern: "https://restricted.example/*", action: "ask" }]
    expect(isProvablyAllowed([...agent, ...session], "https://restricted.example/a")).toBe(false)
    expect(isProvablyAllowed([...agent, ...session], "https://other.example/a")).toBe(true)
  })

  test("#given ask or deny #when checking provably allowed #then it is false", () => {
    expect(isProvablyAllowed([{ permission: "webfetch", pattern: "*", action: "ask" }], "https://x")).toBe(false)
    expect(isProvablyAllowed([{ permission: "webfetch", pattern: "*", action: "deny" }], "https://x")).toBe(false)
    expect(isProvablyAllowed([], "https://x")).toBe(false)
  })
})
