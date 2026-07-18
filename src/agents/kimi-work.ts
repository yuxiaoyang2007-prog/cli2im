import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type {
  AgentCapabilities,
  AgentConfig,
  AgentEvent,
  AgentPlugin,
  AgentProcess,
  SpawnOpts,
  UserMessage,
} from '../types.js';
import { InputQueue } from './input-queue.js';
import {
  KimiWorkRpcClient,
  KimiWorkRpcError,
  resolveKimiNodePath,
  spawnKimiDaimon,
  type KimiWorkConversationCreateResult,
  type KimiWorkConversationSendResult,
  type KimiWorkInteractionPendingParams,
  type KimiWorkInteractionTerminalParams,
  type KimiWorkMessageEventParams,
  type KimiWorkMessagePart,
  type KimiWorkRpcHandlers,
  type KimiWorkRpcNotification,
  type SpawnKimiDaimonOpts,
  type SpawnedKimiDaimon,
} from './kimi-work-protocol.js';

// The daimon's local-client conversation lane is keyed by this fixed sessionKey.
const KIMI_WORK_SESSION_KEY = 'desktop-local-chat';

type KimiWorkStdinPayload =
  | { type: 'user'; message: UserMessage }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'cancel' };

interface PendingTurn {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface KimiWorkRpcConnection {
  connect(): Promise<void>;
  sendRequest<R = unknown>(method: string, params?: unknown): Promise<R>;
  dispose(reason?: string): void;
}

export interface KimiWorkPluginDeps {
  startDaimon(opts: SpawnKimiDaimonOpts): Promise<SpawnedKimiDaimon>;
  createRpcClient(url: string, token: string, handlers: KimiWorkRpcHandlers): KimiWorkRpcConnection;
}

interface SharedDaimon {
  generation: number;
  spawned: SpawnedKimiDaimon;
  rpc: KimiWorkRpcConnection;
  broadcasted: boolean;
}

const defaultDeps: KimiWorkPluginDeps = {
  startDaimon: spawnKimiDaimon,
  createRpcClient: (url, token, handlers) => new KimiWorkRpcClient(url, token, handlers),
};

function messageToText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function thinkingLevel(value: SpawnOpts['reasoningEffort']): 'low' | 'high' | 'max' {
  if (value === 'max' || value === 'xhigh') return 'max';
  if (value === 'high' || value === 'medium') return 'high';
  return 'low';
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactKimiLog(line: string): string {
  return line
    .replace(/(token=)[^\s]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/("apiKey"\s*:\s*")[^"]+/gi, '$1[redacted]');
}

// Resolve when `promise` settles OR after `ms`, whichever comes first. Never
// rejects and never hangs — used for best-effort teardown RPCs (daemon.shutdown,
// conversations.cancel) so an unresponsive daimon can't wedge shutdown/exit.
function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    const done = () => { clearTimeout(timer); resolve(); };
    promise.then(done, done);
  });
}

export class KimiWorkVirtualProcess implements AgentProcess {
  pid = process.pid;
  sessionId = '';
  readonly stdin: Writable;
  readonly stdout = new PassThrough({ objectMode: true });

