#!/usr/bin/env bash
# Claude Code Tool Proxy v2.1 - Linux/Mac launcher.  Usage: ./start.sh [claude args]
PORT="${PORT:-8082}"
DIR="$(cd "$(dirname "$0")" && pwd)"
export PORT
if lsof -ti:"$PORT" &>/dev/null; then lsof -ti:"$PORT" | xargs kill -9 2>/dev/null; sleep 0.5; fi
node "$DIR/alias-proxy.js" & PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null' EXIT
for _ in $(seq 1 25); do sleep 0.3; curl -sf "http://127.0.0.1:$PORT/health" &>/dev/null && READY=1 && break; done
[ -z "$READY" ] && { echo "proxy did not start"; exit 1; }
export ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT"
claude "$@"
