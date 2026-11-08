#!/usr/bin/env bash
# Starts the API and the web app together. Stop both with Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "No .env found. Run: cp .env.example .env, then fill it in."; exit 1; }
set -a; . ./.env; set +a

# A server left over from an earlier run (for example an API whose auto-reload
# worker crashed) can keep a port and never answer, so the app hangs on load.
# Refuse to start until both ports are free, and say what holds them.
port_free() {
  local port=$1 name=$2 pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ' ' || true)
  if [ -n "${pids// /}" ]; then
    echo "Port $port for the $name is already in use:"
    ps -o pid=,command= -p "$(echo $pids | tr ' ' ',')" | sed 's/^/  /'
    echo "Stop it, then run this script again:  kill $pids"
    exit 1
  fi
}
if command -v lsof >/dev/null; then
  port_free "${API_PORT:-8000}" "API"
  port_free "${WEB_PORT:-3000}" "web app"
fi

(cd backend && uv sync)
[ -d frontend/node_modules ] || (cd frontend && npm ci)

trap 'trap - EXIT; kill 0' EXIT INT TERM
(cd backend && uv run uvicorn app.main:app --reload --port "${API_PORT:-8000}") &
cd frontend && PORT="${WEB_PORT:-3000}" npm run dev
