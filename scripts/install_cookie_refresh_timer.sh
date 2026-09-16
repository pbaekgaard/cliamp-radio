#!/usr/bin/env bash
# One-time installer: sets up a systemd timer that periodically runs
# scripts/cookie-refresh/refresh.ts to keep a real, signed-in Google Chrome
# session warm (see scripts/cookie-refresh/refresh.ts and README.md for the
# full explanation). This is entirely separate from the main cliamp-radio
# service/timer — it's only needed if you're using
# YTDLP_COOKIES_FROM_BROWSER for YouTube-playlist stations.
#
# You must run `bun run login` in scripts/cookie-refresh/ (over ssh -X or a
# VNC session) to sign in ONCE before this timer will do anything useful —
# see README.md.
#
# Usage:
#   sudo ./scripts/install_cookie_refresh_timer.sh                # infers the service user
#   sudo ./scripts/install_cookie_refresh_timer.sh someuser        # explicit service user
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COOKIE_REFRESH_DIR="${REPO_DIR}/scripts/cookie-refresh"
SERVICE_PATH="/etc/systemd/system/cliamp-radio-cookie-refresh.service"
TIMER_PATH="/etc/systemd/system/cliamp-radio-cookie-refresh.timer"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs root to write unit files and manage systemd. Re-running with sudo…"
  exec sudo -E "$0" "$@"
fi

SERVICE_USER="${1:-}"
if [ -z "$SERVICE_USER" ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  SERVICE_USER="$SUDO_USER"
fi
if [ -z "$SERVICE_USER" ]; then
  REPO_OWNER="$(stat -c '%U' "$REPO_DIR")"
  if [ "$REPO_OWNER" != "root" ]; then
    SERVICE_USER="$REPO_OWNER"
  fi
fi
if [ -z "$SERVICE_USER" ] || [ "$SERVICE_USER" = "root" ]; then
  echo "Couldn't determine a non-root user to run this as." >&2
  echo "Re-run with the username explicitly, e.g.:" >&2
  echo "    sudo $0 ubuntu" >&2
  exit 1
fi

SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)

BUN_BIN="$(sudo -u "$SERVICE_USER" bash -lc 'command -v bun' 2>/dev/null || true)"
if [ -z "$BUN_BIN" ] && [ -x "${SERVICE_HOME}/.bun/bin/bun" ]; then
  BUN_BIN="${SERVICE_HOME}/.bun/bin/bun"
fi
if [ -z "$BUN_BIN" ]; then
  echo "Could not find a 'bun' binary for user ${SERVICE_USER}. Install it first: https://bun.sh" >&2
  exit 1
fi

if ! command -v google-chrome >/dev/null 2>&1 && ! command -v google-chrome-stable >/dev/null 2>&1 \
   && ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 \
   && [ ! -e /snap/bin/chromium ]; then
  echo "==> WARNING: couldn't find Chrome or Chromium on PATH."
  echo "    Install one first — see README.md (Google Chrome on x86_64, Chromium on ARM)."
fi

echo "==> Repo:    ${REPO_DIR}"
echo "==> User:    ${SERVICE_USER}"
echo "==> Bun:     ${BUN_BIN}"

echo "==> Installing scripts/cookie-refresh dependencies"
sudo -u "$SERVICE_USER" bash -lc "cd '${COOKIE_REFRESH_DIR}' && '${BUN_BIN}' install"

echo "==> Writing ${SERVICE_PATH}"
cat > "$SERVICE_PATH" << EOF
[Unit]
Description=cliamp-radio YouTube cookie keep-alive (visits youtube.com in a real signed-in Chrome profile)

[Service]
Type=oneshot
User=${SERVICE_USER}
WorkingDirectory=${COOKIE_REFRESH_DIR}
ExecStart=${BUN_BIN} run refresh.ts
EOF

echo "==> Writing ${TIMER_PATH}"
cat > "$TIMER_PATH" << EOF
[Unit]
Description=Run cliamp-radio-cookie-refresh periodically

[Timer]
# Every 12 hours, plus up to an hour of random jitter so the visit doesn't
# happen at a suspiciously exact, predictable interval.
OnBootSec=10min
OnUnitActiveSec=12h
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now cliamp-radio-cookie-refresh.timer

echo "==> Done. Status:"
systemctl status cliamp-radio-cookie-refresh.timer --no-pager || true
echo
echo "==> IMPORTANT: this only keeps a session warm once you've logged in ONCE. If you haven't yet:"
echo "    cd ${COOKIE_REFRESH_DIR} && ${BUN_BIN} run login   (needs ssh -X or a VNC session — see README.md)"
