#!/usr/bin/env bash
# Pulls the latest release from GitHub, rebuilds, and restarts the service in place.
# Invoked by the web UI's "Install update" button, or run manually.
set -euo pipefail

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

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet cliamp-radio 2>/dev/null; then
  echo "==> Restarting cliamp-radio systemd service"
  sudo systemctl restart cliamp-radio
else
  echo "==> No active systemd service detected; restart the process manually to apply the update."
fi

echo "==> Update complete: now on ${LATEST_TAG}"
