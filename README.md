# Claude / Codex Usage Dashboard

An unofficial local floating desktop dashboard for viewing Claude Code and Codex usage limits.

The desktop window runs on your Windows machine, reads local usage data, and uses a localhost-only internal service.

![Status](https://img.shields.io/badge/platform-Windows-767FC6)
![Node](https://img.shields.io/badge/node-%3E%3D18-43853D)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

- Shows Claude Code and Codex usage for the 5-hour and weekly windows.
- Reads Claude Code usage through a local `statusLine` cache.
- Reads Codex usage from the newest local `~/.codex/sessions` `rate_limits` snapshot.
- Reads Antigravity quota usage percentages from the local Antigravity CLI gRPC server.
- Starts as a frameless always-on-top desktop floating window.
- Provides startup and desktop shortcuts for the floating window.
- Turns red when usage reaches the alert threshold.
- Uses only Node.js built-in modules. No npm dependencies.

## Important Limitations

Usage numbers only update after you actually use Claude Code or Codex.

Claude Code usage comes from `statusLine`, so opening Claude in the web app or desktop app will not update this dashboard. Codex usage is read from local Codex session files, so it updates only after Codex writes new session data.

This project is not affiliated with Anthropic or OpenAI. It does not include official logos. Make sure your own use of third-party names, trademarks, and local tool output formats follows the relevant terms.

## Requirements

- Windows
- Node.js 18 or newer
- Claude Code, with `statusLine` configured for real Claude usage
- Codex, with local `~/.codex/sessions` data

Check Node.js:

```powershell
node -v
```

## Quick Start

```powershell
git clone https://github.com/YOUR_NAME/claude-codex-usage-dashboard.git
cd claude-codex-usage-dashboard
npm install
npm start
```

The floating desktop window should open automatically. The old standalone web page mode has been removed.

## Windows Floating Dashboard (Desktop Mode)

Start the dashboard as a real floating desktop window (frameless + always-on-top):

```powershell
npm install
npm start
```

Or run directly from a batch script:

```text
start-dashboard-desktop.bat
```

This mode starts the local Node server in the background (if not already running) and opens a desktop overlay window that stays on top of the desktop.

### 启动与自启

```powershell
npm start
install-desktop-autostart.bat   # 设置开机自启 + 桌面快捷方式（桌面悬浮版）
uninstall-desktop-autostart.bat # 取消开机自启并移除桌面快捷方式
```

桌面版右键菜单：
- Reload / 重载
- Toggle DevTools / 打开开发者工具
- Exit / 退出

## Configure Claude Code Usage

Run:

```powershell
.\setup-claude-statusline.bat
```

Then:

1. Fully quit Claude Code.
2. Open Claude Code again.
3. Send one message.
4. Refresh the dashboard.

The Claude card will start reading `~/.claude/usage-cache.json`.

## If You Already Have a statusLine

Claude Code supports one `statusLine.command` at a time. If you already use another statusLine script, such as a Stream Deck integration or a custom prompt status line, use fanout mode.

Copy the example config:

```powershell
Copy-Item .\config.example.json .\config.json
```

Edit `config.json`:

```json
{
  "extraStatuslineCommand": "powershell -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\\.claude\\your-existing-statusline.ps1\""
}
```

Then run:

```powershell
.\setup-claude-statusline.bat --fanout
```

This sends the same Claude Code statusLine JSON to both this dashboard and your existing command.

## Start Automatically on Login

Install autostart:

```powershell
.\install-autostart.bat
```

Remove autostart:

```powershell
.\uninstall-autostart.bat
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Dashboard port |
| `HOST` | `127.0.0.1` | Internal local service host |
| `ALERT_PERCENT` | `85` | Usage percentage that turns the dashboard red |
| `CODEX_LOOKBACK_DAYS` | `14` | How many days of Codex sessions to scan |
| `CLAUDE_USAGE_CACHE` | `~/.claude/usage-cache.json` | Claude usage cache path |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex sessions path |
| `ANTIGRAVITY_LOG_DIR` | `~/.gemini/antigravity-cli/log` | Antigravity CLI log directory, used to discover the local gRPC port |
| `ANTIGRAVITY_SETTINGS` | `~/.gemini/antigravity-cli/settings.json` | Antigravity CLI settings path |
| `ANTIGRAVITY_STALE_MINUTES` | `120` | Marks Antigravity quota data as stale after this many minutes |
| `EXTRA_STATUSLINE_COMMAND` | empty | Extra command for fanout mode |

Example:

```powershell
$env:PORT="8790"
$env:PORT="8790"
npm start
```

## Privacy

Data stays on your machine. The server reads local Claude and Codex usage records, but does not upload them anywhere.

Do not commit:

- `~/.claude/usage-cache.json`
- `~/.codex/sessions`
- `~/.claude/settings.json`
- `config.json`

## Uploading to GitHub

See [GITHUB_UPLOAD_GUIDE.md](GITHUB_UPLOAD_GUIDE.md) for a first-time step-by-step guide.

## License

MIT
