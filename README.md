# Claude / Codex Usage Dashboard

一个非官方的 Windows 本地悬浮面板，用于查看多个 AI Agent 的配额使用情况。

面板通过本机缓存、日志和本机 Codex CLI 获取配额，内部 HTTP 服务严格绑定 loopback，不加载远程字体、脚本或图片。

## 功能

- 自动显示 Claude Code、Codex 和 Antigravity 的 5 小时与 7 天窗口。
- 内置配置菜单，可自由选择显示的 Agent，并在自适应、紧凑、舒展三种卡片样式间切换。
- 悬浮窗按已选 Agent 数量自动调整为 1～3 列并同步改变窗口尺寸。
- 通过本地额度快照桥接 Kimi Code、Grok、Gemini CLI、GitHub Copilot、Cursor、OpenCode 和任意自定义 Agent。
- 内置 kimi-usage-snapshot.js，用本机 Kimi Code CLI 登录态读取官方 /usages 接口并写入快照。
- 内置 grok-usage-snapshot.js，用本机 Grok CLI OAuth 登录态读取官方 billing credits 接口并写入快照。
- 明确显示服务名、5H/7D 含义、数据年龄以及 LIVE、STALE、OFFLINE 状态。
- 数据过期后不再把历史重置时间推算成新的未来周期。
- Codex 默认每 60 秒最多通过本机 app-server 读取一次账户配额，失败时回退到会话文件，并从文件尾部反向分块读取最新 rate_limits。
- Antigravity 在解析到有效配额前不会覆盖最后一份有效缓存。
- 提供无边框、透明、始终置顶的 Electron 悬浮窗和托盘恢复入口。
- 开机自启安装器只处理本项目拥有的快捷方式。
- 使用严格 CSP、loopback Host 校验、沙箱 renderer 和受限 preload。
- 使用 Node.js 内置测试框架提供回归测试。

## 重要限制

各服务的数据刷新方式不同：

- Claude 数据来自 Claude Code statusLine 缓存。网页或 Claude 桌面客户端不会刷新该缓存。
- Codex 默认调用本机 app-server 的 `account/rateLimits/read`，不创建模型对话、不消耗对话额度；CLI 不可用或请求失败时回退到 ~/.codex/sessions 中最新的 rate_limits 事件。
- Antigravity 数据来自本机 Antigravity CLI gRPC 服务；连接失败时保留最后有效值并标记为 stale/offline。
- Gemini CLI、GitHub Copilot、Cursor、OpenCode 等扩展项来自统一的本地快照目录；看板不会读取这些工具的登录凭据，也不会代替它们访问远程服务。
- Kimi Code 数据来自 kimi-usage-snapshot.js 通过本机 CLI 的 OAuth 登录态请求官方 /usages 接口；看板服务默认每 60 秒自动运行一次该脚本（KIMI_USAGE_BRIDGE=off 可关闭），凭据只被脚本进程使用。
- Grok 数据来自 grok-usage-snapshot.js 通过本机 CLI 的 OAuth 登录态请求官方 `/billing?format=credits` 接口；看板服务默认每 60 秒自动运行一次该脚本（GROK_USAGE_BRIDGE=off 可关闭），凭据只被脚本进程使用。

本项目与 Anthropic、OpenAI、xAI 或 Google 无隶属关系，也不包含其官方 Logo。

## 要求

- Windows 10/11
- Node.js 22.12 或更高版本（Electron 43 的安装要求）
- Claude Code 和/或 Codex CLI
- 如需 Antigravity 卡片：本机运行 Antigravity CLI

检查环境：

~~~powershell
node -v
npm -v
~~~

## 快速开始

~~~powershell
git clone https://github.com/YOUR_NAME/claude-codex-usage-dashboard.git
cd claude-codex-usage-dashboard
npm install
npm start
~~~

也可以双击 start-dashboard-desktop.bat。

Electron 会启动本地服务并打开悬浮窗。重复启动只会唤回现有窗口，不会创建第二套进程。

## 配置看板

点击悬浮窗右上角的“配置”：

1. 勾选需要显示的 Agent；未连接的预设会标记为“等待快照”。
2. 选择“自适应”“紧凑”或“舒展”卡片样式。
3. 设置会写入 Electron 页面自己的本地存储，不修改 Agent 配置或凭据。

