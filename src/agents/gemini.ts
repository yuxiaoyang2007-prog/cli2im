import { execFileSync, spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough, Transform, Writable, type TransformCallback } from 'node:stream';
import type {
  AgentCapabilities,
  AgentEvent,
  AgentPlugin,
  AgentProcess,
  SpawnOpts,
  UserMessage,
} from '../types.js';

export interface GeminiEventMappingState {
  sessionId: string;
  toolNamesById: Map<string, string>;
}

export type GeminiStreamEvent = {
  type?: string;
  session_id?: string;
  role?: string;
  content?: unknown;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  status?: string;
  stats?: {
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
  };
};

export function createGeminiEventMappingState(): GeminiEventMappingState {
  return {
    sessionId: '',
    toolNamesById: new Map(),
  };
}

export function mapGeminiEvent(
  event: GeminiStreamEvent,
  state: GeminiEventMappingState = createGeminiEventMappingState(),
): AgentEvent[] {
  if (event.type === 'init') {
    state.sessionId = event.session_id ?? state.sessionId;
    return [{ type: 'status', sessionId: state.sessionId }];
  }

  if (
    event.type === 'message'
    && event.role === 'assistant'
    && event.delta === true
  ) {
    return [{ type: 'text', content: typeof event.content === 'string' ? event.content : '' }];
  }

  if (event.type === 'tool_use') {
    const id = event.tool_id ?? '';
    const name = event.tool_name ?? '';
    state.toolNamesById.set(id, name);
    return [{
      type: 'tool_use',
      id,
      name,
      input: asRecord(event.parameters),
    }];
  }

  if (event.type === 'tool_result') {
    const id = event.tool_id ?? '';
    return [{
      type: 'tool_result',
      id,
      name: state.toolNamesById.get(id) ?? '',
      output: event.status ?? '',
    }];
  }

  if (event.type === 'result') {
    if (event.status === 'success') {
      return [{
        type: 'result',
        sessionId: state.sessionId,
        usage: {
          inputTokens: event.stats?.input_tokens ?? 0,
          outputTokens: event.stats?.output_tokens ?? 0,
          cacheReadTokens: event.stats?.cached,
        },
      }];
    }

    return [{ type: 'error', message: event.status ?? 'Gemini CLI failed' }];
  }

  return [];
}

export class GeminiStreamParser extends Transform {
  private buffer = '';
  private readonly state = createGeminiEventMappingState();

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        this.parseLine(line);
      }

      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _flush(callback: TransformCallback): void {
    try {
      if (this.buffer.trim()) {
        this.parseLine(this.buffer);
      }
      this.buffer = '';
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: GeminiStreamEvent;
    try {
      parsed = JSON.parse(trimmed) as GeminiStreamEvent;
    } catch {
      return;
    }

    for (const event of mapGeminiEvent(parsed, this.state)) {
      this.push(event);
    }
  }
}

type GeminiStdinPayload = { type: 'user'; message: UserMessage };

const PROMPT_ARG_MAX_BYTES = 100 * 1024;

export class GeminiVirtualProcess implements AgentProcess {
  pid = process.pid;
  sessionId: string;
  stdin: Writable;
  stdout: PassThrough;

  private inputBuffer = '';
  private activeChild: ChildProcess | undefined;
  private queuedMessages: string[] = [];
  private stderrBuffer = '';
  private terminated = false;
  private exitEmitted = false;
  private eventEmitter = new EventEmitter();

  constructor(
    private readonly binary: string,
    private readonly opts: SpawnOpts,
    private geminiSessionId?: string,
  ) {
    this.sessionId = geminiSessionId ?? '';
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
    this.queuedMessages = [];

    if (this.activeChild) {
      this.activeChild.kill(signal);
      return;
    }

    this.emitExit(null);
  }

  on(event: 'exit', handler: (code: number | null) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'exit' | 'error', handler: (...args: any[]) => void): void {
    this.eventEmitter.on(event, handler);
  }

