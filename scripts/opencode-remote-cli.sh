#!/usr/bin/env bash
set -e

DEFAULT_CONFIG_FILE="${HOME}/.config/opencode/opencode.json"
CONFIG_FILE="${CONFIG_FILE:-$DEFAULT_CONFIG_FILE}"
PLUGIN_NAME="opencode-remote-provider"

usage() {
    echo "opencode-remote-ssh CLI - Manage package-based remote plugin config"
    echo ""
    echo "Supported mode: package-based plugin registration only"
    echo "Unsupported for automatic mutation: local path-based plugin entries"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  add <provider> <host> <user> [port] [identity-file]"
    echo "  remove <provider> <host>"
    echo "  list"
    echo "  setup <host> <user> [port] [identity-file]"
    echo "  init"
    exit 1
}

die() {
    echo "ERROR: $*" >&2
    exit 1
}

read_config() {
    if [ ! -f "$CONFIG_FILE" ]; then
        die "OpenCode config not found at $CONFIG_FILE"
    fi
    cat "$CONFIG_FILE"
}

backup_config() {
    if [ -f "$CONFIG_FILE" ]; then
        local backup="${CONFIG_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$CONFIG_FILE" "$backup"
        echo "Backed up config to: $backup"
    fi
}

write_config() {
    backup_config
    local tmp
    tmp=$(mktemp)
    cat > "$tmp"
    mv "$tmp" "$CONFIG_FILE"
}

assert_supported_config_mode() {
    python3 - <<'PY'
import json
import os
import sys

config_file = os.path.expanduser(os.environ["CONFIG_FILE"])
plugin_name = os.environ["PLUGIN_NAME"]

with open(config_file) as f:
    data = json.load(f)

plugins = data.get("plugin", [])
package_entry = False
path_entries = []
for entry in plugins:
    if isinstance(entry, list) and entry:
        target = entry[0]
        if target == plugin_name:
            package_entry = True
        elif isinstance(target, str) and ("/plugin" in target or target.endswith("/plugin") or target.endswith("\\plugin")):
            path_entries.append(target)

if path_entries and not package_entry:
    print("Detected a local path-based plugin registration.", file=sys.stderr)
    print("This CLI only manages package-based plugin config entries for 'opencode-remote-provider'.", file=sys.stderr)
    print("Edit your path-based config manually or switch to package-based plugin registration.", file=sys.stderr)
    sys.exit(2)
PY
}

has_plugin() {
    python3 - <<'PY'
import json
import os
import sys

with open(os.path.expanduser(os.environ["CONFIG_FILE"])) as f:
    data = json.load(f)

for entry in data.get("plugin", []):
    if isinstance(entry, list) and entry and entry[0] == os.environ["PLUGIN_NAME"]:
        sys.exit(0)
sys.exit(1)
PY
}

get_plugin_config() {
    python3 - <<'PY'
import json
import os

with open(os.path.expanduser(os.environ["CONFIG_FILE"])) as f:
    data = json.load(f)

for entry in data.get("plugin", []):
    if isinstance(entry, list) and len(entry) >= 2 and entry[0] == os.environ["PLUGIN_NAME"]:
        print(json.dumps(entry[1]))
        break
else:
    print(json.dumps({}))
PY
}

init_plugin() {
    local config="$1"
    local plugin_config='{"providers":{}}'

    echo "$config" | python3 - <<'PY' | write_config
import json
import sys

plugin_name = __import__("os").environ["PLUGIN_NAME"]
data = json.load(sys.stdin)
plugins = data.setdefault("plugin", [])

for entry in plugins:
    if isinstance(entry, list) and entry and entry[0] == plugin_name:
        print(json.dumps(data, indent=2))
        raise SystemExit

plugins.append([plugin_name, {"providers": {}}])
print(json.dumps(data, indent=2))
PY
    echo "Plugin initialized"
}

