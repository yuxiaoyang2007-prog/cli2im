import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PassThrough, Writable } from 'node:stream';
import type {
  AgentCapabilities,
  AgentEvent,
  AgentPlugin,
  AgentProcess,
  SpawnOpts,
  UserMessage,
} from '../types.js';
import { InputQueue } from './input-queue.js';
import {
  spawnZcodeAppServer,
  ZcodeRpcClient,
  ZcodeRpcError,
  type ZcodeEventEnvelope,
  type ZcodeMode,
  type ZcodePartDeltaPayload,
  type ZcodePermissionDecision,
  type ZcodePermissionRequestParams,
  type ZcodeRpcRequest,
  type ZcodeSessionCreateResult,
  type ZcodeToolUpdatedPayload,
  type ZcodeTurnCompletedPayload,
  type ZcodeTurnFailedPayload,
} from './zcode-protocol.js';

// =============================================================================
// zcode agent plugin.
//
// Drives a long-lived `zcode app-server` child process via the JSON-RPC
// protocol (see zcode-protocol.ts). One virtual process = one chat = one
// app-server child. Messages from cli2im (written to our stdin) are
// translated into `session/send` requests; events pushed back by the
// server (`session/event` notifications) are translated into cli2im
// AgentEvents and pushed onto our object-mode stdout.
//
// Permission flow: the server sends an `interaction/requestPermission`
// server→client REQUEST (it carries a JSON-RPC `id`). We surface it to
// cli2im as a `permission_request` AgentEvent keyed by zcode's own
// `requestId`. cli2im's manager writes the user's decision back to our
// stdin via `formatPermissionResponse`; we then correlate requestId →
// JSON-RPC `id` and reply `{id, result:{decision}}`.
// =============================================================================

// --- stdin payloads (our private line protocol with cli2im's manager) -------
//
// These mirror what every other plugin does: a newline-delimited JSON
// object whose `type` selects the action. The manager writes whichever
// payload `formatStdinMessage` / `formatPermissionResponse` /
// `formatCancelMessage` produced.

type ZcodeStdinPayload =
  | { type: 'user'; message: UserMessage }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'cancel' };

interface PendingTurn {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface PendingPermission {
  rpcId: string | number; // JSON-RPC id to reply to
}

const PROMPT_ARG_MAX_BYTES = 100 * 1024;

function mapPermissionMode(mode: SpawnOpts['permissionMode']): ZcodeMode {
  // bypass  → yolo (no permission prompts at all)
  // blacklist → build (prompts for non-allowlisted tools → our card flow)
  return mode === 'bypass' ? 'yolo' : 'build';
}

// Flatten a cli2im UserMessage to the plain string zcode's `content` wants.
// Images are written to temp files and referenced in the prompt (zcode can
// read them from disk), same technique the gemini/agy plugins use.
function messageToPrompt(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;

  const textParts: string[] = [];
  const imagePaths: string[] = [];

  for (const block of message.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      const ext = block.source.media_type.split('/')[1] ?? 'png';
      const dir = join(tmpdir(), 'cli2im-zcode-images');
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      writeFileSync(filePath, Buffer.from(block.source.data, 'base64'));
      imagePaths.push(filePath);
    }
  }

  if (imagePaths.length > 0) {
    const fileList = imagePaths.map((p) => `- ${p}`).join('\n');
    textParts.push(`\n[用户发送了 ${imagePaths.length} 张图片，已保存到以下路径，请用读取文件的能力查看后分析：\n${fileList}\n]`);
  }

  return textParts.join('\n');
}

// =============================================================================
// The virtual process.
// =============================================================================

export class ZcodeVirtualProcess implements AgentProcess {
  pid = process.pid;
  sessionId: string;
  stdin: Writable;
  stdout: PassThrough;

