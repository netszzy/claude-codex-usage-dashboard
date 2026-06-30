#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Configuring Claude Code statusLine for this dashboard..."
echo

node setup-statusline.js "$@"
