import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveSafeFilePayloads } from './codex-file-markers.js';
import type {
  CanUseTool,
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentPlugin,
  AgentProcess,
  AgentEvent,
  AgentCapabilities,
  SpawnOpts,
  UserMessage,
  FilePayload,
} from '../types.js';

// ── Outbound file detection ──────────────────────────────────

async function resolveCreatedFiles(
  rawPaths: string[],
  workingDirectory: string,
): Promise<FilePayload[]> {
  return resolveSafeFilePayloads(rawPaths, workingDirectory, {
    log: (msg) => console.warn(msg.replace('[file-marker]', '[claude-created-file]')),
  });
}

type ClaudeQueryFn = typeof query;
type StdinPayload =
  | { type: 'user'; message: UserMessage }
  | { type: 'tool_use_permission_response'; tool_use_id: string; decision: 'allow' | 'deny' }
  | { type: 'cancel' };

export interface SDKEventMappingState {
  hasStreamedDeltas: boolean;
  latestSessionId?: string;
  toolNamesById: Map<string, string>;
}

interface PendingPermissionResolver {
  resolve: (result: PermissionResult) => void;
}

export function createSDKEventMappingState(): SDKEventMappingState {
  return {
    hasStreamedDeltas: false,
    toolNamesById: new Map(),
  };
}

export function mapSDKEvent(msg: SDKMessage, state: SDKEventMappingState): AgentEvent[] {
  const events: AgentEvent[] = [];

  if (msg.type === 'stream_event') {
    const event = msg.event;
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      state.hasStreamedDeltas = true;
      events.push({ type: 'text', content: event.delta.text });
      return events;
    }

    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      const block = event.content_block;
      state.toolNamesById.set(block.id, block.name);
      events.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: asRecord(block.input),
      });
    }
    return events;
  }

  if (msg.type === 'assistant') {
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        if (!state.hasStreamedDeltas) {
          events.push({ type: 'text', content: block.text });
        }
      } else if (block.type === 'tool_use') {
        state.toolNamesById.set(block.id, block.name);
        events.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: asRecord(block.input),
        });
      } else if (block.type === 'thinking') {
        events.push({ type: 'thinking', content: block.thinking ?? '' });
      }
    }
    return events;
  }

  if (msg.type === 'user') {
    const content = msg.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const id = String(block.tool_use_id ?? '');
        events.push({
          type: 'tool_result',
          id,
          name: state.toolNamesById.get(id) ?? '',
          output: stringifyToolResultContent(block.content),
          isError: block.is_error,
        });
      }
    }
    return events;
  }

  if (msg.type === 'result') {
    state.latestSessionId = msg.session_id;

    if (msg.subtype === 'success') {
      events.push({
        type: 'result',
        sessionId: msg.session_id,
        usage: {
          inputTokens: msg.usage.input_tokens ?? 0,
          outputTokens: msg.usage.output_tokens ?? 0,
          cacheReadTokens: msg.usage.cache_read_input_tokens ?? undefined,
          cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? undefined,
        },
      });
    } else {
      events.push({ type: 'error', message: msg.errors.join('; ') });
    }
    return events;
  }

  if (msg.type === 'system' && msg.subtype === 'init') {
    state.latestSessionId = msg.session_id;
    events.push({ type: 'status', sessionId: msg.session_id });
  }

  return events;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isFileWritingTool(toolName: string): boolean {
  return toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit';
}

function filePathFromToolInput(input: Record<string, unknown>): string | null {
  const filePath = input.file_path ?? input.path;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content ?? '');
}

function mapPermissionMode(permissionMode: SpawnOpts['permissionMode']): PermissionMode {
  return permissionMode === 'bypass' ? 'bypassPermissions' : 'default';
}

function isCancelMessage(payload: StdinPayload): boolean {
  if (payload.type === 'cancel') return true;
  if (payload.type !== 'user') return false;
  return payload.message.content === '/stop';
}

function createPrompt(msg: UserMessage): string | AsyncIterable<SDKUserMessage> {
  if (typeof msg.content === 'string') return msg.content;

  const sdkMessage: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: msg.content as SDKUserMessage['message']['content'],
    },
    parent_tool_use_id: null,
  };

  return (async function* () {
    yield sdkMessage;
  })();
}

export class ClaudeCodeVirtualProcess implements AgentProcess {
  pid = process.pid;
  sessionId: string;
  stdin: Writable;
  stdout: PassThrough;