  private rpc: ZcodeRpcClient;
  private inputBuffer = '';
  private inputQueue = new InputQueue<string>();
  private bootstrapPromise: Promise<void> | undefined;
  private bootstrapError: Error | undefined;
  private activeTurn: PendingTurn | null = null;
  // True while enqueue() is driving the bootstrap → runTurn path, before
  // activeTurn is set. activeTurn alone is not enough: it's assigned inside
  // runTurn *after* the async ensureBootstrap() await, so two messages that
  // arrive before the first bootstrap resolves would both see activeTurn ===
  // null and race into concurrent session/send ("turn already running").
  private driving = false;
  private queuedPrompts: string[] = [];
  // True once we've streamed any assistant text for the active turn via
  // part.delta. zcode (in build mode) often delivers the whole answer only
  // in turn.completed.response with zero part.delta events; in that case we
  // must emit the response as a single text event so the IM IM card shows it.
  private streamedTextThisTurn = false;
  // Guard so we retry the fresh-session recovery at most once per turn.
  private retriedFreshThisTurn = false;
  // requestId (zcode's, used in the AgentEvent) → JSON-RPC id (to reply to).
  private pendingPermissions = new Map<string, PendingPermission>();
  private terminated = false;
  private exitEmitted = false;
  private readonly eventEmitter = new EventEmitter();

  constructor(
    private readonly binary: string,
    private readonly opts: SpawnOpts,
    private resumeSessionId?: string,
  ) {
    this.sessionId = resumeSessionId ?? '';
    this.stdout = new PassThrough({ objectMode: true });

    const child = spawnZcodeAppServer(this.binary, opts);
    this.pid = child.pid ?? process.pid;
    this.rpc = new ZcodeRpcClient(child, {
      onSessionEvent: (env) => this.handleWireEvent(env),
      onRequest: (req) => this.handleServerRequest(req),
      onExit: (code, err) => this.handleTransportExit(code, err),
    });
    // Forward zcode stderr to cli2im's logs for debugging.
    this.rpc.onLog((line) => console.log(`[zcode] ${line}`));

    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        try {
          this.handleStdinChunk(chunk);
          callback();
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
  }

  // --- AgentProcess surface ------------------------------------------------

  kill(_signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.terminate(null);
  }

  on(event: 'exit', handler: (code: number | null) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'exit' | 'error', handler: (...args: any[]) => void): void {
    this.eventEmitter.on(event, handler);
  }

  // --- stdin (from cli2im manager) -----------------------------------------

  private handleStdinChunk(chunk: Buffer | string | Uint8Array): void {
    this.inputBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = this.inputBuffer.split('\n');
    this.inputBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload: ZcodeStdinPayload;
      try {
        payload = JSON.parse(trimmed) as ZcodeStdinPayload;
      } catch {
        continue;
      }
      this.handleStdinPayload(payload);
    }
  }

  private handleStdinPayload(payload: ZcodeStdinPayload): void {
    switch (payload.type) {
      case 'cancel':
        this.terminate(null);
        return;
      case 'permission_response':
        this.resolvePermission(payload.requestId, payload.decision);
        return;
      case 'user':
        void this.enqueue(messageToPrompt(payload.message));
        return;
    }
  }

  // --- turn lifecycle ------------------------------------------------------

  private async enqueue(prompt: string): Promise<void> {
    if (this.terminated) return;

    // If a turn is already running OR one is being set up (bootstrap in
    // flight), queue behind it. The runTurn loop drains queued prompts when
    // the active turn resolves.
    if (this.activeTurn || this.driving) {
      this.queuedPrompts.push(prompt);
      return;
    }

    // First message (or after a turn finished) drives bootstrap + runTurn.
    this.driving = true;
    try {
      try {
        await this.ensureBootstrap();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitError(`zcode session 启动失败：${message}`);
        this.bailUnrecoverable();
        return;
      }

      if (this.terminated) return;
      await this.runTurn(prompt);
    } finally {
      this.driving = false;
    }
  }

  private async ensureBootstrap(): Promise<void> {
    if (this.bootstrapPromise) {
      // A previous bootstrap attempt failed — propagate the cached error
      // rather than retrying implicitly (cli2im will cold-start a fresh
      // virtual process on the next message).
      if (this.bootstrapError) throw this.bootstrapError;
      return this.bootstrapPromise;
    }

    this.bootstrapPromise = this.doBootstrap().catch((err) => {
      this.bootstrapError = err instanceof Error ? err : new Error(String(err));
      // doBootstrap() assigns this.sessionId before awaiting session/subscribe,
      // so a subscribe failure leaves a non-empty but unusable sessionId (no
      // subscription = no events will ever arrive). Clear it on ANY bootstrap
      // failure so the !sessionId checks downstream (e.g. the -32031 reset path)
      // reliably treat this instance as unrecoverable.
      this.sessionId = '';
      throw this.bootstrapError;
    });
    return this.bootstrapPromise;
  }

