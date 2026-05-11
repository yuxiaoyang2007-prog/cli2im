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
import { validateWorkingDirectory } from '../security/validators.js';
import type { Transform } from 'node:stream';

const PERMISSION_TIMEOUT_MS = 60_000;
const GRACEFUL_CANCEL_TIMEOUT_MS = 5_000;

type WatchdogHandle = {
  markActivity: () => void;
  dispose: () => void;
};

type ProcessContext = {
  kind: 'process';
  proc: AgentProcess;
  parser: Transform;
  watchdog: WatchdogHandle;
  abortController: AbortController;
  signal: AbortSignal;
  agentName: string;
  sessionAgentId?: string;
  pendingPermissionKeys: string[];
};

type ProcessClaim = {
  kind: 'claim';
  previous?: ProcessContext;
};

type ContextEntry = ProcessContext | ProcessClaim;

export interface AgentEventContext {
  isCurrent: () => boolean;
  signal: AbortSignal;
}

export interface AgentManagerEvents {
  onEvent: (sessionKey: SessionKey, event: AgentEvent, context: AgentEventContext) => void;
  onToolBlocked: (sessionKey: SessionKey, command: string, requestId: string) => void;
  onPermissionTimeout: (sessionKey: SessionKey, requestId: string) => void;
  onProcessExit: (
    sessionKey: SessionKey,
    code: number | null,
    context: AgentEventContext,
  ) => void | Promise<void>;
}

export type AgentProcessCleanupBinder = (signal: AbortSignal, sessionKey: SessionKey) => void;

function pendingPermissionKey(sessionKey: SessionKey, requestId: string): string {
  return `${sessionKey}::${requestId}`;
}

export class AgentManager {
  private plugins = new Map<string, AgentPlugin>();
  private contexts = new Map<SessionKey, ContextEntry>();
  private exitingContexts = new Map<SessionKey, ProcessContext>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private pendingPermissionContexts = new Map<string, ProcessContext>();
  private toolGate: ToolGate;
  private bindProcessCleanup: AgentProcessCleanupBinder;

