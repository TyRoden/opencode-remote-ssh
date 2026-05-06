#!/usr/bin/env bash
set -e

CONFIG_FILE="${HOME}/.config/opencode/opencode.json"
PLUGIN_NAME="opencode-remote-provider"

usage() {
    echo "opencode-remote-ssh CLI - Manage remote hosts in OpenCode config"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  add <provider> <host> <user> [port] [identity-file]"
    echo "      Add a host to a provider"
    echo "      Example: $0 add my-servers 10.0.0.10 ops 22 ~/.ssh/id_ed25519"
    echo ""
    echo "  remove <provider> <host>"
    echo "      Remove a host from a provider"
    echo "      Example: $0 remove my-servers 10.0.0.10"
    echo ""
    echo "  list"
    echo "      List all configured hosts"
    echo ""
    echo "  setup <host> <user> [port] [identity-file]"
    echo "      Add host and set up remote (shorthand for add + setup-host)"
    echo "      Example: $0 setup 10.0.0.10 ops 22"
    echo ""
    echo "  init"
    echo "      Initialize the plugin in OpenCode config if not present"
    echo ""
    exit 1
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

# Read config safely
read_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        die "OpenCode config not found at $CONFIG_FILE"
    fi
    cat "$CONFIG_FILE"
}

# Backup config before modifying
backup_config() {
    if [ -f "$CONFIG_FILE" ]; then
        local backup="${CONFIG_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$CONFIG_FILE" "$backup"
        echo "Backed up config to: $backup"
    fi
}

# Write config safely (atomic write)
write_config() {
    backup_config
    local tmp=$(mktemp)
    cat > "$tmp"
    mv "$tmp" "$CONFIG_FILE"
}

# Get plugin config or empty array if not present
get_plugin_config() {
    python3 -c "
import json, sys
try:
    with open('$CONFIG_FILE') as f:
        data = json.load(f)
    plugins = data.get('plugin', [])
    for p in plugins:
        if isinstance(p, list) and len(p) >= 2 and p[0] == '$PLUGIN_NAME':
            print(json.dumps(p[1]))
            sys.exit(0)
    print(json.dumps({}))
except Exception as e:
    print('{}')
" 2>/dev/null
}

