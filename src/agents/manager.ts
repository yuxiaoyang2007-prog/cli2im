import type {
  AgentPlugin,
  AgentProcess,
  AgentEvent,
  SpawnOpts,
  PendingPermission,
  SessionKey,
  UserMessage,
} from '../types.js';
import { ToolGate } from './tool-gate.js';
import { scanToolResult } from '../security/content-guard.js';
import type { Transform } from 'node:stream';

const PERMISSION_TIMEOUT_MS = 60_000;
const GRACEFUL_CANCEL_TIMEOUT_MS = 5_000;

export interface AgentManagerEvents {
  onEvent: (sessionKey: SessionKey, event: AgentEvent) => void;
  onToolBlocked: (sessionKey: SessionKey, command: string, requestId: string) => void;
  onPermissionTimeout: (sessionKey: SessionKey, requestId: string) => void;
  onProcessExit: (sessionKey: SessionKey, code: number | null) => void;
}

export class AgentManager {
  private plugins = new Map<string, AgentPlugin>();
  private processes = new Map<SessionKey, AgentProcess>();
  private parsers = new Map<SessionKey, Transform>();
  private sessionAgentMap = new Map<SessionKey, string>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private toolGate: ToolGate;

  constructor(toolGate: ToolGate) {
    this.toolGate = toolGate;
  }

  registerPlugin(plugin: AgentPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  getPlugin(name: string): AgentPlugin | undefined {
    return this.plugins.get(name);
  }

  listPlugins(): string[] {
    return [...this.plugins.keys()];
  }

  spawnAgent(
    sessionKey: SessionKey,
    agentName: string,
    opts: SpawnOpts,
    handlers: AgentManagerEvents,
  ): AgentProcess {
    const plugin = this.plugins.get(agentName);
    if (!plugin) throw new Error(`Unknown agent: ${agentName}`);

    const proc = plugin.spawn(opts);
    this.processes.set(sessionKey, proc);
    this.sessionAgentMap.set(sessionKey, agentName);

    const disposeOutput = this.setupOutputStream(sessionKey, plugin, proc, opts, handlers);

    proc.on('exit', (code) => {
      disposeOutput();
      this.processes.delete(sessionKey);
      this.parsers.delete(sessionKey);
      this.sessionAgentMap.delete(sessionKey);
      handlers.onProcessExit(sessionKey, code);
    });

    return proc;
  }

  resumeAgent(
    sessionKey: SessionKey,
    agentName: string,
    sessionId: string,
    opts: SpawnOpts,
    handlers: AgentManagerEvents,
  ): AgentProcess {
    const plugin = this.plugins.get(agentName);
    if (!plugin) throw new Error(`Unknown agent: ${agentName}`);

    const proc = plugin.resume(sessionId, opts);
    this.processes.set(sessionKey, proc);
    this.sessionAgentMap.set(sessionKey, agentName);

    const disposeOutput = this.setupOutputStream(sessionKey, plugin, proc, opts, handlers);

    proc.on('exit', (code) => {
      disposeOutput();
      this.processes.delete(sessionKey);
      this.parsers.delete(sessionKey);
      this.sessionAgentMap.delete(sessionKey);
      handlers.onProcessExit(sessionKey, code);
    });

    return proc;
  }

  sendMessage(sessionKey: SessionKey, agentName: string, msg: UserMessage): void {
    const proc = this.processes.get(sessionKey);
    const plugin = this.plugins.get(agentName);
    if (!proc || !plugin) return;

    const formatted = plugin.formatStdinMessage(msg);
    proc.stdin.write(formatted);
  }

  approvePermission(requestId: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);

    const proc = this.processes.get(pending.sessionKey);
    const plugin = this.plugins.get(pending.agentName);
    if (proc && plugin) {
      proc.stdin.write(plugin.formatPermissionResponse(requestId, 'allow'));
    }
    return true;
  }

  denyPermission(requestId: string): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pendingPermissions.delete(requestId);

