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

async function ensureBindingReady(binding: import("./types.js").WorkspaceBinding): Promise<import("./types.js").WorkspaceBinding> {
  const selection = providers.resolve({
    provider: binding.provider,
    host: binding.host,
  });
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
  return providers.resolve(providerRequestForWorkspace(workspace));
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
