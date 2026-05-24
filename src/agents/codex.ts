import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform, Writable, type TransformCallback } from 'node:stream';
import { formatAttachmentMetadataFields } from '../security/attachment-metadata.js';
import {
  extractFileMarkerCandidates,
  resolveSafeFilePayloads,
  stripFileMarkers,
} from './codex-file-markers.js';
import type {
  AgentCapabilities,
  AgentEvent,
  AgentPlugin,
  AgentProcess,
  SpawnOpts,
  TokenUsage,
  UserMessage,
  FilePayload,
} from '../types.js';

const CODEX_SDK_MODULE = '@openai/codex-sdk';
const GENERATED_IMAGES_DIR =
  process.env.CTI_CODEX_GENERATED_IMAGES_DIR ?? join(process.env.HOME ?? tmpdir(), '.codex', 'generated_images');

type CodexSdk = {
  Codex: new (options?: Record<string, unknown>) => {
    startThread(options?: Record<string, unknown>): CodexThread;
    resumeThread(id: string, options?: Record<string, unknown>): CodexThread;
  };
};

type CodexThread = {
  id?: string | null;
  runStreamed(input: CodexInput, options?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<CodexThreadEvent> }>;
};

type CodexInput = string | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }>;

type CodexThreadEvent = {
  type: string;
  thread_id?: string;
  usage?: CodexUsage;
  error?: { message?: string };
  message?: string;
  item?: CodexItem;
};

type CodexUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_output_tokens?: number;
};

type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type QueuedInput = {
  message: UserMessage;
  resolve: () => void;
  reject: (err: Error) => void;
};

class CodexEventPassThrough extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  _transform(event: AgentEvent, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.push(event);
    callback();
  }
}

class CodexInputWriter extends Writable {
  private queue: QueuedInput[] = [];
  private waiters: Array<(value: QueuedInput | null) => void> = [];
  private inputClosed = false;

  constructor() {
    super();
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const raw = chunk.toString().trim();
      if (!raw) {
        callback();
        return;
      }
      const payload = JSON.parse(raw) as { message?: UserMessage };
      if (!payload.message) throw new Error('missing message');

      const queued: QueuedInput = {
        message: payload.message,
        resolve: () => callback(),
        reject: (err) => callback(err),
      };

      const waiter = this.waiters.shift();
      if (waiter) waiter(queued);
      else this.queue.push(queued);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    this.inputClosed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
    callback();
  }

  waitForInput(signal: AbortSignal): Promise<QueuedInput | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.inputClosed || signal.aborted) return Promise.resolve(null);

    return new Promise((resolve) => {
      const onAbort = () => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wrappedResolve);
        resolve(null);
      };
      const wrappedResolve = (value: QueuedInput | null) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(wrappedResolve);
    });
  }
}

export function mapCodexItemToEvents(item: CodexItem): AgentEvent[] {
  const id = item.id ?? '';

  if (item.type === 'agent_message') {
    return [{ type: 'text', content: stripFileMarkers(item.text ?? '') }];
  }

  if (item.type === 'reasoning') {
    return [{ type: 'thinking', content: item.text ?? '' }];
  }

  if (item.type === 'command_execution') {
    const output = item.aggregated_output ?? '';
    const isError = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
    return [
      { type: 'tool_use', id, name: 'Bash', input: { command: item.command ?? '' } },
      {
        type: 'tool_result',
        id,
        name: 'Bash',
        output: output || (isError ? `Exit code: ${item.exit_code}` : 'Done'),
        isError,
      },
    ];
  }

  if (item.type === 'file_change') {
    const changes = item.changes ?? [];
    const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');
    return [
      { type: 'tool_use', id, name: 'Edit', input: { files: changes } },
      {
        type: 'tool_result',
        id,
        name: 'Edit',
        output: summary || 'File changes applied',
        isError: item.status === 'failed',
      },
    ];
  }

  if (item.type === 'mcp_tool_call') {
    const server = item.server ?? '';
    const tool = item.tool ?? '';
    const toolName = `mcp__${server}__${tool}`;
    const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
    const resultContent = result?.content ?? result?.structured_content;
    const resultText = typeof resultContent === 'string'
      ? resultContent : resultContent ? JSON.stringify(resultContent) : undefined;
    return [
      {
        type: 'tool_use',
        id,
        name: toolName,
        input: item.arguments as Record<string, unknown> ?? {},
      },
      {
        type: 'tool_result',
        id,
        name: toolName,
        output: item.error?.message || resultText || 'Done',
        isError: item.status === 'failed' || Boolean(item.error),
      },
    ];
  }

  return [];
}

