#!/bin/sh
set -eu

ENDPOINT="http://127.0.0.1:18795/api/health/live"
LISTEN_ADDRESS="127.0.0.1:18795"

if curl -fsS --max-time 8 "$ENDPOINT" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  exit 0
fi

if ss -ltn | awk '{print $4}' | grep -Fxq "$LISTEN_ADDRESS"; then
  logger -t navigator-tunnel-watchdog "bridge listener is unhealthy; recycling restricted tunnel session"
  pkill -TERM -u navigator-tunnel -f 'sshd: navigator-tunnel' 2>/dev/null || true
fi
