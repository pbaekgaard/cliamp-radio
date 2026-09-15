#!/usr/bin/env bash
# Starts cliamp-radio for local development: the Bun API/server and the
# Vite dev server for the client, both in one terminal.
#
# Usage:
#   ./start.sh            # dev mode (client dev server + backend, hot reload)
#   ./start.sh --prod     # production mode (build client once, serve everything from the Bun server)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

command -v bun >/dev/null 2>&1 || {
  echo "bun is required but not found. Install it from https://bun.sh" >&2
  exit 1
}

MODE="${1:-dev}"
[ "$MODE" = "--prod" ] && MODE="prod"

echo "==> Installing server dependencies"
(cd server && bun install)

echo "==> Installing client dependencies"
(cd client && bun install)

if [ "$MODE" = "prod" ]; then
  echo "==> Building client for production"
  (cd client && bun run build)

  echo "==> Starting server (serving API + built client) on http://localhost:${PORT:-8000}"
  if [ "${PORT:-8000}" -lt 1024 ] && [ "$(id -u)" -ne 0 ]; then
    echo "    PORT ${PORT} is a privileged port — you may need 'sudo PORT=${PORT} ./start.sh --prod'"
    echo "    or grant the bun binary CAP_NET_BIND_SERVICE (see README) to avoid running as root."
  fi
  cd server && exec bun run start
fi

# --- dev mode: run both processes, forward signals, clean up on exit ---
cleanup() {
  echo
  echo "==> Shutting down"
  jobs -p | xargs -r kill 2>/dev/null
}
trap cleanup EXIT INT TERM

echo "==> Starting backend on http://localhost:${PORT:-8000}"
(cd server && bun run dev) &

echo "==> Starting client dev server (proxies /api and /cliamp-radio to the backend)"
(cd client && bun run dev) &

wait
