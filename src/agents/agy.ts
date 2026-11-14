import { buildChildEnv } from '../security/child-env.js';
import { getCli2imDataDir } from '../util/data-dir.js';
import { execFileSync, spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Transform, Writable, type TransformCallback } from 'node:stream';
import type {
  AgentCapabilities,
  AgentEvent,
  AgentPlugin,
  AgentProcess,
  SpawnOpts,
  UserMessage,
} from '../types.js';

// Antigravity CLI (`agy` >=1.5) supports persistent multi-turn execution over
// `--input-format stream-json --output-format stream-json`:
//   stdin:  {"event":"user","message":{"role":"user","content":"..."}}
//   stdout: {"event":"init"|"step_update"|"result", ...}

const BARE_EFFORT_MODEL_PATTERN =
  /^(gemini-4-(carbon|argon|hydrogen)|gemini-3\.8-flash|claude-(opus|sonnet)-5-5)$/i;

export function agyModelSupportsEffortFlag(model?: string): boolean {
  if (!model) return false;
  return BARE_EFFORT_MODEL_PATTERN.test(model.trim());
}

function messageToPrompt(message: UserMessage, imageDirectory: () => string): string {
  if (typeof message.content === 'string') return message.content;

  const textParts: string[] = [];
  const imagePaths: string[] = [];

  for (const block of message.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      const ext = imageExtension(block.source.media_type);
      const dir = imageDirectory();
      const filePath = join(dir, `img-${randomUUID()}.${ext}`);
      writeFileSync(filePath, Buffer.from(block.source.data, 'base64'), { mode: 0o600, flag: 'wx' });
      imagePaths.push(filePath);
    }
  }

  if (imagePaths.length > 0) {
    const fileList = imagePaths.map((p) => `- ${p}`).join('\n');
    textParts.push(
      `\n[用户发送了 ${imagePaths.length} 张图片，已保存到以下路径，请用读取文件的能力查看后分析：\n${fileList}\n]`,
    );
  }

  return textParts.join('\n');
}

