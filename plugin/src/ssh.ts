import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ResolvedPluginConfig } from "./config.js";
import type { ResolvedHost, WorkspaceBinding } from "./types.js";

const execFileAsync = promisify(execFile);
const knownHostsFile = `${process.env.HOME ?? ""}/.ssh/known_hosts`;

export interface BootstrapResult {
  remotePort: number;
  localPort: number;
  token: string;
  installRoot: string;
  remoteHome: string;
  launchCommand: string;
  healthURL: string;
  tunnelPID?: number;
}

export class SSHManager {
  constructor(private readonly config: ResolvedPluginConfig) {}

  async bootstrap(workspaceID: string, target: ResolvedHost): Promise<BootstrapResult> {
    const sshConfig = target.host.ssh;
    const identityFile = sshConfig.identityFile
      ? sshConfig.identityFile.replace(/^~\//, `${process.env.HOME}/`)
      : undefined;
    const remotePort = this.config.defaults.stubPort;
    const remoteHome = await this.resolveRemoteHome(sshConfig, identityFile);
    const installRoot = this.expandInstallRoot(remoteHome);
    const token = randomBytes(24).toString("hex");
    const sshArgs = this.buildSSHArgs(sshConfig, identityFile);
    const stubBinary = `${installRoot}/bin/opencode-remote-stub`;
    const tokenFile = `${installRoot}/run/stub.token`;
    const stubPath = this.config.stubBinaryPath;
    const tokenDir = mkdtempSync(join(tmpdir(), "opencode-remote-token-"));
    const tokenPath = join(tokenDir, "stub.token");

    await this.execSSH(sshArgs, `mkdir -p ${installRoot}/bin ${installRoot}/run ${installRoot}/log ${installRoot}/state`);

    if (!existsSync(stubPath)) {
      throw new Error(`Stub binary not found at '${stubPath}'. Build it first or set plugin.stubBinaryPath.`);
    }

    const localStubHash = this.sha256File(stubPath);
    const remoteStubHash = await this.remoteStubHash(sshArgs, stubBinary);
    if (remoteStubHash !== localStubHash) {
      await this.installStub(stubPath, sshArgs, sshConfig, identityFile, stubBinary);
    }

    writeFileSync(tokenPath, token, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    try {
      await this.scp(tokenPath, sshConfig, identityFile, `${sshConfig.user}@${sshConfig.host}:${tokenFile}`);
    } finally {
      try {
        unlinkSync(tokenPath);
      } finally {
        rmSync(tokenDir, { recursive: true, force: true });
      }
    }

    await this.execSSHAllowFailure(sshArgs, "pkill -f 'opencode-remote-stub' 2>/dev/null || true");
    await this.execSSH(sshArgs, `mkdir -p ${installRoot}/log`);
    await this.execSSH(sshArgs, this.buildRemoteStartCommand(installRoot, remotePort));

    const { localPort, tunnelPID } = await this.ensureTunnel(workspaceID, target.host.name, sshConfig, identityFile, remotePort);
    await this.waitForHealth(localPort, token);

    return {
      remotePort,
      localPort,
      token,
      installRoot,
      remoteHome,
      launchCommand: this.buildLaunchCommand(installRoot, remotePort),
      healthURL: `http://127.0.0.1:${localPort}/global/health`,
      tunnelPID,
    };
  }

  async teardown(binding: WorkspaceBinding): Promise<void> {
    await this.closeTunnel(binding.localPort, binding.tunnelPID);
    await this.waitForPortClosed(binding.localPort);
  }

  async reconnect(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    const sshConfig = target.host.ssh;
    const identityFile = sshConfig.identityFile
      ? sshConfig.identityFile.replace(/^~\//, `${process.env.HOME}/`)
      : undefined;

    if (await this.isHealthReachable(binding.localPort, binding.token)) {
      return binding;
    }

    const tunnel = await this.ensureSpecificOrFallbackTunnel(
      binding.workspaceID,
      target.host.name,
      sshConfig,
      identityFile,
      binding.remotePort,
      binding.localPort,
    );

    await this.waitForHealth(tunnel.localPort, binding.token);
    return {
      ...binding,
      localPort: tunnel.localPort,
      tunnelPID: tunnel.tunnelPID,
      status: "ready",
    };
  }

  private buildSSHArgs(
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile?: string,
  ): string[] {
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsFile}`,
      "-o",
      `ConnectTimeout=${Math.ceil(this.config.tunnel.connectTimeoutMs / 1000)}`,
      "-p",
      String(sshConfig.port || 22),
    ];

    if (identityFile && existsSync(identityFile)) {
      args.push("-i", identityFile);
    }

    if (sshConfig.proxyJump) {
      args.push("-J", sshConfig.proxyJump);
    }

    args.push(`${sshConfig.user}@${sshConfig.host}`);
    return args;
  }

  private async execSSH(sshArgs: string[], command: string): Promise<string> {
    const { stdout } = await execFileAsync("ssh", [...sshArgs, command], {
      timeout: this.config.tunnel.connectTimeoutMs * 2,
    });
    return stdout.trim();
  }

  private async execSSHAllowFailure(sshArgs: string[], command: string): Promise<string> {
    try {
      return await this.execSSH(sshArgs, command);
    } catch {
      return "";
    }
  }

  private async scp(
    localPath: string,
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    destination: string,
  ): Promise<void> {
    const args = [
      "-o",
      "BatchMode=yes",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsFile}`,
      "-P",
      String(sshConfig.port || 22),
    ];

    if (identityFile && existsSync(identityFile)) {
      args.push("-i", identityFile);
    }

    if (sshConfig.proxyJump) {
      args.push("-o", `ProxyJump=${sshConfig.proxyJump}`);
    }

    await execFileAsync("scp", [...args, localPath, destination], {
      timeout: this.config.tunnel.connectTimeoutMs * 4,
    });
  }

  private async installStub(
    localPath: string,
    sshArgs: string[],
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    remotePath: string,
  ): Promise<void> {
    const tempPath = `${remotePath}.upload-${process.pid}-${Date.now()}`;
    await this.scp(localPath, sshConfig, identityFile, `${sshConfig.user}@${sshConfig.host}:${tempPath}`);
    const escapedTemp = tempPath.replace(/'/g, `'\''`);
    const escapedRemote = remotePath.replace(/'/g, `'\''`);
    await this.execSSH(
      sshArgs,
      `chmod +x '${escapedTemp}' && mv -f '${escapedTemp}' '${escapedRemote}' && chmod +x '${escapedRemote}'`,
    );
  }

  private sha256File(path: string): string {
    const hash = createHash("sha256");
    hash.update(readFileSync(path));
    return hash.digest("hex");
  }

  private async remoteStubHash(sshArgs: string[], remotePath: string): Promise<string | undefined> {
    const escapedPath = remotePath.replace(/'/g, `'\\''`);
    const output = await this.execSSHAllowFailure(
      sshArgs,
      `if [ -f '${escapedPath}' ]; then sha256sum '${escapedPath}' 2>/dev/null | awk '{print $1}'; fi`,
    );
    const hash = output.trim();
    return hash || undefined;
  }

  private async resolveRemoteHome(
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile?: string,
  ): Promise<string> {
    const sshArgs = this.buildSSHArgs(sshConfig, identityFile);
    const home = await this.execSSH(sshArgs, "printf '%s' \"$HOME\"");
    if (!home) {
      throw new Error(`Unable to determine remote home for ${sshConfig.user}@${sshConfig.host}`);
    }
    return home;
  }

  private async ensureTunnel(
    workspaceID: string,
    host: string,
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    remotePort: number,
  ): Promise<{ localPort: number; tunnelPID?: number }> {
    const [start, end] = this.config.tunnel.localPortRange;
    const span = end - start + 1;
    const initialPort = this.allocateInitialLocalPort(workspaceID, host);

    for (let attempt = 0; attempt < span; attempt++) {
      const localPort = start + ((initialPort - start + attempt) % span);
      const tunnelPID = await this.tryStartTunnel(sshConfig, identityFile, localPort, remotePort);
      if (tunnelPID) {
        return { localPort, tunnelPID };
      }
    }

    throw new Error(`Unable to establish SSH tunnel: no available local port in range ${start}-${end}`);
  }

  private async ensureSpecificOrFallbackTunnel(
    workspaceID: string,
    host: string,
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    remotePort: number,
    preferredLocalPort: number,
  ): Promise<{ localPort: number; tunnelPID?: number }> {
    const tunnelPID = await this.tryStartTunnel(sshConfig, identityFile, preferredLocalPort, remotePort);
    if (tunnelPID) {
      return { localPort: preferredLocalPort, tunnelPID };
    }

    return this.ensureTunnel(workspaceID, host, sshConfig, identityFile, remotePort);
  }

  private async tryStartTunnel(
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    localPort: number,
    remotePort: number,
  ): Promise<number | undefined> {
    if (await this.isPortReachable(localPort)) {
      return undefined;
    }

    const args = [
      "-N",
      "-o",
      "BatchMode=yes",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=10",
      "-L",
      `${localPort}:127.0.0.1:${remotePort}`,
    ];

    if (identityFile && existsSync(identityFile)) {
      args.push("-i", identityFile);
    }

    if (sshConfig.proxyJump) {
      args.push("-J", sshConfig.proxyJump);
    }

    args.push(
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${knownHostsFile}`,
      "-p",
      String(sshConfig.port || 22),
      `${sshConfig.user}@${sshConfig.host}`,
    );

    const child = spawn("ssh", args, {
      detached: true,
      stdio: "ignore",
    });

    child.unref();

    try {
      await this.waitForPortReachable(localPort);
      return child.pid;
    } catch {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // Ignore cleanup errors if the process already exited.
        }
      }
      return undefined;
    }
  }

  private async closeTunnel(localPort: number, tunnelPID?: number): Promise<void> {
    if (tunnelPID) {
      try {
        process.kill(tunnelPID, "SIGTERM");
        return;
      } catch {
        // Fall through to a best-effort local-port validation below.
      }
    }

    if (await this.isPortReachable(localPort)) {
      throw new Error(`Tunnel on local port ${localPort} is reachable but no tracked PID is available for teardown`);
    }
  }

  private async waitForHealth(localPort: number, token: string): Promise<void> {
    const deadline = Date.now() + this.config.tunnel.healthTimeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${localPort}/global/health`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          return;
        }
      } catch {
        // Keep retrying until timeout.
      }

      await this.sleep(300);
    }

    throw new Error(`Remote stub did not become healthy on local port ${localPort}`);
  }