  private async doBootstrap(): Promise<void> {
    const workspacePath = this.opts.workingDirectory;
    const workspace = { workspacePath, workspaceKey: workspacePath };

    let sessionId: string;

    if (this.resumeSessionId) {
      try {
        const res = await this.rpc.sendRequest<ZcodeSessionCreateResult>(
          'session/resume',
          { sessionId: this.resumeSessionId, workspace },
        );
        sessionId = res.session?.sessionId ?? this.resumeSessionId;
      } catch (err) {
        // The persisted session may be unusable: model no longer available
        // (-32031), archived, or stale. Fall back to a fresh session so the
        // user isn't permanently stuck. The old history is lost, but the bot
        // keeps working — which is the better failure mode for an IM bot.
        const code = err instanceof ZcodeRpcError ? err.code : undefined;
        console.warn(`[zcode] session/resume ${this.resumeSessionId} failed (${code ?? 'unknown'}: ${err instanceof Error ? err.message : err}); starting fresh session`);
        this.resumeSessionId = undefined;
        const res = await this.rpc.sendRequest<ZcodeSessionCreateResult>(
          'session/create',
          { workspace, mode: mapPermissionMode(this.opts.permissionMode), persistence: 'deferred' },
        );
        sessionId = res.session?.sessionId ?? '';
      }
    } else {
      const res = await this.rpc.sendRequest<ZcodeSessionCreateResult>(
        'session/create',
        { workspace, mode: mapPermissionMode(this.opts.permissionMode), persistence: 'deferred' },
      );
      sessionId = res.session?.sessionId ?? '';
    }

    if (!sessionId) {
      throw new Error('server returned no session id');
    }

    this.sessionId = sessionId;
    this.emit({ type: 'status', sessionId });

    await this.subscribe(sessionId);
  }

  private async subscribe(sessionId: string): Promise<void> {
    // Subscribe so the server starts pushing live session/event notifications.
    await this.rpc.sendRequest('session/subscribe', {
      sessionId,
      deliveryKind: 'desktop-continuous',
      afterSeq: 0,
      includeSnapshot: false,
    });
  }

  // Create a fresh session (discarding any resume id) and wire it up. Used to
  // recover when a resumed session becomes unusable mid-conversation (e.g. its
  // model was retired → session/send returns -32031).
  private async resetToFreshSession(): Promise<void> {
    this.resumeSessionId = undefined;
    this.bootstrapPromise = undefined;
    this.bootstrapError = undefined;
    this.sessionId = '';
    await this.ensureBootstrap();
  }

