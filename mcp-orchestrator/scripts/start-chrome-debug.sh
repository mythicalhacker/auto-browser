#!/usr/bin/env bash
# Start the dedicated debug Chrome for the MCP orchestrator (macOS/Linux).
# Usually unnecessary: the server auto-launches Chrome on first connect
# (disable with AUTO_LAUNCH_CHROME=0).
set -euo pipefail

PROFILE="${CHROME_USER_DATA:-$HOME/.auto-browser/chrome-profile}"
# CDP_PORT is script-local; the server itself reads the full CDP_URL env var.
# Keep them consistent if you change either.
PORT="${CDP_PORT:-9222}"

case "$(uname -s)" in
  Darwin) DEFAULT_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ;;
  *)      DEFAULT_CHROME="$(command -v google-chrome || command -v chromium-browser || echo /usr/bin/google-chrome)" ;;
esac
CHROME="${CHROME_PATH:-$DEFAULT_CHROME}"

mkdir -p "$PROFILE"
exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check
