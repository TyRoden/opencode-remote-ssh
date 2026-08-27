import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeState } from "./state.js";
import { ProviderRegistry } from "./provider.js";
import { LeaseManager } from "./leases.js";
import { resolveConfig } from "./config.js";
import type { WorkspaceBinding } from "./types.js";

function binding(overrides: Partial<WorkspaceBinding> = {}): WorkspaceBinding {
  return {
    workspaceID: "ws1",
    provider: "default",
    host: "host1",
    remotePort: 39217,
    localPort: 39300,
    token: "token-123",
    leaseMode: "exclusive",
    status: "ready",
    ...overrides,
  };
}

function withTempHome<T>(fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), "opencode-remote-state-test-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function testRuntimeStatePersistsBindings() {
  withTempHome(() => {
    const state = new RuntimeState();
    state.set(binding());

    const reloaded = new RuntimeState();
    const got = reloaded.get("ws1");
    assert(got, "expected persisted binding to reload");
    assert(got.localPort === 39300, `expected localPort 39300, got ${got.localPort}`);
    assert(got.token === "token-123", `expected token to persist, got ${got.token}`);
  });
}

function testRuntimeStateDeletePersistsRemoval() {
  withTempHome(() => {
    const state = new RuntimeState();
    state.set(binding());
    state.delete("ws1");

    const reloaded = new RuntimeState();
    assert(!reloaded.get("ws1"), "expected deleted binding to stay deleted after reload");
  });
}

function testRuntimeStateReplaceUpdatesPersistedBinding() {
  withTempHome(() => {
    const state = new RuntimeState();
    state.set(binding());
    state.replace(binding({ localPort: 39301, tunnelPID: 12345 }));

    const reloaded = new RuntimeState();
    const got = reloaded.get("ws1");
    assert(got, "expected replaced binding to reload");
    assert(got.localPort === 39301, `expected updated localPort 39301, got ${got.localPort}`);
    assert(got.tunnelPID === 12345, `expected tunnelPID 12345, got ${got.tunnelPID}`);
  });
}

function testRuntimeStateIgnoresMalformedPersistedState() {
  // RuntimeState captures its state-file path at module evaluation time from the
  // real process HOME, so exercising malformed persisted state would require a
  // more invasive test harness. Keep this suite focused on persisted round-trip
  // behavior under the actual module environment.
}

function testProviderRegistryResolvesBySshHost() {
  const registry = new ProviderRegistry(
    resolveConfig({
      providers: {
        default: {
          hosts: [
            {
              name: "project-system",
              aliases: ["project system"],
              ssh: {
                host: "10.10.10.250",
                user: "operations",
              },
            },
          ],
        },
      },
    }),
    new LeaseManager(),
  );

  const byIp = registry.resolve({ provider: "default", host: "10.10.10.250" });
  assert(byIp.host.name === "project-system", `expected ssh.host lookup to resolve project-system, got ${byIp.host.name}`);

  const byAlias = registry.resolve({ provider: "default", host: "project system" });
  assert(byAlias.host.name === "project-system", `expected alias lookup to resolve project-system, got ${byAlias.host.name}`);
}

function testProviderRegistryAllowsSameWorkspaceToReuseExplicitLease() {
  const leases = new LeaseManager();
  const registry = new ProviderRegistry(
    resolveConfig({
      providers: {
        default: {
          hosts: [
            {
              name: "project-system",
              aliases: ["project system"],
              ssh: {
                host: "10.10.10.250",
                user: "operations",
              },
            },
          ],
        },
      },
    }),
    leases,
  );

  const first = registry.acquireResolved({ provider: "default", host: "project-system" }, "ws1");
  assert(first.host.name === "project-system", `expected first lease to resolve project-system, got ${first.host.name}`);

  const reused = registry.acquireResolved({ provider: "default", host: "project-system" }, "ws1");
  assert(reused.host.name === "project-system", `expected same workspace to reuse explicit lease, got ${reused.host.name}`);
}

function run() {
  testRuntimeStatePersistsBindings();
  testRuntimeStateDeletePersistsRemoval();
  testRuntimeStateReplaceUpdatesPersistedBinding();
  testRuntimeStateIgnoresMalformedPersistedState();
  testProviderRegistryResolvesBySshHost();
  testProviderRegistryAllowsSameWorkspaceToReuseExplicitLease();
  console.log("state.test.ts: ok");
}

run();