export function mapCodexThreadEvent(
  event: CodexThreadEvent,
  sessionId = '',
  createdFiles?: FilePayload[],
): AgentEvent[] {
  if (event.type === 'thread.started') {
    return [{ type: 'status', sessionId: event.thread_id, message: 'Thread started' }];
  }

  if (event.type === 'item.completed' && event.item) {
    return mapCodexItemToEvents(event.item);
  }

  if (event.type === 'turn.completed') {
    const result: AgentEvent = { type: 'result', sessionId, usage: mapUsage(event.usage) };
    if (createdFiles) result.createdFiles = createdFiles;
    return [result];
  }

  if (event.type === 'turn.failed') {
    return [{ type: 'error', message: event.error?.message ?? 'Codex turn failed' }];
  }

  if (event.type === 'error') {
    return [{ type: 'error', message: event.message ?? 'Codex stream error' }];
  }

  return [];
}

export function shouldRetryFreshThread(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /resuming session with different model|no such session/i.test(message);
}

export class CodexPlugin implements AgentPlugin {
  name = 'codex';
  displayName = 'Codex';
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
      const { execFileSync } = await import('node:child_process');
      const output = execFileSync(this.binary, ['--version'], { timeout: 10000, encoding: 'utf-8' });
      return { ok: true, version: output.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  spawn(opts: SpawnOpts): AgentProcess {
    return this.createSdkProcess(undefined, opts);
  }

  resume(sessionId: string, opts: SpawnOpts): AgentProcess {
    return this.createSdkProcess(sessionId, opts);
  }

  buildSpawnArgs(opts: SpawnOpts): string[] {
    const args: string[] = [];
    if (opts.model) args.push('--model', opts.model);
    if (opts.sandboxMode) args.push('--sandbox', opts.sandboxMode);
    if (opts.reasoningEffort) args.push('--model-reasoning-effort', opts.reasoningEffort);
    return args;
  }

  createStdoutParser(): Transform {
    return new CodexEventPassThrough();
  }

  formatStdinMessage(msg: UserMessage): string {
    return JSON.stringify({ type: 'user', message: msg }) + '\n';
  }

  formatPermissionResponse(requestId: string, decision: 'allow' | 'deny'): string {
    return JSON.stringify({ type: 'permission_response', requestId, decision }) + '\n';
  }

  private createSdkProcess(resumeSessionId: string | undefined, opts: SpawnOpts): AgentProcess {
    const stdin = new CodexInputWriter();
    const stdout = new Readable({
      objectMode: true,
      read() {
        // Events are pushed by the Codex turn loop.
      },
    });
    const controller = new AbortController();
    const exitHandlers: Array<(code: number | null) => void> = [];
    const errorHandlers: Array<(err: Error) => void> = [];
    let sessionId = resumeSessionId ?? '';
    let exited = false;

    const emitExit = (code: number | null) => {
      if (exited) return;
      exited = true;
      stdout.push(null);
      for (const handler of exitHandlers) handler(code);
    };
    const emitError = (err: Error) => {
      stdout.push({ type: 'error', message: err.message } satisfies AgentEvent);
      for (const handler of errorHandlers) handler(err);
    };

    void this.runThreadLoop({
      resumeSessionId,
      opts,
      stdin,
      stdout,
      signal: controller.signal,
      getSessionId: () => sessionId,
      setSessionId: (id) => {
        sessionId = id;
      },
    }).then(
      () => emitExit(0),
      (err) => {
        emitError(err instanceof Error ? err : new Error(String(err)));
        emitExit(1);
      },
    );

    return {
      pid: process.pid,
      get sessionId() {
        return sessionId;
      },
      set sessionId(id: string) {
        sessionId = id;
      },
      stdin,
      stdout,
      kill: () => {
        controller.abort();
        stdin.end();
      },
      on: (event, handler) => {
        if (event === 'exit') exitHandlers.push(handler as (code: number | null) => void);
        if (event === 'error') errorHandlers.push(handler as (err: Error) => void);
      },
    };
  }

  private async runThreadLoop(args: {
    resumeSessionId?: string;
    opts: SpawnOpts;
    stdin: CodexInputWriter;
    stdout: Readable;
    signal: AbortSignal;
    getSessionId: () => string;
    setSessionId: (id: string) => void;
  }): Promise<void> {
    const sdk = await loadCodexSdk();
    const Codex = sdk.Codex;
    const codex = new Codex(createCodexClientOptions(args.opts, this.binary));
    let thread = args.resumeSessionId
      ? codex.resumeThread(args.resumeSessionId, createThreadOptions(args.opts))
      : codex.startThread(createThreadOptions(args.opts));
    let retriedFreshThread = false;

    while (!args.signal.aborted) {
      const queued = await args.stdin.waitForInput(args.signal);
      if (!queued) break;

      try {
        await this.runSingleTurn({
          thread,
          queued,
          opts: args.opts,
          stdout: args.stdout,
          signal: args.signal,
          getSessionId: args.getSessionId,
          setSessionId: args.setSessionId,
        });
        queued.resolve();
      } catch (err) {
        if (args.resumeSessionId && !retriedFreshThread && shouldRetryFreshThread(err)) {
          retriedFreshThread = true;
          thread = codex.startThread(createThreadOptions(args.opts));
          try {
            await this.runSingleTurn({
              thread,
              queued,
              opts: args.opts,
              stdout: args.stdout,
              signal: args.signal,
              getSessionId: args.getSessionId,
              setSessionId: args.setSessionId,
            });
            queued.resolve();
          } catch (retryErr) {
            queued.reject(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
            throw retryErr;
          }
        } else {
          queued.reject(err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      }
    }
  }

  private async runSingleTurn(args: {
    thread: CodexThread;
    queued: QueuedInput;
    opts: SpawnOpts;
    stdout: Readable;
    signal: AbortSignal;
    getSessionId: () => string;
    setSessionId: (id: string) => void;
  }): Promise<void> {
    const tempFiles: string[] = [];
    const beforeImages = await snapshotGeneratedImages();
    const turnController = new AbortController();
    const abortTurn = () => turnController.abort();
    if (args.signal.aborted) {
      turnController.abort();
    } else {
      args.signal.addEventListener('abort', abortTurn, { once: true });
    }

    const assistantTextBuffer: string[] = [];

    try {
      const input = await messageToCodexInput(args.queued.message, tempFiles);
      const { events } = await args.thread.runStreamed(input, { signal: turnController.signal });

      for await (const event of events) {
        if (event.type === 'thread.started' && event.thread_id) {
          args.setSessionId(event.thread_id);
        }

        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          const text = event.item.text ?? '';
          if (text) assistantTextBuffer.push(text);
        }

        if (event.type === 'turn.completed') {
          const generatedImages = await collectNewGeneratedImages(beforeImages);
          const markedFiles = await resolveMarkedFiles(
            assistantTextBuffer.join('\n'),
            args.opts.workingDirectory,
          );
          const createdFiles = mergeUniqueFiles(generatedImages, markedFiles);
          for (const mapped of mapCodexThreadEvent(event, args.getSessionId(), createdFiles)) {
            args.stdout.push(mapped);
          }
          continue;
        }

        for (const mapped of mapCodexThreadEvent(event, args.getSessionId())) {
          args.stdout.push(mapped);
        }
      }

    } catch (err) {
      throw err;
    } finally {
      args.signal.removeEventListener('abort', abortTurn);
      void cleanupTempFiles(tempFiles);
    }
  }
}

async function loadCodexSdk(): Promise<CodexSdk> {
  return import(CODEX_SDK_MODULE) as Promise<CodexSdk>;
}

function createCodexClientOptions(opts: SpawnOpts, binary?: string): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (binary) options.codexPathOverride = binary;

  const apiKey = opts.env?.CTI_CODEX_API_KEY
    ?? opts.env?.CODEX_API_KEY
    ?? opts.env?.OPENAI_API_KEY
    ?? process.env.CTI_CODEX_API_KEY
    ?? process.env.CODEX_API_KEY
    ?? process.env.OPENAI_API_KEY;
  const baseUrl = opts.env?.CTI_CODEX_BASE_URL ?? process.env.CTI_CODEX_BASE_URL;

  if (apiKey) options.apiKey = apiKey;
  if (baseUrl) options.baseUrl = baseUrl;

  if (opts.env && Object.keys(opts.env).length > 0) {
    const fullEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) fullEnv[k] = v;
    }
    Object.assign(fullEnv, opts.env);
    options.env = fullEnv;
  }
  return options;
}

