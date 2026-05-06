import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import type { ResolvedPluginConfig } from "./config.js";
import type { ResolvedHost, WorkspaceBinding } from "./types.js";

const execFileAsync = promisify(execFile);

export interface BootstrapResult {
  remotePort: number;
  localPort: number;
  token: string;
  installRoot: string;
  remoteHome: string;
  launchCommand: string;
  healthURL: string;
}

export class SSHManager {
  constructor(private readonly config: ResolvedPluginConfig) {}

  async bootstrap(workspaceID: string, target: ResolvedHost): Promise<BootstrapResult> {
    const sshConfig = target.host.ssh;
    const identityFile = sshConfig.identityFile
      ? sshConfig.identityFile.replace(/^~\//, `${process.env.HOME}/`)
      : undefined;
    const remotePort = this.config.defaults.stubPort;
    const localPort = this.allocateLocalPort(workspaceID, target.host.name);
    const remoteHome = await this.resolveRemoteHome(sshConfig, identityFile);
    const installRoot = this.expandInstallRoot(remoteHome);
    const token = randomBytes(24).toString("hex");
    const sshArgs = this.buildSSHArgs(sshConfig, identityFile);
    const stubBinary = `${installRoot}/bin/opencode-remote-stub`;
    const tokenFile = `${installRoot}/run/stub.token`;
    const stubPath = `${process.cwd()}/../stub/bin/opencode-remote-stub`;
    const tokenPath = `/tmp/opencode-remote-token-${workspaceID}`;

    await this.execSSH(sshArgs, `mkdir -p ${installRoot}/bin ${installRoot}/run ${installRoot}/log ${installRoot}/state`);

    if (existsSync(stubPath)) {
      await this.scp(stubPath, sshConfig, identityFile, `${sshConfig.user}@${sshConfig.host}:${stubBinary}`);
      await this.execSSH(sshArgs, `chmod +x ${stubBinary}`);
    }

    writeFileSync(tokenPath, token);
    try {
      await this.scp(tokenPath, sshConfig, identityFile, `${sshConfig.user}@${sshConfig.host}:${tokenFile}`);
    } finally {
      unlinkSync(tokenPath);
    }

    await this.execSSHAllowFailure(sshArgs, "pkill -f 'opencode-remote-stub' 2>/dev/null || true");
    await this.execSSH(sshArgs, `mkdir -p ${installRoot}/log`);
    await this.execSSH(sshArgs, this.buildRemoteStartCommand(installRoot, remotePort));

    await this.ensureTunnel(sshConfig, identityFile, localPort, remotePort);
    await this.waitForHealth(localPort, token);

    return {
      remotePort,
      localPort,
      token,
      installRoot,
      remoteHome,
      launchCommand: this.buildLaunchCommand(installRoot, remotePort),
      healthURL: `http://127.0.0.1:${localPort}/global/health`,
    };
  }

  async teardown(binding: WorkspaceBinding): Promise<void> {
    await this.closeTunnel(binding.localPort);
  }

  private buildSSHArgs(
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile?: string,
  ): string[] {
    const args = [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${process.env.HOME}/.ssh/known_hosts`,
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
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${process.env.HOME}/.ssh/known_hosts`,
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
    sshConfig: ResolvedHost["host"]["ssh"],
    identityFile: string | undefined,
    localPort: number,
    remotePort: number,
  ): Promise<void> {
    if (await this.isPortReachable(localPort)) {
      return;
    }

    const args = [
      "-f",
      "-N",
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
      `UserKnownHostsFile=${process.env.HOME}/.ssh/known_hosts`,
      "-p",
      String(sshConfig.port || 22),
      `${sshConfig.user}@${sshConfig.host}`,
    );

    await execFileAsync("ssh", args, { timeout: this.config.tunnel.connectTimeoutMs * 2 });
  }

  private async closeTunnel(localPort: number): Promise<void> {
    try {
      await execFileAsync("pkill", ["-f", `:${localPort}:127.0.0.1:${this.config.defaults.stubPort}`], {
        timeout: 5000,
      });
    } catch {
      return;
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
      await execFileAsync("ssh", ["-G", "127.0.0.1"], { timeout: 1000 });
    } catch {
      // Ignore; this is only used to keep the method async without extra deps.
    }

    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/global/health`, { signal: AbortSignal.timeout(500) });
      return response.ok || response.status === 401 || response.status === 403;
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private allocateLocalPort(workspaceID: string, host: string): number {
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
      "import subprocess",
      "import time",
      "import sys",
      "null_in = open('/dev/null', 'rb')",
      "null_out = open('/dev/null', 'ab')",
      `cmd = ['${installRoot}/bin/opencode-remote-stub', '--listen', '127.0.0.1:${remotePort}', '--token-file', '${installRoot}/run/stub.token', '--state-dir', '${installRoot}/state', '--log-file', '${installRoot}/log/stub.log']`,
      "proc = subprocess.Popen(cmd, stdin=null_in, stdout=null_out, stderr=null_out, close_fds=True)",
      "time.sleep(2)",
      "sys.exit(0 if proc.poll() is None else 1)",
      "PY",
    ].join("\n");
  }
}
