#!/usr/bin/env bash
# Pulls the latest release from GitHub, rebuilds, and restarts the service in place.
# Invoked by the web UI's "Install update" button, or run manually.
set -euo pipefail

# When this is spawned from the systemd-managed server process, PATH is
# whatever systemd gave the service — which usually does NOT include
# ~/.bun/bin. Make sure bun is findable regardless of how we got invoked.
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "==> ERROR: 'bun' not found on PATH (checked \$HOME/.bun/bin, /usr/local/bin, /usr/bin, /bin)." >&2
  echo "    HOME=${HOME:-<unset>} PATH=${PATH}" >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Fetching latest tags from origin"
git fetch --tags origin

LATEST_TAG=$(git describe --tags "$(git rev-list --tags --max-count=1)")
echo "==> Latest tag is ${LATEST_TAG}"

echo "==> Checking out ${LATEST_TAG}"
git checkout "${LATEST_TAG}"

echo "==> Installing server dependencies"
(cd server && bun install --frozen-lockfile)

echo "==> Installing and building client"
(cd client && bun install --frozen-lockfile && bun run build)

# NOTE: we deliberately do NOT restart the service here. This script is run
# by the very server process it would be restarting (spawned from the web
# UI's "Install update" button), so killing it now would drop the HTTP
# connection before the client ever sees the result (a 502 with no body).
# The server schedules the actual restart itself, a moment after it has
# finished sending this script's log back to the client. See
# server/lib/update.ts / the SKIP_RESTART env var below.
if [ "${SKIP_RESTART:-}" = "1" ]; then
  echo "==> Skipping restart here; the server will restart itself after responding to the request."
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet cliamp-radio 2>/dev/null; then
  echo "==> Restarting cliamp-radio systemd service"
  sudo systemctl restart cliamp-radio
else
  echo "==> No active systemd service detected; restart the process manually to apply the update."
fi

echo "==> Update complete: now on ${LATEST_TAG}"
