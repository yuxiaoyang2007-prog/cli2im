import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveSafeFilePayloads } from './codex-file-markers.js';
import { InputQueue } from './input-queue.js';
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
  cleanup: () => void;
}

class ResumeFailed extends Error {
  constructor() {
    super('Resume failed before side effects');
    this.name = 'ResumeFailed';
  }
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

function isTransportExitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('process exited with code');
}

function isThinkingBlockMutationErrorText(content: string): boolean {
  const normalized = content.toLowerCase();
  const mentionsSyntheticError = normalized.includes('api error') && normalized.includes('400');
  const mentionsThinking = normalized.includes('thinking') || normalized.includes('redacted_thinking');
  const mentionsMutation =
    normalized.includes('cannot be modified') ||
    normalized.includes('must remain as they were');
  return mentionsSyntheticError && mentionsThinking && mentionsMutation;
}

function mapPermissionMode(permissionMode: SpawnOpts['permissionMode']): PermissionMode {
  return permissionMode === 'bypass' ? 'bypassPermissions' : 'default';
}

function isCancelMessage(payload: StdinPayload): boolean {
  if (payload.type === 'cancel') return true;
  if (payload.type !== 'user') return false;
  return payload.message.content === '/stop';
}

function createSDKUserMessage(msg: UserMessage): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: msg.content as SDKUserMessage['message']['content'],
    },
    parent_tool_use_id: null,
  };
}

function resetTurnMappingState(state: SDKEventMappingState): void {
  state.hasStreamedDeltas = false;
  state.toolNamesById.clear();
}

function isTurnSideEffectEvent(event: AgentEvent): boolean {
  return event.type !== 'status' && event.type !== 'result';
}

export class ClaudeCodeVirtualProcess implements AgentProcess {
  pid = process.pid;
  sessionId: string;
  stdin: Writable;
  stdout: PassThrough;

