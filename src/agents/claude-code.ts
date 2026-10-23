import { homedir } from 'node:os';
import { agentChildEnv, claudeCheckOptions } from '../isolation/check-options.js';
import { allowedClaudeTool, claudeIsolationOptions } from '../isolation/claude.js';
import { buildChildEnv } from '../security/child-env.js';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { extractFileMarkerCandidates, resolveSafeFilePayloads } from './codex-file-markers.js';
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
  AgentQuestion,
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
    log: () => console.warn('[claude-created-file] file candidate rejected'),
  });
}

type ClaudeQueryFn = typeof query;
type StdinPayload =
  | { type: 'user'; message: UserMessage }
  | { type: 'tool_use_permission_response'; tool_use_id: string; decision: 'allow' | 'deny' }
  | { type: 'question_response'; tool_use_id: string; answers: Record<string, string> }
  | { type: 'cancel' };

const HEARTBEAT_THROTTLE_MS = 30_000;
const KEEP_ALIVE_INTERVAL_MS = 60_000;

const FILE_SEND_NOTE = '要把文件发给聊天中的用户时：文件需放在当前工作目录内（必要时先复制进来），'
  + '并在回复里单独写一行 [[file:相对路径]]；bridge 会在本轮结束后发送该文件，并在显示时隐藏这行标记。';

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

// Only newly written files are auto-sent; edits to existing files (e.g. source code in a
// project) would flood the chat. Anything else is sent via [[file:]] markers.
function isFileWritingTool(toolName: string): boolean {
  return toolName === 'Write';
}

