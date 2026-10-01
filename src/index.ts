import type { Plugin } from "@opencode-ai/plugin"
import { PLUGIN_ID } from "./id.js"
import { createV1Hooks, type V1Deps } from "./v1.js"

/**
 * opencode v1 server export.
 *
 * Load it from `opencode.json[c]`:
 *   "plugin": [["/abs/path/to/dist/index.js", { "enabled": true }]]
 *
 * The default export below is also the shape opencode v1 detects
 * (`{ id, server }`).
 */
export const server: Plugin = (input, options) => createV1Hooks(input, options)

export function createV1Plugin(deps: V1Deps = {}): Plugin {
  return (input, options) => createV1Hooks(input, options, deps)
}

export default { id: PLUGIN_ID, server }
