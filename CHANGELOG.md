# Changelog

All notable changes to opencode-remote-ssh will be documented in this file.

## [1.1.0] - 2026-05-06

### Changed

- Standardized the public setup flow around package-based plugin registration.
- Simplified the plugin to focus on the generic provider-based workspace lifecycle.
- Updated the setup and CLI documentation to match the current supported behavior.

### Fixed

- Removed shipped hard-coded hostnames, usernames, SSH key paths, and developer-local home directory assumptions from the plugin runtime.
- Removed implicit permission auto-approval so remote path access now follows the documented explicit approval flow.
- Fixed SSH bootstrap to resolve remote home directories dynamically and verify remote health before marking workspaces ready.
- Reworked remote stub startup to support older Linux hosts by using a statically built stub and a detached Python-based startup fallback when plain `nohup` is unreliable.
- Fixed `setup-host.sh` output so it now provides exact manual recovery steps when password-assisted bootstrap cannot complete automatically.
- Fixed `opencode-remote-cli.sh` so it clearly supports package-based plugin config only, safely refuses path-based mutation, and supports host aliases where `name` differs from `ssh.host`.

### Added

- Added documented operating guidance for password-only hosts, including both `sshpass` and manual authorized-keys bootstrap paths.
- Added documented host alias usage, including the `protagmanager` style of mapping a friendly name to a real SSH host.
- Added a tested path for bootstrapping and connecting to older CentOS/RHEL 7 era hosts.

## [1.0.0] - 2025-05-05

### Added

- **Provider-Based Host Management**: Define collections of remote hosts organized by providers with label-based selection
- **SSH Bootstrap**: Automatically uploads and installs the Go stub to remote hosts via SCP/SSH
- **Local SSH Tunnel**: Creates SSH port forwarding so the remote appears as a local endpoint
- **Permission-First Security**: Path access is denied by default; approvals are requested through OpenCode's normal permission flow
- **Persistent Approvals**: `always` approvals persist across stub restarts for the same workspace
- **CLI Tool**: `opencode-remote-cli.sh` for easy host management and setup
- **Workspace Adaptor Registration**: Plugin registers "ssh-provider" workspace type with OpenCode
- **Idempotent Setup**: Prevents duplicate entries when running setup multiple times
- **Automatic Key Generation**: Creates dedicated SSH key per host during setup if no key exists
- **Timestamped Backups**: Config backups are automatically created with timestamps

### Components

- **Plugin** (`plugin/`): TypeScript workspace adaptor for OpenCode
- **Stub** (`stub/`): Go HTTP service installed on remote hosts
- **Setup Scripts**:
  - `setup-host.sh`: SSH-based remote setup automation
  - `opencode-remote-cli.sh`: CLI for managing hosts in OpenCode config
  - `run-local-stub.sh`: Local stub testing helper

### Configuration

- Plugin configuration via `opencode.json` under `plugin` key
- Support for multiple providers with multiple hosts each
- SSH authentication via identity file or password
- Configurable tunnel ports, timeouts, and selection strategies

### API Endpoints (Stub)

The remote stub implements OpenCode-compatible endpoints:

- `GET /global/health` - Health/version check
- `GET /global/event` - SSE event stream
- `GET/POST /experimental/workspace*` - Workspace lifecycle
- `POST/GET/DELETE /session*` - Session lifecycle
- `POST /session/{id}/shell` - Execute shell command
- `POST /session/{id}/command` - Execute structured command
- `GET/POST /permission*` - Permission requests

### Security

- Stub binds only to `127.0.0.1` (localhost only)
- All requests require bearer token authentication
- Path access denied by default
- Symlink escape attempts blocked
- Commands constrained to approved directories

### Known Limitations

- Linux-only remote hosts in v1
- Exclusive host leases (one workspace per host at a time)
- No automatic stub restart detection in plugin

## [0.0.1] - 2025-04-01

### Added

- Initial prototype with basic SSH tunnel and stub
- Workspace adaptor scaffolding
- Basic permission system
