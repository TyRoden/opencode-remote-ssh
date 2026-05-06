#!/usr/bin/env bash
set -e

usage() {
    echo "Usage: $0 <host> <user> [port] [identity-file]"
    echo ""
    echo "Setup a remote host for opencode-remote by:"
    echo "  1. Verifying SSH connectivity"
    echo "  2. Detecting platform and creating install directories"
    echo "  3. Uploading the Go stub binary"
    echo "  4. Generating auth token"
    echo "  5. Starting the stub"
    echo "  6. Testing the connection"
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

# Build SSH options - use ControlMaster for connection reuse (asks password only once)
CONTROL_SOCKET="/tmp/ssh-control-$HOST-$USER"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=$CONTROL_SOCKET -o ControlPersist=300 -p $PORT"

# Add identity file if provided and valid
if [ -n "$IDENTITY" ]; then
    # Expand ~ if present
    IDENTITY_EXPANDED="${IDENTITY/#\~/$HOME}"
    # Only use if it's a valid file
    if [ -f "$IDENTITY_EXPANDED" ]; then
        SSH_OPTS="$SSH_OPTS -i $IDENTITY_EXPANDED"
    else
        echo "Warning: Identity file '$IDENTITY_EXPANDED' not found, ignoring"
        IDENTITY=""
    fi
fi

# SCP uses -P (uppercase) for port - build it separately
SCP_OPTS="-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=$CONTROL_SOCKET -o ControlPersist=300 -P $PORT"
if [ -n "$IDENTITY" ] && [ -f "$IDENTITY_EXPANDED" ]; then
    SCP_OPTS="$SCP_OPTS -i $IDENTITY_EXPANDED"
fi

# Try to use SSH agent if available
if [ -z "$SSH_AUTH_SOCK" ]; then
    # Check for ssh-agent
    if [ -f "$HOME/.ssh-agent" ]; then
        source "$HOME/.ssh-agent"
    fi
fi

# Generate a dedicated key for this remote if not provided
if [ -z "$IDENTITY" ]; then
    IDENTITY="$HOME/.ssh/opencode-remote-$HOST"
    if [ ! -f "$IDENTITY" ]; then
        echo "Generating dedicated SSH key for this host..."
        ssh-keygen -t ed25519 -f "$IDENTITY" -N "" -C "opencode-remote-$HOST" >/dev/null 2>&1
        chmod 600 "$IDENTITY"
    fi
    IDENTITY_EXPANDED="$IDENTITY"
    SSH_OPTS="$SSH_OPTS -i $IDENTITY"
    SCP_OPTS="$SCP_OPTS -i $IDENTITY"
fi

# Test if we can connect; if not, try password-based auth to add the key
test_connection() {
    # Try with the dedicated key first
    if [ -f "$IDENTITY" ]; then
        ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes -i "$IDENTITY" -p "$PORT" "$USER@$HOST" "echo ok" 2>/dev/null && return 0
    fi
    # Fall back to any available keys
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes "$SSH_OPTS" "$USER@$HOST" "echo ok" 2>/dev/null
}

add_key_via_password() {
    echo "No SSH key works. Trying password authentication to add the new key..."
    
    # Check if sshpass is available
    if ! command -v sshpass &>/dev/null; then
        echo ""
        echo "sshpass is not installed on this machine."
        echo ""
        echo "To set up key-based authentication manually:"
        echo "1. SSH to $USER@$HOST using your password"
        echo "2. Add this public key to ~/.ssh/authorized_keys:"
        echo ""
        cat "${IDENTITY}.pub"
        echo ""
        echo "Then re-run this script."
        echo ""
        return 1
    fi
    
    # Read password interactively
    echo -n "Enter password for $USER@$HOST: "
    read -s SSHPASS
    echo ""
    export SSHPASS
    
    # Get the public key
    if [ -f "${IDENTITY}.pub" ]; then
        PUBKEY=$(cat "${IDENTITY}.pub")
    else
        echo "ERROR: Public key not found"
        return 1
    fi
    
    # Use sshpass to add the key
    sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -p "$PORT" "$USER@$HOST" "
        mkdir -p ~/.ssh && chmod 700 ~/.ssh
        echo '$PUBKEY' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
        echo 'Key added'
    " 2>/dev/null || {
        echo "Failed to add key via password"
        return 1
    }
    
    echo "Key added successfully. Retrying SSH..."
    return 0
}

# Initial connection test
if ! test_connection >/dev/null 2>&1; then
    # Try to add key via password
    if add_key_via_password; then
        # Wait a moment for key to be available
        sleep 2
    else
        echo "ERROR: Could not authenticate to remote host"
        echo "Please ensure you can connect to $USER@$HOST via SSH"
        exit 1
    fi
fi

# SSH command wrapper
ssh_cmd() {
    ssh $SSH_OPTS "$USER@$HOST" "$@"
}

# Cleanup control socket on exit
cleanup() {
    rm -f "$CONTROL_SOCKET"
}
trap cleanup EXIT

REMOTE_BASE="$HOME/.opencode-remote"
STUB_VERSION="0.1.0"

echo "=== OpenCode Remote Host Setup ==="
echo "Host: $HOST"
echo "User: $USER"
echo "Port: $PORT"
if [ -n "$IDENTITY" ]; then
    echo "Identity: $IDENTITY"