“恢复默认”只恢复 Claude Code、Codex、Antigravity 三个自动采集项和自适应样式。

## 更多 Agent 额度桥接

扩展 Agent 的默认快照目录是：

~~~text
%USERPROFILE%\.claude-codex-usage-dashboard\agents
~~~

内置文件名为 `kimi.json`、`grok.json`、`gemini.json`、`github-copilot.json`、`cursor.json`、`opencode.json`。目录中其他符合 `[a-z0-9][a-z0-9_-]{0,31}.json` 的文件会自动成为自定义 Agent；最多读取 32 个文件，单文件最大 256 KiB。额度百分比统一使用 `0～100`，时间可使用 Unix 毫秒或 ISO 8601。

最小快照示例：

~~~json
{
  "label": "Gemini CLI",
  "fetchedAt": "2026-07-14T10:00:00Z",
  "staleAfterMs": 7200000,
  "windows": [
    { "id": "daily", "label": "DAY", "used": 37.4, "resetAt": "2026-07-15T00:00:00Z" },
    { "id": "pro", "label": "PRO", "used": 12.8, "resetAt": "2026-07-14T12:00:00Z" }
  ]
}
~~~

支持同一 Agent 的多模型/多组额度：

~~~json
{
  "label": "My Agent",
  "fetchedAt": 1784023200000,
  "groups": [
    {
      "id": "fast",
      "label": "Fast models",
      "windows": [{ "id": "daily", "label": "DAY", "used": 42 }]
    },
    {
      "id": "reasoning",
      "label": "Reasoning",
      "windows": [{ "id": "weekly", "label": "7D", "used": 18 }]
    }
  ]
}
~~~

快照只接收白名单字段：`label`、`accent`、`source`、`fetchedAt`、`staleAfterMs`、`stale`、`error`、`windows`、`groups`。凭据、提示词等其他字段不会进入 API。让对应 Agent 的官方命令或你自己的本地脚本更新该文件即可；看板每 5 秒重新读取。

## Kimi Code 额度桥接

Kimi Code（Kimi K3 / K2.7）的 5 小时滚动窗口和 7 天额度由随附脚本写入 `kimi.json`。看板运行期间，服务默认每 60 秒自动运行一次桥接脚本，无需额外进程：

~~~powershell
node kimi-usage-snapshot.js          # 手动单次刷新
node kimi-usage-snapshot.js --watch  # 脱离看板时每 5 分钟自动刷新
~~~

脚本复用 Kimi Code CLI 的本机 OAuth 登录态（`~/.kimi-code/credentials/kimi-code.json`），请求与 CLI `/usage` 命令同源的官方 `GET /usages` 接口。只有额度百分比和重置时间会写入快照；访问令牌不会进入快照、日志或看板服务。访问令牌约 15 分钟过期，脚本会自动用凭据里的 refresh_token 续期并原子回写凭据文件（带文件锁避免与 CLI 同时刷新竞争）；只有 refresh_token 本身被服务端拒绝时才需要重新 /login。单次刷新失败时保留最后一份有效快照，没有有效快照时才写入错误占位。也可以用 `KIMI_USAGE_TOKEN` 环境变量直接提供 Kimi Code Console 签发的 API Key，跳过 OAuth 文件。

日常使用时，把单次模式挂到 Windows 任务计划程序，或让 `--watch` 模式随看板一起启动即可。

## Grok 额度桥接

Grok / SuperGrok 的周期额度（通常为周额度）由随附脚本写入 `grok.json`。看板运行期间，服务默认每 60 秒自动运行一次桥接脚本：

~~~powershell
node grok-usage-snapshot.js          # 手动单次刷新
node grok-usage-snapshot.js --watch  # 脱离看板时每 5 分钟自动刷新
~~~

脚本复用 Grok CLI 的本机 OAuth 登录态（`~/.grok/auth.json`），请求与 CLI `/usage` 命令同源的官方 `GET /billing?format=credits` 接口（默认 `https://cli-chat-proxy.grok.com/v1`）。快照只写入总体 `creditUsagePercent` 与周期结束时间；访问令牌不会进入快照、日志或看板服务。令牌过期时脚本会用 refresh_token 向 `auth.x.ai` 续期并原子回写 `auth.json`（带文件锁避免与 CLI 竞争）。单次刷新失败时保留最后一份有效快照。也可以用 `GROK_USAGE_TOKEN`（或 `XAI_API_KEY`）直接提供令牌；注意 billing 接口通常需要 grok.com OAuth 会话，纯 API Key 可能无法读取额度。

