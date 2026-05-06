import type { WorkspaceBinding } from "./types.js";

export class RuntimeState {
  private readonly bindings = new Map<string, WorkspaceBinding>();

  set(binding: WorkspaceBinding): void {
    this.bindings.set(binding.workspaceID, binding);
  }

  get(workspaceID: string): WorkspaceBinding | undefined {
    return this.bindings.get(workspaceID);
  }

  delete(workspaceID: string): void {
    this.bindings.delete(workspaceID);
  }

  list(): WorkspaceBinding[] {
    return Array.from(this.bindings.values());
  }
}
