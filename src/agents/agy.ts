import { execFileSync, spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

// Antigravity CLI (`agy`) is a print-mode agent: each turn is a fresh
// `agy --print=<prompt>` process. Unlike the Gemini CLI it does NOT emit
// stream-json on stdout — stdout is the plain-text answer, and on resume it
// REPLAYS the whole conversation's assistant messages. So instead of parsing
// stdout we read the per-conversation transcript that agy writes to
//   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl
// and emit only the PLANNER_RESPONSE records appended by the current turn
// (step_index greater than what we've already consumed). This is the same
// "seek past existing history" technique the PTY spike used to avoid replay.

const AGY_DATA_DIR = join(homedir(), '.gemini', 'antigravity-cli');
const PROMPT_ARG_MAX_BYTES = 100 * 1024;
const TRANSCRIPT_READ_RETRIES = 6;
const TRANSCRIPT_READ_DELAY_MS = 150;

let turnLogCounter = 0;

interface TranscriptRecord {
  type?: string;
  content?: unknown;
  step_index?: number;
}

function transcriptPathFor(conversationId: string): string {
  return join(AGY_DATA_DIR, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

// agy logs the conversation it used on each turn as:
//   "Print mode: conversation=<uuid>, sending message"
function parseConversationId(logText: string): string | undefined {
  const matches = logText.match(/Print mode: conversation=([0-9a-fA-F-]{36})/g);
  if (!matches || matches.length === 0) return undefined;
  const last = matches[matches.length - 1];
  return last.slice(last.indexOf('=') + 1);
}

function readAllRecords(conversationId: string): TranscriptRecord[] {
  const path = transcriptPathFor(conversationId);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const records: TranscriptRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as TranscriptRecord);
    } catch {
      // partial/half-written line — ignore
    }
  }
  return records;
}

function maxStepOf(records: TranscriptRecord[]): number {
  let max = -1;
  for (const rec of records) {
    if (typeof rec.step_index === 'number' && rec.step_index > max) max = rec.step_index;
  }
  return max;
}

// Pull PLANNER_RESPONSE text appended after `sinceStep`. Returns the new
// assistant text plus the new high-water step index.
function readPlannerDelta(conversationId: string, sinceStep: number): { text: string; maxStep: number; found: boolean } {
  const records = readAllRecords(conversationId);
  const parts: string[] = [];
  for (const rec of records) {
    const step = typeof rec.step_index === 'number' ? rec.step_index : -1;
    if (rec.type === 'PLANNER_RESPONSE' && step > sinceStep && typeof rec.content === 'string') {
      const text = rec.content.trim();
      if (text) parts.push(text);
    }
  }
  return { text: parts.join('\n\n').trim(), maxStep: maxStepOf(records), found: parts.length > 0 };
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
      const dir = join(tmpdir(), 'cli2im-agy-images');
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

function buildAgyBaseArgs(opts: SpawnOpts): string[] {
  const args: string[] = ['--dangerously-skip-permissions'];

  // Let agy read the bot's working directory (and any pasted images).
  args.push('--add-dir', opts.workingDirectory);
  args.push('--add-dir', join(tmpdir(), 'cli2im-agy-images'));

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.turnTimeoutMs && opts.turnTimeoutMs > 0) {
    args.push('--print-timeout', `${Math.ceil(opts.turnTimeoutMs / 1000)}s`);
  }

  return args;
}

export class AgyVirtualProcess implements AgentProcess {
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
  // High-water transcript step we've already turned into events for this
  // conversation. -1 means "emit everything" (a brand-new conversation).
  private consumedStep = -1;
  private statusEmitted = false;