export function buildAgyBaseArgs(opts: SpawnOpts, extraDirs: string[] = []): string[] {
  const args: string[] = [
    '--dangerously-skip-permissions',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ];

  const seenDirs = new Set<string>();
  const addDir = (dir?: string) => {
    if (!dir || seenDirs.has(dir)) return;
    seenDirs.add(dir);
    args.push('--add-dir', dir);
  };

  addDir(opts.workingDirectory);
  for (const dir of opts.addDirs ?? []) {
    addDir(dir);
  }
  if (!opts.isolation) {
    const mediaDir = join(getCli2imDataDir(), 'media');
    if (existsSync(mediaDir)) {
      addDir(mediaDir);
    }
  }
  for (const dir of extraDirs) {
    addDir(dir);
  }

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.reasoningEffort && agyModelSupportsEffortFlag(opts.model)) {
    args.push('--effort', opts.reasoningEffort);
  }

  if (opts.turnTimeoutMs && opts.turnTimeoutMs > 0) {
    args.push('--print-timeout', `${Math.ceil(opts.turnTimeoutMs / 1000)}s`);
  }

  if (
    opts.sandbox === 'workdir'
    || (opts.sandboxMode && opts.sandboxMode !== 'danger-full-access' && opts.sandboxMode !== 'off')
  ) {
    args.push('--sandbox');
  }

  return args;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatToolOutput(toolInfo?: Record<string, unknown>): string {
  const raw = toolInfo?.output ?? toolInfo?.error;
  if (raw === undefined || raw === null) return '';
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

export class AgyStreamParser extends Transform {
  private buffer = '';
  private emittedSessionId = '';
  private lastConversationId = '';
  private emittedTextInTurn = false;
  private emittedToolUseIds = new Set<string>();
  private emittedToolResultIds = new Set<string>();

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      this.processLine(line);
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.buffer.trim()) {
      this.processLine(this.buffer);
    }
    this.buffer = '';
    callback();
  }

  private emitStatusIfNew(convId: unknown): string | undefined {
    if (typeof convId !== 'string' || !convId) return undefined;
    this.lastConversationId = convId;
    if (convId !== this.emittedSessionId) {
      this.emittedSessionId = convId;
      this.push({ type: 'status', sessionId: convId } satisfies AgentEvent);
    }
    return convId;
  }

  private processLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const eventType = parsed.event;
    if (eventType === 'init') {
      const initObj = asRecord(parsed.init);
      this.emitStatusIfNew(parsed.conversation_id ?? initObj?.conversation_id);
      return;
    }

    if (eventType === 'step_update') {
      const u = asRecord(parsed.step_update);
      if (!u) return;

      this.emitStatusIfNew(u.conversation_id ?? parsed.conversation_id);

      const stepType = typeof u.step_type === 'string' ? u.step_type : '';
      const state = typeof u.state === 'string' ? u.state : '';

      if (stepType === 'tool') {
        const toolInfo = asRecord(u.tool_info);
        const toolId = `agy_step_${String(u.step_index ?? 0)}`;
        const toolName =
          (typeof toolInfo?.name === 'string' && toolInfo.name)
          || (typeof u.tool_name === 'string' && u.tool_name)
          || 'tool';
        const toolInput = asRecord(toolInfo?.parameters) ?? {};

        if (state === 'ACTIVE') {
          if (!this.emittedToolUseIds.has(toolId)) {
            this.emittedToolUseIds.add(toolId);
            this.push({
              type: 'tool_use',
              id: toolId,
              name: toolName,
              input: toolInput,
            } satisfies AgentEvent);
          }
        } else if (state === 'DONE' || state === 'ERROR' || state === 'FAILED') {
          if (!this.emittedToolUseIds.has(toolId)) {
            this.emittedToolUseIds.add(toolId);
            this.push({
              type: 'tool_use',
              id: toolId,
              name: toolName,
              input: toolInput,
            } satisfies AgentEvent);
          }
          if (!this.emittedToolResultIds.has(toolId)) {
            this.emittedToolResultIds.add(toolId);
            this.push({
              type: 'tool_result',
              id: toolId,
              name: toolName,
              output: formatToolOutput(toolInfo),
              isError: state !== 'DONE' || Boolean(toolInfo?.error),
            } satisfies AgentEvent);
          }
        }
        return;
      }

      const thinkingDelta =
        typeof u.thinking_delta === 'string' && u.thinking_delta.length > 0
          ? u.thinking_delta
          : stepType === 'thinking' && typeof u.text_delta === 'string' && u.text_delta.length > 0
            ? u.text_delta
            : undefined;
      if (thinkingDelta) {
        this.push({ type: 'thinking', content: thinkingDelta } satisfies AgentEvent);
        return;
      }

      if (typeof u.text_delta === 'string' && u.text_delta.length > 0) {
        this.emittedTextInTurn = true;
        this.push({ type: 'text', content: u.text_delta } satisfies AgentEvent);
      }
      return;
    }

    if (eventType === 'result') {
      const r = asRecord(parsed.result);
      const convId =
        this.emitStatusIfNew(r?.conversation_id ?? parsed.conversation_id)
        ?? (this.lastConversationId || undefined);

      const hadText = this.emittedTextInTurn;
      this.emittedTextInTurn = false;
      this.emittedToolUseIds.clear();
      this.emittedToolResultIds.clear();

      const status = typeof r?.status === 'string' ? r.status : '';
      const finishedReason = typeof r?.finished_reason === 'string' ? r.finished_reason : '';
      const responseText = typeof r?.response === 'string' ? r.response : '';

      if (status === 'SUCCESS' || (finishedReason === 'print_timeout' && responseText.length > 0)) {
        if (!hadText && responseText.length > 0) {
          this.push({ type: 'text', content: responseText } satisfies AgentEvent);
        }
        const usageObj = asRecord(r?.usage);
        this.push({
          type: 'result',
          sessionId: convId ?? '',
          usage: usageObj
            ? {
                inputTokens: Number(usageObj.input_tokens ?? 0),
                outputTokens: Number(usageObj.output_tokens ?? 0),
                cacheReadTokens: Number(usageObj.cache_read_tokens ?? 0),
              }
            : undefined,
        } satisfies AgentEvent);
      } else {
        const errorMessage = typeof r?.error === 'string' && r.error ? r.error : 'agy turn failed';
        this.push({ type: 'error', message: errorMessage } satisfies AgentEvent);
      }
    }
  }
}

