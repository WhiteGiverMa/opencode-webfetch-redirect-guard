// OpenCode v2 entry point for the webfetch-redirect-guard plugin.
//
// The v2 configuration references this directory as `plugins[].package`.
// opencode v2 loads the module's default export, so this file only re-exports
// the built v2 plugin. Keep this directory inside the repository: the relative
// path below points at `../dist/v2-entry.js`.
export { default } from '../dist/v2-entry.js'
