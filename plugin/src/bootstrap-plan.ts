import type { BootstrapResult } from "./ssh.js";
import type { ResolvedHost } from "./types.js";

export interface BootstrapPlan {
  verifySSH: string;
  detectHome: string;
  detectPlatform: string;
  ensureDirs: string;
  writeToken: string;
  launchStub: string;
  openTunnel: string;
  healthURL: string;
}

export function buildBootstrapPlan(target: ResolvedHost, bootstrap: BootstrapResult): BootstrapPlan {
  const sshPort = target.host.ssh.port ?? 22;
  const jump = target.host.ssh.proxyJump ? `-J ${target.host.ssh.proxyJump} ` : "";
  const identity = target.host.ssh.identityFile ? `-i ${target.host.ssh.identityFile} ` : "";
  const baseSSH = `ssh ${jump}${identity}-p ${sshPort} ${target.host.ssh.user}@${target.host.ssh.host}`;

  return {
    verifySSH: `${baseSSH} true`,
    detectHome: `${baseSSH} 'printf %s "$HOME"'`,
    detectPlatform: `${baseSSH} 'uname -s && uname -m'`,
    ensureDirs: `${baseSSH} 'mkdir -p ${bootstrap.installRoot}/bin ${bootstrap.installRoot}/run ${bootstrap.installRoot}/log ${bootstrap.installRoot}/state/workspaces ${bootstrap.installRoot}/state/sessions ${bootstrap.installRoot}/state/approvals'`,
    writeToken: `${baseSSH} 'printf %s ${bootstrap.token} > ${bootstrap.installRoot}/run/stub.token'`,
    launchStub: `${baseSSH} '${bootstrap.launchCommand} >/dev/null 2>&1 &'`,
    openTunnel: `ssh ${jump}${identity}-N -L ${bootstrap.localPort}:127.0.0.1:${bootstrap.remotePort} -p ${sshPort} ${target.host.ssh.user}@${target.host.ssh.host}`,
    healthURL: bootstrap.healthURL,
  };
}