export class AgyVirtualProcess implements AgentProcess {
  pid = process.pid;
  sessionId: string;
  stdin: Writable;
  stdout: PassThrough;

  private inputBuffer = '';
  private activeChild: ChildProcess | undefined;
  private activeParser: AgyStreamParser | undefined;
  private queuedMessages: string[] = [];
  private stderrBuffer = '';
  private turnInFlight = false;
  private terminated = false;
  private exitEmitted = false;
  private eventEmitter = new EventEmitter();
  private imageDirectory?: string;

  constructor(
    private readonly binary: string,
    private readonly opts: SpawnOpts,
    private conversationId?: string,
  ) {
    this.sessionId = conversationId ?? '';
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
  }

  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    if (this.terminated) return;
    this.terminated = true;
    this.turnInFlight = false;
    this.queuedMessages = [];
    if (this.activeChild) {
      try {
        this.activeChild.stdin?.end();
      } catch {
        // best effort
      }
      this.activeChild.kill(signal);
      return;
    }
    this.emitExit(null);
  }

  on(event: 'exit', handler: (code: number | null) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'exit' | 'error', handler: (...args: any[]) => void): void {
    this.eventEmitter.on(event, handler);
  }

  private ensureImageDirectory(): string {
    this.imageDirectory ??= mkdtempSync(join(tmpdir(), 'cli2im-agy-images-'));
    return this.imageDirectory;
  }

  private handleStdinChunk(chunk: Buffer | string | Uint8Array): void {
    if (this.terminated) return;
    this.inputBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = this.inputBuffer.split('\n');
    this.inputBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload: { type: 'user'; message: UserMessage };
      try {
        payload = JSON.parse(trimmed) as { type: 'user'; message: UserMessage };
      } catch {
        continue;
      }
      if (payload.type === 'user') {
        const prompt = messageToPrompt(payload.message, () => this.ensureImageDirectory());
        this.enqueue(prompt);
      }
    }
  }

  private enqueue(prompt: string): void {
    if (this.terminated) return;
    if (this.turnInFlight) {
      this.queuedMessages.push(prompt);
      return;
    }
    this.sendTurn(prompt);
  }

  private sendTurn(prompt: string): void {
    if (this.terminated) return;

    const child = this.ensureActiveChild();
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      this.stdout.write({ type: 'error', message: 'agy stdin is unavailable' } satisfies AgentEvent);
      return;
    }

    this.stderrBuffer = '';
    this.turnInFlight = true;
    const wireLine = `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`;
    child.stdin.write(wireLine);
  }

  private ensureActiveChild(): ChildProcess {
    if (this.activeChild && !this.activeChild.killed && this.activeChild.stdin && !this.activeChild.stdin.destroyed) {
      return this.activeChild;
    }

    const imgDir = this.ensureImageDirectory();
    const args = buildAgyBaseArgs(this.opts, [imgDir]);
    if (this.conversationId) {
      args.push('--conversation', this.conversationId);
    }

    let child: ChildProcess;
    try {
      child = spawnProcess(this.binary, args, {
        cwd: this.opts.workingDirectory,
        env: buildChildEnv('agy', this.opts.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (this.imageDirectory) {
        rmSync(this.imageDirectory, { recursive: true, force: true });
        this.imageDirectory = undefined;
      }
      throw error;
    }

    this.activeChild = child;
    if (typeof child.pid === 'number') {
      this.pid = child.pid;
    }
    this.stderrBuffer = '';
    this.attachChild(child);
    return child;
  }

  private attachChild(child: ChildProcess): void {
    if (!child.stdout || !child.stderr || !child.stdin) {
      child.kill('SIGTERM');
      this.activeChild = undefined;
      this.stdout.write({ type: 'error', message: 'agy stdio is unavailable' } satisfies AgentEvent);
      return;
    }

    child.stdin.on('error', () => {
      if (this.activeChild === child && !this.terminated) {
        this.stdout.write({ type: 'error', message: 'agy prompt input failed' } satisfies AgentEvent);
      }
    });

    const parser = new AgyStreamParser();
    this.activeParser = parser;
    let rawStdoutTail = '';

    child.stdout.on('data', (chunk: Buffer | string) => {
      rawStdoutTail = (rawStdoutTail + chunk.toString()).slice(-4096);
    });
    child.stdout.pipe(parser);

    parser.on('data', (event: AgentEvent) => {
      if (this.terminated || this.activeParser !== parser) return;

      if ((event.type === 'status' || event.type === 'result') && event.sessionId) {
        this.conversationId = event.sessionId;
        this.sessionId = event.sessionId;
      }

      this.stdout.write(event);

      if (event.type === 'result' || event.type === 'error') {
        this.turnInFlight = false;
        this.dispatchNext();
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk.toString()).slice(-8192);
    });

    child.on('close', (code) => {
      if (this.activeChild === child) {
        this.activeChild = undefined;
      }
      child.stdout?.unpipe(parser);
      parser.end();
      if (this.activeParser === parser) {
        this.activeParser = undefined;
      }

      if (this.terminated) {
        this.emitExit(code);
        return;
      }

      if (this.turnInFlight) {
        this.turnInFlight = false;
        const detail = this.stderrBuffer.trim() || rawStdoutTail.trim() || `agy exited with code ${code}`;
        this.stdout.write({ type: 'error', message: detail } satisfies AgentEvent);
        this.dispatchNext();
      }
    });

    child.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.eventEmitter.listenerCount('error') > 0) {
        this.eventEmitter.emit('error', error);
      }
      if (!this.terminated) {
        this.turnInFlight = false;
        this.stdout.write({ type: 'error', message: error.message } satisfies AgentEvent);
        this.dispatchNext();
      }
    });
  }

  private dispatchNext(): void {
    if (this.terminated || this.turnInFlight) return;
    const next = this.queuedMessages.shift();
    if (!next) return;
    try {
      this.sendTurn(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.turnInFlight = false;
      this.stdout.write({ type: 'error', message } satisfies AgentEvent);
    }
  }

  private emitExit(code: number | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    if (this.imageDirectory) {
      rmSync(this.imageDirectory, { recursive: true, force: true });
      this.imageDirectory = undefined;
    }
    this.stdout.end();
    this.eventEmitter.emit('exit', code);
  }
}