export function parseAskUserQuestions(input: Record<string, unknown>): AgentQuestion[] | undefined {
  if (!Array.isArray(input.questions) || input.questions.length === 0) return undefined;
  const questions: AgentQuestion[] = [];
  for (const raw of input.questions) {
    const item = asRecord(raw);
    if (typeof item.question !== 'string' || !Array.isArray(item.options)) return undefined;
    const options = item.options.map(asRecord).filter((option) => typeof option.label === 'string')
      .map((option) => ({
        label: option.label as string,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      }));
    if (options.length === 0) return undefined;
    questions.push({
      question: item.question,
      ...(typeof item.header === 'string' ? { header: item.header } : {}),
      multiSelect: item.multiSelect === true,
      options,
    });
  }
  return questions;
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
  if (permissionMode === 'bypass') return 'bypassPermissions';
  return permissionMode === 'auto' ? 'auto' : 'default';
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
  private questionInputs = new Map<string, Record<string, unknown>>();
  private backgroundTaskIds = new Set<string>();
  private effectivePermissionMode?: PermissionMode;
  private lastHeartbeatAt = Date.now();
  private keepAliveTimer?: ReturnType<typeof setInterval>;
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

    if (this.opts.isolation && !allowedClaudeTool(this.opts.isolation, toolName, input)) {
      return { behavior: 'deny', message: 'Isolation tool guard denied this request' };
    }

    if (toolName === 'AskUserQuestion') {
      const questions = parseAskUserQuestions(input);
      if (questions) return this.askUser(questions, input, context);
    }

    if (this.opts.autoApprove && !this.usesAutoModeApproval()) {
      return { behavior: 'allow', updatedInput: input };
    }

    const toolUseID = context.toolUseID;
    const result = new Promise<PermissionResult>((resolve) => {
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

    // Consumers can reply synchronously from write(); register the request first.
    this.stdout.write({
      type: 'permission_request',
      id: toolUseID,
      tool: toolName,
      input,
    } satisfies AgentEvent);
    return result;
  };

  private askUser(
    questions: AgentQuestion[],
    input: Record<string, unknown>,
    context: { toolUseID: string; signal: AbortSignal },
  ): Promise<PermissionResult> {
    const toolUseID = context.toolUseID;
    const result = new Promise<PermissionResult>((resolve) => {
      const abort = () => {
        this.settlePermission(toolUseID, { behavior: 'deny', message: 'Question was cancelled', toolUseID });
      };
      if (context.signal.aborted) {
        resolve({ behavior: 'deny', message: 'Question was cancelled', toolUseID });
        return;
      }
      this.questionInputs.set(toolUseID, input);
      this.pendingPermissions.set(toolUseID, {
        resolve,
        cleanup: () => context.signal.removeEventListener('abort', abort),
      });
      context.signal.addEventListener('abort', abort, { once: true });
    });

    this.stdout.write({ type: 'question_request', id: toolUseID, questions } satisfies AgentEvent);
    return result;
  }

  private resolveQuestion(toolUseID: string, answers: Record<string, string>): void {
    const input = this.questionInputs.get(toolUseID);
    if (!input) return;
    // No answers keeps the original input, which the tool reports as "did not answer".
    this.settlePermission(toolUseID, {
      behavior: 'allow',
      updatedInput: Object.keys(answers).length > 0 ? { ...input, answers } : input,
    });
  }

  // In auto mode the classifier settles routine calls itself; whatever still reaches
  // canUseTool (ask rules, the fallback after repeated denials) needs a human.
  private usesAutoModeApproval(): boolean {
    return this.opts.permissionMode === 'auto' && this.effectivePermissionMode === 'auto';
  }

  private noteSDKMessage(msg: SDKMessage): void {
    if (msg.type === 'system') {
      if (msg.subtype === 'task_started') this.backgroundTaskIds.add(msg.task_id);
      if (msg.subtype === 'task_notification') this.backgroundTaskIds.delete(msg.task_id);
      if (msg.subtype === 'task_updated' && ['completed', 'failed', 'killed'].includes(msg.patch.status ?? '')) {
        this.backgroundTaskIds.delete(msg.task_id);
      }
      if ((msg.subtype === 'init' || msg.subtype === 'status') && msg.permissionMode) {
        this.effectivePermissionMode = msg.permissionMode;
      }
    }
    // Any SDK traffic (tool progress, task updates, thinking) proves the CLI is alive.
    this.writeHeartbeat();
  }

  // Background tasks and pending questions emit nothing while they wait; heartbeat so
  // the bridge's idle watchdog only reclaims a process that is truly idle.
  private startKeepAlive(): void {
    if (this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => {
      if (this.backgroundTaskIds.size > 0 || this.pendingPermissions.size > 0) this.writeHeartbeat();
    }, KEEP_ALIVE_INTERVAL_MS);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
  }

  private writeHeartbeat(): void {
    if (this.terminated || this.exitEmitted) return;
    const now = Date.now();
    if (now - this.lastHeartbeatAt < HEARTBEAT_THROTTLE_MS) return;
    this.lastHeartbeatAt = now;
    this.stdout.write({ type: 'status' } satisfies AgentEvent);
  }

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

    if (payload.type === 'question_response') {
      this.resolveQuestion(payload.tool_use_id, payload.answers ?? {});
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
    this.startKeepAlive();

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
    let turnText = '';
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
        this.noteSDKMessage(sdkMessage);
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
          } else if (event.type === 'text') {
            turnText += event.content;
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

          // Attach createdFiles (written files plus [[file:]] markers) to result event
          if (event.type === 'result') {
            const filesToSend = [...new Set([...completedFilePaths, ...extractFileMarkerCandidates(turnText)])];
            const resolved = filesToSend.length > 0
              ? await resolveCreatedFiles(filesToSend, this.opts.workingDirectory)
              : [];
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
            turnText = '';
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
    const env = agentChildEnv('claude-code', this.opts);
    const appendSystemPrompt = this.opts.appendSystemPrompt && !this.opts.isolation
      ? `${this.opts.appendSystemPrompt}\n\n${FILE_SEND_NOTE}`
      : this.opts.appendSystemPrompt;
    return {
      cwd: this.opts.workingDirectory,
      model: this.opts.model,
      resume: resumeSessionId,
      abortController,
      permissionMode,
      allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions' ? true : undefined,
      includePartialMessages: true,
      env,
      ...claudeCheckOptions(this.opts),
      systemPrompt: appendSystemPrompt
        ? { type: 'preset', preset: 'claude_code', append: appendSystemPrompt }
        : this.opts.systemPrompt,
      effort: this.opts.reasoningEffort,
      pathToClaudeCodeExecutable: this.opts.isolation ? this.opts.isolation.binaryPath : this.binary,
      canUseTool: this.canUseTool,
      // Raw CLI diagnostics can contain prompts, paths, or credentials.
      stderr: () => undefined,
      ...(this.opts.isolation ? claudeIsolationOptions(this.opts.isolation, env.HOME ?? homedir()) : {}),
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
    this.questionInputs.clear();
  }

  private settlePermission(toolUseID: string, result: PermissionResult): void {
    const pending = this.pendingPermissions.get(toolUseID);
    if (!pending) return;

    this.pendingPermissions.delete(toolUseID);
    this.questionInputs.delete(toolUseID);
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
    this.stopKeepAlive();
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
    this.stopKeepAlive();
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
        env: buildChildEnv('claude-code'),
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

    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
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

  formatQuestionResponse(requestId: string, answers: Record<string, string>): string {
    return JSON.stringify({
      type: 'question_response',
      tool_use_id: requestId,
      answers,
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