  private inputBuffer = '';
  private activeQuery = false;
  private terminated = false;
  private exitEmitted = false;
  private abortController = new AbortController();
  private queuedMessages: UserMessage[] = [];
  private pendingPermissions = new Map<string, PendingPermissionResolver>();
  private eventEmitter = new EventEmitter();
  private mappingState = createSDKEventMappingState();

  constructor(
    private readonly binary: string,
    private readonly opts: SpawnOpts,
    private sdkSessionId: string | undefined,
    private readonly queryFn: ClaudeQueryFn = query,
  ) {
    this.sessionId = sdkSessionId ?? '';
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

  kill(_signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.terminate(null);
  }

  on(event: 'exit', handler: (code: number | null) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'exit' | 'error', handler: (...args: any[]) => void): void {
    this.eventEmitter.on(event, handler);
  }

  canUseTool: CanUseTool = async (toolName, input, context) => {
    if (this.opts.autoApprove) {
      return { behavior: 'allow', updatedInput: input };
    }

    const toolUseID = context.toolUseID;
    this.stdout.write({
      type: 'permission_request',
      id: toolUseID,
      tool: toolName,
      input,
    } satisfies AgentEvent);

    return new Promise<PermissionResult>((resolve) => {
      const abort = () => {
        this.pendingPermissions.delete(toolUseID);
        resolve({
          behavior: 'deny',
          message: 'Permission request was cancelled',
          toolUseID,
        });
      };

      if (context.signal.aborted) {
        abort();
        return;
      }

      this.pendingPermissions.set(toolUseID, { resolve });
      context.signal.addEventListener('abort', abort, { once: true });
    });
  };

  private handleStdinChunk(chunk: Buffer | string | Uint8Array): void {
    this.inputBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = this.inputBuffer.split('\n');
    this.inputBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.handleStdinPayload(JSON.parse(trimmed) as StdinPayload);
    }
  }

  private handleStdinPayload(payload: StdinPayload): void {
    if (isCancelMessage(payload)) {
      this.terminate(null);
      return;
    }

    if (payload.type === 'tool_use_permission_response') {
      this.resolvePermission(payload.tool_use_id, payload.decision);
      return;
    }

    if (payload.type === 'user') {
      this.enqueueUserMessage(payload.message);
    }
  }

  private enqueueUserMessage(message: UserMessage): void {
    if (this.terminated) return;

    if (this.activeQuery) {
      this.queuedMessages.push(message);
      return;
    }

    void this.runQuery(message);
  }

  private async runQuery(message: UserMessage): Promise<void> {
    if (this.terminated) return;

    this.activeQuery = true;
    this.mappingState.hasStreamedDeltas = false;
    let hasReceivedResult = false;
    const pendingFilePathsByToolId = new Map<string, string>();
    const completedFilePaths: string[] = [];

    try {
      const queryInstance = this.queryFn({
        prompt: createPrompt(message),
        options: this.createQueryOptions(),
      }) as Query;

      for await (const sdkMessage of queryInstance) {
        const events = mapSDKEvent(sdkMessage, this.mappingState);

        // Track successful file-writing tools; failed tool results must not
        // cause unrelated pre-existing files to be sent.
        for (const event of events) {
          if (event.type === 'tool_use' && isFileWritingTool(event.name)) {
            const filePath = filePathFromToolInput(event.input);
            if (filePath) {
              pendingFilePathsByToolId.set(event.id, filePath);
            }
          } else if (event.type === 'tool_result') {
            const filePath = pendingFilePathsByToolId.get(event.id);
            if (!filePath) continue;
            pendingFilePathsByToolId.delete(event.id);
            if (!event.isError && !completedFilePaths.includes(filePath)) {
              completedFilePaths.push(filePath);
            }
          }
        }

        for (const event of events) {
          // Attach createdFiles to result event
          if (event.type === 'result' && completedFilePaths.length > 0) {
            const resolved = await resolveCreatedFiles(
              completedFilePaths,
              this.opts.workingDirectory,
            );
            if (resolved.length > 0) {
              event.createdFiles = resolved;
            }
          }

          this.stdout.write(event);
          if (event.type === 'result' && event.sessionId) {
            hasReceivedResult = true;
            this.sdkSessionId = event.sessionId;
            this.sessionId = event.sessionId;
          }
        }
      }

      if (this.mappingState.latestSessionId) {
        this.sdkSessionId = this.mappingState.latestSessionId;
        this.sessionId = this.mappingState.latestSessionId;
      }
    } catch (err) {
      if (this.terminated || this.abortController.signal.aborted) {
        this.emitExit(null);
        return;
      }

      const message = err instanceof Error ? err.message : String(err);
      const isTransportExit = message.includes('process exited with code');

      if (hasReceivedResult && isTransportExit) {
        console.log('[claude-code-sdk] Suppressing transport error after result');
        return;
      }

      this.terminated = true;
      const error = err instanceof Error ? err : new Error(String(err));
      this.stdout.write({ type: 'error', message: error.message } satisfies AgentEvent);
      if (this.eventEmitter.listenerCount('error') > 0) {
        this.eventEmitter.emit('error', error);
      }
      this.emitExit(1);
      return;
    } finally {
      this.activeQuery = false;
    }

    const nextMessage = this.queuedMessages.shift();
    if (nextMessage) {
      void this.runQuery(nextMessage);
    }
  }