在看板配置面板中勾选 **Grok** 即可显示；默认不勾选，与其他 local-bridge 预设一致。

## Claude statusLine 配置

直接配置：

~~~powershell
.\setup-claude-statusline.bat
~~~

脚本会先强制备份 ~/.claude/settings.json，再通过同目录临时文件原子替换。备份失败时不会继续覆盖。

如果已经配置了其他 statusLine，请使用 fanout：

~~~powershell
.\setup-claude-statusline.bat --fanout
~~~

fanout 模式会把原命令保存到忽略提交的 config.json，然后让 statusline-both.js 同时更新面板缓存并调用原命令。如果 config.json 已包含不同命令，脚本会停止并要求人工确认。

配置后：

1. 完全退出并重新打开 Claude Code。
2. 发送一条消息。
3. 面板会在下一次轮询时更新。

## Windows 自启与快捷方式

安装：

~~~powershell
.\install-desktop-autostart.bat
~~~

卸载：

~~~powershell
.\uninstall-desktop-autostart.bat
~~~

安装脚本会在 Startup 和 Desktop 创建 AIUsageDashboardDesktop.lnk。如果同名快捷方式不属于本项目，脚本会拒绝覆盖；卸载时也会跳过外部快捷方式。

托盘和右键菜单提供显示/隐藏、重载、始终置顶、开发者工具和退出。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| PORT | 8787 | 直接运行 server.js 时的端口 |
| HOST | 127.0.0.1 | 仅允许 127.0.0.1、localhost 或 ::1 |
| DASHBOARD_PORT | 8787 | Electron 使用的服务端口 |
| DASHBOARD_HOST | 127.0.0.1 | Electron 使用的服务地址，仅允许 loopback |
| ALERT_PERCENT | 85 | 进入红色告警状态的使用率 |
| CODEX_LOOKBACK_DAYS | 14 | 查找 Codex 会话文件的天数 |
| CLAUDE_STALE_MINUTES | 10 | Claude 数据过期阈值 |
| CODEX_STALE_MINUTES | 120 | Codex 数据过期阈值 |
| CODEX_RATE_LIMITS_SOURCE | auto | `auto` 通过 app-server 刷新并回退到 sessions；`sessions` 只读取会话文件 |
| CODEX_RATE_LIMIT_REFRESH_SECONDS | 60 | app-server 配额查询的最短间隔，范围 15～3600 秒 |
| CODEX_APP_SERVER_TIMEOUT_SECONDS | 15 | 单次 app-server 配额查询超时，范围 3～60 秒 |
| CODEX_EXECUTABLE | 自动发现 | 指定 Codex CLI 可执行文件；Windows 默认选择最新本机安装 |
| CODEX_RATE_LIMIT_RUST_LOG | error | 配额查询子进程的 Rust 日志级别 |
| ANTIGRAVITY_STALE_MINUTES | 120 | Antigravity 数据过期阈值 |
| CLAUDE_USAGE_CACHE | ~/.claude/usage-cache.json | Claude 缓存路径 |
| CODEX_SESSIONS_DIR | ~/.codex/sessions | Codex 会话目录 |
| ANTIGRAVITY_LOG_DIR | ~/.gemini/antigravity-cli/log | Antigravity 日志目录 |
| ANTIGRAVITY_SETTINGS | ~/.gemini/antigravity-cli/settings.json | Antigravity 设置路径 |
| ANTIGRAVITY_USAGE_CACHE | ~/.claude-codex-usage-dashboard/antigravity-usage-cache.json | Antigravity last-good 缓存 |
| AGENT_USAGE_DIR | ~/.claude-codex-usage-dashboard/agents | 扩展 Agent 的本地额度快照目录 |
| EXTERNAL_AGENT_STALE_MINUTES | 120 | 扩展 Agent 默认过期阈值 |
| EXTRA_STATUSLINE_COMMAND | 空 | fanout 的额外命令，优先于 config.json |
| KIMI_CODE_HOME | ~/.kimi-code | Kimi Code CLI 的数据目录 |
| KIMI_CODE_CREDENTIALS | KIMI_CODE_HOME/credentials/kimi-code.json | Kimi OAuth 凭据路径 |
| KIMI_USAGE_TOKEN | 空 | 直接使用 API Key，跳过 OAuth 凭据文件 |
| KIMI_USAGE_BASE_URL | https://api.kimi.com/coding/v1 | Kimi Code API 地址 |
| KIMI_OAUTH_TOKEN_URL | https://auth.kimi.com/api/oauth/token | Kimi OAuth 续期端点 |
| KIMI_OAUTH_CLIENT_ID | Kimi Code CLI 官方 client_id | OAuth 续期使用的 client_id |
| KIMI_USAGE_TIMEOUT_SECONDS | 8 | 单次 /usages 请求超时，范围 3～60 秒 |
| KIMI_USAGE_BRIDGE | auto | auto 时看板服务按固定间隔自动运行桥接脚本；off 完全手动 |
| KIMI_USAGE_REFRESH_SECONDS | 60（服务端）/ 300（--watch） | Kimi 额度刷新间隔，范围 15～3600 秒 |
| KIMI_USAGE_STALE_MINUTES | 30 | Kimi 快照过期阈值 |
| KIMI_USAGE_SNAPSHOT | AGENT_USAGE_DIR/kimi.json | Kimi 快照输出路径 |
| KIMI_USAGE_LABEL | Kimi Code | Kimi 卡片显示名称 |
| GROK_HOME | ~/.grok | Grok CLI 的数据目录 |
| GROK_AUTH_PATH | GROK_HOME/auth.json | Grok OAuth 凭据路径 |
| GROK_USAGE_TOKEN | 空 | 直接使用访问令牌，跳过 auth.json |
| XAI_API_KEY | 空 | 与 GROK_USAGE_TOKEN 相同的后备令牌 |
| GROK_USAGE_BASE_URL | https://cli-chat-proxy.grok.com/v1 | Grok billing API 地址 |
| GROK_OAUTH_TOKEN_URL | https://auth.x.ai/oauth2/token | Grok OAuth 续期端点 |
| GROK_OAUTH_CLIENT_ID | Grok CLI 官方 client_id | OAuth 续期使用的 client_id |
| GROK_USAGE_TIMEOUT_SECONDS | 8 | 单次 billing 请求超时，范围 3～60 秒 |
| GROK_USAGE_BRIDGE | auto | auto 时看板服务按固定间隔自动运行桥接脚本；off 完全手动 |
| GROK_USAGE_REFRESH_SECONDS | 60（服务端）/ 300（--watch） | Grok 额度刷新间隔，范围 15～3600 秒 |
| GROK_USAGE_STALE_MINUTES | 30 | Grok 快照过期阈值 |
| GROK_USAGE_SNAPSHOT | AGENT_USAGE_DIR/grok.json | Grok 快照输出路径 |
| GROK_USAGE_LABEL | Grok | Grok 卡片显示名称 |