function createThreadOptions(opts: SpawnOpts): Record<string, unknown> {
  return {
    workingDirectory: opts.workingDirectory,
    model: opts.model,
    sandboxMode: opts.sandboxMode,
    modelReasoningEffort: opts.reasoningEffort,
    approvalPolicy: (opts.permissionMode === 'bypass' || opts.autoApprove) ? 'never' : 'on-request',
    skipGitRepoCheck: true,
  };
}

async function messageToCodexInput(msg: UserMessage, tempFiles: string[]): Promise<CodexInput> {
  const parts: Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }> = [];
  if (typeof msg.content === 'string') {
    if (msg.content) parts.push({ type: 'text', text: msg.content });
  } else {
    for (const part of msg.content) {
      if (part.type === 'text') {
        if (part.text) parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        const path = await base64ImageToTempFile(part.source.data, part.source.media_type, tempFiles);
        parts.push({ type: 'local_image', path });
      }
    }
  }

  for (const attachment of msg.attachments ?? []) {
    if (attachment.type === 'image') {
      const path = await attachmentToLocalImage(attachment, tempFiles);
      if (path) parts.push({ type: 'local_image', path });
    } else {
      parts.push({ type: 'text', text: formatNonImageAttachment(attachment) });
    }
  }

  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

async function attachmentToLocalImage(
  attachment: NonNullable<UserMessage['attachments']>[number],
  tempFiles: string[],
): Promise<string | null> {
  if (attachment.localPath) return attachment.localPath;
  const base64Part = extractBase64Image(attachment);
  if (!base64Part) return null;

  return base64ImageToTempFile(base64Part, attachment.mimeType, tempFiles);
}

