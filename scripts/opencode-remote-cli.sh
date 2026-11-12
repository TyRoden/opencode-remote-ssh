#!/usr/bin/env bash
set -e

DEFAULT_CONFIG_FILE="${HOME}/.config/opencode/opencode.json"
CONFIG_FILE="${CONFIG_FILE:-$DEFAULT_CONFIG_FILE}"
PLUGIN_NAME="opencode-remote-provider"

usage() {
    echo "opencode-remote-ssh CLI - Manage the remote plugin entry in the OpenCode V2 config"
    echo ""
    echo "Supports the OpenCode V2 'plugins' array: package-name entries"
    echo "and local path-based plugin entries (e.g. a checkout of this repo)"
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

legacy = data.get("plugin", [])
for entry in legacy:
    if isinstance(entry, list) and entry and (
        entry[0] == plugin_name or (isinstance(entry[0], str) and entry[0].endswith("opencode-remote-ssh/plugin"))
    ):
        print("Detected a legacy OpenCode V1 'plugin' entry for this plugin.", file=sys.stderr)
        print("OpenCode 2.x uses the 'plugins' array with object entries:", file=sys.stderr)
        print('  "plugins": [{"package": "<name-or-path>", "options": {...}}]', file=sys.stderr)
        print("Convert that entry and rerun this CLI.", file=sys.stderr)
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

def is_remote(entry):
    if isinstance(entry, str):
        return entry == os.environ["PLUGIN_NAME"] or entry.endswith("opencode-remote-ssh/plugin")
    if isinstance(entry, dict):
        package = entry.get("package")
        if isinstance(package, str):
            return package == os.environ["PLUGIN_NAME"] or package.endswith("opencode-remote-ssh/plugin")
    return False

sys.exit(0 if any(is_remote(entry) for entry in data.get("plugins", [])) else 1)
PY
}

init_plugin() {
    if [ ! -f "$CONFIG_FILE" ]; then
        die "OpenCode config not found at $CONFIG_FILE"
    fi

    # The npm package is not published, so the entry points at the plugin
    # directory of this checkout.
    local plugin_dir
    plugin_dir="$(cd "$(dirname "$0")/.." && pwd)/plugin"

    PLUGIN_DIR="$plugin_dir" python3 - <<'PY' | write_config
import json
import os

plugin_name = os.environ["PLUGIN_NAME"]
plugin_dir = os.environ["PLUGIN_DIR"]

with open(os.path.expanduser(os.environ["CONFIG_FILE"])) as f:
    data = json.load(f)

plugins = data.setdefault("plugins", [])

def is_remote(entry):
    pkg = entry if isinstance(entry, str) else (
        entry.get("package") if isinstance(entry, dict) else None
    )
    if not isinstance(pkg, str):
        return False
    if pkg == plugin_name or pkg.endswith("opencode-remote-ssh/plugin"):
        return True
    manifest = os.path.join(pkg, "package.json")
    if os.path.isfile(manifest):
        try:
            return json.load(open(manifest)).get("name") == plugin_name
        except Exception:
            return False
    return False

if not any(is_remote(entry) for entry in plugins):
    plugins.append({"package": plugin_dir, "options": {"providers": {}}})
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
        init_plugin
    fi

    python3 - <<'PY' | write_config
import json
import os
import sys

config_file = os.path.expanduser(os.environ["CONFIG_FILE"])
plugin_name = os.environ["PLUGIN_NAME"]
provider = os.environ["REMOTE_PROVIDER"]
host = os.environ["REMOTE_HOST"]
user = os.environ["REMOTE_USER"]
port = int(os.environ["REMOTE_PORT"])
identity = os.environ.get("REMOTE_IDENTITY", "")
ssh_host = os.environ.get("REMOTE_SSH_HOST", host)

with open(config_file) as f:
    data = json.load(f)

plugins = data.setdefault("plugins", [])

def find_entry():
    for entry in plugins:
        pkg = entry if isinstance(entry, str) else (
            entry.get("package") if isinstance(entry, dict) else None
        )
        if not isinstance(pkg, str):
            continue
        if pkg == plugin_name or pkg.endswith("opencode-remote-ssh/plugin"):
            return entry
        manifest = os.path.join(pkg, "package.json")
        if os.path.isfile(manifest):
            try:
                if json.load(open(manifest)).get("name") == plugin_name:
                    return entry
            except Exception:
                pass
    return None

entry = find_entry()
if entry is None:
    print(f"Remote plugin entry not found in {config_file}. Run 'init' first.", file=sys.stderr)
    raise SystemExit(1)
if isinstance(entry, str):
    index = plugins.index(entry)
    entry = {"package": entry, "options": {}}
    plugins[index] = entry

options = entry.setdefault("options", {})
providers = options.setdefault("providers", {})
provider_config = providers.setdefault(provider, {"strategy": "first_available", "hosts": []})
hosts = [item for item in provider_config.setdefault("hosts", []) if item.get("name") != host]
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

plugins = data.get("plugins", [])

def is_remote(entry):
    pkg = entry if isinstance(entry, str) else (
        entry.get("package") if isinstance(entry, dict) else None
    )
    if not isinstance(pkg, str):
        return False
    if pkg == plugin_name or pkg.endswith("opencode-remote-ssh/plugin"):
        return True
    manifest = os.path.join(pkg, "package.json")
    if os.path.isfile(manifest):
        try:
            return json.load(open(manifest)).get("name") == plugin_name
        except Exception:
            return False
    return False

for entry in plugins:
    if is_remote(entry) and isinstance(entry, dict):
        providers = (entry.get("options") or {}).get("providers", {})
        if provider in providers:
            providers[provider]["hosts"] = [
                item for item in providers[provider].get("hosts", []) if item.get("name") != host
            ]
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

    python3 - <<'PY'
import json
import os

with open(os.path.expanduser(os.environ["CONFIG_FILE"])) as f:
    data = json.load(f)

plugin_name = os.environ["PLUGIN_NAME"]

def is_remote(entry):
    pkg = entry if isinstance(entry, str) else (
        entry.get("package") if isinstance(entry, dict) else None
    )
    if not isinstance(pkg, str):
        return False
    if pkg == plugin_name or pkg.endswith("opencode-remote-ssh/plugin"):
        return True
    manifest = os.path.join(pkg, "package.json")
    if os.path.isfile(manifest):
        try:
            return json.load(open(manifest)).get("name") == plugin_name
        except Exception:
            return False
    return False

options = {}
for entry in data.get("plugins", []):
    if is_remote(entry) and isinstance(entry, dict):
        options = entry.get("options") or {}
        break

providers = options.get("providers", {})
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
    init_plugin
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
