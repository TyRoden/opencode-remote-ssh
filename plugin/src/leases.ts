import type { LeaseMode, LeaseRecord } from "./types.js";

export class LeaseManager {
  private readonly leases = new Map<string, LeaseRecord>();

  acquire(host: string, workspaceID: string, mode: LeaseMode): LeaseRecord {
    const current = this.leases.get(host);
    if (mode === "exclusive" && current) {
      throw new Error(`Host '${host}' is already leased by workspace '${current.workspaceID}'`);
    }

    const lease: LeaseRecord = {
      host,
      workspaceID,
      mode,
      acquiredAt: Date.now(),
    };
    this.leases.set(host, lease);
    return lease;
  }

  restore(host: string, workspaceID: string, mode: LeaseMode, acquiredAt?: number): LeaseRecord {
    const lease: LeaseRecord = {
      host,
      workspaceID,
      mode,
      acquiredAt: acquiredAt ?? Date.now(),
    };
    this.leases.set(host, lease);
    return lease;
  }

  list(): LeaseRecord[] {
    return Array.from(this.leases.values());
  }

  clear(): void {
    this.leases.clear();
  }

  hasWorkspace(workspaceID: string): boolean {
    for (const lease of this.leases.values()) {
      if (lease.workspaceID === workspaceID) {
        return true;
      }
    }
    return false;
  }

  release(host: string, workspaceID: string): void {
    const current = this.leases.get(host);
    if (!current) return;
    if (current.workspaceID !== workspaceID) return;
    this.leases.delete(host);
  }

  get(host: string): LeaseRecord | undefined {
    return this.leases.get(host);
  }
}