示例：

~~~powershell
$env:DASHBOARD_PORT = '8790'
npm start
~~~

## 本地 API

- GET /healthz：轻量健康检查，不读取日志。
- GET /api/usage：返回标准化的 `agents` 列表、`config.agents` 目录和 `config.alertPercent`；同时保留原有 `claude`、`codex`、`antigravity` 字段兼容旧客户端。
- GET /?mode=desktop：HUD 页面。

其他 Host、方法和路径会返回 403、405 或 404。

## 测试

~~~powershell
npm test
npm run check
npm audit
~~~

npm run check 会检查所有 JavaScript 文件语法并运行测试。

## 隐私

- 页面不加载任何远程资源。
- 服务只监听本机 loopback。
- API 只返回配额摘要、状态和模型/分组标签，不返回会话正文或扩展快照中的非白名单字段。
- Antigravity gRPC 请求只发往 127.0.0.1。
- Kimi 桥接脚本仅在请求官方 /usages 接口时使用本机 OAuth 凭据；快照只包含额度百分比与重置时间。
- 项目不会上传本地缓存或日志。

不要提交 Claude/Codex 本地缓存、Claude 设置、config.json、凭据或可能暴露账号/路径/工作区的截图。

安全边界详见 [SECURITY.md](SECURITY.md)，首次上传步骤见 [GITHUB_UPLOAD_GUIDE.md](GITHUB_UPLOAD_GUIDE.md)。

## License

MIT
