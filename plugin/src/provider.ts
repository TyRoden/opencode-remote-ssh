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
    const provider = this.config.providers[request.provider];
    if (!provider) {
      throw new Error(`Unknown provider '${request.provider}'`);
    }

    if (request.host) {
      const host = provider.hosts.find((item) => item.name === request.host);
      if (!host) {
        throw new Error(`Host '${request.host}' not found in provider '${request.provider}'`);
      }
      this.assertAvailable(host);
      return this.toResolved(request.provider, provider.labels ?? [], host, provider.strategy ?? this.config.defaults.selectionStrategy);
    }

    const requiredLabels = new Set([...(provider.labels ?? []), ...(request.labels ?? [])]);
    const host = provider.hosts.find((candidate) => this.matchesLabels(candidate, requiredLabels) && !this.leases.get(candidate.name));
    if (!host) {
      throw new Error(`No available host found in provider '${request.provider}'`);
    }

    return this.toResolved(request.provider, Array.from(requiredLabels), host, provider.strategy ?? this.config.defaults.selectionStrategy);
  }

  private matchesLabels(host: HostConfig, labels: Set<string>): boolean {
    const hostLabels = new Set(host.labels ?? []);
    for (const label of labels) {
      if (!hostLabels.has(label)) return false;
    }
    return true;
  }

  private assertAvailable(host: HostConfig): void {
    if (this.leases.get(host.name)) {
      throw new Error(`Host '${host.name}' is already leased`);
    }
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
