# 安全策略

本项目是仅供本机使用的配额面板，不应暴露到局域网或公网。

## 读取范围

服务会读取：

- Claude 使用缓存：~/.claude/usage-cache.json
- Codex 会话中的配额事件：~/.codex/sessions/**/rollout-*.jsonl
- 本机 Codex app-server 的 `account/rateLimits/read` 响应；认证由 Codex CLI 自己处理，面板不读取登录凭据
- Antigravity CLI 日志与设置：~/.gemini/antigravity-cli/log 和 settings.json
- Antigravity last-good 缓存：~/.claude-codex-usage-dashboard/antigravity-usage-cache.json

API 只返回配额百分比、重置时间、数据新鲜度、错误状态和模型/分组标签，不返回提示词、回复正文或完整日志。

## 网络边界

- server.js 默认监听 127.0.0.1。
- HOST 和 DASHBOARD_HOST 仅接受 127.0.0.1、localhost 或 ::1。
- HTTP 层拒绝非 loopback Host header，降低 DNS rebinding 风险。
- `/api/config` 只接受 loopback Origin，且仅能修改告警阈值和 Kimi/Grok 桥接开关；配置保存在本项目自有目录，不写入第三方 Agent 目录。
- 页面使用严格 CSP，只允许加载同源 CSS/JavaScript 并访问同源 API。
- 页面不加载 Google Fonts 或其他远程资源。
- Codex 配额刷新只启动本机 Codex CLI，并由它访问 OpenAI 的账户配额服务；面板不接触认证 token。
- Antigravity gRPC 请求只访问 https://127.0.0.1:<port>。

## Electron 边界

Renderer 使用：

- contextIsolation: true
- nodeIntegration: false
- sandbox: true
- 禁止新窗口、webview、外部顶层导航和所有权限请求
- preload 只暴露拖动与重试所需的最小 IPC
- 单实例锁防止重复窗口和重复服务

Electron 应保持在 npm audit 无已知漏洞的受支持版本。

## 本地命令边界

Codex 配额查询使用固定参数 `app-server --stdio`，通过 Node.js `spawn` 直接启动，不经过 shell。Windows 优先在 `%LOCALAPPDATA%\OpenAI\Codex\bin` 中选择最新 `codex.exe`，找不到时回退到 PATH，也可以用 `CODEX_EXECUTABLE` 显式覆盖。查询子进程设置 `RUST_LOG=error`，拿到响应或超时后立即退出。

fanout 模式可以执行 config.json 或 EXTRA_STATUSLINE_COMMAND 中的命令。默认会按带引号语义拆为 argv，并以 `shell: false` 执行；管道、重定向等 shell 语义会被拒绝。只有显式传入 `--allow-shell` 才会使用 shell，且会把完整命令写到 stderr。即使如此，它们仍属于本机受信配置，不应写入从网络复制的未知命令。

Kimi 与 Grok 的 OAuth 续期默认只会在原凭据通过关键字段校验后回写；写前保留 `.bak`，并可分别用 `KIMI_USAGE_WRITE_BACK=off`、`GROK_USAGE_WRITE_BACK=off` 或脚本的 `--no-write-back` 禁止回写。

setup-statusline.js 会：

- 拒绝静默覆盖不属于本项目的 statusLine
- 在覆盖现有配置前强制创建备份
- 使用临时文件和原子 rename 写入 JSON
- 在备份或写入失败时停止

快捷方式安装器只覆盖或删除目标、参数均指向本仓库启动器的快捷方式。

## 不要提交

不要提交 `.agents/`、`.claude/`、`.codex/`、`.grok/`、`.kimi-code/`、Claude/Codex 本地缓存、Claude 设置、config.json、`*.db*`、截图中的私有信息、token、API key、密码或其他凭据。

## 报告问题

发现安全问题时，请使用 GitHub Private Security Advisory 或直接联系维护者，不要在公开 issue 中粘贴敏感日志。