  private async runTurn(prompt: string): Promise<void> {
    if (this.terminated || !this.sessionId) return;

    this.streamedTextThisTurn = false;
    this.retriedFreshThisTurn = false;

    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    if (promptBytes > PROMPT_ARG_MAX_BYTES) {
      // Very large prompts are still fine over JSON-RPC (no shell arg limit),
      // but we log it in case a future cap is needed.
      console.warn(`[zcode] sending large prompt (${promptBytes} bytes) to session/send`);
    }

    const turn = new Promise<void>((resolve, reject) => {
      this.activeTurn = { resolve, reject };
    });

    let sent = false;
    try {
      await this.rpc.sendRequest('session/send', {
        sessionId: this.sessionId,
        content: prompt,
      });
      sent = true;
    } catch (err) {
      // -32031 = the session's model is no longer available. The session may
      // have resumed fine but send refuses because the bound model is gone.
      // Recover by creating a brand-new session with the current default
      // model and retrying the send once. History is lost, but the bot keeps
      // working instead of being permanently stuck.
      if (err instanceof ZcodeRpcError && err.code === -32031 && !this.retriedFreshThisTurn) {
        this.retriedFreshThisTurn = true;
        console.warn(`[zcode] session/send model unavailable (-32031); resetting to fresh session and retrying`);
        try {
          await this.resetToFreshSession();
          if (this.terminated) return;
          await this.rpc.sendRequest('session/send', {
            sessionId: this.sessionId,
            content: prompt,
          });
          sent = true;
        } catch (retryErr) {
          this.activeTurn = null;
          const message = retryErr instanceof ZcodeRpcError ? `(${retryErr.code}) ${retryErr.message}` : String(retryErr);
          this.emitError(`zcode session/send 失败（重试后）：${message}`);
          if (!this.sessionId) {
            // resetToFreshSession() failed: sessionId is cleared and the
            // bootstrap error is cached, so this instance can't recover.
            // Draining would shift the next queued prompt into runTurn, which
            // returns immediately on the !sessionId guard — silently dropping
            // it. Bail (surface queued prompts + terminate) instead.
            this.bailUnrecoverable();
            return;
          }
          // Reset succeeded but the retry send failed on the live session —
          // fall through to the drain like any other send failure so queued
          // prompts still run.
        }
      } else {
        // -32010 = a turn is already running (queueing should prevent this),
        // or any other error — surface and clear the slot so the next turn
        // can proceed.
        this.activeTurn = null;
        const message = err instanceof ZcodeRpcError ? `(${err.code}) ${err.message}` : String(err);
        this.emitError(`zcode session/send 失败：${message}`);
      }
    }

    // Wait for the turn.completed / turn.failed event to resolve this.
    // failTurn() rejects this promise on turn.failed, transport exit, or
    // terminate. The error is already surfaced via emitError at each reject
    // site, so swallow it here: letting it escape would become an unhandled
    // rejection (callers invoke enqueue as `void this.enqueue(...)`) and would
    // skip the queue drain below. Only await if the send actually went out;
    // on a send failure `turn` never resolves.
    if (sent) {
      try {
        await turn;
      } catch {
        // Turn failed; error already emitted.
      }
    }

    // Drain any prompts that queued while this turn was running OR while it
    // failed to start — runs on the send-failure path too, so a message queued
    // during bootstrap is never stranded behind a later one. Skipped when
    // terminated (terminate() already clears the queue).
    const next = this.queuedPrompts.shift();
    if (next && !this.terminated) {
      await this.runTurn(next);
    }
  }

  // --- wire event → AgentEvent ---------------------------------------------

  private handleWireEvent(env: ZcodeEventEnvelope): void {
    if (this.terminated) return;
    // Keep our sessionId fresh in case the server created/resumed a new one.
    if (env.sessionId) this.sessionId = env.sessionId;

    switch (env.type) {
      case 'session.created':
      case 'session.resumed':
        this.emit({ type: 'status', sessionId: env.sessionId });
        return;

      case 'part.delta': {
        const p = env.payload as ZcodePartDeltaPayload | undefined;
        if (!p || typeof p.delta !== 'string' || p.delta === '') return;
        if (p.field === 'reasoning') {
          this.emit({ type: 'thinking', content: p.delta });
        } else {
          // text / undefined / output → streaming assistant text.
          this.streamedTextThisTurn = true;
          this.emit({ type: 'text', content: p.delta });
        }
        return;
      }

      case 'tool.updated': {
        const p = env.payload as ZcodeToolUpdatedPayload | undefined;
        if (!p) return;
        this.handleToolUpdated(p);
        return;
      }

      case 'turn.completed': {
        const p = env.payload as ZcodeTurnCompletedPayload | undefined;
        this.completeTurn(env.sessionId, p);
        return;
      }

      case 'turn.failed': {
        const p = env.payload as ZcodeTurnFailedPayload | undefined;
        const message = p?.message ?? 'turn failed (no detail)';
        this.failTurn(new Error(message));
        this.emitError(`zcode turn 失败：${message}`);
        return;
      }

      // Informational / unused types — intentionally ignored. We keep the
      // card stream clean by not surfacing session.titleUpdated, model.*,
      // checkpoint.*, etc. as IM-visible events.
      default:
        return;
    }
  }

