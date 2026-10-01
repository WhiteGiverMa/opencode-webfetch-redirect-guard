import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { parseGuardConfig } from "./config.js"
import { guardWebfetchCall, type GuardOutcome } from "./guard.js"
import { parseAnyRuleset, parseRuleset, type PermissionRule } from "./policy.js"
import { RedirectGuardError } from "./redirects.js"

export interface V1Deps {
  readonly fetchImpl?: typeof globalThis.fetch
  readonly agentsCacheTtlMs?: number
  readonly now?: () => number
}

interface V1HostClient {
  readonly app?: { readonly agents?: (input?: unknown) => Promise<unknown> }
  readonly session?: { readonly get?: (input: { path: { id: string } }) => Promise<unknown> }
}

interface AgentsCache {
  readonly at: number
  readonly agents: Map<string, PermissionRule[]>
}

const DEFAULT_AGENTS_CACHE_TTL_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value
}

function toHostClient(value: unknown): V1HostClient {
  if (!isRecord(value)) return {}
  return value as V1HostClient
}

function readUrlArg(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  return typeof args.url === "string" ? args.url : undefined
}

function writeUrlArg(args: unknown, url: string): void {
  if (!isRecord(args)) return
  args.url = url
}

/**
 * Creates the opencode v1 hook object for this guard.
 *
 * When the plugin is disabled, no hook is registered at all: no interception
 * and no network work happen for any tool call.
 */
export function createV1Hooks(input: PluginInput, options: unknown, deps: V1Deps = {}): Promise<Hooks> {
  const config = parseGuardConfig(options)
  if (!config.enabled) return Promise.resolve({})

  const client = toHostClient(input.client)
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const agentsCacheTtlMs = deps.agentsCacheTtlMs ?? DEFAULT_AGENTS_CACHE_TTL_MS
  let agentsCache: AgentsCache | undefined

  async function loadAgents(): Promise<Map<string, PermissionRule[]> | undefined> {
    const cached = agentsCache
    if (cached && now() - cached.at < agentsCacheTtlMs) return cached.agents
    const agents = client.app?.agents
    if (typeof agents !== "function") return undefined
    const raw = unwrapData(await agents.call(client.app))
    if (!Array.isArray(raw)) return undefined
    const parsed = new Map<string, PermissionRule[]>()
    for (const entry of raw) {
      if (!isRecord(entry) || typeof entry.name !== "string") continue
      parsed.set(entry.name, parseAnyRuleset(entry.permission))
    }
    agentsCache = { at: now(), agents: parsed }
    return parsed
  }

  async function loadRules(sessionID: string): Promise<PermissionRule[] | undefined> {
    const getSession = client.session?.get
    if (typeof getSession !== "function") return undefined
    const [agents, sessionRaw] = await Promise.all([
      loadAgents(),
      getSession.call(client.session, { path: { id: sessionID } }),
    ])
    const session = unwrapData(sessionRaw)
    if (!agents || !isRecord(session) || typeof session.agent !== "string") return undefined
    const agentRules = agents.get(session.agent)
    if (!agentRules) return undefined
    const sessionRules = parseRuleset(session.permission)
    return [...agentRules, ...sessionRules]
  }

  async function handleBefore(sessionID: string, args: unknown): Promise<GuardOutcome> {
    const url = readUrlArg(args)
    if (!url) return { action: "none" }
    const rules = await loadRules(sessionID)
    if (!rules) return { action: "none" }
    return guardWebfetchCall({ url, config, rules, fetchImpl })
  }

  const hooks: Hooks = {
    "tool.execute.before": async (hookInput, hookOutput) => {
      if (hookInput.tool !== "webfetch") return
      try {
        const outcome = await handleBefore(hookInput.sessionID, hookOutput.args)
        if (outcome.action === "refuse") throw outcome.error
        if (outcome.action === "rewrite") writeUrlArg(hookOutput.args, outcome.url)
      } catch (error) {
        if (!(error instanceof RedirectGuardError)) return
        throw error
      }
    },
    dispose: async () => {
      agentsCache = undefined
    },
  }

  return Promise.resolve(hooks)
}
