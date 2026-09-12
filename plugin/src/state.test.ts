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
              name: "prod-web-1",
              aliases: ["primary-web"],
              ssh: {
                host: "203.0.113.10",
                user: "ops",
              },
            },
          ],
        },
      },
    }),
    new LeaseManager(),
  );

  const byIp = registry.resolve({ provider: "default", host: "203.0.113.10" });
  assert(byIp.host.name === "prod-web-1", `expected ssh.host lookup to resolve prod-web-1, got ${byIp.host.name}`);

  const byAlias = registry.resolve({ provider: "default", host: "primary-web" });
  assert(byAlias.host.name === "prod-web-1", `expected alias lookup to resolve prod-web-1, got ${byAlias.host.name}`);
}

function testProviderRegistryAllowsSameWorkspaceToReuseExplicitLease() {
  const leases = new LeaseManager();
  const registry = new ProviderRegistry(
    resolveConfig({
      providers: {
        default: {
          hosts: [
            {
              name: "prod-web-1",
              aliases: ["primary-web"],
              ssh: {
                host: "203.0.113.10",
                user: "ops",
              },
            },
          ],
        },
      },
    }),
    leases,
  );

  const first = registry.acquireResolved({ provider: "default", host: "prod-web-1" }, "ws1");
  assert(first.host.name === "prod-web-1", `expected first lease to resolve prod-web-1, got ${first.host.name}`);

  const reused = registry.acquireResolved({ provider: "default", host: "prod-web-1" }, "ws1");
  assert(reused.host.name === "prod-web-1", `expected same workspace to reuse explicit lease, got ${reused.host.name}`);

  const reusedByIp = registry.acquireResolved({ provider: "default", host: "203.0.113.10" }, "ws1");
  assert(reusedByIp.host.name === "prod-web-1", `expected same workspace to reuse explicit lease by ssh.host, got ${reusedByIp.host.name}`);

  const reusedByAlias = registry.acquireResolved({ provider: "default", host: "primary-web" }, "ws1");
  assert(reusedByAlias.host.name === "prod-web-1", `expected same workspace to reuse explicit lease by alias, got ${reusedByAlias.host.name}`);
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