  constructor(
    private readonly binary: string,
    private readonly opts: SpawnOpts,
    private conversationId?: string,
  ) {
    this.sessionId = conversationId ?? '';
    // Resuming an existing conversation: skip past everything already in its
    // transcript so the first turn only emits its own new response.
    if (conversationId) {
      this.consumedStep = maxStepOf(readAllRecords(conversationId));
    }
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
      let payload: { type: 'user'; message: UserMessage };
      try {
        payload = JSON.parse(trimmed) as { type: 'user'; message: UserMessage };
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

    const logPath = join(tmpdir(), 'cli2im-agy-logs', `turn-${process.pid}-${++turnLogCounter}.log`);
    mkdirSync(join(tmpdir(), 'cli2im-agy-logs'), { recursive: true });

    const args = buildAgyBaseArgs(this.opts);
    args.push('--log-file', logPath);
    if (this.conversationId) {
      args.push('--conversation', this.conversationId);
    }

    // Prefer passing the prompt inline (handles leading '-' and newlines via
    // the `--print=` form); fall back to stdin only for very large prompts.
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    const useStdinPrompt = promptBytes > PROMPT_ARG_MAX_BYTES;
    if (useStdinPrompt) {
      args.push('--print');
    } else {
      args.push(`--print=${prompt}`);
    }

    const child = spawnProcess(this.binary, args, {
      cwd: this.opts.workingDirectory,
      env: { ...process.env, ...this.opts.env },
      stdio: [useStdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    this.activeChild = child;
    this.stderrBuffer = '';

    if (useStdinPrompt) {
      if (!child.stdin) {
        this.stdout.write({ type: 'error', message: 'agy stdin is unavailable' } satisfies AgentEvent);
        this.activeChild = undefined;
        return;
      }
      child.stdin.write(prompt);
      child.stdin.end();
    }

    this.attachChild(child, logPath);
  }

  private attachChild(child: ChildProcess, logPath: string): void {
    if (!child.stdout || !child.stderr) {
      this.stdout.write({ type: 'error', message: 'agy stdio is unavailable' } satisfies AgentEvent);
      this.activeChild = undefined;
      return;
    }

    // Drain stdout so the child never blocks on a full pipe. We do not use it
    // for output (transcript is the source of truth); keep a small tail only
    // as a diagnostic fallback.
    let stdoutTail = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutTail = (stdoutTail + chunk.toString()).slice(-4096);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk.toString()).slice(-8192);
    });

    child.on('close', (code) => {
      void this.onTurnComplete(code, logPath, stdoutTail);
    });

    child.on('error', (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.eventEmitter.listenerCount('error') > 0) {
        this.eventEmitter.emit('error', error);
      }
      this.stdout.write({ type: 'error', message: error.message } satisfies AgentEvent);
    });
  }

  private async onTurnComplete(code: number | null, logPath: string, stdoutTail: string): Promise<void> {
    this.activeChild = undefined;

    if (this.terminated) {
      this.emitExit(code);
      return;
    }

    const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const conversationId = parseConversationId(logText) ?? this.conversationId;

    if (!conversationId) {
      const detail = this.stderrBuffer.trim() || stdoutTail.trim() || `agy exited with code ${code}`;
      this.stdout.write({ type: 'error', message: `agy 未返回会话标识：${detail}` } satisfies AgentEvent);
      this.afterTurn();
      return;
    }

    this.conversationId = conversationId;
    this.sessionId = conversationId;
    if (!this.statusEmitted) {
      this.statusEmitted = true;
      this.stdout.write({ type: 'status', sessionId: conversationId } satisfies AgentEvent);
    }

    // The transcript may be flushed a few ms after the process closes.
    let delta = readPlannerDelta(conversationId, this.consumedStep);
    for (let i = 0; i < TRANSCRIPT_READ_RETRIES && !delta.found; i++) {
      await sleep(TRANSCRIPT_READ_DELAY_MS);
      delta = readPlannerDelta(conversationId, this.consumedStep);
    }

    if (delta.found && delta.text) {
      this.consumedStep = delta.maxStep;
      this.stdout.write({ type: 'text', content: delta.text } satisfies AgentEvent);
      this.stdout.write({ type: 'result', sessionId: conversationId } satisfies AgentEvent);
    } else {
      // No new assistant text — agy silently returns empty on failure
      // (e.g. auth/network). Keep the high-water mark so we don't replay later.
      this.consumedStep = Math.max(this.consumedStep, delta.maxStep);
      const detail = this.stderrBuffer.trim() || stdoutTail.trim() || `exit code ${code}`;
      this.stdout.write({ type: 'error', message: `agy 本轮无响应（${detail}）` } satisfies AgentEvent);
    }

    this.afterTurn();
  }

  private afterTurn(): void {
    this.stderrBuffer = '';
    if (this.terminated) {
      this.emitExit(null);
      return;
    }
    const next = this.queuedMessages.shift();
    if (next) this.runTurn(next);
  }

  private emitExit(code: number | null): void {
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.stdout.end();
    this.eventEmitter.emit('exit', code);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgyPlugin implements AgentPlugin {
  name = 'agy';
  displayName = 'Antigravity CLI';
  private binary: string;

  capabilities: AgentCapabilities = {
    streamJson: false,
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