  private readonly emitter = new EventEmitter();
  private readonly inputQueue = new InputQueue<string>();
  private inputBuffer = '';
  private bootstrapPromise: Promise<void> | undefined;
  private activeTurn: PendingTurn | undefined;
  private activeTurnId: string | undefined;
  private completedTurnIds = new Set<string>();
  private terminated = false;
  private exitEmitted = false;
  private textByPart = new Map<string, string>();
  private reasoningByPart = new Map<string, string>();
  private seenToolParts = new Set<string>();
  private pendingInteractions = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly plugin: KimiWorkPlugin,
    private readonly opts: SpawnOpts,
  ) {
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.handleStdin(chunk);
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    void this.consumeInput();
  }

  get isTerminated(): boolean {
    return this.terminated;
  }

  kill(_signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    void this.terminate(true, null);
  }

  on(event: 'exit', handler: (code: number | null) => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
  on(event: 'exit' | 'error', handler: (...args: any[]) => void): void {
    this.emitter.on(event, handler);
  }

  handleNotification(notification: KimiWorkRpcNotification): void {
    if (this.terminated) return;
    switch (notification.method) {
      case 'conversations.message.snapshot':
        this.handleMessage(notification.params as KimiWorkMessageEventParams | undefined, false);
        return;
      case 'conversations.message.complete':
        this.handleMessage(notification.params as KimiWorkMessageEventParams | undefined, true);
        return;
      case 'conversations.message.error':
      case 'conversations.message.warning': {
        const params = objectValue(notification.params);
        const message = stringValue(params.message || params.error || notification.method);
        this.failTurn(new Error(message));
        this.emit({ type: 'error', message: `kimi-work turn 失败：${message}` });
        return;
      }
      case 'conversations.message.cancelled':
        this.failTurn(new Error('turn cancelled'));
        this.emit({ type: 'error', message: 'kimi-work turn 已取消' });
        return;
      case 'interaction.pending':
        this.handleInteraction(notification.params as KimiWorkInteractionPendingParams | undefined);
        return;
      case 'interaction.expired':
      case 'interaction.cancelled':
        this.clearInteraction(notification.params as KimiWorkInteractionTerminalParams | undefined);
        return;
      default:
        return;
    }
  }

  handleDaimonCrash(error: Error): void {
    if (this.terminated) return;
    this.emit({ type: 'error', message: `kimi-work daimon 已退出：${error.message}` });
    if (this.emitter.listenerCount('error') > 0) this.emitter.emit('error', error);
    this.failTurn(error);
    for (const timer of this.pendingInteractions.values()) clearTimeout(timer);
    this.pendingInteractions.clear();
    this.finishTermination(1);
  }

  private handleStdin(chunk: Buffer | string | Uint8Array): void {
    this.inputBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = this.inputBuffer.split('\n');
    this.inputBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let payload: KimiWorkStdinPayload;
      try {
        payload = JSON.parse(line) as KimiWorkStdinPayload;
      } catch {
        continue;
      }
      if (payload.type === 'cancel') {
        void this.terminate(true, null);
      } else if (payload.type === 'permission_response') {
        void this.respondToInteraction(payload.requestId, payload.decision);
      } else if (payload.type === 'user') {
        this.inputQueue.push(messageToText(payload.message));
      }
    }
  }

  private async consumeInput(): Promise<void> {
    for await (const prompt of this.inputQueue) {
      if (this.terminated) return;
      try {
        await this.ensureBootstrap();
        await this.runTurn(prompt);
      } catch (error) {
        if (this.terminated) return;
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ type: 'error', message: `kimi-work 失败：${message}` });
      }
    }
  }

  private ensureBootstrap(): Promise<void> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.plugin.openConversation(this, this.opts).then(({ pid, conversationKey }) => {
        this.pid = pid;
        this.sessionId = conversationKey;
        this.emit({ type: 'status', sessionId: conversationKey });
      }).catch((error) => {
        this.bootstrapPromise = undefined;
        throw error;
      });
    }
    return this.bootstrapPromise;
  }

  private async runTurn(prompt: string): Promise<void> {
    if (this.terminated || !this.sessionId) return;
    this.textByPart.clear();
    this.reasoningByPart.clear();
    this.seenToolParts.clear();
    this.activeTurnId = undefined;
    const completion = new Promise<void>((resolve, reject) => {
      this.activeTurn = { resolve, reject };
    });

    const params = {
      conversationKey: this.sessionId,
      text: prompt,
      modelAlias: this.opts.model || this.plugin.defaultModel,
      thinkingLevel: thinkingLevel(this.opts.reasoningEffort || this.plugin.defaultEffort),
    } as const;

    try {
      const ack = await this.sendTurn(params);
      if (!ack.accepted) throw new Error('conversations.send was not accepted');
      if (this.activeTurnId && this.activeTurnId !== ack.turnId) {
        throw new Error(`turn id mismatch: expected ${ack.turnId}, received ${this.activeTurnId}`);
      }
      this.activeTurnId = ack.turnId;
      await completion;
    } catch (error) {
      this.activeTurn = undefined;
      this.activeTurnId = undefined;
      if (!this.terminated) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ type: 'error', message: `kimi-work conversations.send 失败：${message}` });
      }
    }
  }

  private async sendTurn(
    params: Record<string, unknown>,
  ): Promise<KimiWorkConversationSendResult> {
    try {
      return await this.plugin.request<KimiWorkConversationSendResult>('conversations.send', params);
    } catch (error) {
      // Never auto-resend. No error class reliably proves the first attempt did
      // not already start a turn — a JSON-RPC error can be returned after the
      // handler produced side effects, and a transport loss is fully ambiguous —
      // so a resend could double-charge quota or re-run tools. Surface and stop;
      // the user re-sends explicitly if needed.
      const detail = error instanceof KimiWorkRpcError
        ? `(${error.code}) ${error.message}`
        : error instanceof Error ? error.message : String(error);
      throw new Error(`发送失败且未自动重发（避免重复扣额度/重复执行工具）：${detail}`);
    }
  }

  private handleMessage(params: KimiWorkMessageEventParams | undefined, complete: boolean): void {
    if (!params || params.conversationKey !== this.sessionId || params.message.role !== 'assistant') return;
    if (!this.activeTurn || this.completedTurnIds.has(params.turnId)) return;
    if (this.activeTurnId && this.activeTurnId !== params.turnId) return;
    this.activeTurnId = params.turnId;
    const indexes = new Map<string, number>();
    for (const part of params.message.parts) {
      const index = indexes.get(part.kind) ?? 0;
      indexes.set(part.kind, index + 1);
      this.handlePart(part, index);
    }
    if (!complete) return;
    this.completedTurnIds.add(params.turnId);
    if (this.completedTurnIds.size > 32) {
      const oldest = this.completedTurnIds.values().next().value;
      if (oldest) this.completedTurnIds.delete(oldest);
    }
    this.emit({ type: 'result', sessionId: this.sessionId });
    this.activeTurn?.resolve();
    this.activeTurn = undefined;
    this.activeTurnId = undefined;
  }

  private handlePart(part: KimiWorkMessagePart, index: number): void {
    const id = stringValue(part.toolCallId || part.id || index);
    if (part.kind === 'reasoning') {
      this.emitTextDelta(this.reasoningByPart, `reasoning:${index}`, part.text, 'thinking');
      return;
    }
    if (part.kind === 'text') {
      this.emitTextDelta(this.textByPart, `text:${index}`, part.text, 'text');
      return;
    }
    const key = `${part.kind}:${id}`;
    if (this.seenToolParts.has(key)) return;
    this.seenToolParts.add(key);
    const name = stringValue(part.toolName || part.name);
    if (part.kind === 'tool-call') {
      this.emit({ type: 'tool_use', id, name, input: objectValue(part.input) });
    } else if (part.kind === 'tool-result') {
      const event: AgentEvent = {
        type: 'tool_result',
        id,
        name,
        output: stringValue(part.output ?? part.result ?? part.text),
      };
      if (part.isError) event.isError = true;
      this.emit(event);
    }
  }

  private emitTextDelta(
    seen: Map<string, string>,
    key: string,
    value: string | undefined,
    type: 'text' | 'thinking',
  ): void {
    if (!value) return;
    const previous = seen.get(key) ?? '';
    const delta = value.startsWith(previous) ? value.slice(previous.length) : value;
    seen.set(key, value);
    if (delta) this.emit({ type, content: delta });
  }

  private handleInteraction(params: KimiWorkInteractionPendingParams | undefined): void {
    const interaction = params?.interaction;
    if (!interaction || interaction.turn.conversationKey !== this.sessionId) return;
    if (this.opts.autoApprove || this.opts.permissionMode === 'bypass') {
      void this.plugin.request('interaction.respond', {
        interactionId: interaction.id,
        response: { decision: 'approved' },
      }).catch((error) => this.emit({
        type: 'error',
        message: `kimi-work 自动审批失败：${error instanceof Error ? error.message : String(error)}`,
      }));
      return;
    }

    const expiresAt = Date.parse(interaction.expiresAt);
    const delay = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - Date.now()) : 120_000;
    const timer = setTimeout(() => this.pendingInteractions.delete(interaction.id), delay);
    this.pendingInteractions.set(interaction.id, timer);
    this.emit({
      type: 'permission_request',
      id: interaction.id,
      tool: interaction.turn.toolName || interaction.toolName || interaction.turn.toolCallId || 'tool',
      input: objectValue(interaction.input ?? interaction.turn.input),
    });
  }

  private async respondToInteraction(requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    const timer = this.pendingInteractions.get(requestId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingInteractions.delete(requestId);
    // Wire format (verified live + from renderer): response payload with a
    // past-tense decision, deny carries optional feedback.
    const response: Record<string, unknown> = {
      decision: decision === 'allow' ? 'approved' : 'rejected',
    };
    if (decision === 'deny') response.feedback = 'Denied by user';
    try {
      await this.plugin.request('interaction.respond', { interactionId: requestId, response });
    } catch (error) {
      if (!this.terminated) {
        this.emit({
          type: 'error',
          message: `kimi-work 审批响应失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  private clearInteraction(params: KimiWorkInteractionTerminalParams | undefined): void {
    const id = params?.interactionId || params?.interaction?.id;
    if (!id) return;
    const timer = this.pendingInteractions.get(id);
    if (timer) clearTimeout(timer);
    this.pendingInteractions.delete(id);
  }

  private failTurn(error: Error): void {
    this.activeTurn?.reject(error);
    this.activeTurn = undefined;
    this.activeTurnId = undefined;
  }

  private async terminate(cancelConversation: boolean, code: number | null): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    this.inputQueue.close();
    this.failTurn(new Error('terminated'));
    for (const timer of this.pendingInteractions.values()) clearTimeout(timer);
    this.pendingInteractions.clear();
    await this.plugin.closeConversation(this, cancelConversation);
    this.finishTermination(code);
  }

  private finishTermination(code: number | null): void {
    if (this.exitEmitted) return;
    this.terminated = true;
    this.exitEmitted = true;
    this.inputQueue.close();
    this.stdout.end();
    this.emitter.emit('exit', code);
  }

  private emit(event: AgentEvent): void {
    if (!this.terminated) this.stdout.write(event);
  }
}

export class KimiWorkPlugin implements AgentPlugin {
  readonly name = 'kimi-work';
  readonly displayName = 'Kimi Work (K3)';
  readonly capabilities: AgentCapabilities = {
    streamJson: true,
    permissionPrompt: true,
    sessionResume: false,
    gracefulCancel: true,
    slashCommands: [],
  };
  readonly defaultModel: string;
  readonly defaultEffort: AgentConfig['defaultEffort'];

  private shared: SharedDaimon | undefined;
  private startPromise: Promise<SharedDaimon> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private generation = 0;
  private readonly dispatchers = new Map<string, KimiWorkVirtualProcess>();
  private readonly processes = new Set<KimiWorkVirtualProcess>();
  // conversationKey known from create, before the virtual process learns its
  // sessionId — lets teardown cancel a conversation created mid-bootstrap.
  private readonly provisionalKeys = new Map<KimiWorkVirtualProcess, string>();

  constructor(
    private readonly config: AgentConfig,
    private readonly deps: KimiWorkPluginDeps = defaultDeps,
  ) {
    this.defaultModel = config.defaultModel || 'k3-agent';
    this.defaultEffort = config.defaultEffort || 'low';
  }

  async preflight(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const env = { ...process.env, ...this.config.env };
      await access('/Applications/Kimi.app', constants.R_OK);
      await access(this.config.binary, constants.X_OK);
      const nodePath = await resolveKimiNodePath(env);
      const shareDir = env.KIMI_SHARE_DIR || join(homedir(), '.cli2im', 'kimi-work');
      const configPath = env.DAIMON_CONFIG_PATH || join(shareDir, 'config.json');
      let hasCredential = false;
      try {
        const config = JSON.parse(await readFile(configPath, 'utf8')) as {
          credentials?: { kimiCode?: unknown };
        };
        hasCredential = !!config.credentials?.kimiCode;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      if (!hasCredential) {
        const key = JSON.parse(await readFile(join(shareDir, 'kimi-code-key.json'), 'utf8')) as { apiKey?: unknown };
        if (!key.apiKey) throw new Error('Kimi Work credential is missing');
      }
      // The bundled kimi-daimon CLI has no `--version` (it forwards args to the
      // runtime, which rejects unknown flags). The presence/executability checks
      // above are the preflight; the real control handshake happens on first spawn.
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  spawn(opts: SpawnOpts): AgentProcess {
    const process = new KimiWorkVirtualProcess(this, opts);
    this.processes.add(process);
    return process;
  }

  resume(_sessionId: string, opts: SpawnOpts): AgentProcess {
    return this.spawn(opts);
  }

  buildSpawnArgs(_opts: SpawnOpts): string[] {
    const nodePath = this.config.env?.DAIMON_BUNDLE_NODE_BIN
      || '/Applications/Kimi.app/Contents/Resources/resources/runtime/node';
    return ['--node', nodePath, 'start', '--control'];
  }

  createStdoutParser(): PassThrough {
    return new PassThrough({ objectMode: true });
  }

  formatStdinMessage(message: UserMessage): string {
    return JSON.stringify({ type: 'user', message }) + '\n';
  }

  formatPermissionResponse(requestId: string, decision: 'allow' | 'deny'): string {
    return JSON.stringify({ type: 'permission_response', requestId, decision }) + '\n';
  }

  formatCancelMessage(): string {
    return JSON.stringify({ type: 'cancel' }) + '\n';
  }

  async openConversation(
    process: KimiWorkVirtualProcess,
    opts: SpawnOpts,
  ): Promise<{ pid: number; conversationKey: string }> {
    const shared = await this.ensureDaimon(opts);
    const created = await shared.rpc.sendRequest<KimiWorkConversationCreateResult>(
      'conversations.create',
      { sessionKey: KIMI_WORK_SESSION_KEY },
    );
    const conversationKey = created.session?.activeConversationKey;
    if (!conversationKey) throw new Error('conversations.create returned no activeConversationKey');
    // Register the key immediately (before the process learns its sessionId) so
    // closeConversation can always cancel/deregister it — even if the process is
    // cancelled during the setActive round-trip below.
    this.provisionalKeys.set(process, conversationKey);
    this.dispatchers.set(conversationKey, process);
    // The process may have been cancelled while create was in flight; its own
    // teardown ran before the key was registered, so clean up here.
    if (process.isTerminated) {
      await this.discardConversation(process, conversationKey);
      throw new Error('kimi-work virtual process terminated during bootstrap');
    }
    try {
      // setActive requires BOTH sessionKey and conversationKey (verified live).
      await shared.rpc.sendRequest('conversations.setActive', {
        sessionKey: KIMI_WORK_SESSION_KEY,
        conversationKey,
      });
    } catch (error) {
      await this.discardConversation(process, conversationKey);
      throw error;
    }
    return { pid: shared.spawned.child.pid || process.pid, conversationKey };
  }

  // Cancel + deregister a conversation registered during bootstrap, without
  // touching the process's own lifecycle (its teardown handles that).
  private async discardConversation(process: KimiWorkVirtualProcess, conversationKey: string): Promise<void> {
    this.provisionalKeys.delete(process);
    if (this.dispatchers.get(conversationKey) === process) this.dispatchers.delete(conversationKey);
    if (this.shared) {
      await settleWithin(this.shared.rpc.sendRequest('conversations.cancel', { conversationKey }), 3_000);
    }
  }

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    const shared = this.shared;
    if (!shared) return Promise.reject(new Error(`kimi-work daimon unavailable for ${method}`));
    return shared.rpc.sendRequest<R>(method, params);
  }

  async closeConversation(process: KimiWorkVirtualProcess, cancel: boolean): Promise<void> {
    this.processes.delete(process);
    // Fall back to the provisional key so a conversation created during bootstrap
    // (sessionId not yet set) is still cancelled and deregistered.
    const conversationKey = process.sessionId || this.provisionalKeys.get(process);
    this.provisionalKeys.delete(process);
    if (conversationKey && this.dispatchers.get(conversationKey) === process) {
      this.dispatchers.delete(conversationKey);
    }
    if (!cancel || !conversationKey || !this.shared) return;
    // Best-effort, bounded: an unresponsive daimon must not wedge the virtual
    // process's exit.
    await settleWithin(this.shared.rpc.sendRequest('conversations.cancel', { conversationKey }), 3_000);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async ensureDaimon(opts: SpawnOpts): Promise<SharedDaimon> {
    if (this.shared) return this.shared;
    if (this.startPromise) return this.startPromise;
    const generation = ++this.generation;
    const promise = this.startShared(generation, opts);
    this.startPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = undefined;
    }
  }

  private async startShared(generation: number, opts: SpawnOpts): Promise<SharedDaimon> {
    let shared: SharedDaimon | undefined;
    try {
      const spawned = await this.deps.startDaimon({
        binary: this.config.binary,
        workingDirectory: opts.workingDirectory,
        env: { ...this.config.env, ...opts.env },
      });
      const rpc = this.deps.createRpcClient(spawned.url, spawned.token, {
        onNotification: (notification) => this.routeNotification(generation, notification),
        onError: (error) => this.handleSharedFailure(generation, error),
        onClose: (code, reason) => this.handleSharedFailure(
          generation,
          new Error(`control socket closed (${code}${reason ? `: ${reason}` : ''})`),
        ),
      });
      shared = { generation, spawned, rpc, broadcasted: false };
      this.shared = shared;
      spawned.child.once('error', (error) => this.handleSharedFailure(generation, error));
      spawned.child.once('exit', (code) => this.handleSharedFailure(
        generation,
        new Error(`kimi-daimon exited with code ${code}`),
      ));
      spawned.child.stderr?.setEncoding('utf8');
      spawned.child.stderr?.on('data', (chunk: string) => {
        const line = chunk.trim();
        if (line) console.log(`[kimi-work] ${redactKimiLog(line)}`);
      });
      await rpc.connect();
      if (this.shared !== shared) throw new Error('kimi-daimon start superseded');
      return shared;
    } catch (error) {
      if (this.shared?.generation === generation) this.shared = undefined;
      shared?.rpc.dispose('startup failed');
      try {
        shared?.spawned.child.kill('SIGTERM');
      } catch {
        // It already exited.
      }
      throw error;
    }
  }

  private routeNotification(generation: number, notification: KimiWorkRpcNotification): void {
    if (this.shared?.generation !== generation) return;
    const params = objectValue(notification.params);
    const interaction = objectValue(params.interaction);
    const turn = objectValue(interaction.turn || params.turn);
    const conversationKey = typeof params.conversationKey === 'string'
      ? params.conversationKey
      : typeof turn.conversationKey === 'string'
        ? turn.conversationKey
        : undefined;
    if (!conversationKey) return;
    this.dispatchers.get(conversationKey)?.handleNotification(notification);
  }

  private handleSharedFailure(generation: number, error: Error): void {
    const shared = this.shared;
    if (!shared || shared.generation !== generation || shared.broadcasted) return;
    shared.broadcasted = true;
    this.shared = undefined;
    if (this.startPromise) this.startPromise = undefined;
    shared.rpc.dispose('daimon failed');
    try {
      shared.spawned.child.kill('SIGTERM');
    } catch {
      // It already exited.
    }
    const processes = [...this.processes];
    this.processes.clear();
    this.dispatchers.clear();
    this.provisionalKeys.clear();
    for (const process of processes) process.handleDaimonCrash(error);
  }

  private async doShutdown(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // Startup already cleaned its own generation.
      }
    }
    const shared = this.shared;
    if (!shared) return;
    shared.broadcasted = true;
    this.shared = undefined;
    this.processes.clear();
    this.dispatchers.clear();
    this.provisionalKeys.clear();
    try {
      // Bounded: if the control socket is open but the daimon never answers,
      // fall through to dispose + kill instead of hanging shutdown forever.
      await settleWithin(shared.rpc.sendRequest('daemon.shutdown', {}), 3_000);
    } finally {
      shared.rpc.dispose('plugin shutdown');
      try {
        shared.spawned.child.kill('SIGTERM');
      } catch {
        // It already exited.
      }
    }
  }
}
