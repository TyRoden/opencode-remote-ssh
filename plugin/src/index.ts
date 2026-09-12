import type { PluginInput, WorkspaceAdapter, WorkspaceInfo, WorkspaceTarget } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { resolveConfig, type ResolvedPluginConfig } from "./config.js";
import { LeaseManager } from "./leases.js";
import { ProviderRegistry } from "./provider.js";
import { SSHManager } from "./ssh.js";
import { RuntimeState } from "./state.js";

const leases = new LeaseManager();
const state = new RuntimeState();
let config: ResolvedPluginConfig;
let sshManager: SSHManager;
let providers: ProviderRegistry;

function providerRequestForWorkspace(workspace: WorkspaceInfo) {
  if (!workspace.extra || typeof (workspace.extra as Record<string, unknown>).provider !== "string") {
    throw new Error("Workspace extra.provider must be configured");
  }

  return {
    provider: (workspace.extra as Record<string, unknown>).provider as string,
    host: typeof (workspace.extra as Record<string, unknown>).host === "string"
      ? ((workspace.extra as Record<string, unknown>).host as string)
      : undefined,
    labels: Array.isArray((workspace.extra as Record<string, unknown>).labels)
      ? ((workspace.extra as Record<string, unknown>).labels as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createRemoteSession(binding: import("./types.js").WorkspaceBinding, title = "Remote Session"): Promise<string> {
  const sessionID = `sess_${Date.now()}`;
  const response = await fetch(`http://127.0.0.1:${binding.localPort}/session`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${binding.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: sessionID, title, workspaceID: binding.workspaceID }),
  });

  if (!response.ok) {
    throw new Error(`Remote session create failed: HTTP ${response.status} ${await response.text()}`);
  }

  return sessionID;
}

async function createRemoteWorkspace(binding: import("./types.js").WorkspaceBinding): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${binding.localPort}/experimental/workspace`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${binding.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: binding.workspaceID,
      type: "ssh-provider",
      name: "Remote Workspace",
      extra: { provider: binding.provider, host: binding.host },
    }),
  });

  if (!response.ok) {
    throw new Error(`Remote workspace create failed: HTTP ${response.status} ${await response.text()}`);
  }
}

async function createConnectedBinding(providerName: string, host: string | undefined, workspaceName: string) {
  const workspaceID = `remote-${Date.now()}-${workspaceName.replace(/\s+/g, "-")}`;
  const selection = providers.acquireResolved({ provider: providerName, host }, workspaceID);

  try {
    const bootstrap = await sshManager.bootstrap(workspaceID, selection);
    const binding: import("./types.js").WorkspaceBinding = {
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

    await createRemoteWorkspace(binding);
    binding.sessionID = await createRemoteSession(binding);
    setBinding(binding);
    return binding;
  } catch (error) {
    providers.release(selection.host.name, workspaceID);
    throw error;
  }
}

async function findReusableBinding(providerName: string, host?: string) {
  for (const binding of listBindings()) {
    if (binding.status === "removed" || binding.provider !== providerName) {
      continue;
    }

    try {
      const selection = providers.acquireResolved({ provider: providerName, host: host ?? binding.host }, binding.workspaceID);
      if (selection.host.name !== binding.host) {
        providers.release(selection.host.name, binding.workspaceID);
        continue;
      }

      const recovered = await sshManager.ensureRecoveredBinding(binding, selection);
      if (!recovered.sessionID) {
        recovered.sessionID = await createRemoteSession(recovered);
      }
      replaceBinding(recovered);
      return recovered;
    } catch {
      providers.release(binding.host, binding.workspaceID);
      state.delete(binding.workspaceID);
    }
  }

  return undefined;
}

async function removeRemoteWorkspace(binding: import("./types.js").WorkspaceBinding): Promise<void> {
  if (binding.sessionID) {
    try {
      await fetch(`http://127.0.0.1:${binding.localPort}/session/${binding.sessionID}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${binding.token}` },
      });
    } catch {
      // Best-effort remote cleanup; local lease/tunnel cleanup still runs below.
    }
  }

  try {
    await fetch(`http://127.0.0.1:${binding.localPort}/experimental/workspace/${binding.workspaceID}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${binding.token}` },
    });
  } catch {
    // Best-effort remote cleanup; local lease/tunnel cleanup still runs below.
  }
}

