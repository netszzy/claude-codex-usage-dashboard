#!/usr/bin/env bash
set -euo pipefail

LABEL="com.local.claude-codex-usage-dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_VALUE="$(id -u)"

launchctl bootout "gui/$UID_VALUE" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl remove "$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "Removed macOS LaunchAgent:"
echo "  $PLIST_PATH"
