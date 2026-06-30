# Claude / Codex Usage Dashboard

An unofficial local dashboard for Claude Code, Codex, and Antigravity usage limits.

The default app is a Windows floating desktop window. The same local server also keeps the KOBO / e-ink routes from the LAN build for small screens that need server-rendered HTML.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-767FC6)
![Node](https://img.shields.io/badge/node-%3E%3D18-43853D)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Features

- Shows Claude Code and Codex usage for the 5-hour and weekly windows.
- Shows Antigravity 5-hour and weekly quota usage percentages in the desktop floating window.
- Reads Claude Code usage through a local `statusLine` cache.
- Reads Codex usage from the newest local `~/.codex/sessions` `rate_limits` snapshot.
- Reads Antigravity quota usage from the local Antigravity CLI gRPC server.
- Starts as a frameless always-on-top Windows desktop floating window.
- Provides Windows startup and desktop shortcuts for the floating window.
- Keeps server-rendered KOBO / e-ink pages at `/k`, `/u`, and `/kobo`.
- Supports macOS helper scripts for the server/LAN mode.
- Turns red when usage reaches the alert threshold.

## Important Limitations

Usage numbers only update after you actually use Claude Code, Codex, or Antigravity.

Claude Code usage comes from `statusLine`, so opening Claude in the web app or desktop app will not update this dashboard. Codex usage is read from local Codex session files, so it updates only after Codex writes new session data. Antigravity quota usage depends on the local Antigravity CLI process exposing its gRPC language server.

This project is not affiliated with Anthropic, OpenAI, or Google. It does not include official logos. Make sure your own use of third-party names, trademarks, and local tool output formats follows the relevant terms.

This is a personal side project. Support is best-effort.

## Requirements

- Windows 10/11 for the floating desktop window
- Windows 10/11 or macOS for server / KOBO mode
- Node.js 18 or newer
- Claude Code, with `statusLine` configured for real Claude usage
- Codex, with local `~/.codex/sessions` data
- Antigravity CLI running locally if you want Antigravity quota percentages

Check Node.js:

```bash
node -v
```

## Quick Start: Floating Desktop Window

```powershell
git clone https://github.com/frankchiu-dev/claude-codex-usage-dashboard.git
cd claude-codex-usage-dashboard
npm install
npm start
```

The floating desktop window should open automatically. The normal root web page is intentionally disabled in this desktop build; start the app with `npm start` or `start-dashboard.bat`.

## Windows Floating Dashboard

Start the dashboard as a real floating desktop window:

```powershell
npm start
```

Or run directly from a batch script:

```text
start-dashboard.bat
```

This mode starts the local Node server in the background if needed and opens a desktop overlay window that stays on top of the desktop.

Install startup and desktop shortcuts:

```powershell
install-desktop-autostart.bat
```

Remove startup and desktop shortcuts:

```powershell
uninstall-desktop-autostart.bat
```

Desktop right-click menu:

- Reload
- Toggle DevTools
- Exit

## Server / KOBO / E-ink Mode

Run the local server directly when you need KOBO / e-ink routes or LAN access:

```bash
npm run start:server
```

Shortest URL for remaining percentage:

```text
http://YOUR-LAN-IP:8787/k
```

Shortest URL for used percentage:

```text
http://YOUR-LAN-IP:8787/u
```

Long URLs also work:

```text
http://YOUR-LAN-IP:8787/kobo?mode=remaining
http://YOUR-LAN-IP:8787/kobo?mode=used
```

`/eink`, `/e`, `/r`, `/kr`, and `/ku` are aliases. The KOBO page is rendered on the server, so it does not require JavaScript and refreshes with a simple `<meta refresh>` tag.

To expose the server to another device on your LAN, start it with `HOST=0.0.0.0`.

## Start Scripts

### Windows

```powershell
.\start-dashboard.bat
```

### macOS server mode

```bash
chmod +x ./start-dashboard.sh ./start-dashboard.command
./start-dashboard.sh
```

You can also double-click `start-dashboard.command` in Finder after making it executable.

## Configure Claude Code Usage

This step lets the dashboard show real Claude Code usage.

### Windows

```powershell
.\setup-claude-statusline.bat
```

### macOS

```bash
chmod +x ./setup-claude-statusline.sh
./setup-claude-statusline.sh
```

Then:

1. Fully quit Claude Code.
2. Open Claude Code again.
3. Send one message.
4. Refresh the dashboard.

The Claude card will start reading `~/.claude/usage-cache.json`.

## If You Already Have a statusLine

Claude Code supports one `statusLine.command` at a time. If you already use another statusLine script, such as a Stream Deck integration or a custom prompt status line, use fanout mode.

Copy the example config.

### Windows

```powershell
Copy-Item .\config.example.json .\config.json
```

### macOS

```bash
cp ./config.example.json ./config.json
```

Edit `config.json`.

Windows example:

```json
{
  "extraStatuslineCommand": "powershell -NoProfile -ExecutionPolicy Bypass -File \"%USERPROFILE%\\.claude\\your-existing-statusline.ps1\""
}
```

macOS example:

```json
{
  "extraStatuslineCommand": "/Users/YOUR_NAME/.claude/your-existing-statusline.sh"
}
```

Then enable fanout mode.

### Windows

```powershell
.\setup-claude-statusline.bat --fanout
```

### macOS

```bash
./setup-claude-statusline.sh --fanout
```

This sends the same Claude Code statusLine JSON to both this dashboard and your existing command.

## Start Automatically on Login

### Windows floating desktop window

Install autostart and desktop shortcut:

```powershell
.\install-desktop-autostart.bat
```

Remove autostart and desktop shortcut:

```powershell
.\uninstall-desktop-autostart.bat
```

### macOS server mode

Install a LaunchAgent:

```bash
chmod +x ./install-autostart-macos.sh ./uninstall-autostart-macos.sh
./install-autostart-macos.sh
```

Remove the LaunchAgent:

```bash
./uninstall-autostart-macos.sh
```

The macOS LaunchAgent writes logs to:

```text
~/Library/Logs/claude-codex-usage-dashboard.log
~/Library/Logs/claude-codex-usage-dashboard.err.log
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Dashboard port |
| `HOST` | `127.0.0.1` | Local service host. Use `0.0.0.0` for LAN / KOBO access |
| `ALERT_PERCENT` | `85` | Usage percentage that turns the dashboard red |
| `DISPLAY_MODE` | `used` | KOBO/server display mode: `used` percentage or `remaining` percentage |
| `KOBO_REFRESH_SECONDS` | `60` | Refresh interval for `/kobo`; minimum rendered value is 15 seconds |
| `CODEX_LOOKBACK_DAYS` | `14` | How many days of Codex sessions to scan |
| `CLAUDE_USAGE_CACHE` | `~/.claude/usage-cache.json` | Claude usage cache path |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex sessions path |
| `ANTIGRAVITY_LOG_DIR` | `~/.gemini/antigravity-cli/log` | Antigravity CLI log directory, used to discover the local gRPC port |
| `ANTIGRAVITY_SETTINGS` | `~/.gemini/antigravity-cli/settings.json` | Antigravity CLI settings path |
| `ANTIGRAVITY_STALE_MINUTES` | `120` | Marks Antigravity quota data as stale after this many minutes |
| `EXTRA_STATUSLINE_COMMAND` | empty | Extra command for fanout mode |

Windows server example:

```powershell
$env:PORT="8790"
$env:HOST="0.0.0.0"
$env:DISPLAY_MODE="remaining"
$env:KOBO_REFRESH_SECONDS="120"
npm run start:server
```

macOS server example:

```bash
PORT=8790 HOST=0.0.0.0 DISPLAY_MODE=remaining KOBO_REFRESH_SECONDS=120 npm run start:server
```

`DISPLAY_MODE=used` shows how much of the limit has been used. `DISPLAY_MODE=remaining` shows how much is left. The red alert color is still based on used percentage reaching `ALERT_PERCENT`.

## Network Access

If another device cannot connect, make sure it is on the same Wi-Fi network as the computer running the dashboard.

### Windows Firewall

```powershell
netsh advfirewall firewall add rule name="AIUsageDashboard" dir=in action=allow protocol=TCP localport=8787
```

### macOS Firewall

macOS may ask whether Node.js can accept incoming network connections. Allow it if you want to open the dashboard from a phone, tablet, or KOBO.

## Privacy

Data stays on your machine. The server reads local Claude, Codex, and Antigravity usage records, but does not upload them anywhere.

Do not commit:

- `~/.claude/usage-cache.json`
- `~/.codex/sessions`
- `~/.claude/settings.json`
- `~/.gemini/antigravity-cli`
- `config.json`

## Uploading to GitHub

See [GITHUB_UPLOAD_GUIDE.md](GITHUB_UPLOAD_GUIDE.md) for a first-time step-by-step guide.

## License

MIT
