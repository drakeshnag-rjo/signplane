#!/usr/bin/env bash
# reset-demo.sh — one-command clean slate for a demo (macOS / Linux).
# Stops Signplane + the AWS emulator, wipes demo data, restarts both,
# and opens the dashboard. Windows equivalent: reset-demo.ps1
set -euo pipefail
cd "$(dirname "$0")"

echo "Resetting Signplane demo environment..."

for port in 4820 5000; do
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  stopping process(es) on port $port"
    kill -9 $pids 2>/dev/null || true
  fi
done

if [ -d data ]; then
  rm -rf data
  echo "  cleared data/ (agents, intents, evidence ledger)"
fi

PY="$(command -v python3 || command -v python)"

echo "Starting AWS emulator (moto) on :5000..."
nohup "$PY" -m moto.server -p 5000 > /tmp/signplane-moto.log 2>&1 &

sleep 1
echo "Starting Signplane on :4820..."
nohup node server.js > /tmp/signplane-server.log 2>&1 &

sleep 2
URL="http://localhost:4820"
if command -v open >/dev/null 2>&1; then open "$URL"          # macOS
elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" # Linux desktop
else echo "Dashboard: $URL"
fi

echo "Ready. Dashboard is open, mode is OBSERVE, ledger is empty."
echo "Logs: /tmp/signplane-server.log · /tmp/signplane-moto.log"