function extractBase64Image(attachment: NonNullable<UserMessage['attachments']>[number]): string | null {
  if (!attachment.url?.startsWith('data:')) return null;
  const comma = attachment.url.indexOf(',');
  if (comma < 0) return null;
  return attachment.url.slice(comma + 1);
}

export function formatNonImageAttachment(attachment: NonNullable<UserMessage['attachments']>[number]): string {
  const fields = formatAttachmentMetadataFields(attachment);
  return [
    'Non-image attachment provided to Codex:',
    ...(fields.length > 0 ? fields.map((field) => `- ${field}`) : ['- attachment: "unavailable"']),
  ].filter(Boolean).join('\n');
}

async function base64ImageToTempFile(base64Data: string, mimeType: string | undefined, tempFiles: string[]): Promise<string> {
  const ext = extensionForMime(mimeType);
  const path = join(tmpdir(), `cli2im-codex-${randomUUID()}${ext}`);
  await writeFile(path, Buffer.from(base64Data, 'base64'));
  tempFiles.push(path);
  return path;
}

function mapUsage(usage?: CodexUsage): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cached_input_tokens ?? usage.cache_read_tokens,
    cacheWriteTokens: usage.cache_write_tokens,
  };
}

async function snapshotGeneratedImages(): Promise<Set<string>> {
  await mkdir(GENERATED_IMAGES_DIR, { recursive: true });
  const files = await readdir(GENERATED_IMAGES_DIR).catch(() => []);
  return new Set(files.map((file) => join(GENERATED_IMAGES_DIR, file)));
}

async function collectNewGeneratedImages(before: Set<string>): Promise<FilePayload[]> {
  const files = await readdir(GENERATED_IMAGES_DIR).catch(() => []);
  const created: FilePayload[] = [];
  for (const file of files) {
    const path = join(GENERATED_IMAGES_DIR, file);
    if (before.has(path)) continue;
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) {
      created.push({
        path,
        name: file,
        size: info.size,
        mtimeMs: info.mtimeMs,
        dev: info.dev,
        ino: info.ino,
      });
    }
  }
  return created.sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveMarkedFiles(text: string, workingDirectory?: string): Promise<FilePayload[]> {
  if (!workingDirectory) return [];
  const candidates = extractFileMarkerCandidates(text);
  if (candidates.length === 0) return [];
  return resolveSafeFilePayloads(candidates, workingDirectory, {
    log: (msg) => console.warn(msg),
  });
}

function mergeUniqueFiles(...lists: FilePayload[][]): FilePayload[] {
  const seen = new Set<string>();
  const out: FilePayload[] = [];
  for (const list of lists) {
    for (const file of list) {
      const key = fileIdentityKey(file);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
  }
  return out;
}

function fileIdentityKey(file: FilePayload): string {
  return typeof file.dev === 'number' && typeof file.ino === 'number'
    ? `${file.dev}:${file.ino}`
    : file.path;
}

async function cleanupTempFiles(paths: string[]): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => undefined)));
}

function extensionForMime(mimeType?: string): string {
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  if (mimeType === 'image/gif') return '.gif';
  return '.png';
}
