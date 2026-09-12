import type { HostConfig, ResolvedHost } from "./types.js";
import type { ResolvedPluginConfig } from "./config.js";
import { LeaseManager } from "./leases.js";

export interface HostSelectionRequest {
  provider: string;
  host?: string;
  labels?: string[];
}

export class ProviderRegistry {
  constructor(
    private readonly config: ResolvedPluginConfig,
    private readonly leases: LeaseManager,
  ) {}

  resolve(request: HostSelectionRequest): ResolvedHost {
    return this.resolveWithLease(request).selection;
  }

  resolveWithLease(request: HostSelectionRequest, workspaceID?: string) {
    const provider = this.config.providers[request.provider];
    if (!provider) {
      throw new Error(`Unknown provider '${request.provider}'`);
    }

    const strategy = provider.strategy ?? this.config.defaults.selectionStrategy;
    const requiredLabels = new Set([...(provider.labels ?? []), ...(request.labels ?? [])]);

    const requestedHost = request.host;
    const candidates = requestedHost
      ? provider.hosts.filter(
          (item) =>
            item.name === requestedHost ||
            item.ssh.host === requestedHost ||
            item.aliases?.includes(requestedHost) === true,
        )
      : provider.hosts.filter((candidate) => this.matchesLabels(candidate, requiredLabels));

    const requestedLabels = Array.from(requiredLabels);

    if (request.host && candidates.length === 0) {
      throw new Error(`Host '${request.host}' not found in provider '${request.provider}'`);
    }

    if (!request.host && candidates.length === 0) {
      throw new Error(`No available host found in provider '${request.provider}'`);
    }

    if (!workspaceID) {
      const host = candidates.find((candidate) => !this.leases.get(candidate.name));
      if (!host) {
        throw new Error(`No available host found in provider '${request.provider}'`);
      }
      return {
        selection: this.toResolved(request.provider, requestedLabels, host, strategy)
      };
    }

    const existingHost = candidates.find((candidate) => this.leases.get(candidate.name)?.workspaceID === workspaceID);
    if (existingHost) {
      return {
        selection: this.toResolved(request.provider, requestedLabels, existingHost, strategy),
        lease: this.leases.get(existingHost.name),
      };
    }

    for (const host of candidates) {
      try {
        const lease = this.leases.acquire(host.name, workspaceID, this.config.defaults.leaseMode);
        return {
          selection: this.toResolved(request.provider, requestedLabels, host, strategy),
          lease,
        };
      } catch {
        // Try the next candidate. For explicit-host selection this loop has one item,
        // so we naturally fall through to the final not-available error.
      }
    }

    if (request.host) {
      throw new Error(`Host '${request.host}' is already leased`);
    }

    throw new Error(`No available host found in provider '${request.provider}'`);
  }

  acquireResolved(request: HostSelectionRequest, workspaceID: string): ResolvedHost {
    return this.resolveWithLease(request, workspaceID).selection;
  }

  release(host: string, workspaceID: string): void {
    this.leases.release(host, workspaceID);
  }

  getLease(host: string) {
    return this.leases.get(host);
  }

  private matchesLabels(host: HostConfig, labels: Set<string>): boolean {
    const hostLabels = new Set(host.labels ?? []);
    for (const label of labels) {
      if (!hostLabels.has(label)) return false;
    }
    return true;
  }

  private toResolved(provider: string, labels: string[], host: HostConfig, strategy: "first_available"): ResolvedHost {
    return {
      provider,
      host,
      labels: host.labels ?? labels,
      strategy,
    };
  }
}
