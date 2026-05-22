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

On each remote host, the stub installs under `~/.opencode-remote-ssh/`:

```
~/.opencode-remote-ssh/
├── bin/
│   └── opencode-remote-ssh-stub   # The Go binary (your code runs here)
├── run/
│   ├── stub.token             # Authentication token
│   └── stub.pid               # Process ID (optional)
├── log/
│   └── stub.log               # Runtime logs
├── state/
│   ├── workspaces/            # Workspace metadata
│   ├── sessions/              # Active session data
│   └── approvals/             # Persisted "always" permissions
└── version                    # Version marker
```

## API Compatibility

The stub implements a subset of OpenCode's API so OpenCode can treat it as a remote workspace:

| Endpoint | Purpose |
|----------|---------|
| `GET /global/health` | Is the stub running? |
| `GET /global/event` | Real-time updates |
| `GET/POST /experimental/workspace` | Create/manage workspaces |
| `POST /session` | Start a new session |
| `POST /session/{id}/shell` | Run a command |
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
2. **Detached remote startup**: `setup-host.sh` launches the stub in a separate session via Python `setsid` semantics so the process survives bootstrap SSH teardown more reliably on older Linux hosts.

## Why This Architecture?

We chose this approach because:

1. **No remote dependencies**: The stub is a single static binary - no Go installation needed on the remote
2. **Permission alignment**: Uses OpenCode's permission system instead of a custom one
3. **Provider-based**: Supports managing multiple hosts with labels
4. **SSH-based**: Leverages existing SSH infrastructure for transport and authentication
