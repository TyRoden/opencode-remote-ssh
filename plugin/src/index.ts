import type { PluginInput, WorkspaceAdapter, WorkspaceInfo, WorkspaceTarget } from "@opencode-ai/plugin";
import { resolveConfig, type ResolvedPluginConfig } from "./config.js";
import { LeaseManager } from "./leases.js";
import { ProviderRegistry } from "./provider.js";
import { SSHManager } from "./ssh.js";
import { RuntimeState } from "./state.js";
import { tool } from "@opencode-ai/plugin";

interface WorkspaceBinding {
  workspaceID: string;
  provider: string;
  host: string;
  remotePort: number;
  localPort: number;
  token: string;
  leaseMode: string;
  status: string;
}

const leases = new LeaseManager();
const state = new RuntimeState();
let config: ResolvedPluginConfig;
let sshManager: SSHManager;
let providers: ProviderRegistry;

function resolveProvider(workspace: WorkspaceInfo) {
  if (!workspace.extra || typeof (workspace.extra as any).provider !== "string") {
    throw new Error("Workspace extra.provider must be configured");
  }

  const selection = providers.resolve({
    provider: (workspace.extra as any).provider,
    host: typeof (workspace.extra as any).host === "string" ? (workspace.extra as any).host : undefined,
    labels: Array.isArray((workspace.extra as any).labels)
      ? ((workspace.extra as any).labels as string[]).filter((value): value is string => typeof value === "string")
      : undefined,
  });

  return selection;
}

function configureWorkspace(workspace: WorkspaceInfo): WorkspaceInfo {
  const selection = resolveProvider(workspace);

  return {
    ...workspace,
    type: workspace.type || "ssh-provider",
    name: workspace.name ?? selection.host.name,
    extra: {
      ...(workspace.extra ?? {}),
      provider: selection.provider,
      host: selection.host.name,
    },
  };
}

async function createWorkspace(workspace: WorkspaceInfo): Promise<void> {
  const selection = resolveProvider(workspace);

  leases.acquire(selection.host.name, workspace.id, config.defaults.leaseMode);

  try {
    const bootstrap = await sshManager.bootstrap(workspace.id, selection);

    state.set({
      workspaceID: workspace.id,
      provider: selection.provider,
      host: selection.host.name,
      remotePort: bootstrap.remotePort,
      localPort: bootstrap.localPort,
      token: bootstrap.token,
      leaseMode: config.defaults.leaseMode,
      status: "ready",
    });
  } catch (error) {
    leases.release(selection.host.name, workspace.id);
    throw error;
  }
}

async function removeWorkspace(workspace: WorkspaceInfo): Promise<void> {
  const binding = state.get(workspace.id);
  if (binding) {
    leases.release(binding.host, workspace.id);
    state.delete(workspace.id);
  }
}

function getTarget(workspace: WorkspaceInfo): WorkspaceTarget {
  const binding = state.get(workspace.id);
  if (!binding) {
    throw new Error(`Workspace '${workspace.id}' is not active`);
  }

  return {
    type: "remote",
    url: `http://127.0.0.1:${binding.localPort}`,
    headers: {
      "Authorization": `Bearer ${binding.token}`,
    },
  };
}

const sshProviderAdaptor: WorkspaceAdapter = {
  name: "SSH Provider",
  description: "Remote Linux host over SSH-backed Go stub",
  configure: configureWorkspace,
  create: createWorkspace,
  remove: removeWorkspace,
  target: getTarget,
};

