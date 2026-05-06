#!/usr/bin/env bash
set -e

usage() {
    echo "Usage: $0 <host> <user> [port] [identity-file]"
    echo ""
    echo "Set up a remote host for opencode-remote-ssh by:"
    echo "  1. Verifying SSH connectivity"
    echo "  2. Creating remote install directories"
    echo "  3. Uploading the Go stub binary"
    echo "  4. Generating an auth token"
    echo "  5. Starting the stub"
    echo ""
    echo "This script installs and starts the remote stub."
    echo "OpenCode still needs to connect through the plugin at runtime."
    echo ""
    echo "Example: $0 10.0.0.10 ops 22 ~/.ssh/id_ed25519"
    exit 1
}

if [ $# -lt 2 ]; then
    usage
fi

HOST="$1"
USER="$2"
PORT="${3:-22}"
IDENTITY="${4:-}"
IDENTITY_EXPANDED=""
CONTROL_SOCKET="/tmp/ssh-control-$HOST-$USER"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=$CONTROL_SOCKET -o ControlPersist=300 -p $PORT"
SCP_OPTS="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=$CONTROL_SOCKET -o ControlPersist=300 -P $PORT"

if [ -n "$IDENTITY" ]; then
    IDENTITY_EXPANDED="${IDENTITY/#\~/$HOME}"
    if [ -f "$IDENTITY_EXPANDED" ]; then
        SSH_OPTS="$SSH_OPTS -i $IDENTITY_EXPANDED"
        SCP_OPTS="$SCP_OPTS -i $IDENTITY_EXPANDED"
    else
        echo "Warning: identity file '$IDENTITY_EXPANDED' not found, ignoring"
        IDENTITY=""
        IDENTITY_EXPANDED=""
    fi
fi

if [ -z "$SSH_AUTH_SOCK" ] && [ -f "$HOME/.ssh-agent" ]; then
    # shellcheck disable=SC1090
    source "$HOME/.ssh-agent"
fi

if [ -z "$IDENTITY" ]; then
    IDENTITY="$HOME/.ssh/opencode-remote-$HOST"
    IDENTITY_EXPANDED="$IDENTITY"
    if [ ! -f "$IDENTITY_EXPANDED" ]; then
        echo "Generating dedicated SSH key for this host..."
        ssh-keygen -t ed25519 -f "$IDENTITY_EXPANDED" -N "" -C "opencode-remote-$HOST" >/dev/null 2>&1
        chmod 600 "$IDENTITY_EXPANDED"
    fi
    SSH_OPTS="$SSH_OPTS -i $IDENTITY_EXPANDED"
    SCP_OPTS="$SCP_OPTS -i $IDENTITY_EXPANDED"
fi

test_connection() {
    if [ -f "$IDENTITY_EXPANDED" ]; then
        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes -i "$IDENTITY_EXPANDED" -p "$PORT" "$USER@$HOST" "echo ok" 2>/dev/null && return 0
    fi
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes $SSH_OPTS "$USER@$HOST" "echo ok" 2>/dev/null
}

add_key_via_password() {
    echo "No SSH key works. Trying password authentication to add the generated key..."

    if ! command -v sshpass >/dev/null 2>&1; then
        echo ""
        echo "sshpass is not installed on this machine."
        echo "Add this public key to ~/.ssh/authorized_keys on $USER@$HOST, then rerun the script:"
        echo ""
        cat "${IDENTITY_EXPANDED}.pub"
        echo ""
        return 1
    fi

    echo -n "Enter password for $USER@$HOST: "
    read -r -s SSHPASS
    echo ""
    export SSHPASS

    if [ ! -f "${IDENTITY_EXPANDED}.pub" ]; then
        echo "ERROR: Public key not found at ${IDENTITY_EXPANDED}.pub"
        return 1
    fi

    PUBKEY=$(cat "${IDENTITY_EXPANDED}.pub")
    sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -p "$PORT" "$USER@$HOST" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\n' '$PUBKEY' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys" 2>/dev/null || {
        echo "Failed to add key via password"
        return 1
    }

    echo "Key added successfully. Retrying SSH..."
}

print_manual_key_install_steps() {
    local public_key
    public_key=$(cat "${IDENTITY_EXPANDED}.pub")

    echo ""
    echo "Alternative automated option:"
    echo "1. Install sshpass on your local machine."
    echo "2. Re-run this same setup command."
    echo "3. The script can then prompt for the remote password once and install the key automatically."
    echo ""
    echo "Manual setup steps:"
    echo "1. SSH to $USER@$HOST using your normal password-based login:"
    echo "   ssh -p $PORT $USER@$HOST"
    echo "2. On the remote host, run these commands exactly:"
    echo "   mkdir -p ~/.ssh"
    echo "   chmod 700 ~/.ssh"
    echo "   printf '%s\\n' '$public_key' >> ~/.ssh/authorized_keys"
    echo "   chmod 600 ~/.ssh/authorized_keys"
    echo "3. Exit the remote shell."
    echo "4. Re-run this setup command:"
    echo "   $0 $HOST $USER $PORT ${IDENTITY:-}"
    echo ""
    echo "Generated public key:"
    echo "$public_key"
    echo ""
    echo "Local public key file: ${IDENTITY_EXPANDED}.pub"
}

