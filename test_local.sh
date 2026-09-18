#!/usr/bin/env bash
# Runs the cliamp-radio server and client dev server together for local
# testing. Ctrl+C (or closing this script) stops both.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

SERVER_PID=""
CLIENT_PID=""

cleanup() {
  echo
  echo "Stopping…"
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$CLIENT_PID" ]] && kill -0 "$CLIENT_PID" 2>/dev/null; then
    kill "$CLIENT_PID" 2>/dev/null || true
  fi
  wait "$SERVER_PID" "$CLIENT_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting server (server/)…"
(cd server && bun run dev) &
SERVER_PID=$!

echo "Starting client (client/)…"
(cd client && bun run dev) &
CLIENT_PID=$!

echo
echo "Server PID: $SERVER_PID · Client PID: $CLIENT_PID"
echo "Press Ctrl+C to stop both."

wait -n "$SERVER_PID" "$CLIENT_PID"
