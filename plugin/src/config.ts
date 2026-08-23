import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DefaultsConfig, PluginConfig, ProviderConfig, TunnelConfig } from "./types.js";

const DEFAULT_TUNNEL: Required<TunnelConfig> = {
  localPortRange: [39000, 39999],
  connectTimeoutMs: 15_000,
  healthTimeoutMs: 5_000,
};

const DEFAULTS: Required<DefaultsConfig> = {
  selectionStrategy: "first_available",
  leaseMode: "exclusive",
  stubPort: 39217,
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STUB_BINARY = resolve(join(MODULE_DIR, "../../stub/bin/opencode-remote-stub"));

export interface ResolvedPluginConfig extends PluginConfig {
  installRoot: string;
  stubBinaryPath: string;
  tunnel: Required<TunnelConfig>;
  defaults: Required<DefaultsConfig>;
  providers: Record<string, ProviderConfig>;
}

export function resolveConfig(input: PluginConfig): ResolvedPluginConfig {
  // If no config provided, return empty config and let it fail gracefully at runtime
  if (!input || !input.providers || Object.keys(input.providers).length === 0) {
    return {
      installRoot: "~/.opencode-remote",
      stubBinaryPath: DEFAULT_STUB_BINARY,
      tunnel: DEFAULT_TUNNEL,
      defaults: DEFAULTS,
      providers: {},
    };
  }

  // Filter out invalid providers
  const validProviders: Record<string, ProviderConfig> = {};
  for (const [providerName, provider] of Object.entries(input.providers)) {
    if (provider.hosts && provider.hosts.length > 0) {
      const validHosts = provider.hosts.filter(h => h.name && h.ssh?.host && h.ssh?.user);
      if (validHosts.length > 0) {
        validProviders[providerName] = { ...provider, hosts: validHosts };
      }
    }
  }

  return {
    ...input,
    installRoot: input.installRoot ?? "~/.opencode-remote",
    stubBinaryPath: input.stubBinaryPath ? resolve(input.stubBinaryPath) : DEFAULT_STUB_BINARY,
    tunnel: {
      ...DEFAULT_TUNNEL,
      ...input.tunnel,
    },
    defaults: {
      ...DEFAULTS,
      ...input.defaults,
    },
    providers: validProviders,
  };
}