  constructor(toolGate: ToolGate, bindProcessCleanup: AgentProcessCleanupBinder) {
    this.toolGate = toolGate;
    this.bindProcessCleanup = bindProcessCleanup;
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

  async spawnAgent(
    sessionKey: SessionKey,
    agentName: string,
    opts: SpawnOpts,
    handlers: AgentManagerEvents,
  ): Promise<AgentProcess> {
    const plugin = this.plugins.get(agentName);
    if (!plugin) throw new Error(`Unknown agent: ${agentName}`);
    const claim = this.claimContext(sessionKey);
    let promoted = false;

    try {
      if (!(await validateWorkingDirectory(opts.workingDirectory))) {
        throw new Error(`Invalid working directory: ${opts.workingDirectory}`);
      }
      this.assertCurrentClaim(sessionKey, claim);

      const abortController = this.createAbortController(sessionKey);
      const proc = plugin.spawn(opts);
      const ctx = this.createProcessContext(sessionKey, agentName, plugin, proc, opts, abortController);
      this.promoteClaim(sessionKey, claim, ctx);
      promoted = true;
      this.setupOutputStream(sessionKey, plugin, ctx, opts, handlers);
      this.setupExitHandler(sessionKey, ctx, handlers);

      return proc;
    } catch (err) {
      if (!promoted) {
        this.releaseClaim(sessionKey, claim);
      }
      throw err;
    }
  }

  async resumeAgent(
    sessionKey: SessionKey,
    agentName: string,
    sessionId: string,
    opts: SpawnOpts,
    handlers: AgentManagerEvents,
  ): Promise<AgentProcess> {
    const plugin = this.plugins.get(agentName);
    if (!plugin) throw new Error(`Unknown agent: ${agentName}`);
    const claim = this.claimContext(sessionKey);
    let promoted = false;

    try {
      if (!(await validateWorkingDirectory(opts.workingDirectory))) {
        throw new Error(`Invalid working directory: ${opts.workingDirectory}`);
      }
      this.assertCurrentClaim(sessionKey, claim);

      const abortController = this.createAbortController(sessionKey);
      const proc = plugin.resume(sessionId, opts);
      const ctx = this.createProcessContext(sessionKey, agentName, plugin, proc, opts, abortController);
      this.promoteClaim(sessionKey, claim, ctx);
      promoted = true;
      this.setupOutputStream(sessionKey, plugin, ctx, opts, handlers);
      this.setupExitHandler(sessionKey, ctx, handlers);

      return proc;
    } catch (err) {
      if (!promoted) {
        this.releaseClaim(sessionKey, claim);
      }
      throw err;
    }
  }

  sendMessage(sessionKey: SessionKey, agentName: string, msg: UserMessage): void {
    const ctx = this.getProcessContext(sessionKey);
    const plugin = this.plugins.get(agentName);
    if (!ctx || !plugin) return;
    if (ctx.signal.aborted) return;

    const formatted = plugin.formatStdinMessage(msg);
    ctx.proc.stdin.write(formatted);
  }

  approvePermission(sessionKey: SessionKey, requestId: string): boolean {
    const key = pendingPermissionKey(sessionKey, requestId);
    const pending = this.pendingPermissions.get(key);
    if (!pending) return false;
    const ctx = this.pendingPermissionContexts.get(key);
    if (!ctx || !this.isCurrentContext(pending.sessionKey, ctx)) {
      if (ctx) this.clearPendingPermission(sessionKey, requestId, ctx);
      return false;
    }
    if (ctx.signal.aborted) return false;

    this.clearPendingPermission(sessionKey, requestId, ctx);

    const plugin = this.plugins.get(pending.agentName);
    if (plugin) {
      ctx.proc.stdin.write(plugin.formatPermissionResponse(requestId, 'allow'));
    }
    return true;
  }

  denyPermission(sessionKey: SessionKey, requestId: string): boolean {
    const key = pendingPermissionKey(sessionKey, requestId);
    const pending = this.pendingPermissions.get(key);
    if (!pending) return false;
    const ctx = this.pendingPermissionContexts.get(key);
    if (!ctx || !this.isCurrentContext(pending.sessionKey, ctx)) {
      if (ctx) this.clearPendingPermission(sessionKey, requestId, ctx);
      return false;
    }
    if (ctx.signal.aborted) return false;

    this.clearPendingPermission(sessionKey, requestId, ctx);

    const plugin = this.plugins.get(pending.agentName);
    if (plugin) {
      ctx.proc.stdin.write(plugin.formatPermissionResponse(requestId, 'deny'));
    }
    return true;
  }

  getPendingPermissionForSession(sessionKey: SessionKey): PendingPermission | undefined {
    for (const [key, pending] of this.pendingPermissions) {
      const ctx = this.pendingPermissionContexts.get(key);
      if (!ctx || ctx.signal.aborted || !this.isCurrentContext(pending.sessionKey, ctx)) {
        if (ctx) this.clearPendingPermission(pending.sessionKey, pending.requestId, ctx);
        continue;
      }
      if (pending.sessionKey === sessionKey) return pending;
    }
    return undefined;
  }

  cancelAgent(sessionKey: SessionKey): void {
    const ctx = this.getProcessContext(sessionKey);
    if (!ctx) return;
    this.abortContext(ctx);

    const plugin = this.plugins.get(ctx.agentName);

    if (plugin?.capabilities.gracefulCancel && plugin.formatCancelMessage) {
      ctx.proc.stdin.write(plugin.formatCancelMessage());
      setTimeout(() => {
        if (!this.isCurrentContext(sessionKey, ctx)) return;
        ctx.proc.kill('SIGTERM');
        setTimeout(() => {
          if (!this.isCurrentContext(sessionKey, ctx)) return;
          ctx.proc.kill('SIGKILL');
        }, 5000);
      }, GRACEFUL_CANCEL_TIMEOUT_MS);
    } else {
      ctx.proc.kill('SIGTERM');
      setTimeout(() => {
        if (!this.isCurrentContext(sessionKey, ctx)) return;
        ctx.proc.kill('SIGKILL');
      }, 5000);
    }
  }

  killAgent(sessionKey: SessionKey, expectedProc?: AgentProcess): void {
    const ctx = this.getProcessContext(sessionKey);
    if (!ctx) return;
    if (expectedProc && ctx.proc !== expectedProc) return;
    this.abortContext(ctx);

    ctx.proc.kill('SIGTERM');
    setTimeout(() => {
      if (!this.isCurrentContext(sessionKey, ctx)) return;
      ctx.proc.kill('SIGKILL');
    }, 5000);
  }

  hasProcess(sessionKey: SessionKey): boolean {
    return this.isProcessActive(sessionKey);
  }

  isProcessActive(sessionKey: SessionKey): boolean {
    const ctx = this.getProcessContextForActiveCheck(sessionKey);
    return !!ctx && !ctx.signal.aborted;
  }

  getProcess(sessionKey: SessionKey): AgentProcess | undefined {
    return this.getProcessContext(sessionKey)?.proc;
  }

  getContextSignal(sessionKey: SessionKey): AbortSignal | undefined {
    return this.getProcessContext(sessionKey)?.signal;
  }

  getCurrentContext(sessionKey: SessionKey): AgentEventContext | undefined {
    const ctx = this.getCurrentRawContext(sessionKey);
    return ctx ? this.createCurrentEventContext(sessionKey, ctx) : undefined;
  }

  private setupWatchdog(
    sessionKey: SessionKey,
    ctx: ProcessContext,
    turnTimeoutMs?: number,
    idleTimeoutMs?: number,
  ): WatchdogHandle {
    let disposed = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const expire = () => {
      if (disposed) return;
      if (!this.isCurrentContext(sessionKey, ctx)) return;
      this.killAgent(sessionKey, ctx.proc);
    };

    const turnTimer = turnTimeoutMs ? setTimeout(expire, turnTimeoutMs) : undefined;
    const markActivity = () => {
      if (!idleTimeoutMs || disposed) return;
      if (!this.isCurrentContext(sessionKey, ctx)) return;
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

  private createAbortController(sessionKey: SessionKey): AbortController {
    const abortController = new AbortController();
    this.bindProcessCleanup(abortController.signal, sessionKey);
    return abortController;
  }

  private createProcessContext(
    sessionKey: SessionKey,
    agentName: string,
    plugin: AgentPlugin,
    proc: AgentProcess,
    opts: SpawnOpts,
    abortController: AbortController,
  ): ProcessContext {
    const parser = plugin.createStdoutParser();
    const ctx: ProcessContext = {
      kind: 'process',
      proc,
      parser,
      watchdog: undefined as unknown as WatchdogHandle,
      abortController,
      signal: abortController.signal,
      agentName,
      sessionAgentId: proc.sessionId || undefined,
      pendingPermissionKeys: [],
    };
    ctx.watchdog = this.setupWatchdog(sessionKey, ctx, opts.turnTimeoutMs, opts.idleTimeoutMs);
    return ctx;
  }

  private claimContext(sessionKey: SessionKey): ProcessClaim {
    const exiting = this.exitingContexts.get(sessionKey);
    if (exiting) {
      this.exitingContexts.delete(sessionKey);
      this.disposeContext(exiting);
    }
    const current = this.contexts.get(sessionKey);
    const previous = current?.kind === 'process' ? current : current?.previous;
    const claim: ProcessClaim = { kind: 'claim', previous };
    this.contexts.set(sessionKey, claim);
    return claim;
  }

  private promoteClaim(sessionKey: SessionKey, claim: ProcessClaim, ctx: ProcessContext): void {
    this.assertCurrentClaim(sessionKey, claim);
    this.contexts.set(sessionKey, ctx);
    if (claim.previous) this.disposeContext(claim.previous);
  }

  private releaseClaim(sessionKey: SessionKey, claim: ProcessClaim): void {
    if (!this.isCurrentClaim(sessionKey, claim)) return;
    if (claim.previous) {
      this.contexts.set(sessionKey, claim.previous);
    } else {
      this.contexts.delete(sessionKey);
    }
  }

  private assertCurrentClaim(sessionKey: SessionKey, claim: ProcessClaim): void {
    if (!this.isCurrentClaim(sessionKey, claim)) {
      throw new Error(`Process start superseded for ${sessionKey}`);
    }
  }

  private isCurrentClaim(sessionKey: SessionKey, claim: ProcessClaim): boolean {
    return this.contexts.get(sessionKey) === claim;
  }

  private getProcessContext(sessionKey: SessionKey): ProcessContext | undefined {
    const ctx = this.contexts.get(sessionKey);
    return ctx?.kind === 'process' ? ctx : undefined;
  }

  private getProcessContextForActiveCheck(sessionKey: SessionKey): ProcessContext | undefined {
    const ctx = this.contexts.get(sessionKey);
    if (ctx?.kind === 'process') return ctx;
    return ctx?.previous;
  }

  private setupExitHandler(
    sessionKey: SessionKey,
    ctx: ProcessContext,
    handlers: AgentManagerEvents,
  ): void {
    ctx.proc.on('exit', (code) => {
      void this.handleProcessExit(sessionKey, ctx, handlers, code).catch((err) => {
        console.error(`[agent-manager] process exit handler failed for ${sessionKey}:`, err);
      });
    });
  }

  private async handleProcessExit(
    sessionKey: SessionKey,
    ctx: ProcessContext,
    handlers: AgentManagerEvents,
    code: number | null,
  ): Promise<void> {
    const exitContext = this.createCurrentEventContext(sessionKey, ctx);
    const current = this.contexts.get(sessionKey);
    if (current?.kind === 'claim' && current.previous === ctx) {
      current.previous = undefined;
      this.disposeContext(ctx);
      await handlers.onProcessExit(sessionKey, code, exitContext);
      return;
    }

    if (!this.isCurrentContext(sessionKey, ctx)) return;

    this.contexts.delete(sessionKey);
    this.exitingContexts.set(sessionKey, ctx);
    try {
      await handlers.onProcessExit(sessionKey, code, exitContext);
    } finally {
      if (this.exitingContexts.get(sessionKey) === ctx) {
        this.exitingContexts.delete(sessionKey);
        this.disposeContext(ctx);
      }
    }
  }

  private setupOutputStream(
    sessionKey: SessionKey,
    plugin: AgentPlugin,
    ctx: ProcessContext,
    opts: SpawnOpts,
    handlers: AgentManagerEvents,
  ): void {
    const { proc, parser, watchdog } = ctx;
    const eventContext = this.createProcessEventContext(sessionKey, ctx);

    const markRawActivity = () => {
      if (!this.isCurrentContext(sessionKey, ctx)) return;
      watchdog.markActivity();
    };
    proc.stdout.on('data', markRawActivity);
    proc.stdout.pipe(parser);

    parser.on('data', (event: AgentEvent) => {
      if (!this.isCurrentContext(sessionKey, ctx)) return;
      if (ctx.signal.aborted) return;

      watchdog.markActivity();

      if (event.type === 'permission_request') {
        if (opts.autoApprove) {
          proc.stdin.write(plugin.formatPermissionResponse(event.id, 'allow'));
          handlers.onEvent(sessionKey, event, eventContext);
          return;
        }

        const gateResult = this.toolGate.check(event.tool, event.input);

        if (gateResult.action === 'block') {
          const key = pendingPermissionKey(sessionKey, event.id);
          const timer = setTimeout(() => {
            if (!this.isCurrentContext(sessionKey, ctx)) return;
            if (this.pendingPermissionContexts.get(key) !== ctx) return;

            this.clearPendingPermission(sessionKey, event.id, ctx);

            proc.stdin.write(plugin.formatPermissionResponse(event.id, 'deny'));
            handlers.onPermissionTimeout(sessionKey, event.id);
          }, PERMISSION_TIMEOUT_MS);

          this.pendingPermissions.set(key, {
            requestId: event.id,
            tool: event.tool,
            command: gateResult.command ?? '',
            chatId: sessionKey.split(':')[1],
            sessionKey,
            agentName: plugin.name,
            timer,
            createdAt: Date.now(),
          });
          this.pendingPermissionContexts.set(key, ctx);
          ctx.pendingPermissionKeys.push(key);

          handlers.onToolBlocked(sessionKey, gateResult.command ?? '', event.id);
          return;
        }

        // Auto-approve safe commands
        proc.stdin.write(plugin.formatPermissionResponse(event.id, 'allow'));
      }

      if (event.type === 'result' && event.sessionId) {
        proc.sessionId = event.sessionId;
        ctx.sessionAgentId = event.sessionId;
      }

      if (event.type === 'status' && event.sessionId) {
        proc.sessionId = event.sessionId;
        ctx.sessionAgentId = event.sessionId;
      }

      if (event.type === 'tool_result') {
        event.output = scanToolResult(event.name, event.output);
      }

      handlers.onEvent(sessionKey, event, eventContext);
    });

    ctx.watchdog = {
      markActivity: watchdog.markActivity,
      dispose: () => {
        watchdog.dispose();
        proc.stdout.off('data', markRawActivity);
        proc.stdout.unpipe(parser);
        parser.removeAllListeners();
      },
    };
  }

  private disposeContext(ctx: ProcessContext): void {
    this.abortContext(ctx);
    ctx.watchdog.dispose();
    this.clearPendingPermissionsForContext(ctx);
  }

  private abortContext(ctx: ProcessContext): void {
    this.clearPendingPermissionsForContext(ctx);
    if (ctx.signal.aborted) return;
    ctx.abortController.abort();
  }

  private clearPendingPermissionsForContext(ctx: ProcessContext): void {
    for (const key of [...ctx.pendingPermissionKeys]) {
      this.clearPendingPermissionByKey(key, ctx);
    }
  }

  private clearPendingPermission(sessionKey: SessionKey, requestId: string, ctx: ProcessContext): void {
    this.clearPendingPermissionByKey(pendingPermissionKey(sessionKey, requestId), ctx);
  }

  private clearPendingPermissionByKey(key: string, ctx: ProcessContext): void {
    if (this.pendingPermissionContexts.get(key) !== ctx) return;
    const pending = this.pendingPermissions.get(key);
    if (pending) clearTimeout(pending.timer);
    this.pendingPermissions.delete(key);
    this.pendingPermissionContexts.delete(key);
    ctx.pendingPermissionKeys = ctx.pendingPermissionKeys.filter((pendingKey) => pendingKey !== key);
  }

  private isCurrentContext(sessionKey: SessionKey, ctx: ProcessContext): boolean {
    return this.contexts.get(sessionKey) === ctx;
  }

  private getCurrentRawContext(sessionKey: SessionKey): ProcessContext | undefined {
    return this.getProcessContext(sessionKey) ?? this.exitingContexts.get(sessionKey);
  }

  private createProcessEventContext(
    sessionKey: SessionKey,
    ctx: ProcessContext,
  ): AgentEventContext {
    return {
      isCurrent: () => this.isCurrentContext(sessionKey, ctx),
      signal: ctx.signal,
    };
  }

  private createCurrentEventContext(
    sessionKey: SessionKey,
    ctx: ProcessContext,
  ): AgentEventContext {
    return {
      isCurrent: () => this.getCurrentRawContext(sessionKey) === ctx,
      signal: ctx.signal,
    };
  }
}