  private handleStdinChunk(chunk: Buffer | string | Uint8Array): void {
    this.inputBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = this.inputBuffer.split('\n');
    this.inputBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let payload: GeminiStdinPayload;
      try {
        payload = JSON.parse(trimmed) as GeminiStdinPayload;
      } catch {
        continue;
      }
      if (payload.type === 'user') {
        this.enqueue(messageToPrompt(payload.message));
      }
    }
  }

  private enqueue(prompt: string): void {
    if (this.terminated) return;

    if (this.activeChild) {
      this.queuedMessages.push(prompt);
      return;
    }

    this.runTurn(prompt);
  }

  private runTurn(prompt: string): void {
    if (this.terminated) return;

    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    const useStdinPrompt = promptBytes > PROMPT_ARG_MAX_BYTES;
    const args = this.createTurnArgs(prompt, useStdinPrompt);
    const child = spawnProcess(this.binary, args, {
      cwd: this.opts.workingDirectory,
      env: { ...process.env, ...this.opts.env },
      stdio: [useStdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    this.activeChild = child;
    this.stderrBuffer = '';

    if (useStdinPrompt) {
      if (!child.stdin) {
        this.stdout.write({ type: 'error', message: 'Gemini CLI stdin is unavailable' } satisfies AgentEvent);
        this.activeChild = undefined;
        return;
      }
      child.stdin.write(prompt);
      child.stdin.end();
    }

    this.attachChild(child);
  }

  private createTurnArgs(prompt: string, useStdinPrompt: boolean): string[] {
    const args = buildGeminiBaseArgs(this.opts);

    if (this.geminiSessionId) {
      args.push('--resume', this.geminiSessionId);
    }

    if (!useStdinPrompt) {
      args.push('-p', prompt);
    }

    return args;
  }

  private attachChild(child: ChildProcess): void {
    if (!child.stdout || !child.stderr) {
      this.stdout.write({ type: 'error', message: 'Gemini CLI stdio is unavailable' } satisfies AgentEvent);
      this.activeChild = undefined;
      return;
    }

    const parser = new GeminiStreamParser();
    let childClosed = false;
    let childExitCode: number | null = null;
    let parserDrained = false;
    let completed = false;

    const maybeComplete = () => {
      if (completed || !childClosed || !parserDrained) return;
      completed = true;
      this.onTurnComplete(childExitCode);
    };

    child.stdout.pipe(parser);
    child.stdout.on('close', () => parser.end());
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer += chunk.toString();
    });

    parser.on('data', (event: AgentEvent) => {
      if (event.type === 'status' && event.sessionId) {
        this.geminiSessionId = event.sessionId;
        this.sessionId = event.sessionId;
      }
      if (event.type === 'result' && event.sessionId) {
        this.geminiSessionId = event.sessionId;
        this.sessionId = event.sessionId;
      }
      this.stdout.write(event);
    });

    parser.on('error', (err) => {
      this.stdout.write({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies AgentEvent);
    });

    parser.on('end', () => {
      parserDrained = true;
      maybeComplete();
    });

    child.on('close', (code) => {
      childClosed = true;
      childExitCode = code;
      maybeComplete();
    });

    child.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.eventEmitter.listenerCount('error') > 0) {
        this.eventEmitter.emit('error', error);
      }
      this.stdout.write({ type: 'error', message: error.message } satisfies AgentEvent);
    });
  }

  private onTurnComplete(code: number | null): void {
    if (this.terminated) {
      this.activeChild = undefined;
      this.emitExit(code);
      return;
    }

    this.activeChild = undefined;

    if (code !== 0 && code !== null) {
      const message = this.stderrBuffer.trim() || `Gemini CLI exited with code ${code}`;
      this.stdout.write({ type: 'error', message } satisfies AgentEvent);
      this.queuedMessages = [];
      this.stderrBuffer = '';
      return;
    }

    this.stderrBuffer = '';
    const next = this.queuedMessages.shift();
    if (next) {
      this.runTurn(next);
    }
  }

  private emitExit(code: number | null): void {
    if (this.exitEmitted) return;

    this.exitEmitted = true;
    this.stdout.end();
    this.eventEmitter.emit('exit', code);
  }
}

export class GeminiPlugin implements AgentPlugin {
  name = 'gemini';
  displayName = 'Gemini CLI';
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
      });
      return { ok: true, version: output.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  spawn(opts: SpawnOpts): AgentProcess {
    return new GeminiVirtualProcess(this.binary, opts);
  }

  resume(sessionId: string, opts: SpawnOpts): AgentProcess {
    return new GeminiVirtualProcess(this.binary, opts, sessionId);
  }

  buildSpawnArgs(opts: SpawnOpts): string[] {
    return buildGeminiBaseArgs(opts);
  }

  createStdoutParser(): PassThrough {
    return new PassThrough({ objectMode: true });
  }

  formatStdinMessage(msg: UserMessage): string {
    return JSON.stringify({ type: 'user', message: msg }) + '\n';
  }

  formatPermissionResponse(_requestId: string, _decision: 'allow' | 'deny'): string {
    return '';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildGeminiBaseArgs(opts: SpawnOpts): string[] {
  const args = [
    '--output-format',
    'stream-json',
    '--approval-mode',
    'yolo',
    '--skip-trust',
  ];

  if (opts.model) {
    args.push('--model', opts.model);
  }

  return args;
}

function messageToPrompt(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;

  const textParts: string[] = [];
  const imagePaths: string[] = [];

  for (const block of message.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'image') {
      const ext = block.source.media_type.split('/')[1] ?? 'png';
      const dir = join(tmpdir(), 'cli2im-gemini-images');
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      writeFileSync(filePath, Buffer.from(block.source.data, 'base64'));
      imagePaths.push(filePath);
    }
  }

  if (imagePaths.length > 0) {
    const fileList = imagePaths.map((p) => `- ${p}`).join('\n');
    textParts.push(`\n[用户发送了 ${imagePaths.length} 张图片，已保存到以下路径，请先用 upload_file 工具上传后分析：\n${fileList}\n]`);
  }

  return textParts.join('\n');
}
