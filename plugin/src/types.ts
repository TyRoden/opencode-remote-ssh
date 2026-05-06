export type SelectionStrategy = "first_available";

export type LeaseMode = "exclusive" | "shared";

export interface SSHConfig {
  host: string;
  user: string;
  port?: number;
  identityFile?: string;
  proxyJump?: string;
}

export interface HostConfig {
  name: string;
  ssh: SSHConfig;
  labels?: string[];
}

export interface ProviderConfig {
  strategy?: SelectionStrategy;
  labels?: string[];
  hosts: HostConfig[];
}

export interface TunnelConfig {
  localPortRange?: [number, number];
  connectTimeoutMs?: number;
  healthTimeoutMs?: number;
}

export interface DefaultsConfig {
  selectionStrategy?: SelectionStrategy;
  leaseMode?: LeaseMode;
  stubPort?: number;
}

export interface PluginConfig {
  installRoot?: string;
  tunnel?: TunnelConfig;
  defaults?: DefaultsConfig;
  providers?: Record<string, ProviderConfig>;
}

export interface ResolvedHost {
  provider: string;
  host: HostConfig;
  labels: string[];
  strategy: SelectionStrategy;
}

export interface LeaseRecord {
  host: string;
  workspaceID: string;
  mode: LeaseMode;
  acquiredAt: number;
}

export interface WorkspaceBinding {
  workspaceID: string;
  provider: string;
  host: string;
  remotePort: number;
  localPort: number;
  token: string;
  leaseMode: LeaseMode;
  status: "creating" | "ready" | "failed" | "removed";
  sessionID?: string;
}

export interface WorkspaceInfo {
  id: string;
  type: string;
  name?: string;
  branch?: string | null;
  directory?: string | null;
  extra?: Record<string, unknown> | null;
  projectID?: string;
}

export interface WorkspaceTarget {
  type: "remote";
  url: string;
  headers: Record<string, string>;
}