    const proc = this.processes.get(pending.sessionKey);
    const plugin = this.plugins.get(pending.agentName);
    if (proc && plugin) {
      proc.stdin.write(plugin.formatPermissionResponse(requestId, 'deny'));
    }
    return true;
  }

  getPendingPermissionForChat(chatId: string): PendingPermission | undefined {
    for (const pending of this.pendingPermissions.values()) {
      if (pending.chatId === chatId) return pending;
    }
    return undefined;
  }

  cancelAgent(sessionKey: SessionKey): void {
    const proc = this.processes.get(sessionKey);
    if (!proc) return;

    const agentName = this.sessionAgentMap.get(sessionKey);
    const plugin = agentName ? this.plugins.get(agentName) : undefined;

    if (plugin?.capabilities.gracefulCancel && plugin.formatCancelMessage) {
      proc.stdin.write(plugin.formatCancelMessage());
      setTimeout(() => {
        if (this.processes.has(sessionKey)) {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (this.processes.has(sessionKey)) {
              proc.kill('SIGKILL');
            }
          }, 5000);
        }
      }, GRACEFUL_CANCEL_TIMEOUT_MS);
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (this.processes.has(sessionKey)) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  killAgent(sessionKey: SessionKey): void {
    const proc = this.processes.get(sessionKey);
    if (!proc) return;
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (this.processes.has(sessionKey)) {
        proc.kill('SIGKILL');
      }
    }, 5000);
  }

  hasProcess(sessionKey: SessionKey): boolean {
    return this.processes.has(sessionKey);
  }

  getProcess(sessionKey: SessionKey): AgentProcess | undefined {
    return this.processes.get(sessionKey);
  }

  setupWatchdog(
    sessionKey: SessionKey,
    turnTimeoutMs?: number,
    idleTimeoutMs?: number,
  ): { markActivity: () => void; dispose: () => void } {
    let disposed = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const expire = () => {
      if (disposed) return;
      this.killAgent(sessionKey);
    };

    const turnTimer = turnTimeoutMs ? setTimeout(expire, turnTimeoutMs) : undefined;
    const markActivity = () => {
      if (!idleTimeoutMs || disposed) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(expire, idleTimeoutMs);
    };

    return {
      markActivity,
      dispose: () => {
        disposed = true;
        if (turnTimer) clearTimeout(turnTimer);
        if (idleTimer) clearTimeout(idleTimer);
      },
    };
  }

  private setupOutputStream(
    sessionKey: SessionKey,
    plugin: AgentPlugin,
    proc: AgentProcess,
    opts: SpawnOpts,
    handlers: AgentManagerEvents,
  ): () => void {
    const parser = plugin.createStdoutParser();
    const watchdog = this.setupWatchdog(sessionKey, opts.turnTimeoutMs, opts.idleTimeoutMs);
    this.parsers.set(sessionKey, parser);

    const markRawActivity = () => watchdog.markActivity();
    proc.stdout.on('data', markRawActivity);
    proc.stdout.pipe(parser);

    parser.on('data', (event: AgentEvent) => {
      watchdog.markActivity();

      if (event.type === 'permission_request') {
        if (opts.autoApprove) {
          proc.stdin.write(plugin.formatPermissionResponse(event.id, 'allow'));
          handlers.onEvent(sessionKey, event);
          return;
        }

        const gateResult = this.toolGate.check(event.tool, event.input);

        if (gateResult.action === 'block') {
          const timer = setTimeout(() => {
            this.pendingPermissions.delete(event.id);
            proc.stdin.write(plugin.formatPermissionResponse(event.id, 'deny'));
            handlers.onPermissionTimeout(sessionKey, event.id);
          }, PERMISSION_TIMEOUT_MS);

          this.pendingPermissions.set(event.id, {
            requestId: event.id,
            tool: event.tool,
            command: gateResult.command ?? '',
            chatId: sessionKey.split(':')[1],
            sessionKey,
            agentName: plugin.name,
            timer,
            createdAt: Date.now(),
          });

          handlers.onToolBlocked(sessionKey, gateResult.command ?? '', event.id);
          return;
        }

        // Auto-approve safe commands
        proc.stdin.write(plugin.formatPermissionResponse(event.id, 'allow'));
      }

      if (event.type === 'result' && event.sessionId) {
        proc.sessionId = event.sessionId;
      }

      if (event.type === 'tool_result') {
        event.output = scanToolResult(event.name, event.output);
      }

      handlers.onEvent(sessionKey, event);
    });

    return () => {
      watchdog.dispose();
      proc.stdout.off('data', markRawActivity);
      proc.stdout.unpipe(parser);
      parser.removeAllListeners();
    };
  }
}
