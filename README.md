# opencode-webfetch-redirect-guard

An OpenCode plugin that enhances the **native `webfetch` tool** with bounded,
permission-respecting redirect resolution.

It does not register a replacement tool, does not scrape pages itself, and never
bypasses the host permission engine. It only rewrites the URL argument of the
native call after proving that the call would have been auto-allowed anyway.

- Verified hosts: OpenCode **v1 `1.18.34` on Linux/native Windows**, and
  **v2 `2.0.21` on Linux**. Windows v2 is not claimed.
- License: MIT (original implementation, no code copied from other plugins).
- Runtime dependencies: none (standard `fetch`, `URL`, `AbortController` only).

## Behavior

For an allowed `webfetch` call, before the native tool runs, the guard:

1. Reads the effective permission rules for the session and the requested URL.
2. If and only if the last matching rule is an explicit `allow`, resolves the
   redirect chain itself with `fetch(url, { redirect: "manual" })`.
3. Follows `301`, `302`, `303`, `307`, and `308` responses, resolving relative
   `Location` headers against the current URL. Permission is checked before
   every preflight hop; unapproved targets are never requested by the guard.
4. Releases every response body it receives (`body.cancel()`); bodies are never
   read, stored, or forwarded.
5. Rewrites `args.url` to the final URL only when the final URL is also provably
   auto-allowed; otherwise the original argument is left untouched and the
   native tool behaves exactly as before.
6. Refuses the chain with a deterministic error when it detects a loop, exceeds
   the hop limit, or sees a non-HTTP(S) or credential-bearing redirect target.

The native tool then performs its own permission assertion and fetch against the
(possibly rewritten) URL. Normal successful content is produced by the native
tool, unchanged.

### Deterministic refusals

| Condition | Error code | Example message |
| --- | --- | --- |
| URL repeats in the chain | `redirect_loop` | `webfetch-redirect-guard: redirect loop detected: https://a -> https://b -> https://a` |
| More redirects than `maxRedirects` | `redirect_limit` | `webfetch-redirect-guard: redirect limit exceeded (maxRedirects=10): https://a -> ...` |
| `Location` targets a non-HTTP(S) scheme | `non_http_target` | `webfetch-redirect-guard: refusing non-HTTP(S) redirect target file:///etc/passwd from https://a` |
| `Location` contains user info | `credential_target` | `webfetch-redirect-guard: refusing redirect target with credentials https://a -> https://example/... ` |
| `Location` cannot be parsed | `invalid_location` | `webfetch-redirect-guard: invalid redirect Location header from https://a` |

Transport failures (DNS, connection refused, total-timeout aborts) are **not**
errors from the plugin: the resolution is skipped and the native tool runs with
its original argument, so native error messages and retry behavior stay intact.

## Permission boundary (read this before deploying)

The guard's only network activity is a redirect preflight, and that preflight
runs **only after** the guard has proven, from the host's own permission data,
that the native permission engine would auto-allow this exact `webfetch` URL.

### v1 (`1.18.34`)

- Hook: `tool.execute.before`, with mutable `args`. The hook runs before the
  native executor; the native executor asserts the `webfetch` permission inside
  its own body, after the hook returns.
- Policy snapshot, read through the plugin's own SDK client:
  - `GET /agent` -> each agent's effective `permission` ruleset (this includes
    built-in defaults, global `permission` config, and custom agent config).
  - `GET /session/:id` -> the session's `agent` name and session-level
    `permission` ruleset.
  - Evaluation order matches the host: `[...agentRules, ...sessionRules]` with
    **last matching rule wins**. The URL is provably allowed only when that
    last match is exactly `allow`.
- Conservative skips (no preflight, native behavior preserved) when:
  - the decision is `ask` or `deny`, or no rule matches;
  - the session has no `agent`, the agent has no ruleset, or either lookup
    fails;
  - the requested URL is not literally `http(s)://`, or embeds credentials;
  - the final URL after resolution is not provably allowed.
- Runtime "always" approvals (`approved` grants the permission service keeps in
  memory after a user answers `always`) are not exposed to plugins and are
  therefore invisible to the snapshot. These calls are skipped conservatively.
- The agent list response is cached for 30 seconds per plugin instance to keep
  per-call overhead low; the cache is cleared on plugin dispose. The snapshot is
  never used to *grant* anything: if it is stale toward `allow`, the native
  engine can still ask/deny on the rewritten URL; if it is stale toward `ask`,
  the guard simply skips.

### v2 (`2.0.21`)

- Hook: `tool.execute.before` with mutable `input`. The native executor asserts
  the `webfetch` permission inside its body, after the hook returns.
