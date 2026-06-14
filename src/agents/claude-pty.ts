import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Transform, Writable } from 'node:stream';
import type {
  AgentCapabilities,
  AgentEvent,
  AgentPlugin,
  AgentProcess,
  SpawnOpts,
  UserMessage,
} from '../types.js';
import { getCli2imDataDir } from '../util/data-dir.js';
import { InputInjector, type InputWriteTarget } from './pty/InputInjector.js';
import { InteractiveClaudeSession } from './pty/InteractiveClaudeSession.js';
import { JsonlTailer } from './pty/JsonlTailer.js';
import { PtyClaudeRunner, type PtySpawnInput, type PtyState } from './pty/PtyClaudeRunner.js';
import {
  buildSandboxProfile,
  defaultDenyReadPaths,
  writeSandboxProfile,
} from './pty/SandboxProfile.js';
import { PtyScreenRenderer } from './pty/screen.js';
import {
  SettingsInjector,
  type BuiltSettings,
  type StatuslinePayload,
  type StopMarker,
} from './pty/SettingsInjector.js';
import { TurnController, type TurnDecision } from './pty/TurnController.js';

const AGENT_SLASH_COMMANDS = [
  '/compact', '/review', '/ultrareview', '/cost', '/doctor',
  '/permissions', '/config', '/memory', '/init', '/help',
];
const DEFAULT_TURN_TIMEOUT_MS = 180_000;
const STATUSLINE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;
const BLACKLIST_DENY_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit'];

type ProcessState = 'starting' | 'ready' | 'rebuilding' | 'degradedNeedsResume' | 'failed' | 'terminated';

type PtyRunnerLike = {
  pid?: number;
  currentState: PtyState;
  spawn(input: PtySpawnInput): Promise<void>;
  write(data: string): void | Promise<void>;
  kill(signal?: string): void;
  onData(cb: (chunk: string) => void): () => void;
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): () => void;
};

type JsonlTailerLike = Pick<JsonlTailer, 'drain' | 'seekToEnd'>;
type RuntimeSettings = BuiltSettings;

interface Runtime {
  settings: RuntimeSettings;
  runner: PtyRunnerLike;
  tailer: JsonlTailerLike;
  injector: InputInjector;
  session: InteractiveClaudeSession;
  disposeStopWatch: () => void;
  disposeRunnerData: () => void;
  disposeRunnerExit: () => void;
}

interface StopQueue {
  push(marker: StopMarker): void;
  shift(): StopMarker | undefined;
  clear(): void;
}

export interface ClaudePtyRuntimeDeps {
  buildSettings?: (input: {
    handle: string;
    sessionId?: string;
    effortLevel?: string;
    permissionMode: SpawnOpts['permissionMode'];
  }) => Promise<BuiltSettings>;
  createRunner?: (opts: { claudeBin: string; cwd: string; env?: Record<string, string> }) => PtyRunnerLike;
  createTailer?: (path: string) => JsonlTailerLike;
  watchStop?: (
    filePath: string,
    filter: { sessionId?: string },
    cb: (marker: StopMarker) => void,
  ) => () => void;
  waitForStatuslinePayload?: (filePath: string) => Promise<StatuslinePayload>;
}

interface ClaudePtyRuntimeTuning {
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  slashQuietMs?: number;
  slashTimeoutMs?: number;
}

type StdinPayload =
  | { type: 'user'; message: UserMessage }
  | { type: 'cancel' }
  | { type: 'tool_use_permission_response'; tool_use_id: string; decision: 'allow' | 'deny' };

export class ClaudePtyVirtualProcess implements AgentProcess {
  pid = process.pid;
  sessionId: string;
  stdin: Writable;
  stdout: PassThrough;

  private readonly events = new EventEmitter();
  private readonly deps: Required<ClaudePtyRuntimeDeps>;
  private readonly turnTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly slashQuietMs?: number;
  private readonly slashTimeoutMs?: number;
  private inputBuffer = '';
  private state: ProcessState;
  private ready: Promise<void>;
  private queue: UserMessage[] = [];
  private processing = false;
  private runtime?: Runtime;
  private stopQueue: StopQueue = createStopQueue();
  private terminated = false;
  private exitEmitted = false;
  private suppressRunnerExit = false;
  private activeCancel?: { cancelled: boolean };