# Check if plugin is initialized
has_plugin() {
    python3 -c "
import json, sys
with open('$CONFIG_FILE') as f:
    data = json.load(f)
plugins = data.get('plugin', [])
for p in plugins:
    if isinstance(p, list) and p[0] == '$PLUGIN_NAME':
        sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

# Initialize plugin in config (only if not already there)
init_plugin() {
    local config="$1"
    local plugin_config="${2:-{\"providers\":{}}}"
    
    # Check if plugin already exists in any form
    if echo "$config" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for p in data.get('plugin', []):
    if isinstance(p, list) and p[0] == '$PLUGIN_NAME':
        sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
        echo "Plugin already initialized"
        return 0
    fi
    
    python3 -c "
import json, sys
data = json.load(sys.stdin)
if 'plugin' not in data:
    data['plugin'] = []
data['plugin'].append(['$PLUGIN_NAME', $plugin_config])
print(json.dumps(data, indent=2))
" < <(echo "$config") | write_config
    echo "Plugin initialized"
}

# Add host to provider
cmd_add() {
    if [ $# -lt 3 ]; then
        echo "Usage: $0 add <provider> <host> <user> [port] [identity-file]"
        exit 1
    fi
    
    local provider="$1"
    local host="$2"
    local user="$3"
    local port="${4:-22}"
    local identity="$5"
    
    # Initialize plugin only if not present - don't duplicate
    if ! has_plugin; then
        init_plugin
    fi
    
    # Add/update the host (idempotent - skip if already exists)
    local existing_check=$(python3 -c "
import json
with open('$CONFIG_FILE') as f:
    data = json.load(f)
for p in data.get('plugin', []):
    if isinstance(p, list) and p[0] == '$PLUGIN_NAME':
        plugin = p[1] if len(p) > 1 else {}
        for prov_name, prov in plugin.get('providers', {}).items():
            if prov_name == '$provider':
                for h in prov.get('hosts', []):
                    if h.get('name') == '$host':
                        print('exists')
                        sys.exit(0)
print('not_found')
" 2>/dev/null || echo "not_found")

if [ "$existing_check" = "exists" ]; then
    echo "Host '$host' already exists in provider '$provider', skipping add"
    return 0
fi

    local new_config=$(python3 -c "
import json, sys

with open('$CONFIG_FILE') as f:
    data = json.load(f)
plugin = None

provider = '$provider'
host = '$host'
user = '$user'
port = $port
identity = '$identity'

# Find or create plugin entry
new_plugin = []
for p in data.get('plugin', []):
    if isinstance(p, list) and p[0] == '$PLUGIN_NAME':
        plugin = p[1] if len(p) > 1 else {}
        p[1] = plugin
        plugin = p[1]
    new_plugin.append(p)

if plugin is None:
    plugin = {'providers': {}}
    new_plugin.append(['$PLUGIN_NAME', plugin])

# Ensure providers structure
if 'providers' not in plugin:
    plugin['providers'] = {}
if provider not in plugin['providers']:
    plugin['providers'][provider] = {'strategy': 'first_available', 'hosts': []}
if 'hosts' not in plugin['providers'][provider]:
    plugin['providers'][provider]['hosts'] = []

# Build host entry
host_entry = {'name': host, 'ssh': {'host': host, 'user': user, 'port': port}}
if identity:
    host_entry['ssh']['identityFile'] = identity

# Remove existing host with same name
hosts = plugin['providers'][provider]['hosts']
hosts = [h for h in hosts if h.get('name') != host]
hosts.append(host_entry)
plugin['providers'][provider]['hosts'] = hosts

data['plugin'] = new_plugin
print(json.dumps(data, indent=2))
")
    
    echo "$new_config" | write_config
    echo "Added host '$host' to provider '$provider'"
}

# Remove host from provider
cmd_remove() {
    if [ $# -lt 2 ]; then
        echo "Usage: $0 remove <provider> <host>"
        exit 1
    fi
    
    local provider="$1"
    local host="$2"
    
    if ! has_plugin; then
        die "Plugin not initialized. Run '$0 init' first."
    fi
    
    local new_config=$(python3 -c "
import json, sys

with open('$CONFIG_FILE') as f:
    data = json.load(f)
provider = '$provider'
host = '$host'

for p in data.get('plugin', []):
    if isinstance(p, list) and p[0] == '$PLUGIN_NAME':
        plugin = p[1] if len(p) > 1 else {}
        if 'providers' in plugin and provider in plugin['providers']:
            hosts = plugin['providers'][provider].get('hosts', [])
            hosts = [h for h in hosts if h.get('name') != host]
            plugin['providers'][provider]['hosts'] = hosts

print(json.dumps(data, indent=2))
")
    
    echo "$new_config" | write_config
    echo "Removed host '$host' from provider '$provider'"
}

# List all hosts
cmd_list() {
    if ! has_plugin; then
        echo "No remote hosts configured. Run '$0 init' first."
        return
    fi
    
    local plugin_config=$(get_plugin_config)
    
    echo "$plugin_config" | python3 -c "
import json, sys
try:
    plugin = json.load(sys.stdin)
    providers = plugin.get('providers', {})
    if not providers:
        print('No providers configured')
    for prov_name, prov in providers.items():
        print(f'Provider: {prov_name}')
        print(f'  Strategy: {prov.get(\"strategy\", \"first_available\")}')
        for h in prov.get('hosts', []):
            ssh = h.get('ssh', {})
            print(f'  - {h.get(\"name\")}: {ssh.get(\"user\")}@{ssh.get(\"host\")}:{ssh.get(\"port\", 22)}')
            labels = h.get('labels', [])
            if labels:
                print(f'    Labels: {labels}')
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
" 2>&1
}

# Setup host (add + setup)
cmd_setup() {
    if [ $# -lt 2 ]; then
        echo "Usage: $0 setup <host> <user> [port] [identity-file]"
        echo ""
        echo "This command adds a host to config AND sets up the remote stub."
        echo "Example: $0 setup 10.0.0.10 ops 22 ~/.ssh/id_ed25519"
        exit 1
    fi
    
    local host="$1"
    local user="$2"
    local port="${3:-22}"
    local identity="$4"
    
    # Determine provider name
    local provider="default"
    
    echo "Adding host to config..."
    cmd_add "$provider" "$host" "$user" "$port" "$identity"
    
    echo ""
    echo "Setting up remote host (this will take a moment)..."
    SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
    if [ -f "$SCRIPT_DIR/scripts/setup-host.sh" ]; then
        # Only pass identity if it's a valid non-numeric path
        if [ -n "$identity" ] && [ ! -f "$identity" ]; then
            # Not a valid file, treat as empty
            identity=""
        fi
        "$SCRIPT_DIR/scripts/setup-host.sh" "$host" "$user" "$port" "$identity"
    else
        echo "setup-host.sh not found. Run it manually from the scripts directory."
    fi
}

# Init command
cmd_init() {
    local config=$(read_config)
    if has_plugin "$config"; then
        echo "Plugin already initialized"
        return
    fi
    init_plugin "$config"
}

# Main
if [ $# -lt 1 ]; then
    usage
fi

cmd="$1"
shift

case "$cmd" in
    add) cmd_add "$@" ;;
    remove) cmd_remove "$@" ;;
    list) cmd_list ;;
    setup) cmd_setup "$@" ;;
    init) cmd_init ;;
    -h|--help|help) usage ;;
    *) die "Unknown command: $cmd" ;;
esac