cmd_add() {
    [ $# -ge 3 ] || die "Usage: $0 add <provider> <host> <user> [port] [identity-file]"
    assert_supported_config_mode

    local provider="$1"
    local host="$2"
    local user="$3"
    local port="${4:-22}"
    local identity="${5:-}"

    if ! has_plugin; then
        init_plugin "$(read_config)"
    fi

    python3 - <<'PY' | write_config
import json
import os

config_file = os.path.expanduser(os.environ["CONFIG_FILE"])
plugin_name = os.environ["PLUGIN_NAME"]
provider = os.environ["REMOTE_PROVIDER"]
host = os.environ["REMOTE_HOST"]
user = os.environ["REMOTE_USER"]
port = int(os.environ["REMOTE_PORT"])
identity = os.environ.get("REMOTE_IDENTITY", "")

with open(config_file) as f:
    data = json.load(f)

for entry in data.get("plugin", []):
    if isinstance(entry, list) and entry and entry[0] == plugin_name:
        plugin = entry[1] if len(entry) > 1 else {}
        entry[1] = plugin
        providers = plugin.setdefault("providers", {})
        provider_config = providers.setdefault(provider, {"strategy": "first_available", "hosts": []})
        hosts = [item for item in provider_config.setdefault("hosts", []) if item.get("name") != host]
        ssh_host = os.environ.get("REMOTE_SSH_HOST", host)
        host_entry = {
            "name": host,
            "ssh": {
                "host": ssh_host,
                "user": user,
                "port": port,
            },
        }
        if identity:
            host_entry["ssh"]["identityFile"] = identity
        hosts.append(host_entry)
        provider_config["hosts"] = hosts
        break

print(json.dumps(data, indent=2))
PY
    echo "Added host '$host' to provider '$provider'"
}

cmd_remove() {
    [ $# -ge 2 ] || die "Usage: $0 remove <provider> <host>"
    assert_supported_config_mode
    has_plugin || die "Plugin not initialized. Run '$0 init' first."

    local provider="$1"
    local host="$2"

    python3 - <<'PY' | write_config
import json
import os

config_file = os.path.expanduser(os.environ["CONFIG_FILE"])
plugin_name = os.environ["PLUGIN_NAME"]
provider = os.environ["REMOTE_PROVIDER"]
host = os.environ["REMOTE_HOST"]

with open(config_file) as f:
    data = json.load(f)

for entry in data.get("plugin", []):
    if isinstance(entry, list) and entry and entry[0] == plugin_name:
        plugin = entry[1] if len(entry) > 1 else {}
        providers = plugin.get("providers", {})
        if provider in providers:
            providers[provider]["hosts"] = [item for item in providers[provider].get("hosts", []) if item.get("name") != host]
        break

print(json.dumps(data, indent=2))
PY
    echo "Removed host '$host' from provider '$provider'"
}

cmd_list() {
    assert_supported_config_mode
    if ! has_plugin; then
        echo "No remote hosts configured. Run '$0 init' first."
        return
    fi

    CONFIG_FILE_VALUE="$CONFIG_FILE" PLUGIN_NAME_VALUE="$PLUGIN_NAME" python3 - <<'PY'
import json
import os
import sys

with open(os.path.expanduser(os.environ["CONFIG_FILE_VALUE"])) as f:
    data = json.load(f)

plugin = {}
for entry in data.get("plugin", []):
    if isinstance(entry, list) and len(entry) >= 2 and entry[0] == os.environ["PLUGIN_NAME_VALUE"]:
        plugin = entry[1]
        break

providers = plugin.get("providers", {})
if not providers:
    print("No providers configured")

for name, provider in providers.items():
    print(f"Provider: {name}")
    print(f"  Strategy: {provider.get('strategy', 'first_available')}")
    for host in provider.get("hosts", []):
        ssh = host.get("ssh", {})
        print(f"  - {host.get('name')}: {ssh.get('user')}@{ssh.get('host')}:{ssh.get('port', 22)}")
PY
}

cmd_setup() {
    [ $# -ge 2 ] || die "Usage: $0 setup <host> <user> [port] [identity-file]"
    assert_supported_config_mode

    local host="$1"
    local user="$2"
    local port="${3:-22}"
    local identity="${4:-}"

    echo "Adding host to config..."
    cmd_add default "$host" "$user" "$port" "$identity"
    echo ""
    echo "Setting up remote host..."
    local script_dir
    script_dir="$(cd "$(dirname "$0")/.." && pwd)"
    "$script_dir/scripts/setup-host.sh" "$host" "$user" "$port" "$identity"
}

cmd_init() {
    assert_supported_config_mode
    if has_plugin; then
        echo "Plugin already initialized"
        return
    fi
    init_plugin "$(read_config)"
}

if [ $# -lt 1 ]; then
    usage
fi

export CONFIG_FILE PLUGIN_NAME
cmd="$1"
shift

case "$cmd" in
    add)
        export REMOTE_PROVIDER="$1" REMOTE_HOST="$2" REMOTE_USER="$3" REMOTE_PORT="${4:-22}" REMOTE_IDENTITY="${5:-}" REMOTE_SSH_HOST="${REMOTE_SSH_HOST:-$2}"
        cmd_add "$@"
        ;;
    remove)
        export REMOTE_PROVIDER="$1" REMOTE_HOST="$2"
        cmd_remove "$@"
        ;;
    list)
        cmd_list
        ;;
    setup)
        export REMOTE_PROVIDER="default" REMOTE_HOST="$1" REMOTE_USER="$2" REMOTE_PORT="${3:-22}" REMOTE_IDENTITY="${4:-}" REMOTE_SSH_HOST="${REMOTE_SSH_HOST:-$1}"
        cmd_setup "$@"
        ;;
    init)
        cmd_init
        ;;
    -h|--help|help)
        usage
        ;;
    *)
        die "Unknown command: $cmd"
        ;;
esac