  private createQueryOptions(): ClaudeQueryOptions {
    const permissionMode = mapPermissionMode(this.opts.permissionMode);
    return {
      cwd: this.opts.workingDirectory,
      model: this.opts.model,
      resume: this.sdkSessionId,
      abortController: this.abortController,
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions' ? true : undefined,
      includePartialMessages: true,
      env: { ...process.env, ...this.opts.env },
      systemPrompt: this.opts.systemPrompt,
      effort: this.opts.reasoningEffort,
      pathToClaudeCodeExecutable: this.binary,
      canUseTool: this.canUseTool,
      stderr: (data: string) => {
        const trimmed = data.trim();
        if (trimmed) console.warn('[claude-code-sdk] stderr:', trimmed);
      },
    };
  }

  private resolvePermission(toolUseID: string, decision: 'allow' | 'deny'): void {
    const pending = this.pendingPermissions.get(toolUseID);
    if (!pending) return;

    this.pendingPermissions.delete(toolUseID);
    if (decision === 'allow') {
      pending.resolve({ behavior: 'allow' });
      return;
    }

    pending.resolve({
      behavior: 'deny',
      message: 'Denied by user',
    });
  }

  private terminate(code: number | null): void {
    if (this.terminated) return;

    this.terminated = true;
    this.abortController.abort();
    for (const [toolUseID, pending] of this.pendingPermissions) {
      pending.resolve({
        behavior: 'deny',
        message: 'Process terminated',
        toolUseID,
      });
    }
    this.pendingPermissions.clear();

    if (!this.activeQuery) {
      this.emitExit(code);
    }
  }

  private emitExit(code: number | null): void {
    if (this.exitEmitted) return;

    this.exitEmitted = true;
    this.stdout.end();
    this.eventEmitter.emit('exit', code);
  }
}

export class ClaudeCodePlugin implements AgentPlugin {
  name = 'claude-code';
  displayName = 'Claude Code';
  private binary: string;

  capabilities: AgentCapabilities = {
    streamJson: true,
    permissionPrompt: true,
    sessionResume: true,
    gracefulCancel: true,
    slashCommands: [
      '/compact', '/review', '/ultrareview', '/cost', '/doctor',
      '/permissions', '/config', '/memory', '/init', '/help',
    ],
  };

  constructor(binary: string, private readonly queryFn: ClaudeQueryFn = query) {
    this.binary = binary;
  }

  async preflight(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const { execFileSync } = await import('node:child_process');
      const output = execFileSync(this.binary, ['--version'], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      const version = output.trim();
      return { ok: true, version };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  buildSpawnArgs(opts: SpawnOpts): string[] {
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
    ];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.systemPrompt) {
      args.push('--system-prompt', opts.systemPrompt);
    }

    return args;
  }

  spawn(opts: SpawnOpts): AgentProcess {
    return new ClaudeCodeVirtualProcess(this.binary, opts, undefined, this.queryFn);
  }

  resume(sessionId: string, opts: SpawnOpts): AgentProcess {
    return new ClaudeCodeVirtualProcess(this.binary, opts, sessionId, this.queryFn);
  }

  createStdoutParser(): PassThrough {
    return new PassThrough({ objectMode: true });
  }

  formatStdinMessage(msg: UserMessage): string {
    return JSON.stringify({
      type: 'user',
      message: msg,
    }) + '\n';
  }

  formatPermissionResponse(requestId: string, decision: 'allow' | 'deny'): string {
    return JSON.stringify({
      type: 'tool_use_permission_response',
      tool_use_id: requestId,
      decision,
    }) + '\n';
  }

  formatCancelMessage(): string {
    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: '/stop',
      },
    }) + '\n';
  }
}
