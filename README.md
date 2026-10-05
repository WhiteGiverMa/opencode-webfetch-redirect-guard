# opencode-webfetch-redirect-guard

[English](README.en.md) | **简体中文**

一个 OpenCode 插件，为**原生 `webfetch` 工具**加上有边界的、尊重权限的重定向解析。

它不注册替代工具，也不自己抓取页面：只在确认这次调用本来就会被自动放行之后，改写原生调用的 URL 参数，正文抓取仍由原生工具完成。

- 已验证宿主：Linux / 原生 Windows 上的 OpenCode **v1 `1.18.34`**，以及 Linux 上的 **v2 `2.0.21`**。
- 许可：MIT。
- 运行时依赖：无（只用标准 `fetch`、`URL`、`AbortController`）。

## 行为

对于一次被放行的 `webfetch` 调用，在原生工具执行之前，守卫会：

1. 读取该会话与目标 URL 的生效权限规则。
2. 当且仅当最后一条匹配规则是显式 `allow` 时，用 `fetch(url, { redirect: "manual" })` 自行解析跳转链。
3. 跟随 `301`、`302`、`303`、`307`、`308` 响应，相对 `Location` 头按当前 URL 解析。每一跳预检之前都先检查权限，未获批准的目标不会被请求。
4. 收到的每个响应体都会被释放（`body.cancel()`），不读取、不存储、不转发。
5. 只有当最终 URL 同样可证明会被自动放行时，才把 `args.url` 改写为最终 URL；否则原参数原样保留，原生工具行为不变。
6. 检测到循环、超过跳数上限、或非 HTTP(S)、带凭据的跳转目标时，以确定的错误码拒绝整条链。

随后原生工具对（可能被改写的）URL 执行自己的权限断言和抓取，正常内容完全由原生工具产出。

### 确定性拒绝

| 条件 | 错误码 | 示例消息 |
| --- | --- | --- |
| URL 在链中重复 | `redirect_loop` | `webfetch-redirect-guard: redirect loop detected: https://a -> https://b -> https://a` |
| 跳转数超过 `maxRedirects` | `redirect_limit` | `webfetch-redirect-guard: redirect limit exceeded (maxRedirects=10): https://a -> ...` |
| `Location` 指向非 HTTP(S) 协议 | `non_http_target` | `webfetch-redirect-guard: refusing non-HTTP(S) redirect target file:///etc/passwd from https://a` |
| `Location` 含有用户信息 | `credential_target` | `webfetch-redirect-guard: refusing redirect target with credentials https://a -> https://example/...` |
| `Location` 无法解析 | `invalid_location` | `webfetch-redirect-guard: invalid redirect Location header from https://a` |

传输层失败（DNS、连接被拒、总超时）不算插件错误：跳过解析，原生工具带着原参数照常执行，原生的错误消息与重试行为保持原样。

## 权限边界

守卫唯一的网络活动是重定向预检，而预检只在守卫根据宿主自己的权限数据证明「原生权限引擎会自动放行这个 URL」之后才会发生。

### v1（`1.18.34`）

- 钩子：`tool.execute.before`，`args` 可变。钩子在原生执行器之前运行；原生执行器在钩子返回后、自己内部断言 `webfetch` 权限。
- 策略快照通过插件自己的 SDK 客户端读取：
  - `GET /agent` → 每个 agent 的生效 `permission` 规则集（含内置默认值、全局 `permission` 配置与自定义 agent 配置）。
  - `GET /session/:id` → 会话的 `agent` 名与会话级 `permission` 规则集。
  - 求值顺序与宿主一致：`[...agentRules, ...sessionRules]`，**最后匹配的规则生效**。只有最后匹配恰好是 `allow` 时才算可证明放行。
- 以下情况保守跳过（不预检，原生行为不变）：
  - 决策为 `ask` 或 `deny`，或没有规则匹配；
  - 会话没有 `agent`、agent 没有规则集，或任一查询失败；
  - 请求的 URL 不是字面 `http(s)://`，或内嵌凭据；
  - 解析后的最终 URL 无法证明会被放行。
- 运行时的 "always" 批准（用户回答 always 后权限服务保存在内存中的授权）不对插件暴露，因此对快照不可见，这类调用会被保守跳过。
- agent 列表响应在每个插件实例内缓存 30 秒，插件销毁时清空。快照只用于跳过，从不用于放行：即使快照朝 `allow` 方向过期，原生引擎仍可对改写后的 URL 询问或拒绝；朝 `ask` 方向过期时守卫只是跳过。

### v2（`2.0.21`）