- Policy snapshot uses in-process domains, no HTTP calls:
  - `ctx.agent.get({ agentID })` -> `AgentInfo.permissions` (`{ action, resource,
    effect }` rules).
  - `ctx.session.get({ sessionID })` -> `SessionInfo.permissions` (evaluated
    after the agent's rules, last match wins).
  - Provably allowed requires **both** the agent rules and the merged
    agent+session rules to resolve to `allow` with the last matching rule. This
    keeps the gate conservative because the host evaluates agent-level denies
    before it considers the rules appended after them.
- Saved "always" grants are not exposed to plugins and are invisible to the
  snapshot; such calls are skipped conservatively.
- Hook errors are used only for the deterministic refusal cases; any other
  internal failure leaves the tool call untouched.

### What the guard never does

- It never calls the permission API itself (`ctx.ask` / `permit` / evaluate and
  mutate) and never changes a permission decision.
- It never calls `session.prompt` / `session.promptAsync` or injects messages.
- It never patches `fetch`, the filesystem, or any host internal.
- It never sends credentials (`credentials: "omit"`), cookies, or authorization
  headers; it never follows redirects to `file:`, `data:`, `ftp:`, or other
  non-HTTP(S) schemes.
- It never reads or forwards response bodies.

## Overhead

For one allowed `webfetch` call that is subject to the guard:

- v1: up to 2 local SDK calls (agent list is cached for 30 s) + preflight
  requests.
- v2: in-process agent/session lookups.
- Preflight: one `GET` per hop plus one `GET` for the final URL, bodies
  released. With `N` redirects that is `N+1` extra requests before the native
  fetch of the final URL; without redirects it is 1 extra request. The preflight
  is bounded by `timeoutMs` (default 5000 ms); when it times out or fails, the
  guard abandons and the native call proceeds unchanged.

Disallowed (`ask`/`deny`) or unprovable calls perform **zero** target requests.

## Configuration

Configuration lives in the plugin options, independently for each host and
repository. Unknown keys are ignored; invalid values fall back to defaults.

| Option | Type | Default | Bounds | Meaning |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | - | `false` disables the guard entirely: no hook is registered, no policy lookup, no network work. |
| `maxRedirects` | integer | `10` | `0..50` | Maximum redirects followed before refusing with `redirect_limit`. `0` refuses any redirect. |
| `timeoutMs` | integer | `5000` | `100..30000` | Total preflight deadline; expiry skips the enhancement (native behavior). |

### opencode v1

```jsonc
{
  "plugin": [
    ["/abs/path/to/opencode-webfetch-redirect-guard/dist/index.js", { "enabled": true, "maxRedirects": 10, "timeoutMs": 5000 }]
  ]
}
```

### opencode v2

```jsonc
{
  "plugins": [
    { "package": "/abs/path/to/opencode-webfetch-redirect-guard/v2-entry", "options": { "enabled": true } }
  ]
}
```

`v2-entry/` is a committed wrapper that re-exports `dist/v2-entry.js`; keep it
inside the repository (or repoint its relative import if you copy it).

### Disable and rollback

- Set `"enabled": false` (or `{ "enabled": false }` in the options object).
  Disabled means: no hook registered, no policy read, no preflight request.
- Or remove the plugin entry from the host configuration and restart opencode.
- Rollback: restore the previous configuration file. The plugin writes no files
  and keeps no persistent state.

## Build, test, verify

```bash
bun install
bun run typecheck   # tsc --noEmit, strict
bun test            # local-HTTP redirect suite + permission/disabled adapter tests
bun run build       # dist/index.js (v1), dist/v2-entry.js (v2), declarations
bun run check       # all of the above
```

The test suite uses real loopback HTTP servers for redirect behavior and
deterministic fake hosts for the permission boundary:

- redirect chains, all five statuses, relative `Location`, loops, hop limits,
  invalid/credential/non-HTTP targets, no-`Location` responses, total timeout,
  body release, and manual/no-credential fetch options;
- policy parsing/evaluation for v1 and v2 rulesets, last-match precedence;
- v1/v2 adapters: denied and ask calls make **no** target request, allowed
  chains rewrite the argument, disabled configuration registers nothing, and
  internal failures never alter the native call.

## Known limits

- The guard only enhances the native `webfetch` tool; it does not cover
  `websearch`, MCP tools, or shell-based fetchers.
- It does not re-encode or cache content; the native tool still performs the
  real fetch, including image attachment and markdown/text conversion.
- Redirect targets that native `fetch` would auto-follow outside the guard are
  only followed by the guard when the initial URL is provably auto-allowed.
- Runtime permission grants and mid-session config changes are not observable;
  those calls are conservatively skipped.
- Very large final responses are fetched twice when the guard rewrites the URL
  (once in preflight with the body released, once by the native tool).

## Runtime verification

Actual native tool calls were driven by a local mock model on Linux v1/v2 and
native Windows v1, with both plugins enabled and disabled. The cases checked
native final-page content, normal redirect chains, loops including fragment-only
self-redirects, and denied calls producing no preflight request. Native permission
may hide a denied tool from the model; that outcome was recorded rather than
inventing a tool call. HOME/USERPROFILE, XDG and databases were isolated; host
session counts stayed370 on Linux and571 on Windows. No paid model or service
restart was used. Task captures remain local in
`.omo/evidence/20261001-modular-guards/` and are not published.

## License

MIT. See [LICENSE](./LICENSE). This is an original implementation; the
repository does not vendor or import code from other plugins.
