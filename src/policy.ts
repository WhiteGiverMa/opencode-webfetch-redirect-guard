export type PermissionAction = "allow" | "deny" | "ask"

/**
 * Host-neutral permission rule.
 *
 * OpenCode v1 uses `{ permission, pattern, action }`; opencode v2 uses
 * `{ action, resource, effect }`. Both are normalized into this shape before
 * evaluation, and both are matched with the same wildcard semantics the hosts
 * use for permissions.
 */
export interface PermissionRule {
  readonly permission: string
  readonly pattern: string
  readonly action: PermissionAction
}

export const WEBFETCH_PERMISSION = "webfetch"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readAction(value: unknown): PermissionAction | undefined {
  return value === "allow" || value === "deny" || value === "ask" ? value : undefined
}

/**
 * Mirrors the host wildcard matching used for permission patterns:
 * `*` matches any run of characters, `?` matches one character, and the match
 * is anchored to the full input. Windows matching is case-insensitive, like
 * the host implementation.
 */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  const source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
  const flags = process.platform === "win32" ? "si" : "s"
  return new RegExp(`^${source}$`, flags).test(normalized)
}

/** Parses an opencode v1 ruleset (`[{ permission, pattern, action }]`). */
export function parseRuleset(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return []
  const rules: PermissionRule[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (typeof item.permission !== "string" || typeof item.pattern !== "string") continue
    const action = readAction(item.action)
    if (!action) continue
    rules.push({ permission: item.permission, pattern: item.pattern, action })
  }
  return rules
}

/** Parses an opencode v2 ruleset (`[{ action, resource, effect }]`). */
export function parseV2Ruleset(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return []
  const rules: PermissionRule[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (typeof item.action !== "string" || typeof item.resource !== "string") continue
    const effect = readAction(item.effect)
    if (!effect) continue
    rules.push({ permission: item.action, pattern: item.resource, action: effect })
  }
  return rules
}

/**
 * Parses the legacy flat agent permission object (`{ webfetch: "allow" }`) that
 * older opencode v1 SDK responses used, treating each entry as a `*` pattern.
 */
export function parseFlatPermissions(value: unknown): PermissionRule[] {
  if (!isRecord(value)) return []
  const rules: PermissionRule[] = []
  for (const [permission, raw] of Object.entries(value)) {
    const action = readAction(raw)
    if (action) rules.push({ permission, pattern: "*", action })
  }
  return rules
}

/** Accepts a v1 ruleset, a v1 flat object, or a v2 ruleset. */
export function parseAnyRuleset(value: unknown): PermissionRule[] {
  const arrayRules = parseRuleset(value)
  if (arrayRules.length > 0) return arrayRules
  return parseFlatPermissions(value)
}

/**
 * Evaluates permission rules with the same precedence the hosts use: the last
 * matching rule wins. Returns `undefined` when no rule matches, which callers
 * must treat as "not provably allowed".
 */
export function evaluatePermission(
  rules: readonly PermissionRule[],
  permission: string,
  resource: string,
): PermissionAction | undefined {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]
    if (!rule) continue
    if (!wildcardMatch(permission, rule.permission)) continue
    if (!wildcardMatch(resource, rule.pattern)) continue
    return rule.action
  }
  return undefined
}

/**
 * Conservative gate: the host permission engine will auto-allow this call only
 * when the effective ruleset's last matching rule is an explicit `allow`.
 */
export function isProvablyAllowed(rules: readonly PermissionRule[], url: string): boolean {
  return evaluatePermission(rules, WEBFETCH_PERMISSION, url) === "allow"
}