  private handleToolUpdated(p: ZcodeToolUpdatedPayload): void {
    const id = p.toolCallId ?? '';
    const name = p.toolName ?? '';
    switch (p.kind) {
      case 'scheduled':
      case 'started':
        this.emit({
          type: 'tool_use',
          id,
          name,
          input: (p.input && typeof p.input === 'object' ? p.input : {}) as Record<string, unknown>,
        });
        return;
      case 'result': {
        const output = typeof p.result?.content === 'string'
          ? p.result.content
          : (typeof p.result?.display === 'string' ? p.result.display : '');
        this.emit({ type: 'tool_result', id, name, output, isError: p.result?.success === false ? true : undefined });
        return;
      }
      case 'error':
        this.emit({ type: 'tool_result', id, name, output: p.error ?? '', isError: true });
        return;
      default:
        // progress / batch — not surfaced to the IM card.
        return;
    }
  }

  private completeTurn(sessionId: string, p: ZcodeTurnCompletedPayload | undefined): void {
    const resultType = p?.resultType ?? 'success';
    if (resultType !== 'success' && resultType !== 'cancelled') {
      this.failTurn(new Error(`turn ended: ${resultType}`));
      this.emitError(`zcode turn 结束：${resultType}`);
      return;
    }

    // If zcode didn't stream any assistant text this turn (common in build
    // mode — the whole answer arrives only in turn.completed.response),
    // emit the response as a single text event so the IM card shows it.
    // cli2im's runtime accumulates `text` events into its relay buffer; a
    // bare `result` event with no preceding text would leave the user with
    // an empty reply.
    if (!this.streamedTextThisTurn && typeof p?.response === 'string' && p.response.trim() !== '') {
      this.emit({ type: 'text', content: p.response });
    }

    const usage = p?.usage
      ? {
          inputTokens: typeof p.usage.inputTokens === 'number' ? p.usage.inputTokens : 0,
          outputTokens: typeof p.usage.outputTokens === 'number' ? p.usage.outputTokens : 0,
          cacheReadTokens: typeof p.usage.cacheReadTokens === 'number' ? p.usage.cacheReadTokens : undefined,
        }
      : undefined;

    this.emit({ type: 'result', sessionId, usage });
    this.activeTurn?.resolve();
    this.activeTurn = null;
  }

  private failTurn(err: Error): void {
    this.activeTurn?.reject(err);
    this.activeTurn = null;
  }

  // --- permission (server→client request channel) --------------------------

  private handleServerRequest(req: ZcodeRpcRequest): void {
    if (req.method === 'interaction/requestPermission') {
      const params = req.params as ZcodePermissionRequestParams | undefined;
      if (!params) return;
      this.handlePermissionRequest(req.id, params);
      return;
    }

    if (req.method === 'interaction/requestUserInput') {
      // We don't support the AskUserQuestion surface from IM; auto-decline so
      // the agent doesn't hang. cli2im's card flow is permission-only.
      this.rpc.sendResponse(req.id, { decision: 'deny', reason: 'user input not supported via IM' });
      return;
    }

    // Unknown server→client request: reply with a generic error so the
    // server's awaiting promise doesn't hang forever.
    this.rpc.sendResponse(req.id, undefined);
  }

  private handlePermissionRequest(rpcId: string | number, params: ZcodePermissionRequestParams): void {
    if (this.opts.autoApprove) {
      this.rpc.sendResponse(rpcId, { decision: 'allow' } satisfies ZcodePermissionDecision);
      return;
    }

    // Record the JSON-RPC id so resolvePermission can reply later.
    this.pendingPermissions.set(params.requestId, { rpcId });

    this.emit({
      type: 'permission_request',
      id: params.requestId,
      tool: params.toolName,
      input: (params.input && typeof params.input === 'object' ? params.input : {}) as Record<string, unknown>,
    });
  }