else
    echo "Identity: (none - using SSH agent or password)"
fi
echo ""

echo "[1/7] Testing SSH connectivity..."
if ! ssh_cmd "echo ok" >/dev/null 2>&1; then
    echo "ERROR: Cannot connect to $USER@$HOST"
    exit 1
fi
echo "OK"

echo "[2/7] Detecting remote platform..."
PLATFORM=$(ssh_cmd "uname -s")
ARCH=$(ssh_cmd "uname -m")
echo "Platform: $PLATFORM $ARCH"

if [ "$PLATFORM" != "Linux" ]; then
    echo "WARNING: Non-Linux platform detected. Only Linux is fully supported."
fi

REMOTE_BASE_EXPANDED=$(ssh_cmd "printf '%s' \$HOME")/.opencode-remote

echo "[3/7] Creating remote directories..."
ssh $SSH_OPTS "$USER@$HOST" "mkdir -p $REMOTE_BASE_EXPANDED/bin $REMOTE_BASE_EXPANDED/run $REMOTE_BASE_EXPANDED/log $REMOTE_BASE_EXPANDED/state"
echo "OK: $REMOTE_BASE_EXPANDED"

echo "[4/7] Determining stub binary..."
LOCAL_ARCH=$(uname -m)
case "$LOCAL_ARCH" in
    x86_64) GOARCH="amd64" ;;
    aarch64|arm64) GOARCH="arm64" ;;
    *) GOARCH="amd64" ;;
esac

# Get absolute path to the project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
STUB_DIR="$PROJECT_ROOT/stub/bin"
STUB_BINARY="$STUB_DIR/opencode-remote-stub"

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

echo "[5/7] Uploading stub binary..."
scp $SCP_OPTS "$STUB_BINARY" "$USER@$HOST:$REMOTE_BASE_EXPANDED/bin/opencode-remote-stub"
ssh $SSH_OPTS "$USER@$HOST" "chmod +x $REMOTE_BASE_EXPANDED/bin/opencode-remote-stub"
echo "OK"

echo "[6/7] Generating auth token and starting stub..."
TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | xxd -p)
echo "$TOKEN" > /tmp/opencode-remote-token-$HOST
scp $SCP_OPTS /tmp/opencode-remote-token-$HOST "$USER@$HOST:$REMOTE_BASE_EXPANDED/run/stub.token"

# Kill any existing stub and start fresh
ssh $SSH_OPTS "$USER@$HOST" "
    pkill -f 'opencode-remote-stub' 2>/dev/null || true
    sleep 1
    nohup $REMOTE_BASE_EXPANDED/bin/opencode-remote-stub \
        --listen 127.0.0.1:39217 \
        --token-file $REMOTE_BASE_EXPANDED/run/stub.token \
        --state-dir $REMOTE_BASE_EXPANDED/state \
        --log-file $REMOTE_BASE_EXPANDED/log/stub.log \
        >/dev/null 2>&1 &
    sleep 2
    pgrep -f 'opencode-remote-stub' || {
        echo 'ERROR: Stub failed to start'
        exit 1
    }
    echo 'Stub started'
"

# Find available local port
LOCAL_PORT=39300
for port in 39300 39301 39302 39303 39304; do
    if ! ss -tln 2>/dev/null | grep -q ":$port "; then
        LOCAL_PORT=$port
        break
    fi
done

echo "[7/7] Verifying stub is running..."
if ssh $SSH_OPTS "$USER@$HOST" "pgrep -f 'opencode-remote-stub' >/dev/null" 2>/dev/null; then
    echo "SUCCESS: Remote stub is installed and running"
    echo ""
    echo "To use with OpenCode, you need to:"
    echo "  1. Create an SSH tunnel:"
    echo "     ssh -N -L $LOCAL_PORT:127.0.0.1:39217 $USER@$HOST"
    echo "  2. The token is saved at: $REMOTE_BASE_EXPANDED/run/stub.token on the remote"
    echo "  3. Update your OpenCode config to use the remote URL"
    echo ""
    echo "To test manually:"
    echo "  TOKEN=\$(ssh $USER@$HOST 'cat ~/.opencode-remote/run/stub.token')"
    echo "  curl -H \"Authorization: Bearer \$TOKEN\" http://127.0.0.1:$LOCAL_PORT/global/health"
else
    echo "WARNING: Stub process not detected on remote host"
    echo "You may need to start it manually or check logs at: $REMOTE_BASE_EXPANDED/log/stub.log"
fi

echo ""
echo "=== Setup Complete ==="
echo "Host: $USER@$HOST"
echo "Identity: $IDENTITY_EXPANDED"
echo "Stub location: $REMOTE_BASE_EXPANDED/bin/"
    echo "WARNING: Connection test returned unexpected response"
    echo "$RESPONSE"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To use with OpenCode, add to your config:"
echo ""
cat <<EOF
{
  "plugin": [
    ["opencode-remote-provider", {
      "providers": {
        "setup-host": {
          "strategy": "first_available",
          "hosts": [
            {
              "name": "$HOST",
              "ssh": {
                "host": "$HOST",
                "user": "$USER",
                "port": $PORT
                $([ -n "$IDENTITY" ] && echo ", \"identityFile\": \"$IDENTITY\"")
              }
            }
          ]
        }
      }
    }]
  ]
}
EOF