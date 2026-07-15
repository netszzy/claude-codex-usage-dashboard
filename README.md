# Claude / Codex Usage Dashboard

一个非官方的 Windows 本地悬浮面板，用于查看多个 AI Agent 的配额使用情况。

面板只读取本机缓存与日志，内部 HTTP 服务严格绑定 loopback，不加载远程字体、脚本或图片。

## 功能

- 自动显示 Claude Code、Codex 和 Antigravity 的 5 小时与 7 天窗口。
- 内置配置菜单，可自由选择显示的 Agent，并在自适应、紧凑、舒展三种卡片样式间切换。
- 悬浮窗按已选 Agent 数量自动调整为 1～3 列并同步改变窗口尺寸。
- 通过本地额度快照桥接 Gemini CLI、GitHub Copilot、Cursor、OpenCode 和任意自定义 Agent。
- 明确显示服务名、5H/7D 含义、数据年龄以及 LIVE、STALE、OFFLINE 状态。
- 数据过期后不再把历史重置时间推算成新的未来周期。
- Codex 日志按修改时间排序，并从文件尾部反向分块读取最新 rate_limits，避免周期性全量扫描。
- Antigravity 在解析到有效配额前不会覆盖最后一份有效缓存。
- 提供无边框、透明、始终置顶的 Electron 悬浮窗和托盘恢复入口。
- 开机自启安装器只处理本项目拥有的快捷方式。
- 使用严格 CSP、loopback Host 校验、沙箱 renderer 和受限 preload。
- 使用 Node.js 内置测试框架提供回归测试。

## 重要限制

配额只会在对应 CLI 写入新数据后更新：

- Claude 数据来自 Claude Code statusLine 缓存。网页或 Claude 桌面客户端不会刷新该缓存。
- Codex 数据来自 ~/.codex/sessions 中最新的 rate_limits 事件。
- Antigravity 数据来自本机 Antigravity CLI gRPC 服务；连接失败时保留最后有效值并标记为 stale/offline。
- Gemini CLI、GitHub Copilot、Cursor、OpenCode 等扩展项来自统一的本地快照目录；看板不会读取这些工具的登录凭据，也不会代替它们访问远程服务。

本项目与 Anthropic、OpenAI 或 Google 无隶属关系，也不包含其官方 Logo。

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

内置文件名为 `gemini.json`、`github-copilot.json`、`cursor.json`、`opencode.json`。目录中其他符合 `[a-z0-9][a-z0-9_-]{0,31}.json` 的文件会自动成为自定义 Agent；最多读取 32 个文件，单文件最大 256 KiB。额度百分比统一使用 `0～100`，时间可使用 Unix 毫秒或 ISO 8601。

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
| ANTIGRAVITY_STALE_MINUTES | 120 | Antigravity 数据过期阈值 |
| CLAUDE_USAGE_CACHE | ~/.claude/usage-cache.json | Claude 缓存路径 |
| CODEX_SESSIONS_DIR | ~/.codex/sessions | Codex 会话目录 |
| ANTIGRAVITY_LOG_DIR | ~/.gemini/antigravity-cli/log | Antigravity 日志目录 |
| ANTIGRAVITY_SETTINGS | ~/.gemini/antigravity-cli/settings.json | Antigravity 设置路径 |
| ANTIGRAVITY_USAGE_CACHE | ~/.claude-codex-usage-dashboard/antigravity-usage-cache.json | Antigravity last-good 缓存 |
| AGENT_USAGE_DIR | ~/.claude-codex-usage-dashboard/agents | 扩展 Agent 的本地额度快照目录 |
| EXTERNAL_AGENT_STALE_MINUTES | 120 | 扩展 Agent 默认过期阈值 |
| EXTRA_STATUSLINE_COMMAND | 空 | fanout 的额外命令，优先于 config.json |

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
- 项目不会上传本地缓存或日志。

不要提交 Claude/Codex 本地缓存、Claude 设置、config.json、凭据或可能暴露账号/路径/工作区的截图。

安全边界详见 [SECURITY.md](SECURITY.md)，首次上传步骤见 [GITHUB_UPLOAD_GUIDE.md](GITHUB_UPLOAD_GUIDE.md)。

## License

MIT
