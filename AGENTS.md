# Agent Guidelines for opencode-remote-ssh

## Critical Rules

### Never Hardcode User-Specific Settings
This project is published on Git for other users. **NEVER** hardcode:
- Specific IP addresses (e.g., `192.168.50.94`, `67.205.147.74`)
- Usernames (e.g., `troden`, `root`)
- SSH key paths specific to the developer (e.g., `/home/troden/.ssh/...`)
- Any configuration that relies on the developer's local environment

### Always Use Configuration
- Read settings from `opencode.json` config
- Use environment variables or config files for user-specific values
- When adding aliases or host mappings, build them dynamically from the user's config

### Remote Provider Runtime Rules
- Treat `~/.config/opencode/opencode-remote-state.json` as live lease/binding state, not sample data. Remove stale entries before concluding a host is unavailable or already leased.
- When verifying a managed remote workspace, test the real adaptor lifecycle: `configure`, `create`, `target`, health check through the forwarded URL, and `remove`.
- A configured host may be selected by canonical `name`, `ssh.host`, or any configured alias; preserve all three resolution paths when changing provider logic.
- Re-resolution for an existing workspace must be lease-aware. The same workspace should be able to resolve and reuse its own explicit host lease during `configure` and `target`.
- `SSHManager.bootstrap()` must not assume the stub binary can always be overwritten with `scp`. On some hosts the live install path rejects SFTP-backed overwrite even though the existing stub is healthy. Prefer reusing the installed binary when its hash matches the local stub.
- Before pushing remote-provider changes, verify both repo tests and one real host lifecycle against current config rather than relying on unit tests alone.

### Before Committing
- Search for any hardcoded paths, IPs, or usernames
- Replace with config-based alternatives or placeholders
- Test with generic/example values

## Example: Host Resolution
```typescript
// BAD - hardcoded
const host = "192.168.50.94";

// GOOD - read from config
if (config.providers[providerName]?.hosts) {
  for (const h of config.providers[providerName].hosts) {
    if (h.name === targetHost) {
      host = h.ssh.host;
    }
  }
}
```
