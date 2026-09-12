#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../plugin/dist/config.js";
import { LeaseManager } from "../plugin/dist/leases.js";
import { ProviderRegistry } from "../plugin/dist/provider.js";
import { SSHManager } from "../plugin/dist/ssh.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfig = resolve(homedir(), ".config", "opencode", "opencode.json");

function usage() {
  console.error([
    "Usage: scripts/verify-remote-lifecycle.mjs --host <host> [--provider <provider>] [--config <path>]",
    "",
    "Runs the real remote lifecycle: resolve, bootstrap, tunnel, health, workspace, session, permission, shell, cleanup.",
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const out = { config: defaultConfig, provider: undefined, host: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") out.config = argv[++i];
    else if (arg === "--provider") out.provider = argv[++i];
    else if (arg === "--host") out.host = argv[++i];
    else if (arg === "-h" || arg === "--help") usage();
    else throw new Error(`Unknown argument '${arg}'`);
  }
  if (!out.host) usage();
  return out;
}

function pluginConfigFromOpenCodeConfig(configPath) {
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  const repoPluginPath = resolve(repoRoot, "plugin");

  for (const entry of plugins) {
    if (!Array.isArray(entry) || entry.length < 2 || !entry[1] || typeof entry[1] !== "object") {
      continue;
    }

    const target = String(entry[0]);
    const resolvedTarget = target.startsWith("/") ? resolve(target) : target;
    if (
      target === "opencode-remote-provider" ||
      resolvedTarget === repoPluginPath ||
      basename(target) === "opencode-remote-provider" ||
      target.includes("remote-provider")
    ) {
      return entry[1];
    }
  }

  throw new Error(`No opencode-remote-provider plugin config found in ${configPath}`);
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { response, body };
}

async function assertOk(label, url, options) {
  const result = await jsonFetch(url, options);
  if (!result.response.ok) {
    throw new Error(`${label} failed: HTTP ${result.response.status} ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginConfig = pluginConfigFromOpenCodeConfig(resolve(args.config));
  const config = resolveConfig(pluginConfig);
  const provider = args.provider || Object.keys(config.providers)[0] || "default";

  if (!existsSync(config.stubBinaryPath)) {
    throw new Error(`Stub binary not found at '${config.stubBinaryPath}'. Build it before running the harness.`);
  }

  const leases = new LeaseManager();
  const providers = new ProviderRegistry(config, leases);
  const ssh = new SSHManager(config);
  const workspaceID = `harness-${Date.now()}-${args.host.replace(/\s+/g, "-")}`;
  const selection = providers.acquireResolved({ provider, host: args.host }, workspaceID);
  const bootstrap = await ssh.bootstrap(workspaceID, selection);
  const binding = {
    workspaceID,
    provider: selection.provider,
    host: selection.host.name,
    remotePort: bootstrap.remotePort,
    localPort: bootstrap.localPort,
    token: bootstrap.token,
    leaseMode: config.defaults.leaseMode,
    status: "ready",
    tunnelPID: bootstrap.tunnelPID,
  };

  const baseURL = `http://127.0.0.1:${binding.localPort}`;
  const headers = { Authorization: `Bearer ${binding.token}` };
  const jsonHeaders = { ...headers, "Content-Type": "application/json" };
  const sessionID = `sess_${Date.now()}`;
  let cleanupError;

  try {
    const health = await assertOk("health", `${baseURL}/global/health`, { headers });
    await assertOk("workspace create", `${baseURL}/experimental/workspace`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        id: workspaceID,
        type: "ssh-provider",
        name: "Harness Workspace",
        extra: { provider: selection.provider, host: selection.host.name },
      }),
    });
    await assertOk("session create", `${baseURL}/session`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ id: sessionID, title: "Harness Session", workspaceID }),
    });

    const shell = await jsonFetch(`${baseURL}/session/${sessionID}/shell`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ command: "pwd" }),
    });

    if (shell.response.status === 403) {
      const permissions = await assertOk("permission list", `${baseURL}/permission`, { headers });
      const request = permissions.find((item) => item.sessionID === sessionID && item.permission === "path.access");
      if (!request) {
        throw new Error(`Shell required permission but no matching request was listed: ${JSON.stringify(permissions)}`);
      }
      await assertOk("permission approve", `${baseURL}/permission/${request.id}/reply`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ reply: "once" }),
      });
    } else if (!shell.response.ok) {
      throw new Error(`shell permission probe failed: HTTP ${shell.response.status} ${JSON.stringify(shell.body)}`);
    }

    const shellVerified = await assertOk("shell", `${baseURL}/session/${sessionID}/shell`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ command: "pwd" }),
    });

    console.log(JSON.stringify({
      success: true,
      provider: selection.provider,
      host: selection.host.name,
      sshHost: selection.host.ssh.host,
      workspaceID,
      sessionID,
      localPort: binding.localPort,
      remotePort: binding.remotePort,
      tunnelPID: binding.tunnelPID,
      health,
      shell: shellVerified,
    }, null, 2));
  } finally {
    try {
      await fetch(`${baseURL}/session/${sessionID}`, { method: "DELETE", headers });
      await fetch(`${baseURL}/experimental/workspace/${workspaceID}`, { method: "DELETE", headers });
      await ssh.teardown(binding);
      leases.release(selection.host.name, workspaceID);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      console.error(`Cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