async function ensureBindingReady(binding: import("./types.js").WorkspaceBinding): Promise<import("./types.js").WorkspaceBinding> {
  const selection = providers.acquireResolved({
    provider: binding.provider,
    host: binding.host,
  }, binding.workspaceID);
  const recovered = await sshManager.ensureRecoveredBinding(binding, selection);
  if (recovered.localPort !== binding.localPort || recovered.tunnelPID !== binding.tunnelPID || recovered.status !== binding.status) {
    state.replace(recovered);
    return recovered;
  }
  return binding;
}

function rehydrateLeasesFromState(): void {
  leases.clear();
  for (const binding of state.list()) {
    if (binding.status === "removed") {
      continue;
    }
    leases.restore(binding.host, binding.workspaceID, binding.leaseMode);
  }
}

async function removeBinding(binding: import("./types.js").WorkspaceBinding): Promise<void> {
  await removeRemoteWorkspace(binding);
  await sshManager.closeRecoveredBinding(binding);
  providers.release(binding.host, binding.workspaceID);
  state.delete(binding.workspaceID);
}

function setBinding(binding: import("./types.js").WorkspaceBinding): void {
  state.set(binding);
}

function replaceBinding(binding: import("./types.js").WorkspaceBinding): void {
  state.replace(binding);
}

function listBindings() {
  return state.list();
}

function getBinding(workspaceID: string) {
  return state.get(workspaceID);
}

function deleteBinding(workspaceID: string) {
  state.delete(workspaceID);
}

function releaseBindingHost(host: string, workspaceID: string) {
  providers.release(host, workspaceID);
}

function releaseRecoveredBinding(binding: import("./types.js").WorkspaceBinding) {
  providers.release(binding.host, binding.workspaceID);
}

async function getReadyBinding(workspaceID: string) {
  const binding = state.get(workspaceID);
  if (!binding) {
    return undefined;
  }
  return ensureBindingReady(binding);
}

function _stateForTesting() {
  return state;
}

function _leasesForTesting() {
  return leases;
}

function _providersForTesting() {
  return providers;
}

function _sshManagerForTesting() {
  return sshManager;
}

function _configForTesting() {
  return config;
}

function _rehydrateForTesting() {
  rehydrateLeasesFromState();
}

void _stateForTesting;
void _leasesForTesting;
void _providersForTesting;
void _sshManagerForTesting;
void _configForTesting;
void _rehydrateForTesting;
void replaceBinding;
void deleteBinding;
void releaseBindingHost;
void releaseRecoveredBinding;
void getReadyBinding;
void listBindings;
void getBinding;
void setBinding;
void removeBinding;


function resolveProvider(workspace: WorkspaceInfo) {
  return providers.acquireResolved(providerRequestForWorkspace(workspace), workspace.id);
}

function configureWorkspace(workspace: WorkspaceInfo): WorkspaceInfo {
  const selection = resolveProvider(workspace);

  return {
    ...workspace,
    type: workspace.type || "ssh-provider",
    name: workspace.name ?? selection.host.name,
    extra: {
      ...(workspace.extra ?? {}),
      provider: selection.provider,
      host: selection.host.name,
    },
  };
}

async function createWorkspace(workspace: WorkspaceInfo): Promise<void> {
  const selection = providers.acquireResolved(providerRequestForWorkspace(workspace), workspace.id);

  try {
    const bootstrap = await sshManager.bootstrap(workspace.id, selection);

    setBinding({
      workspaceID: workspace.id,
      provider: selection.provider,
      host: selection.host.name,
      remotePort: bootstrap.remotePort,
      localPort: bootstrap.localPort,
      token: bootstrap.token,
      leaseMode: config.defaults.leaseMode,
      status: "ready",
      tunnelPID: bootstrap.tunnelPID,
    });
  } catch (error) {
    providers.release(selection.host.name, workspace.id);
    throw error;
  }
}

