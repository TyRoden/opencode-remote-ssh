import type { ResolvedPluginConfig } from "./config.js";
import { LeaseManager } from "./leases.js";
import { ProviderRegistry } from "./provider.js";
import { buildBootstrapPlan } from "./bootstrap-plan.js";
import { SSHManager } from "./ssh.js";
import { RuntimeState } from "./state.js";
import type { WorkspaceInfo, WorkspaceTarget } from "./types.js";

export class RemoteWorkspaceAdaptor {
  private readonly leases = new LeaseManager();
  private readonly state = new RuntimeState();
  private readonly providers: ProviderRegistry;
  private readonly ssh: SSHManager;

  constructor(private readonly config: ResolvedPluginConfig) {
    this.providers = new ProviderRegistry(config, this.leases);
    this.ssh = new SSHManager(config);
  }

  configure(workspace: WorkspaceInfo): WorkspaceInfo {
    if (!workspace.extra || typeof workspace.extra.provider !== "string") {
      throw new Error("Workspace extra.provider must be configured");
    }

    const selection = this.providers.resolve({
      provider: workspace.extra.provider,
      host: typeof workspace.extra.host === "string" ? workspace.extra.host : undefined,
      labels: Array.isArray(workspace.extra.labels)
        ? workspace.extra.labels.filter((value): value is string => typeof value === "string")
        : undefined,
    });

    return {
      ...workspace,
      type: workspace.type || "ssh-provider",
      name: workspace.name ?? selection.host.name,
      extra: {
        ...(workspace.extra ?? {}),
        provider: selection.provider,
        host: selection.host.name,
        labels: selection.host.labels ?? [],
        selection: {
          strategy: selection.strategy,
        },
      },
    };
  }

  async create(workspace: WorkspaceInfo): Promise<void> {
    const configured = this.configure(workspace);
    const provider = configured.extra?.provider;
    if (typeof provider !== "string") throw new Error("Workspace provider is required");

    const selection = this.providers.resolve({
      provider,
      host: typeof configured.extra?.host === "string" ? configured.extra.host : undefined,
      labels: Array.isArray(configured.extra?.labels)
        ? configured.extra.labels.filter((value): value is string => typeof value === "string")
        : undefined,
    });

    this.leases.acquire(selection.host.name, configured.id, this.config.defaults.leaseMode);

    try {
      const bootstrap = await this.ssh.bootstrap(configured.id, selection);
      const plan = buildBootstrapPlan(selection, bootstrap);
      this.state.set({
        workspaceID: configured.id,
        provider: selection.provider,
        host: selection.host.name,
        remotePort: bootstrap.remotePort,
        localPort: bootstrap.localPort,
        token: bootstrap.token,
        leaseMode: this.config.defaults.leaseMode,
        status: "ready",
      });
      void plan;
    } catch (error) {
      this.leases.release(selection.host.name, configured.id);
      throw error;
    }
  }

  target(workspace: WorkspaceInfo): WorkspaceTarget {
    const binding = this.state.get(workspace.id);
    if (!binding) {
      throw new Error(`Workspace '${workspace.id}' is not active`);
    }

    return {
      type: "remote",
      url: `http://127.0.0.1:${binding.localPort}`,
      headers: {
        authorization: `Bearer ${binding.token}`,
      },
    };
  }

  async remove(workspace: WorkspaceInfo): Promise<void> {
    const binding = this.state.get(workspace.id);
    if (!binding) return;

    await this.ssh.teardown(binding);
    this.leases.release(binding.host, workspace.id);
    this.state.delete(workspace.id);
  }
}
