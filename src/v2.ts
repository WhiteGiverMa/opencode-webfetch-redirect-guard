import type * as V2 from "@opencode/plugin/promise/plugin"
import { parseGuardConfig } from "./config.js"
import { guardWebfetchCall } from "./guard.js"
import { PLUGIN_ID } from "./id.js"
import { parseV2Ruleset, type PermissionRule } from "./policy.js"
import { RedirectGuardError } from "./redirects.js"

export interface V2Deps {
  readonly fetchImpl?: typeof globalThis.fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function unwrapData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value
}

function readUrlArg(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  return typeof args.url === "string" ? args.url : undefined
}

function writeUrlArg(args: unknown, url: string): void {
  if (!isRecord(args)) return
  args.url = url
}

interface V2Rules {
  readonly rules: PermissionRule[]
  readonly agentRules: PermissionRule[]
}

async function loadRules(
  context: V2.Context,
  agentID: string,
  sessionID: string,
): Promise<V2Rules | undefined> {
  if (typeof context.agent?.get !== "function" || typeof context.session?.get !== "function") return undefined
  const [agentRaw, sessionRaw] = await Promise.all([
    context.agent.get({ agentID }),
    context.session.get({ sessionID }),
  ])
  const agent = unwrapData(agentRaw)
  const session = unwrapData(sessionRaw)
  if (!isRecord(agent) || !isRecord(session)) return undefined
  const agentRules = parseV2Ruleset(agent.permissions)
  if (agentRules.length === 0) return undefined
  return { rules: [...agentRules, ...parseV2Ruleset(session.permissions)], agentRules }
}

/**
 * Creates the opencode v2 plugin definition.
 *
 * The guard is registered as a `tool.execute.before` hook. When the plugin is
 * disabled, no hook is registered, so no interception and no network work
 * happen for any tool call. Host permission rules are read from the in-process
 * agent and session domains; runtime "always" grants are not visible here and
 * therefore never cause a preflight request.
 */
export function createV2Plugin(deps: V2Deps = {}): V2.Plugin {
  return {
    id: PLUGIN_ID,
    setup: async (context: V2.Context) => {
      const config = parseGuardConfig(context.options)
      if (!config.enabled) return
      const tool = context.tool
      if (!tool || typeof tool.hook !== "function") return

      const fetchImpl = deps.fetchImpl ?? globalThis.fetch
      await tool.hook("execute.before", async (event) => {
        if (event.tool !== "webfetch") return
        const url = readUrlArg(event.input)
        if (!url) return
        try {
          const snapshot = await loadRules(context, event.agent, event.sessionID)
          if (!snapshot) return
          const outcome = await guardWebfetchCall({
            url,
            config,
            rules: snapshot.rules,
            requiredRules: snapshot.agentRules,
            fetchImpl,
          })
          if (outcome.action === "refuse") throw outcome.error
          if (outcome.action === "rewrite") writeUrlArg(event.input, outcome.url)
        } catch (error) {
          if (!(error instanceof RedirectGuardError)) return
          throw error
        }
      })
    },
  }
}