async function removeWorkspace(workspace: WorkspaceInfo): Promise<void> {
  const binding = getBinding(workspace.id);
  if (!binding) {
    return;
  }

  await removeBinding(binding);
}

async function getTarget(workspace: WorkspaceInfo): Promise<WorkspaceTarget> {
  const binding = await getReadyBinding(workspace.id);
  if (!binding) {
    throw new Error(`Workspace '${workspace.id}' is not active`);
  }

  return {
    type: "remote",
    url: `http://127.0.0.1:${binding.localPort}`,
    headers: {
      Authorization: `Bearer ${binding.token}`,
    },
  };
}

const sshProviderAdaptor: WorkspaceAdapter = {
  name: "SSH Provider",
  description: "Remote Linux host over SSH-backed Go stub",
  configure: configureWorkspace,
  create: createWorkspace,
  remove: removeWorkspace,
  target: getTarget,
};

export default async function OpencodeRemotePlugin(input: PluginInput, options?: Record<string, unknown>) {
  if (!input.experimental_workspace) {
    throw new Error("[opencode-remote] experimental_workspace not available");
  }

  config = resolveConfig((options as ResolvedPluginConfig | undefined) ?? { providers: {} });
  sshManager = new SSHManager(config);
  providers = new ProviderRegistry(config, leases);
  rehydrateLeasesFromState();
  input.experimental_workspace.register("ssh-provider", sshProviderAdaptor);

  return {
    tool: {
      "remote-workspace-create": tool({
        description: "Create a remote SSH workspace on a configured host",
        args: {
          workspaceName: tool.schema.string().describe("Name for the workspace"),
          provider: tool.schema.string().optional().describe("Provider name from plugin config"),
          host: tool.schema.string().optional().describe("Specific configured host name to use"),
        },
        async execute(args) {
          try {
            const providerName = args.provider || Object.keys(config.providers)[0];
            if (!providerName) {
              throw new Error("No providers configured for opencode-remote-provider");
            }

            const workspaceID = `remote-${Date.now()}-${args.workspaceName.replace(/\s+/g, "-")}`;
            const selection = providers.acquireResolved({
              provider: providerName,
              host: args.host,
            }, workspaceID);

            try {
              const bootstrap = await sshManager.bootstrap(workspaceID, selection);
              setBinding({
                workspaceID,
                provider: selection.provider,
                host: selection.host.name,
                remotePort: bootstrap.remotePort,
                localPort: bootstrap.localPort,
                token: bootstrap.token,
                leaseMode: config.defaults.leaseMode,
                status: "ready",
                tunnelPID: bootstrap.tunnelPID,
              });
            } catch (error) {
              providers.release(selection.host.name, workspaceID);
              throw error;
            }

            return JSON.stringify({
              success: true,
              workspaceID,
              provider: selection.provider,
              host: selection.host.name,
              message: `Remote workspace '${args.workspaceName}' created on ${selection.host.name}`,
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }),
      "remote-switch": tool({
        description: "Connect to a configured remote SSH host and make it available as the active remote workspace",
        args: {
          host: tool.schema.string().optional().describe("Configured host name, ssh.host, or alias to connect to"),
          provider: tool.schema.string().optional().describe("Provider name from plugin config"),
        },
        async execute(args) {
          try {
            const providerName = args.provider || Object.keys(config.providers)[0] || "default";
            const binding = await findReusableBinding(providerName, args.host)
              ?? await createConnectedBinding(providerName, args.host, args.host || providerName);

            return JSON.stringify({
              success: true,
              type: "remote",
              url: `http://127.0.0.1:${binding.localPort}`,
              headers: { Authorization: `Bearer ${binding.token}` },
              workspaceID: binding.workspaceID,
              sessionID: binding.sessionID,
              provider: binding.provider,
              host: binding.host,
              localPort: binding.localPort,
              message: `SWITCHED TO REMOTE: ${binding.host} on local port ${binding.localPort}`,
            });
          } catch (error) {
            return JSON.stringify({ success: false, error: errorMessage(error) });
          }
        },
      }),
      "remote-status": tool({
        description: "Check remote SSH workspace connection status and recover stale tunnels when possible",
        args: {},
        async execute() {
          const bindings = [];
          for (const binding of listBindings()) {
            try {
              bindings.push(await ensureBindingReady(binding));
            } catch (error) {
              state.delete(binding.workspaceID);
              providers.release(binding.host, binding.workspaceID);
              bindings.push({
                workspaceID: binding.workspaceID,
                provider: binding.provider,
                host: binding.host,
                status: "failed",
                error: errorMessage(error),
              });
            }
          }

          return JSON.stringify({ connected: bindings.some((binding) => binding.status === "ready"), workspaces: bindings });
        },
      }),
      "remote-disconnect": tool({
        description: "Disconnect one or all remote SSH workspaces and return to local operation",
        args: {
          workspaceID: tool.schema.string().optional().describe("Workspace ID to disconnect; defaults to all active remote workspaces"),
        },
        async execute(args) {
          const bindings = args.workspaceID ? listBindings().filter((binding) => binding.workspaceID === args.workspaceID) : listBindings();
          if (bindings.length === 0) {
            return JSON.stringify({ success: false, error: "No active remote connection to disconnect." });
          }

          const removed = [];
          for (const binding of bindings) {
            await removeBinding(binding);
            removed.push(binding.workspaceID);
          }

          return JSON.stringify({ success: true, removed, message: "Disconnected remote workspace connection(s)." });
        },
      }),
      "remote-doctor": tool({
        description: "Run a live remote SSH provider preflight by connecting, health-checking, and cleaning up a test workspace",
        args: {
          host: tool.schema.string().optional().describe("Configured host name, ssh.host, or alias to test"),
          provider: tool.schema.string().optional().describe("Provider name from plugin config"),
        },
        async execute(args) {
          const providerName = args.provider || Object.keys(config.providers)[0] || "default";
          let binding: import("./types.js").WorkspaceBinding | undefined;
          let createdForDoctor = false;
          try {
            binding = await findReusableBinding(providerName, args.host);
            if (!binding) {
              binding = await createConnectedBinding(providerName, args.host, `doctor-${args.host || providerName}`);
              createdForDoctor = true;
            }
            const response = await fetch(`http://127.0.0.1:${binding.localPort}/global/health`, {
              headers: { Authorization: `Bearer ${binding.token}` },
            });
            if (!response.ok) {
              throw new Error(`Health check failed through target: HTTP ${response.status} ${await response.text()}`);
            }

            return JSON.stringify({
              success: true,
              provider: binding.provider,
              host: binding.host,
              workspaceID: binding.workspaceID,
              sessionID: binding.sessionID,
              localPort: binding.localPort,
              reused: !createdForDoctor,
              health: await response.json(),
            });
          } catch (error) {
            return JSON.stringify({ success: false, error: errorMessage(error) });
          } finally {
            if (binding && createdForDoctor) {
              try {
                await removeBinding(binding);
              } catch {
                // Doctor should report the primary failure rather than hide it with cleanup noise.
              }
            }
          }
        },
      }),
      "remote-workspace-list": tool({
        description: "List active remote workspaces",
        args: {},
        async execute() {
          const recovered = [];
          for (const binding of listBindings()) {
            recovered.push(await ensureBindingReady(binding));
          }
          return JSON.stringify({ workspaces: recovered });
        },
      }),
      "remote-workspace-remove": tool({
        description: "Remove a remote workspace",
        args: {
          workspaceID: tool.schema.string().describe("Workspace ID to remove"),
        },
        async execute(args) {
          const binding = getBinding(args.workspaceID);
          if (!binding) {
            return JSON.stringify({ success: false, error: "Workspace not found" });
          }

          await removeBinding(binding);
          return JSON.stringify({ success: true, message: `Workspace ${args.workspaceID} removed` });
        },
      }),
    },
  };
}

export type { PluginConfig } from "./types.js";