  private resolvePermission(requestId: string, decision: 'allow' | 'deny'): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);

    const result: ZcodePermissionDecision = decision === 'allow'
      ? { decision: 'allow' }
      : { decision: 'deny', reason: 'Denied by user' };
    this.rpc.sendResponse(pending.rpcId, result);
  }

  private denyPendingPermissions(reason: string): void {
    for (const [, pending] of this.pendingPermissions) {
      this.rpc.sendResponse(pending.rpcId, { decision: 'deny', reason });
    }
    this.pendingPermissions.clear();
  }

  // --- lifecycle / teardown -------------------------------------------------

  // The instance can no longer serve turns (no session + cached bootstrap
  // error). Surface any prompts queued during the failed bootstrap/reset
  // instead of dropping them silently, then terminate so the manager
  // cold-starts a fresh process on the next message. emitError alone does NOT
  // recycle the process — the manager only recycles on an exit event.
  private bailUnrecoverable(): void {
    if (this.queuedPrompts.length > 0) {
      this.emitError(`zcode session 启动失败，已丢弃 ${this.queuedPrompts.length} 条排队消息，请重新发送`);
    }
    this.terminate(null);
  }

  private handleTransportExit(code: number | null, err?: Error): void {
    if (this.terminated) return;
    const message = err
      ? err.message
      : `zcode app-server exited (code ${code})`;
    this.failTurn(new Error(message));
    this.denyPendingPermissions('zcode process exited');
    this.emitError(message);
    this.terminate(code);
  }

  private terminate(code: number | null): void {
    if (this.terminated) return;
    this.terminated = true;
    this.queuedPrompts = [];
    this.inputQueue.close();
    this.denyPendingPermissions('terminated');

    // Best-effort stop, then kill the child.
    if (this.sessionId) {
      try {
        this.rpc.sendNotification('session/stop', { sessionId: this.sessionId });
      } catch {
        /* transport may already be gone */
      }
    }
    this.rpc.dispose();

    if (!this.activeTurn) {
      this.emitExit(code);
    } else {
      // An active turn's promise will reject via failTurn; emit exit after.
      this.failTurn(new Error('terminated'));
      this.emitExit(code);
    }
  }

  private emitExit(code: number | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.stdout.end();
    this.eventEmitter.emit('exit', code);
  }

  // --- output helper -------------------------------------------------------

  private emit(event: AgentEvent): void {
    if (this.terminated) return;
    this.stdout.write(event);
  }

  private emitError(message: string): void {
    this.emit({ type: 'error', message });
  }
}

// =============================================================================
// The plugin.
// =============================================================================

export class ZcodePlugin implements AgentPlugin {
  name = 'zcode';
  displayName = 'ZCode (GLM-5.2)';
  private readonly binary: string;

  capabilities: AgentCapabilities = {
    streamJson: true,
    permissionPrompt: true,
    sessionResume: true,
    gracefulCancel: true,
    slashCommands: [],
  };

  constructor(binary: string) {
    this.binary = binary;
  }

  async preflight(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      // The binary is a .cjs bundle — run it through node.
      const output = execFileSync(process.execPath, [this.binary, '--version'], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      return { ok: true, version: output.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  spawn(opts: SpawnOpts): AgentProcess {
    return new ZcodeVirtualProcess(this.binary, opts, undefined);
  }

  resume(sessionId: string, opts: SpawnOpts): AgentProcess {
    return new ZcodeVirtualProcess(this.binary, opts, sessionId);
  }

  buildSpawnArgs(_opts: SpawnOpts): string[] {
    // The args we would pass to node if we spawned a raw process. Used only
    // for logging / the /sessions resume hint, since this plugin drives the
    // child directly.
    return [this.binary, 'app-server'];
  }

  createStdoutParser(): PassThrough {
    // stdout is already an object-mode stream of AgentEvent; the manager's
    // pipe just needs a no-op passthrough (same trick claude-code/gemini use).
    return new PassThrough({ objectMode: true });
  }

  formatStdinMessage(msg: UserMessage): string {
    return JSON.stringify({ type: 'user', message: msg }) + '\n';
  }

  formatPermissionResponse(requestId: string, decision: 'allow' | 'deny'): string {
    return JSON.stringify({ type: 'permission_response', requestId, decision }) + '\n';
  }

  formatCancelMessage(): string {
    return JSON.stringify({ type: 'cancel' }) + '\n';
  }
}
