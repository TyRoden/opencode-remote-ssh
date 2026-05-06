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

function resolveProvider(workspace: WorkspaceInfo) {
  if (!workspace.extra || typeof (workspace.extra as Record<string, unknown>).provider !== "string") {
    throw new Error("Workspace extra.provider must be configured");
  }

  return providers.resolve({
    provider: (workspace.extra as Record<string, unknown>).provider as string,
    host: typeof (workspace.extra as Record<string, unknown>).host === "string"
      ? ((workspace.extra as Record<string, unknown>).host as string)
      : undefined,
    labels: Array.isArray((workspace.extra as Record<string, unknown>).labels)
      ? ((workspace.extra as Record<string, unknown>).labels as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
  });
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
  const selection = resolveProvider(workspace);

  leases.acquire(selection.host.name, workspace.id, config.defaults.leaseMode);

  try {
    const bootstrap = await sshManager.bootstrap(workspace.id, selection);

    state.set({
      workspaceID: workspace.id,
      provider: selection.provider,
      host: selection.host.name,
      remotePort: bootstrap.remotePort,
      localPort: bootstrap.localPort,
      token: bootstrap.token,
      leaseMode: config.defaults.leaseMode,
      status: "ready",
    });
  } catch (error) {
    leases.release(selection.host.name, workspace.id);
    throw error;
  }
}

async function removeWorkspace(workspace: WorkspaceInfo): Promise<void> {
  const binding = state.get(workspace.id);
  if (!binding) {
    return;
  }

  await sshManager.teardown(binding);
  leases.release(binding.host, workspace.id);
  state.delete(workspace.id);
}

function getTarget(workspace: WorkspaceInfo): WorkspaceTarget {
  const binding = state.get(workspace.id);
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
            const selection = providers.resolve({
              provider: providerName,
              host: args.host,
            });

            leases.acquire(selection.host.name, workspaceID, config.defaults.leaseMode);

            try {
              const bootstrap = await sshManager.bootstrap(workspaceID, selection);
              state.set({
                workspaceID,
                provider: selection.provider,
                host: selection.host.name,
                remotePort: bootstrap.remotePort,
                localPort: bootstrap.localPort,
                token: bootstrap.token,
                leaseMode: config.defaults.leaseMode,
                status: "ready",
              });
            } catch (error) {
              leases.release(selection.host.name, workspaceID);
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
          return JSON.stringify({ workspaces: state.list() });
        },
      }),
      "remote-workspace-remove": tool({
        description: "Remove a remote workspace",
        args: {
          workspaceID: tool.schema.string().describe("Workspace ID to remove"),
        },
        async execute(args) {
          const binding = state.get(args.workspaceID);
          if (!binding) {
            return JSON.stringify({ success: false, error: "Workspace not found" });
          }

          await sshManager.teardown(binding);
          leases.release(binding.host, args.workspaceID);
          state.delete(args.workspaceID);
          return JSON.stringify({ success: true, message: `Workspace ${args.workspaceID} removed` });
        },
      }),
    },
  };
}

export type { PluginConfig } from "./types.js";
