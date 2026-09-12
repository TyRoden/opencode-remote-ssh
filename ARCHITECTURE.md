# Architecture

## How It Works

opencode-remote-ssh enables OpenCode to execute commands on remote Linux hosts that cannot run OpenCode directly. It works by:

1. **Installing a small Go program (stub)** on the remote host
2. **Creating an SSH tunnel** from your local machine to the remote
3. **Proxying all commands** through this tunnel to the remote stub

The remote stub acts as a miniature OpenCode server - it handles workspace, session, permission, and shell operations just like OpenCode would locally.

## System Components

### 1. Local Plugin (`plugin/`)

The OpenCode plugin that runs on your local machine. It handles:

| Responsibility | Description |
|---------------|-------------|
| **Provider Registry** | Maintains your list of remote hosts organized by groups |
| **Host Selection** | Picks which remote to use based on labels, availability, and optional host aliases |
| **Lease Management** | Ensures only one workspace uses a host at a time |
| **SSH Bootstrap** | Uploads and starts the remote stub |
| **Tunnel Management** | Maintains the SSH port forwarding |
| **Workspace Adaptor** | Implements OpenCode's workspace interface |
| **Remote Tools** | Exposes connection, status, disconnect, and doctor workflows for first-launch validation |

### 2. Remote Stub (`stub/`)

A self-contained Go binary that runs on the remote host. It provides:

| Feature | Description |
|---------|-------------|
| **HTTP API** | OpenCode-compatible endpoints for all operations |
| **Authentication** | Validates bearer token on every request |
| **State Management** | Tracks workspaces, sessions, and approvals |
| **Permission Engine** | Enforces path access controls |
| **Event Stream** | SSE events for real-time updates |

## Data Flow

When you create a remote workspace:

```
┌─────────────────┐                    ┌─────────────────┐
│  Local OpenCode│                    │   Remote Host   │
└────────┬────────┘                    └────────┬────────┘
         │                                      │
         │ 1. Select provider/host              │
         ▼                                      ▼
┌─────────────────┐                    ┌─────────────────┐
│  Plugin         │                    │                 │
│  - Load config  │                    │                 │
│  - Pick host    │                    │                 │
└────────┬────────┘                    └────────┬────────┘
         │                                      │
         │ 2. SSH connect + upload stub         │
         ├─────────────────────────────────────▶│
         │                                      │
         │ 3. Start stub + create tunnel        │
         ├─────────────────────────────────────▶│
         │                                      ▼
         │                              ┌─────────────────┐
         │                              │  Go Stub        │
         │                              │  - workspace   │
         │                              │  - session     │
         │                              │  - shell       │
         │                              │  - permission  │
         │                              └────────┬────────┘
         │                                       │
         │ 4. Return remote URL                  │
         ▼                                       │
┌─────────────────┐                              │
│  OpenCode uses  │◀─────────────────────────────┘
│  remote as      │    All subsequent commands
│  workspace      │    go through the tunnel
└─────────────────┘
```

## Remote Install Layout

On each remote host, the stub installs under `~/.opencode-remote/`:

```
~/.opencode-remote/
├── bin/
│   └── opencode-remote-stub
├── run/
│   └── stub.token
├── log/
│   └── stub.log
└── state/
    ├── workspaces/
    ├── sessions/
    └── approvals/
```.

The plugin can also be pointed at a locally built stub binary explicitly via `stubBinaryPath` in plugin configuration when auto-discovery is not suitable.

## First-Launch Flow

The normal user-facing connection path is `remote-switch`. It resolves the configured provider host, ensures the remote stub binary and token are installed, starts the stub if needed, opens an SSH tunnel with local-port fallback, health-checks through the forwarded URL, creates a remote workspace/session, and persists the resulting binding for later recovery.

`remote-status` reloads persisted bindings and attempts to recover stale tunnels. If a persisted binding cannot be resolved or reached, it is removed from local state instead of blocking future connections.

`remote-doctor` runs the same connection path as a preflight. It can validate an existing recovered binding, or create and clean up a temporary test workspace when no binding exists.

For non-interactive validation, `scripts/verify-remote-lifecycle.mjs` runs the same provider registry and SSH manager against a configured host and verifies the full remote lifecycle: bootstrap, tunnel, health, workspace, session, permission, shell, and cleanup.

## API Compatibility

The stub implements a subset of OpenCode's API so OpenCode can treat it as a remote workspace:

| Endpoint | Purpose |
|----------|---------|
| `GET /global/health` | Is the stub running? |
| `GET /global/event` | Real-time updates |
| `GET/POST /experimental/workspace` | Create/manage workspaces |
| `POST /session` | Start a new session |
| `POST /session/{id}/shell` | Run a shell command |
| `POST /session/{id}/command` | Run a structured command payload |
| `POST /experimental/workspace/{id}/session-restore` | List sessions that belong to a workspace |
| `GET /permission` | Check for path approvals |
| `POST /permission/{id}/reply` | Approve/deny path access |

## Security Design

The stub is designed with security in mind:

- **Localhost only**: Binds to `127.0.0.1` - only accessible via the SSH tunnel
- **Token auth**: Every request must include a valid bearer token
- **Default deny**: All file access is blocked until explicitly approved
- **Symlink blocking**: Prevents escaping to arbitrary paths
- **Approval persistence**: "Always" approvals are saved but workspace-specific

## Recent Behavior Changes

Two recent runtime behaviors are important when reasoning about the current system:

1. **Host aliases**: a configured host can expose multiple friendly names through `aliases`, while still resolving to the same `ssh.host` target.
2. **Detached remote startup**: setup flows launch the stub in a separate session via Python `setsid` semantics so the process survives bootstrap SSH teardown more reliably on older Linux hosts.
3. **Lease-aware recovery**: persisted bindings can re-resolve their own lease by canonical host name, `ssh.host`, or alias instead of blocking reconnects.
4. **Verified first launch**: `remote-switch`, `remote-doctor`, and the live harness verify the tunnel and remote health before reporting a connection as ready.

## Why This Architecture?

We chose this approach because:

1. **No remote dependencies**: The stub is a single static binary - no Go installation needed on the remote
2. **Permission alignment**: Uses OpenCode's permission system instead of a custom one
3. **Provider-based**: Supports managing multiple hosts with labels
4. **SSH-based**: Leverages existing SSH infrastructure for transport and authentication