- 钩子：`tool.execute.before`，`input` 可变。原生执行器在自己内部、钩子返回之后断言 `webfetch` 权限。
- 策略快照使用进程内 domain，无 HTTP 调用：
  - `ctx.agent.get({ agentID })` → `AgentInfo.permissions`（`{ action, resource, effect }` 规则）。
  - `ctx.session.get({ sessionID })` → `SessionInfo.permissions`（在 agent 规则之后求值，最后匹配生效）。
  - 可证明放行要求 agent 规则与合并后的 agent+session 规则**都**以最后匹配解析为 `allow`。因为宿主先评估 agent 级拒绝，再考虑其后追加的规则，这道闸门因此保持保守。
- 保存的 "always" 授权不对插件暴露，对快照不可见；这类调用被保守跳过。
- 钩子抛错只用于上述确定性拒绝场景；任何其他内部失败都不影响原生调用。

### 守卫永不做的事

- 不调用权限 API 本身（`ctx.ask` / `permit` / 求值并修改），从不改变任何权限决定。
- 不调用 `session.prompt` / `session.promptAsync`，不注入消息。
- 不 patch `fetch`、文件系统或任何宿主内部。
- 不发送凭据（`credentials: "omit"`）、cookie 或授权头；不跟随到 `file:`、`data:`、`ftp:` 等非 HTTP(S) 协议的跳转。
- 不读取、不转发响应体。

## 开销

对一次受守卫处理、被放行的 `webfetch` 调用：

- v1：至多 2 次本地 SDK 调用（agent 列表缓存 30 秒）+ 预检请求。
- v2：进程内 agent/session 查询。
- 预检：每一跳一次 `GET`，最终 URL 再一次 `GET`，响应体都释放。有 `N` 次跳转时，比原生多 `N+1` 次请求；没有跳转时多 1 次。预检受 `timeoutMs`（默认 5000 毫秒）约束；超时或失败时守卫放弃，原生调用照常进行。

被拒绝（`ask`/`deny`）或无法证明的调用**零次**目标请求。

## 配置

配置在插件选项中，按宿主和仓库各自独立。未知键被忽略；非法值回落到默认值。

| 选项 | 类型 | 默认 | 范围 | 含义 |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | - | `false` 完全禁用守卫：不注册钩子、不查策略、不做网络工作。 |
| `maxRedirects` | integer | `10` | `0..50` | 拒绝前允许跟随的最大跳转数。`0` 拒绝任何跳转。 |
| `timeoutMs` | integer | `5000` | `100..30000` | 预检总时限；超时则跳过增强（原生行为）。 |

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

`v2-entry/` 是随仓库提交的包装入口，re-export `dist/v2-entry.js`；复制本仓库时请把它留在仓库内（或修改它的相对导入路径）。

### 禁用与回滚

- 设置 `"enabled": false`。禁用意味着：不注册钩子、不读策略、不发预检请求。
- 或从宿主配置中删除插件条目并重启 opencode。
- 回滚：恢复之前的配置文件即可。插件不写任何文件，也没有持久状态。

## 构建、测试、验证

```bash
bun install
bun run typecheck   # tsc --noEmit, strict
bun test            # 本地 HTTP 跳转套件 + 权限/禁用适配器测试
bun run build       # dist/index.js (v1), dist/v2-entry.js (v2), 类型声明
bun run check       # 以上全部
```

测试套件用真实的 loopback HTTP 服务器覆盖跳转行为，用确定性假宿主覆盖权限边界：

- 跳转链、全部五种状态码、相对 `Location`、循环、跳数上限、非法/带凭据/非 HTTP 目标、无 `Location` 响应、总超时、响应体释放，以及 manual/无凭据的 fetch 选项；
- v1 与 v2 规则集的策略解析/求值、最后匹配优先；
- v1/v2 适配器：被拒绝和询问的调用**不发**目标请求，被放行的链改写参数，禁用配置什么都不注册，内部失败不改变原生调用。

## 已知限制

- 守卫只增强原生 `webfetch` 工具，不覆盖 `websearch`、MCP 工具或 shell 抓取。
- 不重新编码、不缓存内容；真实抓取（含图片附件和 markdown/text 转换）仍由原生工具执行。
- 只有初始 URL 可证明会被自动放行时，守卫才会跟随跳转。
- 运行时权限授权和会话中途的配置变更不可观察，这类调用被保守跳过。
- 守卫改写 URL 后，特别大的最终响应会被抓取两次（预检一次、原生一次；预检的响应体被释放）。

## 运行时验证

在 Linux v1/v2 与原生 Windows v1 上，由本地 mock 模型驱动真实原生工具调用验证过，启用与禁用两种情况都覆盖。用例包括原生最终页内容、正常跳转链、含仅 fragment 自跳转的循环，以及被拒绝的调用不产生预检请求。注意原生权限引擎可能对模型隐藏被拒绝的工具，因此拒绝场景的观测结果就是「没有产生工具调用」。全程隔离了 HOME/USERPROFILE、XDG 与数据库。

## 许可

MIT，见 [LICENSE](./LICENSE)。
