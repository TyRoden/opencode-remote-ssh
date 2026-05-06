#!/usr/bin/env bash

ACTION="${1:-start}"
TOKEN_FILE="${TOKEN_FILE:-/tmp/opencode-test-token}"
STATE_DIR="${STATE_DIR:-/tmp/opencode-test-state}"
LOG_FILE="${LOG_FILE:-/tmp/opencode-test-stub.log}"
PORT="${PORT:-39217}"

mkdir -p "$STATE_DIR"/{workspaces,sessions,approvals}

case "$ACTION" in
    start)
        if [ ! -f "$TOKEN_FILE" ]; then
            printf '%s' "$(openssl rand -hex 24)" > "$TOKEN_FILE"
        fi

        if pgrep -f "opencode-remote-stub" >/dev/null 2>&1; then
            echo "Stub already running"
            exit 0
        fi

        echo "Starting stub on port $PORT..."
        nohup /mnt/ai/opencode-remote/stub/bin/opencode-remote-stub \
            --listen "127.0.0.1:$PORT" \
            --token-file "$TOKEN_FILE" \
            --state-dir "$STATE_DIR" \
            --log-file "$LOG_FILE" \
            >/dev/null 2>&1 &

        sleep 1

        if pgrep -f "opencode-remote-stub" >/dev/null 2>&1; then
            echo "Stub started"
        else
            echo "ERROR: Stub failed to start"
            exit 1
        fi
        ;;

    stop)
        echo "Stopping stub..."
        pkill -f "opencode-remote-stub" 2>/dev/null || true
        ;;

    status)
        if pgrep -f "opencode-remote-stub" >/dev/null 2>&1; then
            echo "Running"
        else
            echo "Not running"
        fi
        ;;

    test)
        TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || echo "")
        if [ -z "$TOKEN" ]; then
            echo "ERROR: No token found"
            exit 1
        fi
        echo "Testing health endpoint..."
        curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/global/health"
        echo ""
        echo ""
        echo "Testing workspace adaptor..."
        curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/experimental/workspace/adaptor"
        echo ""
        ;;

    *)
        echo "Usage: $0 [start|stop|status|test]"
        ;;
esac