if ! test_connection >/dev/null 2>&1; then
    if add_key_via_password; then
        sleep 2
    else
        echo "ERROR: Could not authenticate to remote host automatically"
        echo "Please ensure you can connect to $USER@$HOST via SSH or install the generated public key manually."
        print_manual_key_install_steps
        exit 1
    fi
fi

ssh_cmd() {
    ssh $SSH_OPTS "$USER@$HOST" "$@"
}

start_stub_remote() {
    ssh_cmd "python2 - <<'PY' 2>/dev/null || python - <<'PY'
import subprocess
import time

null_in = open('/dev/null', 'rb')
null_out = open('/dev/null', 'ab')
cmd = [
    '$REMOTE_BASE/bin/opencode-remote-stub',
    '--listen', '127.0.0.1:39217',
    '--token-file', '$REMOTE_BASE/run/stub.token',
    '--state-dir', '$REMOTE_BASE/state',
    '--log-file', '$REMOTE_BASE/log/stub.log',
]
proc = subprocess.Popen(cmd, stdin=null_in, stdout=null_out, stderr=null_out, close_fds=True)
time.sleep(2)
import sys
sys.exit(0 if proc.poll() is None else 1)
PY"
}

cleanup() {
    rm -f "$CONTROL_SOCKET"
}
trap cleanup EXIT

echo "=== OpenCode Remote Host Setup ==="
echo "Host: $HOST"
echo "User: $USER"
echo "Port: $PORT"
echo "Identity: $IDENTITY_EXPANDED"
echo ""

echo "[1/6] Testing SSH connectivity..."
ssh_cmd "echo ok" >/dev/null
echo "OK"

echo "[2/6] Detecting remote platform..."
PLATFORM=$(ssh_cmd "uname -s")
ARCH=$(ssh_cmd "uname -m")
echo "Platform: $PLATFORM $ARCH"
if [ "$PLATFORM" != "Linux" ]; then
    echo "WARNING: Non-Linux platform detected. Only Linux is fully supported."
fi

REMOTE_HOME=$(ssh_cmd "printf '%s' \"\$HOME\"")
REMOTE_BASE="$REMOTE_HOME/.opencode-remote"

echo "[3/6] Creating remote directories..."
ssh_cmd "mkdir -p $REMOTE_BASE/bin $REMOTE_BASE/run $REMOTE_BASE/log $REMOTE_BASE/state"
echo "OK: $REMOTE_BASE"

echo "[4/6] Determining stub binary..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
STUB_BINARY="$PROJECT_ROOT/stub/bin/opencode-remote-stub"
if [ ! -f "$STUB_BINARY" ]; then
    echo "Stub binary not found at $STUB_BINARY"
    echo "Building stub..."
    (cd "$PROJECT_ROOT/stub" && go build -o "$STUB_BINARY" ./cmd)
fi

if [ ! -f "$STUB_BINARY" ]; then
    echo "ERROR: Cannot find or build stub binary"
    exit 1
fi
echo "Using stub: $STUB_BINARY"

echo "[5/6] Uploading stub binary..."
ssh_cmd "pkill -f 'opencode-remote-stub' 2>/dev/null || true"
scp $SCP_OPTS "$STUB_BINARY" "$USER@$HOST:$REMOTE_BASE/bin/opencode-remote-stub"
ssh_cmd "chmod +x $REMOTE_BASE/bin/opencode-remote-stub"
echo "OK"

echo "[6/6] Generating auth token and starting stub..."
TOKEN_FILE="/tmp/opencode-remote-token-$HOST"
TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p)
printf '%s' "$TOKEN" > "$TOKEN_FILE"
scp $SCP_OPTS "$TOKEN_FILE" "$USER@$HOST:$REMOTE_BASE/run/stub.token"
rm -f "$TOKEN_FILE"

ssh_cmd "mkdir -p $REMOTE_BASE/log; pkill -f 'opencode-remote-stub' 2>/dev/null || true"
start_stub_remote
if ! ssh_cmd "pgrep -af 'opencode-remote-stub' >/dev/null"; then
    start_stub_remote
fi
if ! ssh_cmd "pgrep -af 'opencode-remote-stub' >/dev/null"; then
    echo "ERROR: Stub failed to stay running on the remote host"
    echo "Remote log (if any):"
    ssh_cmd "cat $REMOTE_BASE/log/stub.log 2>/dev/null || true"
    exit 1
fi
echo "Stub started"

echo ""
echo "=== Setup Complete ==="
echo "Host: $USER@$HOST"
echo "Identity: $IDENTITY_EXPANDED"
echo "Stub location: $REMOTE_BASE/bin/opencode-remote-stub"
echo "Token file: $REMOTE_BASE/run/stub.token"
echo "Log file: $REMOTE_BASE/log/stub.log"
echo ""
echo "Next steps:"
echo "1. Add this host to your plugin config if you have not already."
echo "2. Use the plugin's provider-based workspace flow to connect."
echo "3. For manual verification, create a temporary SSH tunnel and query /global/health:"
echo "   ssh -N -L 39300:127.0.0.1:39217 $USER@$HOST"
echo "   TOKEN=\$(ssh $USER@$HOST 'cat ~/.opencode-remote/run/stub.token')"
echo "   curl -H \"Authorization: Bearer \$TOKEN\" http://127.0.0.1:39300/global/health"