  constructor(
    private readonly binary: string,
    private readonly opts: SpawnOpts,
    resumeSessionId?: string,
    deps: ClaudePtyRuntimeDeps = {},
    tuning: ClaudePtyRuntimeTuning = {},
  ) {
    this.sessionId = resumeSessionId ?? '';
    this.state = resumeSessionId ? 'rebuilding' : 'starting';
    this.turnTimeoutMs = tuning.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.pollIntervalMs = tuning.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.slashQuietMs = tuning.slashQuietMs;
    this.slashTimeoutMs = tuning.slashTimeoutMs;
    this.deps = withDefaultDeps(deps);
    this.stdout = new PassThrough({ objectMode: true });
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
    this.ready = this.init(resumeSessionId).catch((err) => {
      this.failInit(err);
    });
  }

  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    if (this.terminated) return;
    this.terminated = true;
    this.state = 'terminated';
    this.queue = [];
    this.activeCancel = undefined;
    this.disposeRuntime(signal, true);
    this.ready.finally(() => this.emitExit(null)).catch(() => this.emitExit(null));
  }

  on(event: 'exit', handler: (code: number | null) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'exit' | 'error', handler: (...args: any[]) => void): void {
    this.events.on(event, handler);
  }

  private handleStdinChunk(chunk: Buffer | string | Uint8Array): void {
    this.inputBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = this.inputBuffer.split('\n');
    this.inputBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload: StdinPayload;
      try {
        payload = JSON.parse(trimmed) as StdinPayload;
      } catch {
        continue;
      }
      if (payload.type === 'user') {
        this.queue.push(payload.message);
        void this.drainQueue();
      } else if (payload.type === 'cancel') {
        this.activeCancel = { cancelled: true };
      }
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.processing || this.terminated) return;
    this.processing = true;
    try {
      await this.ready;
      while (!this.terminated && this.queue.length > 0) {
        if (this.state === 'degradedNeedsResume') {
          await this.rebuildRuntime();
        }
        if (this.state === 'failed' || this.state === 'terminated') return;
        const message = this.queue.shift();
        if (!message) continue;
        await this.processTurn(message);
      }
    } finally {
      this.processing = false;
      if (!this.terminated && this.queue.length > 0) void this.drainQueue();
    }
  }

  private async processTurn(message: UserMessage): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) {
      this.writeEvent({ type: 'error', message: 'Claude PTY runtime is not ready' });
      return;
    }

    const cancel = { cancelled: false };
    this.activeCancel = cancel;
    const prompt = messageToText(message);
    const slashCommand = extractAgentSlashCommand(prompt);
    if (slashCommand) {
      await this.processSlashTurn(runtime, slashCommand, cancel);
      if (this.activeCancel === cancel) this.activeCancel = undefined;
      return;
    }

    const decision = await runtime.session.send(prompt, {
      onEvent: (event) => this.emitIfCurrent(event, cancel),
    }).catch((err) => {
      const event = { type: 'error' as const, message: err instanceof Error ? err.message : String(err) };
      this.emitIfCurrent(event, cancel);
      return undefined;
    });

    if (decision?.sessionId && !this.sessionId) {
      this.sessionId = decision.sessionId;
    }
    if (this.activeCancel === cancel) this.activeCancel = undefined;

  }

  private async processSlashTurn(
    runtime: Runtime,
    command: string,
    cancel: { cancelled: boolean },
  ): Promise<void> {
    try {
      const result = await runtime.session.runSlashCommand(command);
      if (this.isTurnCancelled(cancel)) return;
      const output = redactSlashOutput(result.output);
      if (output) {
        this.writeEvent({ type: 'text', content: output, noRelay: true });
      }
      this.writeEvent({ type: 'result', sessionId: this.sessionId, noRelay: true });
    } catch (err) {
      if (!this.isTurnCancelled(cancel)) {
        this.writeEvent({
          type: 'error',
          message: redactSlashOutput(err instanceof Error ? err.message : String(err)),
        });
      }
    } finally {
      await runtime.tailer.seekToEnd();
    }
  }

  private async init(resumeSessionId?: string): Promise<void> {
    if (this.terminated) return;
    const runtime = await this.createRuntime(resumeSessionId);
    if (this.terminated) {
      this.disposeRuntime('SIGTERM', true, runtime);
      return;
    }
    this.runtime = runtime;
    this.state = 'ready';
    if (!resumeSessionId) {
      this.writeStatusIfReady();
    }
  }

  private async rebuildRuntime(): Promise<void> {
    if (this.terminated) return;
    this.state = 'rebuilding';
    this.ready = this.createRuntime(this.sessionId || undefined)
      .then((runtime) => {
        if (this.terminated) {
          this.disposeRuntime('SIGTERM', true, runtime);
          return;
        }
        this.runtime = runtime;
        this.state = 'ready';
      })
      .catch((err) => this.failInit(err));
    await this.ready;
  }

  private async createRuntime(resumeSessionId?: string): Promise<Runtime> {
    const handle = `claude-pty-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ptyHandleDir = join(getCli2imDataDir(), 'pty', handle);
    const tmpDir = join(ptyHandleDir, 'tmp');
    const settings = await this.deps.buildSettings({
      handle,
      sessionId: resumeSessionId,
      effortLevel: this.opts.reasoningEffort,
      permissionMode: this.opts.permissionMode,
    });
    const sandboxProfilePath = await this.buildSandboxProfile(handle, ptyHandleDir);
    const runner = this.deps.createRunner({
      claudeBin: this.binary,
      cwd: this.opts.workingDirectory,
      env: this.opts.env,
    });
    const disposeRunnerExit = runner.onExit((event) => {
      if (this.suppressRunnerExit) return;
      if (this.terminated) return;
      this.state = 'terminated';
      this.emitExit(event.exitCode ?? null);
    });
    const initScreen = new PtyScreenRenderer();
    const disposeRunnerData = runner.onData((chunk) => {
      void initScreen.write(chunk);
    });

    let disposeStopWatch: (() => void) | undefined;
    let spawned = false;
    try {
      await runner.spawn({
        settingsPath: settings.settingsPath,
        resumeSessionId,
        model: this.opts.model,
        permissionMode: this.opts.permissionMode,
        addDirs: buildAddDirs(this.opts.workingDirectory, this.opts.addDirs),
        sandboxProfilePath,
        tmpDir: sandboxProfilePath ? tmpDir : undefined,
      });
      spawned = true;

      const stopInitMenuWatcher = this.watchInitMenus(initScreen, runner);
      let payload: StatuslinePayload;
      try {
        payload = await this.deps.waitForStatuslinePayload(settings.rawPayloadFile);
      } catch (err) {
        throw await this.decorateInitTimeoutError(err, initScreen);
      } finally {
        stopInitMenuWatcher();
      }
      if (!payload.sessionId) {
        throw new Error('Claude PTY did not report a session id');
      }
      if (!payload.transcriptPath) {
        throw new Error('Claude PTY did not report a transcript path');
      }
      if (this.terminated) {
        throw new Error('Claude PTY init terminated');
      }

      this.sessionId = payload.sessionId;
      const tailer = this.deps.createTailer(payload.transcriptPath);
      if (resumeSessionId) await tailer.seekToEnd();
      this.stopQueue = createStopQueue();
      disposeStopWatch = this.deps.watchStop(
        settings.stopMarkerFile,
        { sessionId: payload.sessionId },
        (marker) => this.stopQueue.push(marker),
      );
      const injector = new InputInjector(runner as InputWriteTarget);
      const session = new InteractiveClaudeSession({
        injector,
        turnTimeoutMs: this.turnTimeoutMs,
        beginTurn: () => this.currentController?.beginTurn(),
        waitForTurn: (input) => this.waitForPtyTurn(input?.onEvents),
        onTurnDeadline: () => this.handleTurnDeadline(),
        onDispose: async () => {
          this.disposeRuntime('SIGTERM', true);
        },
        slash: {
          runner,
          quietMs: this.slashQuietMs,
          timeoutMs: this.slashTimeoutMs,
        },
      });

      return {
        settings,
        runner,
        tailer,
        injector,
        session,
        disposeStopWatch,
        disposeRunnerData,
        disposeRunnerExit,
      };
    } catch (err) {
      disposeStopWatch?.();
      disposeRunnerData();
      disposeRunnerExit();
      if (spawned) runner.kill('SIGTERM');
      throw err;
    }
  }

  private async buildSandboxProfile(handle: string, ptyHandleDir: string): Promise<string | undefined> {
    if (this.opts.sandbox !== 'workdir') return undefined;
    if (!existsSync('/usr/bin/sandbox-exec')) {
      throw new Error('Claude PTY sandbox requested but /usr/bin/sandbox-exec is unavailable');
    }
    const tmpDir = join(ptyHandleDir, 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const homeDir = homedir();
    const profile = buildSandboxProfile({
      boxRoots: this.opts.sandboxBoxRoots ?? [this.opts.workingDirectory],
      homeDir,
      ptyHandleDir,
      denyReadPaths: defaultDenyReadPaths(homeDir),
      otherProtectedRoots: this.opts.sandboxOtherProtectedRoots ?? [],
    });
    return writeSandboxProfile({ handle, ptyHandleDir, profile });
  }

  private currentController?: TurnController;

  private async waitForPtyTurn(onEvents?: (events: AgentEvent[]) => void | Promise<void>): Promise<TurnDecision> {
    const runtime = this.runtime;
    if (!runtime) {
      return { branch: 'error', events: [{ type: 'error', message: 'Claude PTY runtime is not ready' }] };
    }
    const controller = new TurnController({
      tailer: runtime.tailer as JsonlTailer,
      sessionId: this.sessionId || undefined,
      transcriptPath: this.currentTranscriptPath(),
      maxTurnMs: Number.POSITIVE_INFINITY,
      stopDrainPollMs: this.pollIntervalMs,
    });
    this.currentController = controller;
    controller.beginTurn();
    const cancel = this.activeCancel ?? { cancelled: false };
    const startedAt = Date.now();
    for (;;) {
      if (this.isTurnCancelled(cancel)) {
        return { branch: 'ignored', events: [], reason: 'turn cancelled' };
      }

      const records = await runtime.tailer.drain();
      if (this.isTurnCancelled(cancel)) {
        return { branch: 'ignored', events: [], reason: 'turn cancelled' };
      }
      const events = controller.observeRecords(records);
      if (events.length > 0) {
        await onEvents?.(events);
      }
      if (this.isTurnCancelled(cancel)) {
        return { branch: 'ignored', events: [], reason: 'turn cancelled' };
      }

      const marker = this.stopQueue.shift();
      if (marker) {
        const decision = await controller.handleStop(marker);
        if (this.isTurnCancelled(cancel)) {
          return { branch: 'ignored', events: [], reason: 'turn cancelled' };
        }
        if (decision.branch !== 'waiting' && decision.branch !== 'ignored') {
          this.currentController = undefined;
          return decision;
        }
      }

      const elapsedMs = Date.now() - startedAt;
      const fallback = controller.evaluateFallback({
        elapsedMs,
        ptyReady: runtime.runner.currentState === 'ready',
      });
      if (fallback.branch === 'error') {
        this.currentController = undefined;
        return fallback;
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async handleTurnDeadline(): Promise<TurnDecision> {
    const controller = this.currentController;
    const cancel = this.activeCancel;
    const decision = controller?.finalizeOnDeadline(this.turnTimeoutMs) ?? {
      branch: 'error' as const,
      events: [{ type: 'error' as const, message: `Turn timed out after ${this.turnTimeoutMs}ms` }],
      elapsedMs: this.turnTimeoutMs,
      reason: 'turn deadline exceeded',
    };
    for (const event of decision.events) {
      this.writeEvent(event);
    }
    if (cancel) cancel.cancelled = true;
    this.disposeRuntime('SIGTERM', false);
    this.state = this.terminated ? 'terminated' : 'degradedNeedsResume';
    this.currentController = undefined;
    return { ...decision, events: [] };
  }

  private disposeRuntime(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM', emitExit = false, runtime = this.runtime): void {
    if (!runtime) return;
    if (this.runtime === runtime) this.runtime = undefined;
    runtime.disposeStopWatch();
    runtime.disposeRunnerData();
    runtime.disposeRunnerExit();
    this.stopQueue.clear();
    this.suppressRunnerExit = !emitExit;
    try {
      runtime.runner.kill(signal);
    } finally {
      this.suppressRunnerExit = false;
    }
  }

  private emitIfCurrent(event: AgentEvent, cancel: { cancelled: boolean }): void {
    if (this.isTurnCancelled(cancel)) return;
    this.writeEvent(event);
  }

  private isTurnCancelled(cancel: { cancelled: boolean }): boolean {
    return cancel.cancelled || this.terminated || this.state === 'degradedNeedsResume';
  }

  private writeStatusIfReady(): void {
    if (this.sessionId) this.writeEvent({ type: 'status', sessionId: this.sessionId });
  }

  private writeEvent(event: AgentEvent): void {
    if (this.terminated || this.stdout.destroyed) return;
    if ((event.type === 'result' || event.type === 'status') && !event.sessionId) return;
    if (event.type === 'result' || event.type === 'status') {
      const sessionId = event.sessionId;
      if (!sessionId) return;
      this.sessionId = sessionId;
    }
    this.stdout.write(event);
  }

  private currentTranscriptPath(): string | undefined {
    return undefined;
  }

  private watchInitMenus(screen: PtyScreenRenderer, runner: PtyRunnerLike): () => void {
    let disposed = false;
    let polling = false;
    const handlers: Array<{
      handled: boolean;
      match: (rendered: string) => boolean;
      keys: Array<{ value: string; delayMs?: number }>;
    }> = [
      {
        handled: false,
        match: (rendered) => (
          rendered.includes('bypass permissions mode')
          && rendered.includes('1. no, exit')
          && rendered.includes('yes, i accept')
        ),
        keys: [
          { value: '\x1b[B' },
          { value: '\r', delayMs: 300 },
        ],
      },
      {
        handled: false,
        match: (rendered) => (
          rendered.includes('allow external claude.md file imports')
          && rendered.includes('yes, allow external imports')
        ),
        keys: [{ value: '\r' }],
      },
    ];

    const poll = async (): Promise<void> => {
      if (disposed || polling) return;
      polling = true;
      try {
        const rendered = (await screen.renderedText()).toLowerCase();
        for (const handler of handlers) {
          if (disposed) return;
          if (handler.handled || !handler.match(rendered)) continue;
          handler.handled = true;
          for (const key of handler.keys) {
            if (key.delayMs) await sleep(key.delayMs);
            if (disposed) return;
            await Promise.resolve(runner.write(key.value));
          }
          return;
        }
      } finally {
        polling = false;
      }
    };

    const timer = setInterval(() => {
      void poll().catch(() => undefined);
    }, this.pollIntervalMs);
    void poll().catch(() => undefined);

    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }

  private async decorateInitTimeoutError(err: unknown, screen: PtyScreenRenderer): Promise<Error> {
    if (!isStatuslineTimeoutError(err)) {
      return err instanceof Error ? err : new Error(String(err));
    }
    const screenTail = redactInitScreenTail(await screen.renderedText());
    if (screenTail) {
      console.log(`[claude-pty] init timeout screen tail:\n${screenTail}`);
    }
    return new Error('Claude 会话启动超时(30s),可能卡在某个启动确认界面(详情见服务端日志)');
  }

  private failInit(err: unknown): void {
    if (this.terminated || this.state === 'terminated') return;
    this.state = 'failed';
    const message = err instanceof Error ? err.message : String(err);
    const count = Math.max(this.queue.length, 1);
    this.queue = [];
    for (let i = 0; i < count; i += 1) {
      this.writeEvent({ type: 'error', message });
    }
    this.emitExit(1);
  }

  private emitExit(code: number | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.stdout.end();
    this.events.emit('exit', code);
  }
}

export class ClaudePtyPlugin implements AgentPlugin {
  name = 'claude-code-pty';
  displayName = 'Claude Code PTY';

  capabilities: AgentCapabilities = {
    streamJson: false,
    permissionPrompt: false,
    sessionResume: true,
    gracefulCancel: false,
    slashCommands: AGENT_SLASH_COMMANDS,
  };

  constructor(private readonly binary: string) {}

  async preflight(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const { execFileSync } = await import('node:child_process');
      const output = execFileSync(this.binary, ['--version'], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      return { ok: true, version: output.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  spawn(opts: SpawnOpts): AgentProcess {
    return new ClaudePtyVirtualProcess(this.binary, { ...opts, turnTimeoutMs: undefined });
  }

  resume(sessionId: string, opts: SpawnOpts): AgentProcess {
    return new ClaudePtyVirtualProcess(this.binary, { ...opts, turnTimeoutMs: undefined }, sessionId);
  }

  buildSpawnArgs(opts: SpawnOpts): string[] {
    return PtyClaudeRunner.buildArgs({
      settingsPath: '<runtime-settings>',
      model: opts.model,
      permissionMode: opts.permissionMode,
      addDirs: buildAddDirs(opts.workingDirectory, opts.addDirs),
    });
  }

  createStdoutParser(): Transform {
    return new PassThrough({ objectMode: true });
  }

  formatStdinMessage(msg: UserMessage): string {
    return JSON.stringify({ type: 'user', message: msg }) + '\n';
  }

  formatPermissionResponse(requestId: string, decision: 'allow' | 'deny'): string {
    return JSON.stringify({
      type: 'tool_use_permission_response',
      tool_use_id: requestId,
      decision,
    }) + '\n';
  }
}

function withDefaultDeps(deps: ClaudePtyRuntimeDeps): Required<ClaudePtyRuntimeDeps> {
  return {
    buildSettings: deps.buildSettings ?? (async (input) => {
      const injector = new SettingsInjector({
        runtimeDir: join(getCli2imDataDir(), 'pty', input.handle),
        permissionsDeny: input.permissionMode === 'blacklist' ? BLACKLIST_DENY_TOOLS : [],
      });
      return injector.build({
        handle: input.handle,
        sessionId: input.sessionId,
        effortLevel: input.effortLevel,
      });
    }),
    createRunner: deps.createRunner ?? ((opts) => new PtyClaudeRunner({
      claudeBin: opts.claudeBin,
      cwd: opts.cwd,
      env: opts.env,
    })),
    createTailer: deps.createTailer ?? ((path) => new JsonlTailer(path)),
    watchStop: deps.watchStop ?? SettingsInjector.watchStop,
    waitForStatuslinePayload: deps.waitForStatuslinePayload ?? waitForStatuslinePayload,
  };
}

async function waitForStatuslinePayload(filePath: string): Promise<StatuslinePayload> {
  const deadline = Date.now() + STATUSLINE_TIMEOUT_MS;
  for (;;) {
    if (existsSync(filePath)) {
      const payload = await SettingsInjector.readPayload(filePath);
      if (payload.sessionId && payload.transcriptPath) return payload;
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Claude PTY statusline');
    }
    await sleep(100);
  }
}

function createStopQueue(): StopQueue {
  const items: StopMarker[] = [];
  return {
    push: (marker) => {
      items.push(marker);
    },
    shift: () => items.shift(),
    clear: () => {
      items.splice(0, items.length);
    },
  };
}

function messageToText(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .flatMap((part) => part.type === 'text' ? [part.text] : [])
    .join('\n');
}

function extractAgentSlashCommand(input: string): string | undefined {
  let text = input.replace(/^<cti-sender\b[^>]*\/>\n\n/, '');
  text = text.replace(/^<cti-relay>[\s\S]*?<\/cti-relay>\n\n/, '');
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const command = trimmed.split(/\s+/)[0];
  if (!AGENT_SLASH_COMMANDS.includes(command)) return undefined;
  return trimmed;
}

function redactSlashOutput(input: string): string {
  const home = homedir();
  let output = input
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted>')
    .replace(/\b(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)=\S+/g, '$1=<redacted>')
    .replace(/\b(\w*(?:KEY|TOKEN|SECRET)\w*)=\S+/gi, '$1=<redacted>');
  if (home) {
    output = output.replace(new RegExp(escapeRegExp(home), 'g'), '~');
  }
  return output
    .trim();
}

function redactInitScreenTail(input: string): string {
  const lastLines = input.split('\n').slice(-20).join('\n');
  return redactSlashOutput(lastLines.length > 2048 ? lastLines.slice(-2048) : lastLines);
}

function isStatuslineTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('timed out waiting for claude pty statusline');
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildAddDirs(workingDirectory: string, addDirs: string[] = []): string[] {
  return [...new Set([workingDirectory, ...addDirs])].filter((dir) => dir.length > 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensurePtyRuntimeDir(): Promise<void> {
  await mkdir(join(getCli2imDataDir(), 'pty'), { recursive: true });
}