  private async isPortReachable(localPort: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/global/health`, { signal: AbortSignal.timeout(500) });
      return response.ok || response.status === 401 || response.status === 403;
    } catch {
      return false;
    }
  }

  private async isHealthReachable(localPort: number, token: string): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/global/health`, {
        signal: AbortSignal.timeout(500),
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async ensureRecoveredBinding(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    if (await this.isHealthReachable(binding.localPort, binding.token)) {
      return binding;
    }
    return this.reconnect(binding, target);
  }

  async validateRecoveredBinding(binding: WorkspaceBinding): Promise<boolean> {
    return this.isHealthReachable(binding.localPort, binding.token);
  }

  async closeRecoveredBinding(binding: WorkspaceBinding): Promise<void> {
    if (binding.tunnelPID) {
      await this.teardown(binding);
      return;
    }

    if (await this.isPortReachable(binding.localPort)) {
      throw new Error(`Recovered tunnel on local port ${binding.localPort} is reachable but has no tracked PID for safe teardown`);
    }
  }

  async isBindingReady(binding: WorkspaceBinding): Promise<boolean> {
    return this.isHealthReachable(binding.localPort, binding.token);
  }

  async reconnectBinding(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async canReachBinding(binding: WorkspaceBinding): Promise<boolean> {
    return this.isHealthReachable(binding.localPort, binding.token);
  }

  async probeBinding(binding: WorkspaceBinding): Promise<boolean> {
    return this.isHealthReachable(binding.localPort, binding.token);
  }

  async ensureReady(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async ensureActive(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async reconnectAfterRestart(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async ensureAfterRestart(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async ensureTargetReady(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }

  async reconnectTargetBinding(binding: WorkspaceBinding, target: ResolvedHost): Promise<WorkspaceBinding> {
    return this.ensureRecoveredBinding(binding, target);
  }
  private async waitForPortReachable(localPort: number): Promise<void> {
    const deadline = Date.now() + this.config.tunnel.connectTimeoutMs;

    while (Date.now() < deadline) {
      if (await this.isPortReachable(localPort)) {
        return;
      }
      await this.sleep(200);
    }

    throw new Error(`SSH tunnel did not become reachable on local port ${localPort}`);
  }

  private async waitForPortClosed(localPort: number): Promise<void> {
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      if (!(await this.isPortReachable(localPort))) {
        return;
      }
      await this.sleep(200);
    }

    throw new Error(`SSH tunnel on local port ${localPort} did not close after teardown`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private allocateInitialLocalPort(workspaceID: string, host: string): number {
    const [start, end] = this.config.tunnel.localPortRange;
    const seed = `${workspaceID}:${host}`;
    let hash = 0;
    for (const char of seed) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return start + (hash % (end - start + 1));
  }

  private expandInstallRoot(remoteHome: string): string {
    if (this.config.installRoot.startsWith("~/")) {
      return `${remoteHome}/${this.config.installRoot.slice(2)}`;
    }
    return this.config.installRoot;
  }

  private buildLaunchCommand(installRoot: string, remotePort: number): string {
    return [
      `${installRoot}/bin/opencode-remote-stub`,
      `--listen 127.0.0.1:${remotePort}`,
      `--token-file ${installRoot}/run/stub.token`,
      `--state-dir ${installRoot}/state`,
      `--log-file ${installRoot}/log/stub.log`,
    ].join(" ");
  }

  private buildRemoteStartCommand(installRoot: string, remotePort: number): string {
    return [
      "python2 - <<'PY' 2>/dev/null || python - <<'PY'",
      "import os",
      "import subprocess",
      "import time",
      "import sys",
      "null_in = open('/dev/null', 'rb')",
      "null_out = open('/dev/null', 'ab')",
      `cmd = ['${installRoot}/bin/opencode-remote-stub', '--listen', '127.0.0.1:${remotePort}', '--token-file', '${installRoot}/run/stub.token', '--state-dir', '${installRoot}/state', '--log-file', '${installRoot}/log/stub.log']`,
      "proc = subprocess.Popen(cmd, stdin=null_in, stdout=null_out, stderr=null_out, close_fds=True, preexec_fn=os.setsid)",
      "time.sleep(2)",
      "sys.exit(0 if proc.poll() is None else 1)",
      "PY",
    ].join("\n");
  }
}