  private inputBuffer = '';
  private activeQuery = false;
  private queryStarted = false;
  private terminated = false;
  private exitEmitted = false;
  private abortController = new AbortController();
  private inputQueue = new InputQueue<SDKUserMessage>();
  private coldStartReplayInputs: SDKUserMessage[] = [];
  private bufferingColdStartReplay = true;
  private bufferingResumeInput = false;
  private resumeAttemptHasSideEffects = false;
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
    this.resumeAttemptHasSideEffects = this.bufferingResumeInput || this.resumeAttemptHasSideEffects;

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
        this.settlePermission(toolUseID, {
          behavior: 'deny',
          message: 'Permission request was cancelled',
          toolUseID,
        });
      };

      if (context.signal.aborted) {
        resolve({
          behavior: 'deny',
          message: 'Permission request was cancelled',
          toolUseID,
        });
        return;
      }

      this.pendingPermissions.set(toolUseID, {
        resolve,
        cleanup: () => context.signal.removeEventListener('abort', abort),
      });
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

    const sdkMessage = createSDKUserMessage(message);
    if (this.bufferingColdStartReplay) {
      this.coldStartReplayInputs.push(sdkMessage);
    }

    if (!this.queryStarted) {
      this.queryStarted = true;
      void this.runQuery();
    }

    this.inputQueue.push(sdkMessage);
  }

  private async runQuery(): Promise<void> {
    if (this.terminated) return;

    this.activeQuery = true;

    try {
      let resumeForAttempt = this.sdkSessionId;
      while (!this.terminated) {
        try {
          await this.consumeQuery(resumeForAttempt);
          return;
        } catch (err) {
          if (this.terminated || this.abortController.signal.aborted) {
            this.emitExit(null);
            return;
          }

          if (
            resumeForAttempt &&
            !this.resumeAttemptHasSideEffects &&
            !isTransportExitError(err)
          ) {
            this.sdkSessionId = undefined;
            this.sessionId = '';
            this.mappingState = createSDKEventMappingState();
            this.resetInputQueueFromColdStartReplay();
            this.bufferingResumeInput = false;
            this.resumeAttemptHasSideEffects = false;
            resumeForAttempt = undefined;
            continue;
          }

          this.handleFatalError(err);
          return;
        }
      }
    } finally {
      this.activeQuery = false;
    }
  }

  private async consumeQuery(resumeSessionId: string | undefined): Promise<void> {
    const usedResume = !!resumeSessionId;
    const bufferedStatusEvents: AgentEvent[] = [];
    const pendingFilePathsByToolId = new Map<string, string>();
    const completedFilePaths: string[] = [];
    const attemptAbort = this.createAttemptAbortController();
    let hasSideEffectsSinceLastResult = false;
    let resumeFailed = false;

    this.bufferingResumeInput = usedResume;
    this.resumeAttemptHasSideEffects = false;

    try {
      const queryInstance = this.queryFn({
        prompt: this.inputQueue,
        options: this.createQueryOptions(resumeSessionId, attemptAbort.controller),
      }) as Query;

      for await (const sdkMessage of queryInstance) {
        const isSyntheticAssistant =
          sdkMessage.type === 'assistant' && sdkMessage.message?.model === '<synthetic>';
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
          if (
            usedResume &&
            this.bufferingResumeInput &&
            isSyntheticAssistant &&
            event.type === 'text' &&
            isThinkingBlockMutationErrorText(event.content)
          ) {
            resumeFailed = true;
            attemptAbort.controller.abort();
            throw new ResumeFailed();
          }

          if (usedResume && this.bufferingResumeInput && event.type === 'status') {
            bufferedStatusEvents.push(event);
            continue;
          }

          if (isTurnSideEffectEvent(event)) {
            hasSideEffectsSinceLastResult = true;
          }

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

          if (usedResume && this.bufferingResumeInput && event.type !== 'result') {
            this.resumeAttemptHasSideEffects = true;
          }

          if (event.type === 'result' && event.sessionId) {
            for (const statusEvent of bufferedStatusEvents) {
              this.stdout.write(statusEvent);
            }
            bufferedStatusEvents.length = 0;
            this.bufferingResumeInput = false;
          }

          this.stdout.write(event);
          if (event.type === 'result' && event.sessionId) {
            this.sdkSessionId = event.sessionId;
            this.sessionId = event.sessionId;
            if (this.bufferingColdStartReplay) {
              this.coldStartReplayInputs = [];
              this.bufferingColdStartReplay = false;
            }
            hasSideEffectsSinceLastResult = false;
            resetTurnMappingState(this.mappingState);
            pendingFilePathsByToolId.clear();
            completedFilePaths.length = 0;
          }
        }
      }
    } catch (err) {
      if (resumeFailed) {
        throw new ResumeFailed();
      }
      if (isTransportExitError(err) && !hasSideEffectsSinceLastResult) {
        // A transport exit means the subprocess crashed. We intentionally do
        // not keep or replay in-flight stdin here; AgentManager will rebuild
        // on the next user message using the latest session id, and the user
        // can resend the message that was in flight when the crash happened.
        this.terminated = true;
        this.denyPendingPermissions('Process exited');
        this.emitExit(1);
        return;
      }
      throw err;
    } finally {
      attemptAbort.dispose();
    }

    this.bufferingResumeInput = false;

    if (this.mappingState.latestSessionId) {
      this.sdkSessionId = this.mappingState.latestSessionId;
      this.sessionId = this.mappingState.latestSessionId;
    }

    if (this.terminated || this.abortController.signal.aborted) {
      this.emitExit(null);
    }
  }

  private handleFatalError(err: unknown): void {
    this.terminated = true;
    this.bufferingResumeInput = false;
    const error = err instanceof Error ? err : new Error(String(err));
    this.stdout.write({ type: 'error', message: error.message } satisfies AgentEvent);
    this.denyPendingPermissions('Process failed');
    if (this.eventEmitter.listenerCount('error') > 0) {
      this.eventEmitter.emit('error', error);
    }
    this.emitExit(1);
  }

  private createAttemptAbortController(): { controller: AbortController; dispose: () => void } {
    const attemptAbortController = new AbortController();
    const abortAttempt = () => attemptAbortController.abort();
    if (this.abortController.signal.aborted) {
      attemptAbortController.abort();
    } else {
      this.abortController.signal.addEventListener('abort', abortAttempt, { once: true });
    }
    return {
      controller: attemptAbortController,
      dispose: () => this.abortController.signal.removeEventListener('abort', abortAttempt),
    };
  }

  private createQueryOptions(
    resumeSessionId: string | undefined,
    abortController: AbortController,
  ): ClaudeQueryOptions {
    const permissionMode = mapPermissionMode(this.opts.permissionMode);
    return {
      cwd: this.opts.workingDirectory,
      model: this.opts.model,
      resume: resumeSessionId,
      abortController,
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
    if (decision === 'allow') {
      this.settlePermission(toolUseID, { behavior: 'allow' });
      return;
    }

    this.settlePermission(toolUseID, {
      behavior: 'deny',
      message: 'Denied by user',
    });
  }

  private denyPendingPermissions(message: string): void {
    for (const [toolUseID, pending] of this.pendingPermissions) {
      pending.cleanup();
      pending.resolve({
        behavior: 'deny',
        message,
        toolUseID,
      });
    }
    this.pendingPermissions.clear();
  }

  private settlePermission(toolUseID: string, result: PermissionResult): void {
    const pending = this.pendingPermissions.get(toolUseID);
    if (!pending) return;

    this.pendingPermissions.delete(toolUseID);
    pending.cleanup();
    pending.resolve(result);
  }

  private resetInputQueueFromColdStartReplay(): void {
    this.inputQueue = new InputQueue<SDKUserMessage>();
    for (const message of this.coldStartReplayInputs) {
      this.inputQueue.push(message);
    }
  }

  private terminate(code: number | null): void {
    if (this.terminated) return;

    this.terminated = true;
    this.abortController.abort();
    this.inputQueue.close();
    this.coldStartReplayInputs = [];
    this.bufferingColdStartReplay = false;
    this.denyPendingPermissions('Process terminated');

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
