import type { PluginInput } from "@opencode-ai/plugin"
import type * as V2 from "@opencode/plugin/promise/plugin"

export interface ServerHandle {
  readonly base: string
  stop(): Promise<void>
}

export function startLocalServer(fetch: (request: Request) => Response | Promise<Response>): ServerHandle {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  return {
    base: `http://127.0.0.1:${server.port}`,
    async stop() {
      await server.stop(true)
    },
  }
}

export function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } })
}

export function ok(body = "ok"): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } })
}

export interface FetchSpy {
  readonly calls: string[]
  readonly impl: typeof globalThis.fetch
}

export function createFetchSpy(handler: (url: string) => Response | Promise<Response>): FetchSpy {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push(url)
    return await handler(url)
  }) as typeof globalThis.fetch
  return { calls, impl }
}

export function v1Input(input: {
  readonly agents?: unknown
  readonly session?: unknown
  readonly agentsError?: Error
  readonly sessionError?: Error
}): { readonly pluginInput: PluginInput; readonly counts: { agents: number; session: number } } {
  const counts = { agents: 0, session: 0 }
  const client = {
    app: {
      agents: async () => {
        counts.agents += 1
        if (input.agentsError) throw input.agentsError
        return { data: input.agents ?? [] }
      },
    },
    session: {
      get: async () => {
        counts.session += 1
        if (input.sessionError) throw input.sessionError
        return { data: input.session ?? { agent: "build" } }
      },
    },
  }
  return { pluginInput: { client } as unknown as PluginInput, counts }
}

export interface V2HookCall {
  readonly name: string
  readonly callback: (event: unknown) => Promise<void> | void
}

export interface V2ContextHandle {
  readonly context: V2.Context
  readonly hooks: V2HookCall[]
}

export function v2Context(input: {
  readonly options?: unknown
  readonly agent?: unknown
  readonly session?: unknown
  readonly agentError?: Error
  readonly sessionError?: Error
}): V2ContextHandle {
  const hooks: V2HookCall[] = []
  const context = {
    options: input.options,
    tool: {
      hook: async (name: string, callback: (event: unknown) => Promise<void> | void) => {
        hooks.push({ name, callback })
        return { dispose: () => {} }
      },
    },
    agent: {
      get: async () => {
        if (input.agentError) throw input.agentError
        return { location: {}, data: input.agent ?? {} }
      },
    },
    session: {
      get: async () => {
        if (input.sessionError) throw input.sessionError
        return input.session ?? { permissions: [] }
      },
    },
  }
  return { context: context as unknown as V2.Context, hooks }
}
