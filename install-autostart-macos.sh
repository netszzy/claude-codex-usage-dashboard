#!/usr/bin/env bash
set -euo pipefail

LABEL="com.local.claude-codex-usage-dashboard"
DASHBOARD_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node || true)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
UID_VALUE="$(id -u)"

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js was not found in PATH."
  echo "Install Node.js first, then run this script again."
  exit 1
fi

xml_escape() {
  printf '%s' "$1" \
    | sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

mkdir -p "$PLIST_DIR" "$LOG_DIR"

NODE_BIN_XML="$(xml_escape "$NODE_BIN")"
DASHBOARD_DIR_XML="$(xml_escape "$DASHBOARD_DIR")"
STDOUT_XML="$(xml_escape "$LOG_DIR/claude-codex-usage-dashboard.log")"
STDERR_XML="$(xml_escape "$LOG_DIR/claude-codex-usage-dashboard.err.log")"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN_XML</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DASHBOARD_DIR_XML</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$STDOUT_XML</string>
  <key>StandardErrorPath</key>
  <string>$STDERR_XML</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_VALUE" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$UID_VALUE" "$PLIST_PATH"
launchctl kickstart -k "gui/$UID_VALUE/$LABEL" >/dev/null 2>&1 || true

echo "Installed macOS LaunchAgent:"
echo "  $PLIST_PATH"
echo
echo "The dashboard will start automatically when you log in."
echo "Logs:"
echo "  $LOG_DIR/claude-codex-usage-dashboard.log"
echo "  $LOG_DIR/claude-codex-usage-dashboard.err.log"
