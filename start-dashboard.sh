#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Starting Claude / Codex usage dashboard..."
echo
echo "Optional environment variables:"
echo "  PORT=8787 HOST=0.0.0.0 ALERT_PERCENT=85 DISPLAY_MODE=used CODEX_LOOKBACK_DAYS=14"
echo

exec node server.js
