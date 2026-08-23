import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkspaceBinding } from "./types.js";

const STATE_FILE = (() => {
  const home = homedir();
  if (home) {
    return join(home, ".config", "opencode", "opencode-remote-state.json");
  }
  return join(tmpdir(), "opencode-remote-state.json");
})();

export class RuntimeState {
  private readonly bindings = new Map<string, WorkspaceBinding>();

  constructor() {
    this.load();
  }

  set(binding: WorkspaceBinding): void {
    this.bindings.set(binding.workspaceID, binding);
    this.save();
  }

  get(workspaceID: string): WorkspaceBinding | undefined {
    return this.bindings.get(workspaceID);
  }

  delete(workspaceID: string): void {
    this.bindings.delete(workspaceID);
    this.save();
  }

  list(): WorkspaceBinding[] {
    return Array.from(this.bindings.values());
  }

  replace(binding: WorkspaceBinding): void {
    this.bindings.set(binding.workspaceID, binding);
    this.save();
  }

  private load(): void {
    if (!existsSync(STATE_FILE)) {
      return;
    }

    try {
      const raw = readFileSync(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const item of parsed) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const binding = item as WorkspaceBinding;
        if (!binding.workspaceID || !binding.provider || !binding.host || !binding.token) {
          continue;
        }
        this.bindings.set(binding.workspaceID, binding);
      }
    } catch {
      // Ignore malformed persisted state rather than failing plugin startup.
    }
  }

  private save(): void {
    const dir = dirname(STATE_FILE);
    mkdirSync(dir, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(Array.from(this.bindings.values()), null, 2), { mode: 0o600 });
    chmodSync(STATE_FILE, 0o600);
  }
}
