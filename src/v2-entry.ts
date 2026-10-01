import { createV2Plugin, type V2Deps } from "./v2.js"

export { createV2Plugin, type V2Deps }

/**
 * opencode v2 entry point.
 *
 * The `v2-entry/` directory in this repository re-exports this module's
 * default export and is referenced from the v2 configuration:
 *   "plugins": [{ "package": "/abs/path/to/v2-entry", "options": { ... } }]
 */
const plugin = createV2Plugin()

export const Plugin = plugin
export default plugin
