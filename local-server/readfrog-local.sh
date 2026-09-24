#!/usr/bin/env bash
# One entry point for the Read Frog local subtitle service.
#
#   ./readfrog-local.sh setup      install dependencies into ./.venv and download the model
#   ./readfrog-local.sh run        run in the foreground (Ctrl-C to stop)
#   ./readfrog-local.sh start      run in the background and start at login (launchd)
#   ./readfrog-local.sh stop       stop and disable start at login
#   ./readfrog-local.sh status     show whether the service answers
#   ./readfrog-local.sh logs       follow the service log
set -euo pipefail
cd "$(dirname "$0")"

LABEL="app.readfrog.local-server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/ReadFrogLocal"
PORT="${READ_FROG_LOCAL_PORT:-8765}"

need_uv() {
  command -v uv >/dev/null || {
    echo "uv is required: https://docs.astral.sh/uv/ (brew install uv)" >&2
    exit 1
  }
}

setup() {
  need_uv
  uv sync --python 3.13
  uv run --python 3.13 server.py --warmup
}

run() {
  need_uv
  exec uv run --python 3.13 server.py --port "$PORT"
}

start() {
  need_uv
  [[ -d .venv ]] || setup
  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v uv)</string><string>run</string><string>--python</string><string>3.13</string>
    <string>server.py</string><string>--port</string><string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$PWD</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Started. It will also start at login. Waiting for it to answer..."
  for _ in $(seq 1 30); do
    if status >/dev/null 2>&1; then status; return; fi
    sleep 1
  done
  echo "Not answering yet; check: $0 logs" >&2
}

stop() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Stopped and removed from login items."
}

status() {
  curl -fsS "http://127.0.0.1:$PORT/health" && echo
}

logs() {
  tail -f "$LOG_DIR/server.log"
}

case "${1:-}" in
  setup | run | start | stop | status | logs) "$1" ;;
  *)
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
