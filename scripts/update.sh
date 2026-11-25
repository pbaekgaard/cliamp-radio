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

# yt-dlp has to keep up with YouTube's constantly changing player JS — a
# months-old copy starts failing with "n challenge solving failed" / "The
# page needs to be reloaded". Upgrade it on every update. Best-effort: a
# failure here never blocks the rest of the update.
upgrade_ytdlp() {
  local bin py
  bin=$(command -v yt-dlp 2>/dev/null) || { echo "    yt-dlp not found on PATH; skipping"; return 0; }
  if command -v pipx >/dev/null 2>&1 && pipx list --short 2>/dev/null | grep -q '^yt-dlp '; then
    pipx upgrade yt-dlp && return 0
  fi
  py=$(head -n1 "$bin" | sed -n 's/^#!\s*//p' | awk '{print $1}')
  if [[ -n "$py" && "$py" == *python* && -x "$py" ]]; then
    # yt-dlp[default] also pulls in yt-dlp-ejs, the bundled YouTube challenge solver.
    "$py" -m pip install --quiet --upgrade "yt-dlp[default]" && return 0
    # A --user install on a PEP 668 ("externally managed") distro only
    # touches ~/.local, never system packages, so this override is safe there.
    if [[ "$bin" == "$HOME/.local/"* ]]; then
      "$py" -m pip install --quiet --user --break-system-packages --upgrade "yt-dlp[default]" && return 0
    fi
  fi
  yt-dlp -U && return 0
  return 1
}

echo "==> Upgrading yt-dlp"
if upgrade_ytdlp; then
  echo "    yt-dlp is now $(yt-dlp --version 2>/dev/null || echo unknown)"
else
  echo "==> WARNING: couldn't upgrade yt-dlp automatically — upgrade it by hand (e.g. 'pip install -U \"yt-dlp[default]\"')." >&2
fi

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
