import { randomBytes } from "node:crypto";
import { spawn, exec } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { promisify } from "node:util";
import type { ResolvedPluginConfig } from "./config.js";
import type { ResolvedHost, WorkspaceBinding } from "./types.js";

const execAsync = promisify(exec);

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
    const host = target.host;
    const sshConfig = host.ssh;
    const identityFile = sshConfig.identityFile 
      ? sshConfig.identityFile.replace(/^~\//, `${process.env.HOME}/`)
      : undefined;

    const remotePort = this.config.defaults.stubPort;
    const localPort = this.allocateLocalPort(workspaceID, host.name);
    const remoteHome = `/home/${sshConfig.user}`;
    const installRoot = this.expandInstallRoot(remoteHome);

    const token = randomBytes(24).toString("hex");

    const sshArgs = [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "UserKnownHostsFile=${process.env.HOME}/.ssh/known_hosts",
      "-o", "ConnectTimeout=15",
      "-p", String(sshConfig.port || 22),
    ];
    if (identityFile && existsSync(identityFile)) {
      sshArgs.push("-i", identityFile);
    }
    sshArgs.push(`${sshConfig.user}@${sshConfig.host}`);

    const remoteBase = `~/.opencode-remote`;
    const stubBinary = `${installRoot}/bin/opencode-remote-stub`;
    const tokenFile = `${installRoot}/run/stub.token`;

    await this.execSSH(sshArgs, "mkdir -p ~/.opencode-remote/bin ~/.opencode-remote/run ~/.opencode-remote/log ~/.opencode-remote/state");

    const stubPath = `${process.cwd()}/../stub/bin/opencode-remote-stub`;
    if (existsSync(stubPath)) {
      await this.scp(stubPath, sshArgs, `${installRoot}/bin/opencode-remote-stub`);
      await this.execSSH(sshArgs, `chmod +x ${stubBinary}`);
    }

    writeFileSync("/tmp/opencode-token", token);
    await this.scp("/tmp/opencode-token", sshArgs, tokenFile);
    const startCmd = `pkill -f 'opencode-remote-stub' 2>/dev/null || true; nohup ${stubBinary} --listen 127.0.0.1:${remotePort} --token-file ${tokenFile} --state-dir ${installRoot}/state --log-file ${installRoot}/log/stub.log >/dev/null 2>&1 &`;
    await this.execSSH(sshArgs, startCmd);
    await this.sleep(3000);

    console.error(`[SSH] Creating local tunnel...`);
    const tunnelCmd = `ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=10 -N -L ${localPort}:127.0.0.1:${remotePort} ${sshConfig.user}@${sshConfig.host}${identityFile ? ` -i ${identityFile}` : ""} -p ${sshConfig.port || 22}`;

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

  async teardown(_binding: WorkspaceBinding): Promise<void> {
    return;
  }

  private async execSSH(sshArgs: string[], command: string): Promise<string> {
    const fullArgs = [...sshArgs, command];
    const { stdout, stderr } = await execAsync(`ssh ${fullArgs.join(" ")}`, { timeout: 30000 });
    return stdout;
  }

  private async scp(localPath: string, sshArgs: string[], remotePath: string): Promise<void> {
    const scpArgs = [...sshArgs.map(a => a.replace("-o ", "-o ")).map(a => a.replace("-p ", "-P "))];
    const dest = `${sshArgs[sshArgs.length - 2]}@${sshArgs[sshArgs.length - 1]}:${remotePath}`;
    await execAsync(`scp -o StrictHostKeyChecking=accept-new ${localPath} ${dest}`, { timeout: 60000 });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
}
