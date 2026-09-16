#!/usr/bin/env bash
# One-time installer: sets up cliamp-radio as a systemd service that starts
# on boot and restarts on failure. Safe to re-run (it updates the unit file
# in place and reloads systemd), but you only need to run it once per host.
#
# The generated unit file lives in /etc/systemd/system/ — completely outside
# this git repo — so `git pull` / the in-app "Install update" button never
# touches or resets it. It persists across every future update.
#
# Usage:
#   sudo ./scripts/install_systemd.sh                # infers the service user
#   sudo ./scripts/install_systemd.sh someuser        # explicit service user
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_PATH="/etc/systemd/system/cliamp-radio.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "This script needs root to write ${UNIT_PATH} and manage systemd. Re-running with sudo…"
  exec sudo -E "$0" "$@"
fi

# Figure out which non-root user should own/run the service. Preference order:
# explicit arg > $SUDO_USER (set by `sudo`, may or may not survive `sudo su`)
# > the owner of this repo checkout.
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
  echo "Couldn't determine a non-root user to run cliamp-radio as." >&2
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

echo "==> Repo:    ${REPO_DIR}"
echo "==> User:    ${SERVICE_USER}"
echo "==> Bun:     ${BUN_BIN}"

echo "==> Building the client for production"
sudo -u "$SERVICE_USER" bash -lc "cd '${REPO_DIR}/server' && '${BUN_BIN}' install"
sudo -u "$SERVICE_USER" bash -lc "cd '${REPO_DIR}/client' && '${BUN_BIN}' install && '${BUN_BIN}' run build"

echo "==> Writing ${UNIT_PATH}"
cat > "$UNIT_PATH" << EOF
[Unit]
Description=cliamp-radio web service
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${REPO_DIR}/server
ExecStart=${BUN_BIN} run index.ts
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
# The app listens on 8000 by default; put Caddy (or another reverse proxy) in
# front of it on 80/443 for TLS — see deploy/Caddyfile and the README.
# ADMIN_USERNAME/ADMIN_PASSWORD_HASH are only consulted on first boot, before
# server/data/admin-credentials.json exists — usually leave these unset and
# use the forced "changeme" -> new password flow instead.
# Environment=ADMIN_USERNAME=admin
# Environment=ADMIN_PASSWORD_HASH=...
# Environment=JWT_SECRET=change-me-to-something-random
# Environment=APP_VERSION=1.0.0
# Environment=GITHUB_REPO=pbaekgaard/cliamp-radio
# If YouTube starts blocking this server with "Sign in to confirm you're not
# a bot" for playlist-backed stations, point this at a cookies.txt exported
# from a real, signed-in YouTube session — see README.md for how to export
# and where to put it.
# Environment=YTDLP_COOKIES_FILE=${REPO_DIR}/server/data/youtube-cookies.txt

[Install]
WantedBy=multi-user.target
EOF

echo "==> Allowing ${SERVICE_USER} to restart this service without a password"
echo "    (needed for the in-app 'Install update' button)"
SUDOERS_PATH="/etc/sudoers.d/cliamp-radio"
echo "${SERVICE_USER} ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart cliamp-radio" > "$SUDOERS_PATH"
chmod 440 "$SUDOERS_PATH"
visudo -c -f "$SUDOERS_PATH" >/dev/null || {
  echo "Generated sudoers file failed validation — removing it." >&2
  rm -f "$SUDOERS_PATH"
  exit 1
}

echo "==> Enabling and starting cliamp-radio"
systemctl daemon-reload
systemctl enable --now cliamp-radio

echo
echo "==> Done. Status:"
systemctl status cliamp-radio --no-pager || true
echo
echo "Next: put a reverse proxy (see deploy/Caddyfile) in front of port 8000 for HTTPS,"
echo "and set JWT_SECRET (uncomment + edit ${UNIT_PATH}, then: systemctl daemon-reload && systemctl restart cliamp-radio)."