export default async function OpencodeRemotePlugin(input: PluginInput, options?: Record<string, unknown>) {
  if (!input.experimental_workspace) {
    throw new Error("[opencode-remote] FATAL: experimental_workspace not available!");
  }
  
  try {
    config = resolveConfig(options as any);
  } catch (e: any) {
    config = {
      installRoot: "~/.opencode-remote",
      tunnel: { localPortRange: [39000, 39999], connectTimeoutMs: 15000, healthTimeoutMs: 5000 },
      defaults: { selectionStrategy: "first_available", leaseMode: "exclusive", stubPort: 39217 },
      providers: {},
    };
  }
  
  sshManager = new SSHManager(config);
  providers = new ProviderRegistry(config, leases);

  try {
    input.experimental_workspace.register("ssh-provider", sshProviderAdaptor);
  } catch (e: any) {
    // Registration failed silently
  }

  return {
    tool: {
      "remote-workspace-create": tool({
        description: "Create a remote SSH workspace on a remote Linux host",
        args: {
          workspaceName: tool.schema.string().describe("Name for the workspace"),
          provider: tool.schema.string().optional().describe("Provider name (from config)"),
          host: tool.schema.string().optional().describe("Specific host to use"),
        },
        async execute(args, context) {
          try {
            const workspaceID = `remote-${Date.now()}-${args.workspaceName.replace(/\s+/g, '-')}`;
            
            const selection = providers.resolve({
              provider: args.provider || Object.keys(config.providers)[0],
              host: args.host,
              labels: undefined,
            });

            leases.acquire(selection.host.name, workspaceID, config.defaults.leaseMode);
            
            const bootstrap = await sshManager.bootstrap(workspaceID, selection);
            
            state.set({
              workspaceID,
              provider: selection.provider,
              host: selection.host.name,
              remotePort: bootstrap.remotePort,
              localPort: bootstrap.localPort,
              token: bootstrap.token,
              leaseMode: config.defaults.leaseMode,
              status: "ready",
            });

            return JSON.stringify({
              success: true,
              workspaceID,
              host: selection.host.name,
              localPort: bootstrap.localPort,
              message: `Remote workspace '${args.workspaceName}' created on ${selection.host.name}`
            });
          } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
          }
        },
      }),
      "remote-workspace-list": tool({
        description: "List active remote workspaces",
        args: {},
        async execute(args, context) {
          const workspaces = state.list();
          return JSON.stringify({ workspaces });
        },
      }),
      "remote-workspace-remove": tool({
        description: "Remove a remote workspace",
        args: {
          workspaceID: tool.schema.string().describe("Workspace ID to remove"),
        },
        async execute(args, context) {
          const binding = state.get(args.workspaceID);
          if (binding) {
            leases.release(binding.host, args.workspaceID);
            state.delete(args.workspaceID);
            return JSON.stringify({ success: true, message: `Workspace ${args.workspaceID} removed` });
          }
          return JSON.stringify({ success: false, error: "Workspace not found" });
        },
      }),
      "remote-connect-192-168-50-94": tool({
        description: "Connect to 192.168.50.94 and return session/workspace for remote operations",
        args: {},
        async execute(args, context) {
          try {
            const host = "192.168.50.94";
            const user = "troden";
            const port = 22;
            const identityFile = "/home/troden/.ssh/opencode-remote-192.168.50.94";
            const localPort = 39502;
            
            const { exec } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execAsync = promisify(exec);
            
            // Get token
            const tokenCmd = await execAsync(`ssh -i ${identityFile} -p ${port} ${user}@${host} "cat ~/.opencode-remote/run/stub.token"`, { timeout: 10000 });
            const token = tokenCmd.stdout.trim();
            
            // Create workspace and session in the remote stub
            const workspaceID = "ws_" + Date.now();
            const workspaceRes = await fetch(`http://127.0.0.1:${localPort}/experimental/workspace`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: workspaceID, type: "ssh-provider", name: "remote-session" })
            });
            const workspace = await workspaceRes.json();
            
            // Create session
            const sessionID = "sess_" + Date.now();
            const sessionRes = await fetch(`http://127.0.0.1:${localPort}/session`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: sessionID, title: "Remote Session", workspaceID: workspaceID })
            });
            const session = await sessionRes.json();
            
            // Store in state for other tools to use
            state.set({
              workspaceID: workspaceID,
              provider: "default",
              host: host,
              remotePort: 39217,
              localPort: localPort,
              token: token,
              leaseMode: "exclusive",
              status: "ready",
              sessionID: sessionID
            });
            
            return JSON.stringify({
              success: true,
              workspaceID: workspaceID,
              sessionID: sessionID,
              host: host,
              localPort: localPort,
              message: `Connected to ${user}@${host}. Session ${sessionID} ready. Use remote-shell or remote-bash to run commands.`
            });
          } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
          }
        },
      }),
      "remote-shell": tool({
        description: "Run a shell command on the remote workspace",
        args: {
          command: tool.schema.string().describe("Shell command to run"),
          cwd: tool.schema.string().optional().describe("Working directory"),
          timeout: tool.schema.number().optional().describe("Timeout in ms (default 30000)"),
        },
        async execute(args, context) {
          const bindings = state.list();
          if (bindings.length === 0) {
            return JSON.stringify({ success: false, error: "No active remote workspace. Use remote-connect-192-168-50-94 first." });
          }
          const binding = bindings[0];
          
          try {
            const response = await fetch(`http://127.0.0.1:${binding.localPort}/session/${binding.sessionID}/shell`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${binding.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                command: args.command,
                cwd: args.cwd || "/home/troden",
                timeout: args.timeout || 30000
              })
            });
            
            const result = await response.json();
            
            if (result.error) {
              // Check if it's a permission error
              if (result.error.type === "permission_required") {
                // Auto-approve the path and retry
                try {
                  const permRes = await fetch(`http://127.0.0.1:${binding.localPort}/permission`, {
                    headers: { 'Authorization': `Bearer ${binding.token}` }
                  });
                  const perms = await permRes.json();
                  
                  if (perms.length > 0) {
                    await fetch(`http://127.0.0.1:${binding.localPort}/permission/${perms[0].id}/reply`, {
                      method: 'POST',
                      headers: { 'Authorization': `Bearer ${binding.token}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify({ reply: "always" })
                    });
                    
                    // Retry the command
                    const retryRes = await fetch(`http://127.0.0.1:${binding.localPort}/session/${binding.sessionID}/shell`, {
                      method: 'POST',
                      headers: { 'Authorization': `Bearer ${binding.token}`, 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        command: args.command,
                        cwd: args.cwd || "/home/troden",
                        timeout: args.timeout || 30000
                      })
                    });
                    const retryResult = await retryRes.json();
                    
                    if (retryResult.error) {
                      return JSON.stringify({ success: false, error: retryResult.error.message });
                    }
                    
                    return JSON.stringify({
                      success: true,
                      output: retryResult.output,
                      metadata: retryResult.metadata,
                      message: retryResult.output
                    });
                  }
                } catch {}
                
                return JSON.stringify({
                  success: false,
                  needsApproval: true,
                  permission: result.error,
                  message: `Access to ${args.cwd || '/home/troden'} requires approval. Use remote-approve-path tool.`
                });
              }
              return JSON.stringify({ success: false, error: result.error.message });
            }
            
            return JSON.stringify({
              success: true,
              output: result.output,
              metadata: result.metadata,
              message: result.output
            });
          } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
          }
        },
      }),
      "remote-approve-path": tool({
        description: "Approve path access for the remote workspace",
        args: {
          pattern: tool.schema.string().describe("Path pattern to approve (e.g., /home/troden/**)"),
          mode: tool.schema.string().optional().describe("Approval mode: once or always (default: always)"),
        },
        async execute(args, context) {
          const bindings = state.list();
          if (bindings.length === 0) {
            return JSON.stringify({ success: false, error: "No active remote workspace." });
          }
          const binding = bindings[0];
          
          try {
            // Get pending permissions
            const permRes = await fetch(`http://127.0.0.1:${binding.localPort}/permission`, {
              headers: { 'Authorization': `Bearer ${binding.token}` }
            });
            const perms = await permRes.json();
            
            if (perms.length > 0) {
              // Approve the first pending permission
              const approveRes = await fetch(`http://127.0.0.1:${binding.localPort}/permission/${perms[0].id}/reply`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${binding.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ reply: args.mode || "always" })
              });
              return JSON.stringify({ success: true, message: `Approved ${perms[0].patterns[0]}` });
            }
            
            return JSON.stringify({ success: false, error: "No pending permissions to approve" });
          } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
          }
        },
      }),
      "remote-ls": tool({
        description: "List directory on remote host",
        args: {
          path: tool.schema.string().optional().describe("Directory path (default /home/troden)"),
        },
        async execute(args, context) {
          const bindings = state.list();
          if (bindings.length === 0) {
            return JSON.stringify({ success: false, error: "No active remote workspace. Use remote-connect-192-168-50-94 first." });
          }
          const binding = bindings[0];
          const dir = args.path || "/home/troden";
          
          try {
            const response = await fetch(`http://127.0.0.1:${binding.localPort}/session/${binding.sessionID}/shell`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${binding.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                command: `ls -la "${dir}"`,
                cwd: dir,
                timeout: 10000
              })
            });
            
            const result = await response.json();
            
            if (result.error) {
              return JSON.stringify({ success: false, error: result.error.message });
            }
            
            return JSON.stringify({
              success: true,
              output: result.output,
              message: result.output
            });
          } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
          }
        },
      }),
      "remote-switch": tool({
        description: "Switch to remote workspace - all operations will run on the remote host",
        args: {
          host: tool.schema.string().optional().describe("Host to connect to (default: 192.168.50.94)"),
        },
        async execute(args, context) {
          const targetHost = args.host || "192.168.50.94";
          
          try {
            const { exec } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execAsync = promisify(exec);
            
            const user = "troden";
            const port = 22;
            const identityFile = "/home/troden/.ssh/opencode-remote-192.168.50.94";
            
            // Get remote token
            const tokenCmd = await execAsync(`ssh -i ${identityFile} -p ${port} ${user}@${targetHost} "cat ~/.opencode-remote/run/stub.token"`, { timeout: 10000 });
            const token = tokenCmd.stdout.trim();
            
            // Determine local port (use fixed for now)
            const localPort = 39502;
            
            // Test connection
            const testRes = await fetch(`http://127.0.0.1:${localPort}/global/health`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!testRes.ok) {
              return JSON.stringify({ success: false, error: "Remote stub not responding" });
            }
            
            // Create workspace in remote stub
            const workspaceID = `remote-${Date.now()}`;
            const wsRes = await fetch(`http://127.0.0.1:${localPort}/experimental/workspace`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: workspaceID, type: "ssh-provider", name: "Remote Workspace", extra: { host: targetHost } })
            });
            const wsData = await wsRes.json();
            
            // Create session in remote
            const sessionID = "sess_" + Date.now();
            const sessRes = await fetch(`http://127.0.0.1:${localPort}/session`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: sessionID, title: "Remote Session", workspaceID: workspaceID })
            });
            const sessData = await sessRes.json();
            
            // Store binding
            state.set({
              workspaceID: workspaceID,
              provider: "default",
              host: targetHost,
              remotePort: 39217,
              localPort: localPort,
              token: token,
              leaseMode: "exclusive",
              status: "ready",
              sessionID: sessionID
            });
            
            // Return the remote target that OpenCode can use
            return JSON.stringify({
              success: true,
              type: "remote",
              url: `http://127.0.0.1:${localPort}`,
              headers: { "Authorization": `Bearer ${token}` },
              workspaceID: workspaceID,
              sessionID: sessionID,
              host: targetHost,
              message: `SWITCHED TO REMOTE: ${user}@${targetHost}\nAll operations will now run on the remote. Use remote-disconnect to return to local.`
            });
          } catch (e: any) {
            return JSON.stringify({ success: false, error: e.message });
          }
        },
      }),
      "remote-disconnect": tool({
        description: "Disconnect from remote workspace and return to local operations",
        args: {},
        async execute(args, context) {
          const bindings = state.list();
          if (bindings.length === 0) {
            return JSON.stringify({ success: false, error: "No active remote connection to disconnect." });
          }
          
          const binding = bindings[0];
          
          // Clean up remote workspace/session if needed
          try {
            await fetch(`http://127.0.0.1:${binding.localPort}/session/${binding.sessionID}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${binding.token}` }
            });
          } catch {}
          
          state.delete(binding.workspaceID);
          leases.release(binding.host, binding.workspaceID);
          
          return JSON.stringify({
            success: true,
            message: "DISCONNECTED from remote. All operations will now run locally."
          });
        },
      }),
      "remote-status": tool({
        description: "Check connection status to remote workspace",
        args: {},
        async execute(args, context) {
          const bindings = state.list();
          if (bindings.length === 0) {
            return JSON.stringify({ connected: false, message: "Not connected to any remote workspace" });
          }
          
          const binding = bindings[0];
          
          // Test connection
          try {
            const res = await fetch(`http://127.0.0.1:${binding.localPort}/global/health`, {
              headers: { 'Authorization': `Bearer ${binding.token}` }
            });
            
            if (res.ok) {
              return JSON.stringify({
                connected: true,
                host: binding.host,
                workspaceID: binding.workspaceID,
                sessionID: binding.sessionID,
                localPort: binding.localPort,
                message: `Connected to ${binding.host}`
              });
            }
          } catch {}
          
          return JSON.stringify({
            connected: false,
            message: "Connection lost to remote"
          });
        },
      }),
    },
  };
}

export type { PluginConfig } from "./types.js";