function imageExtension(mimeType: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[mimeType] ?? 'png';
}

export class AgyPlugin implements AgentPlugin {
  name = 'agy';
  displayName = 'Antigravity CLI';
  private binary: string;

  capabilities: AgentCapabilities = {
    streamJson: true,
    permissionPrompt: false,
    sessionResume: true,
    gracefulCancel: false,
    slashCommands: [],
  };

  constructor(binary: string) {
    this.binary = binary;
  }

  async preflight(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const output = execFileSync(this.binary, ['--version'], {
        timeout: 10000,
        encoding: 'utf-8',
        env: buildChildEnv('agy'),
      });
      return { ok: true, version: output.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  spawn(opts: SpawnOpts): AgentProcess {
    return new AgyVirtualProcess(this.binary, opts);
  }

  resume(sessionId: string, opts: SpawnOpts): AgentProcess {
    return new AgyVirtualProcess(this.binary, opts, sessionId);
  }

  buildSpawnArgs(opts: SpawnOpts): string[] {
    return buildAgyBaseArgs(opts);
  }

  createStdoutParser(): Transform {
    return new PassThrough({ objectMode: true });
  }

  formatStdinMessage(msg: UserMessage): string {
    return JSON.stringify({ type: 'user', message: msg }) + '\n';
  }

  formatPermissionResponse(_requestId: string, _decision: 'allow' | 'deny'): string {
    return '';
  }
}
