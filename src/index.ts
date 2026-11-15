import { resolveBotSpawnOpts, type BotSpawnOptsResolver } from './runtime/spawn-options.js';
export { resolveBotSpawnOpts, readAgentsInstructions, DEFAULT_AGENTS_FILE, MAX_AGENTS_FILE_BYTES } from './runtime/spawn-options.js';
export type { ResolveBotSpawnOptsInput, BotSpawnOptsResolver } from './runtime/spawn-options.js';
import { loadRuntimeConfig } from './config/loader.js';
import { SessionStore } from './session/store.js';
import { ChatQueue, MessageBatcher, QueueCancelledError } from './session/queue.js';
import { AgentManager, type AgentManagerEvents } from './agents/manager.js';
import { ToolGate } from './agents/tool-gate.js';
import { createStaticAgentPlugin, hotReloadAgentPlugin } from './agents/plugin-loader.js';
import { FeishuAdapter } from './platforms/feishu/adapter.js';
import { TelegramAdapter } from './platforms/telegram/adapter.js';
import { TelegramStreamController } from './platforms/telegram/stream.js';
import { StreamingCardController } from './platforms/feishu/cards.js';
import { HandoffService } from './services/handoff.js';
import { HttpServer } from './services/server.js';
import {
  InboundPipeline,
  buildSenderHeader,
  buildSenderEnv,
  getGroupMessageSkipReason,
  parseBridgeCommand,
} from './pipeline.js';
import {
  buildPermissionBlockedCard,
  buildHandoffNotification,
} from './platforms/feishu/markdown.js';
import { sanitizeVoiceTranscript } from './security/validators.js';
import {
  buildUserMessageForAgent,
  downloadInboundAttachments,
  expandHome,
} from './media.js';
import {
  initContentGuard,
  contentGuardStatus,
  contentGuardBackend,
  scanUntrustedExternalText,
} from './security/content-guard.js';
import { applyHotConfigReload } from './config/reload.js';
import { deliverCliNotification } from './notifications/cli-notify.js';
import { runOnlineDoctorProbes, formatOnlineDoctorSection } from './services/doctor-online.js';
import { renderDashboardHtml } from './services/dashboard.js';
import {
  handlePermissionCallback,
  isCallbackAuthorized,
  parseModelOrEffortAction,
  parsePermissionCallbackData,
  parseQuestionCallbackData,
  parseSessionResumeCallback,
} from './runtime/callbacks.js';
import { handleCLISessionResume } from './runtime/session-resume.js';
import { transcribeAudio } from './services/speech.js';
import { sendVoiceReply } from './runtime/voice-reply.js';
import type {
  SessionKey,
  InboundMessage,
  PlatformAdapter,
  BotConfig,
  SpawnOpts,
  UserMessage,
} from './types.js';
import { RelayManager } from './relay/manager.js';
import { scrubLog } from './security/logging.js';
import { createRuntimeEventHandler } from './runtime/event-handler.js';
import { createRuntimeProcessExitHandler } from './runtime/process-exit-handler.js';
import {
  bindSessionScopedBufferCleanup,
  commitVoiceSessionWhenContextReady,
  clearSessionScopedBuffers,
} from './runtime/session-scoped-cleanup.js';
import { ensurePrivateDirectorySync, getCli2imDataDir } from './util/data-dir.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { CodexNotificationService } from './notifications/service.js';
import { buildSessionKey } from './types.js';
import { getBotAccessRejection } from './security/access-policy.js';
import { configureNetworkPolicy, refreshNetworkPolicy, assertNetworkReady, networkPolicyStatus } from './security/network-policy.js';
import { BotLifecycle } from './runtime/bot-lifecycle.js';
import { buildQueueNoticeCard, parseControlAction, parseQueueSteerAction } from './runtime/control-panel.js';
import { QuestionBoard, answersFromText, buildQuestionCard } from './runtime/questions.js';
import { parseProjectAction } from './runtime/projects.js';
import { bindReplyRoute, type ReplyRoute } from './runtime/reply-route.js';
import { RecoveryStore } from './runtime/result-recovery.js';
import { TaskTracker } from './runtime/task-tracker.js';
import { reportMessageFailure, withMessageFailureCleanup } from './runtime/message-failure.js';
import { reconcileIsolatedSession } from './isolation/session.js';
import { IsolationRuntime } from './isolation/runtime.js';
import { runIsolationCheck } from './isolation/check.js';
import { runIsolationDoctor, formatIsolationReport } from './services/isolation-doctor.js';
import { VerificationStore } from './isolation/verification.js';
import { policyPaths, isolationWritablePaths, contains } from './isolation/policy.js';
import { sandboxReadFile } from './isolation/sbx-read.js';
import { MemoryStore } from './memory/store.js';
import { MemoryInjector } from './memory/inject.js';
import { MemorySessions } from './memory/sessions.js';
import { resolvePeople, resolveRuntimeMemoryIdentity } from './memory/principal.js';
import type { MemoryCommandContext } from './memory/commands.js';
import { resolveExecutionScope, ensureExecutionSession } from './runtime/execution-scope.js';
import { PreparationGuard } from './runtime/preparation-guard.js';
import { loadDataDirDotEnv } from './config/dotenv.js';
import { rotateLogFileIfNeeded, pruneStaleMediaFiles } from './util/housekeeping.js';
import { saveBotEnabled } from './config/runtime-update.js';
import { runDoctor, formatDoctorReport, formatServiceInventory } from './services/doctor.js';
import {
  handleBridgeCommand,
  type BridgeControls,
  type BridgeCommandSender,
  type RuntimeCommandState,
} from './commands/bridge-commands.js';
export { handleBridgeCommand, type BridgeControls, type BridgeCommandSender };

let CONFIG_PATH = process.env.CLI2IM_CONFIG ?? join(homedir(), '.cli2im', 'config.yaml');
const startedAt = Date.now();

export function logInboundMessageSummary(
  botName: string,
  message: InboundMessage,
  relayBotCount: number,
  botIdentityPresent: boolean,
): void {
  const chatType = message.chatType === 'p2p' || message.chatType === 'group'
    ? message.chatType
    : 'unknown';
  const command = parseBridgeCommand(message.text)?.command ?? 'none';
  console.log(
    `[pipeline] ${scrubLog(botName)}: inbound chat=${chatType}`
    + ` relay=${Boolean(message.isRelay)} command=${command}`
    + ` textLength=${message.text.length} mentionCount=${message.mentions?.length ?? 0}`
    + ` attachmentCount=${message.attachments?.length ?? 0}`
    + ` relayBotCount=${relayBotCount} botIdentity=${botIdentityPresent ? 'present' : 'absent'}`,
  );
}

async function main(): Promise<void> {
  loadDataDirDotEnv();
  CONFIG_PATH = process.env.CLI2IM_CONFIG ?? join(homedir(), '.cli2im', 'config.yaml');
  console.log('[cli2im] Starting...');

  const { config, botErrors, botIdentities } = loadRuntimeConfig(CONFIG_PATH);
  for (const name of Object.keys(botErrors)) console.warn(`[config] bot=${scrubLog(name)} status=invalid_disabled`);
  await configureNetworkPolicy(config.network);
  console.log(`[cli2im] Loaded config with ${Object.keys(config.bots).length} bot(s)`);
  initContentGuard({ enabled: config.contentGuard?.enabled !== false, blockThreshold: config.contentGuard?.blockThreshold });
  console.log(`[security] content_guard=${contentGuardStatus()}`);

  const dataDir = getCli2imDataDir();
  const mediaDir = join(dataDir, 'media');
  const logPath = join(dataDir, 'logs', 'cli2im.log');
  ensurePrivateDirectorySync(dataDir);
  ensurePrivateDirectorySync(mediaDir);
  ensurePrivateDirectorySync(join(dataDir, 'logs'));

  const store = await SessionStore.create(config.session.dbPath.replace('~', homedir()), {
    coalesceMs: 250,
  });
  await store.markInterruptedTasks();
  try {
    if (rotateLogFileIfNeeded(logPath)) console.log('[housekeeping] Rotated cli2im.log');
    const prunedMedia = pruneStaleMediaFiles(mediaDir);
    if (prunedMedia > 0) console.log(`[housekeeping] Pruned ${prunedMedia} stale media file(s)`);
    const prunedDb = store.pruneStaleRecords({ pruneMissingCursorFiles: true });
    if (prunedDb.deletedCursors + prunedDb.deletedDeliveries + prunedDb.deletedTasks > 0) {
      console.log(
        `[housekeeping] Pruned stale DB records cursors=${prunedDb.deletedCursors}`
        + ` deliveries=${prunedDb.deletedDeliveries} tasks=${prunedDb.deletedTasks}`,
      );
    }
  } catch (err) {
    console.warn(`[housekeeping] startup_failed reason=${scrubLog(err instanceof Error ? err.message : String(err))}`);
  }
  const queue = new ChatQueue();
  const preparation = new PreparationGuard();
  const recovery = new RecoveryStore(join(dataDir, 'recovery'));
  const busyTasks = new TaskTracker();
  const lifecycle = new BotLifecycle();
  const routes = new Map<SessionKey, ReplyRoute>();
  const cardScopes = new Map<string, { threadId?: string }>();
  const senders = new Map<SessionKey, InboundMessage>();
  let configUpdate = Promise.resolve();
  const reloadRuntimeConfig = () => {
    const run = configUpdate.catch(() => {}).then(() =>
      applyHotConfigReload({
        config,
        configPath: CONFIG_PATH,
        envPath: join(dataDir, '.env'),
        toolGate,
      }),
    );
    configUpdate = run.then(() => {}, () => {});
    return run;
  };
  const questionBoard = new QuestionBoard();
  const pendingQueuedMsgs = new Map<SessionKey, InboundMessage[]>();
  const queueNoticeIds = new Map<SessionKey, string>();

  function popMergedQueuedMessage(key: SessionKey): InboundMessage | undefined {
    const items = pendingQueuedMsgs.get(key);
    pendingQueuedMsgs.delete(key);
    if (!items?.length) return undefined;
    if (items.length === 1) return items[0];
    const base: InboundMessage = { ...items[items.length - 1] };
    base.text = items.map((m) => m.text).filter(Boolean).join('\n\n');
    const quoted = items.map((m) => m.quotedText).filter(Boolean).join('\n\n');
    if (quoted) base.quotedText = quoted;
    const attachments = items.flatMap((m) => m.attachments ?? []);
    if (attachments.length) base.attachments = attachments;
    return base;
  }

  async function submitQuestion(key: SessionKey, adapter: PlatformAdapter, chatId: string, answers: Record<string, string>): Promise<void> {
    const pending = questionBoard.get(key);
    if (!pending) return;
    questionBoard.close(key, pending.requestId);
    pending.answers = answers;
    const delivered = agentManager.answerQuestion(key, pending.requestId, answers);
    if (pending.messageId && adapter.replaceCard) {
      await adapter.replaceCard(pending.messageId, buildQuestionCard(pending, delivered ? 'done' : 'expired'));
    } else {
      await adapter.send(chatId, { text: delivered ? `已提交：${Object.values(answers).join('；')}` : '这个问题已失效。', plainText: true });
    }
  }

  async function handleQuestionCallback(key: SessionKey, adapter: PlatformAdapter, chatId: string, data: { token: string; question: number; option: number }): Promise<void> {
    const pending = questionBoard.get(key);
    if (!pending || pending.token !== data.token || !agentManager.hasPendingQuestion(key, pending.requestId)) {
      if (pending && pending.token === data.token) questionBoard.close(key, pending.requestId);
      await adapter.send(chatId, { text: '这个问题已失效。', plainText: true });
      return;
    }
    if (questionBoard.select(pending, data.question, data.option)) {
      await submitQuestion(key, adapter, chatId, pending.answers);
    } else if (pending.messageId && adapter.replaceCard) {
      await adapter.replaceCard(pending.messageId, buildQuestionCard(pending));
    } else {
      const question = pending.questions[data.question];
      const answer = question ? pending.answers[question.question] : undefined;
      const picked = [...(pending.selections.get(data.question) ?? [])].map((index) => question?.options[index]?.label).filter(Boolean);
      await adapter.send(chatId, { text: answer ? `已记录：${answer}` : `当前已选：${picked.join(', ') || '无'}`, plainText: true });
    }
  }
  const batchers = new Map<string, MessageBatcher>();
  const toolGate = new ToolGate(config.dangerousPatterns);
  const typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  const relayManager = new RelayManager();
  const adapters = new Map<string, PlatformAdapter>();
  const cardControllers = new Map<string, StreamingCardController>();
  const telegramStreams = new Map<string, TelegramStreamController>();
  const voiceSessions = new Map<SessionKey, string>();
  const messageProcessors = new Map<string, (msg: InboundMessage) => Promise<void>>();
  const runtimeState: RuntimeCommandState = {
    fastModeBySession: new Map(),
  };
  let notificationService: CodexNotificationService | undefined;
  const agentManager = new AgentManager(toolGate, (signal, sessionKey) => {
    const botName = sessionKey.split(':')[2];
    bindSessionScopedBufferCleanup(signal, sessionKey, {
      voiceSessions,
      tgStreamController: telegramStreams.get(botName),
    });
  });

  const memoryStore = new MemoryStore(expandHome(config.memory?.dir ?? join(dataDir, 'memory')));
  const memoryInjector = new MemoryInjector();
  const memorySessions = new MemorySessions(store, memoryStore, key => {
    preparation.cancel(key);
    busyTasks.cancel(key);
    queue.cancelPending(key);
    const name = key.split(':')[2];
    batchers.get(name)?.cancel(key);
    agentManager.forgetSession(key);
    cardControllers.get(name)?.interruptCard(key);
    clearSessionScopedBuffers(key, { voiceSessions, tgStreamController: telegramStreams.get(name) });
  });
  const isolation = new IsolationRuntime({ config, store, memory: memoryStore,
    paths: policyPaths(config), runCheck: runIsolationCheck, verification: new VerificationStore(join(dataDir, 'isolation', 'verification.json')),
    replaceProcess: key => agentManager.forgetSession(key),
    invalidate: key => {
      preparation.cancel(key); queue.cancelPending(key); busyTasks.cancel(key);
      batchers.get(key.split(':')[2])?.cancel(key);
      agentManager.forgetSession(key);
    },
  });
  agentManager.setIsolationGuard((key, opts, id) => isolation.guardStart(key, opts, id));

  async function prepareIsolation(botName: string, message: InboundMessage, key: SessionKey, workingDirectory: string, requireVerified = true, inspectOnly = false): Promise<SpawnOpts> {
    const bot = config.bots[botName];
    const telegramIds = new Map<string, string>();
    for (const [name, adapter] of adapters) if (adapter.appKey) telegramIds.set(name, adapter.appKey);
    const { identity, people } = resolveRuntimeMemoryIdentity(botName, botIdentities, config.memory?.people, telegramIds, message);
    if (!inspectOnly) await memorySessions.bind(key, identity.principal);
    const prefs = await store.getPreferences(key);
    const opts = await resolveBotSpawnOpts({ botConfig: bot, workingDirectory,
      allWritable: isolationWritablePaths(config, policyPaths(config)),
      env: { ...config.agents[bot.agent]?.env, ...buildSenderEnv({ channel: message.platform, userId: message.userId,
        userName: message.userName, chatId: message.chatId, chatType: message.chatType }),
        ...(bot.larkCliConfigDir ? { LARKSUITE_CLI_CONFIG_DIR: bot.larkCliConfigDir } : {}) },
      model: prefs.model ?? config.agents[bot.agent]?.defaultModel, autoApprove: bot.autoApprove,
      turnTimeoutMs: bot.turnTimeoutMs, idleTimeoutMs: bot.idleTimeoutMs, sandboxMode: bot.sandboxMode,
      reasoningEffort: runtimeState.fastModeBySession.get(key)
        ? 'low'
        : (prefs.effort ?? config.agents[bot.agent]?.defaultEffort) });
    const policy = await isolation.prepare(key, identity.principal, resolveExecutionScope(bot, message).scopeKey, opts, [...people.entries()].sort(), requireVerified, inspectOnly);
    opts.isolation = policy;
    return opts;
  }

  async function resumeIsolated(callback: import('./types.js').CallbackQuery, id: string, botName: string): Promise<void> {
    const key = buildSessionKey(callback.platform, callback.chatId, botName, callback.threadId);
    const ensureReady = captureReadiness(key);
    const message = { ...callback, text: '' };
    const scope = resolveExecutionScope(config.bots[botName], message);
    const record = store.getProvenance(botName, id);
    if (!record || !contains(scope.workingDirectory, record.scope)) throw new Error('Isolation session unavailable');
    const opts = await prepareIsolation(botName, message, key, record.scope);
    ensureReady();
    await isolation.assert(key, id);
    ensureReady();
    if (agentManager.isSessionInUse(config.bots[botName].agent, id, key)) throw new Error('Session is already in use');
    agentManager.forgetSession(key);
    const session = await store.getOrCreate(key, { agentName: config.bots[botName].agent, workingDirectory: record.scope });
    ensureReady();
    await agentManager.resumeAgent(key, config.bots[botName].agent, id, opts, createEventHandlers(key));
    ensureReady();
    await store.updateWorkingDirectory(session.id, record.scope);
    await store.updateAgentSessionId(session.id, id);
    await store.updateState(session.id, 'active');
  }

  function memoryContext(botName: string, message: InboundMessage): MemoryCommandContext | undefined {
    const bot = config.bots[botName];
    if (bot.memory !== true && !bot.isolation?.enabled) return undefined;
    const command = parseBridgeCommand(message.text)?.command;
    // Diagnostic and stop controls must remain usable even when a memory file is damaged.
    if (command && !['remember', 'memory', 'forget', 'new', 'cwd', 'projects', 'task', 'resume', 'switch', 'handoff', 'model'].includes(command)) return undefined;
    const telegramIds = new Map<string, string>();
    for (const [name, adapter] of adapters) if (adapter.appKey) telegramIds.set(name, adapter.appKey);
    const { identity, people } = resolveRuntimeMemoryIdentity(botName, botIdentities, config.memory?.people, telegramIds, message);
    return { store: memoryStore, people, identity,
      revoke: principal => memorySessions.revoke(principal),
    };
  }

  function captureReadiness(key: SessionKey): () => void {
    const check = preparation.capture(key);
    return () => {
      check();
      if (!lifecycle.status(key.split(':')[2]).acceptsMessages) throw new QueueCancelledError();
      assertNetworkReady();
    };
  }

  function startTyping(chatId: string, adapter: PlatformAdapter): void {
    stopTyping(chatId);
    if (!adapter.sendTypingIndicator) return;
    adapter.sendTypingIndicator(chatId).catch(() => {});
    typingTimers.set(chatId, setInterval(() => {
      adapter.sendTypingIndicator!(chatId).catch(() => {});
    }, 4000));
  }

  function stopTyping(chatId: string): void {
    const timer = typingTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      typingTimers.delete(chatId);
    }
  }

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const plugin = createStaticAgentPlugin(name, agentConfig);
    if (plugin) agentManager.registerPlugin(plugin);
  }

  for (const [botName, botConfig] of Object.entries(config.bots)) {
    if (botConfig.platform === 'feishu' && botConfig.feishu) {
      const adapter = new FeishuAdapter({
        appId: botConfig.feishu.appId,
        appSecret: botConfig.feishu.appSecret,
        botName,
      });
      adapters.set(botName, adapter);

      const cardController = new StreamingCardController(adapter, {
        intervalMs: config.streaming.intervalMs,
        minDeltaChars: config.streaming.minDeltaChars,
        interactiveStop: true,
      });
      cardControllers.set(botName, cardController);
    } else if (botConfig.platform === 'telegram' && botConfig.telegram) {
      const adapter = new TelegramAdapter({
        token: botConfig.telegram.token,
        botName,
      });
      adapters.set(botName, adapter);
      telegramStreams.set(
        botName,
        new TelegramStreamController(
          adapter,
          Math.max(1000, config.streaming.intervalMs || 1200),
          key => routes.get(key) ?? {},
        ),
      );
    }
  }

  const codexNotificationConfig = config.notifications?.codex;
  if (codexNotificationConfig?.enabled === true) {
    const notificationBot = config.bots[codexNotificationConfig.botName];
    const codexDir = join(homedir(), '.codex');
    notificationService = new CodexNotificationService({
      botName: codexNotificationConfig.botName,
      workingDirectory: notificationBot.workingDirectory,
      sessionsDir: join(codexDir, 'sessions'),
      sessionIndexPath: join(codexDir, 'session_index.jsonl'),
      socketPath: join(homedir(), '.cli2im', 'codex-notify.sock'),
      completionSource: codexNotificationConfig.completionSource,
      store,
      resolveAdapter: (botName) => adapters.get(botName),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
  }

  const pipeline = new InboundPipeline(config);

  async function collectOtherProtectedRoots(currentBotName: string): Promise<string[]> {
    const configuredRoots = Object.entries(config.bots)
      .filter(([name]) => name !== currentBotName)
      .map(([, bot]) => bot.workingDirectory);
    const sessionRoots = (await Promise.all(
      Object.keys(config.bots)
        .filter((name) => name !== currentBotName)
        .map((name) => store.listByBot(name)),
    )).flat().map((session) => session.workingDirectory);
    return [...configuredRoots, ...sessionRoots];
  }

  function findBotNameForConfig(target: BotConfig): string | undefined {
    return Object.entries(config.bots).find(([, bot]) => bot === target)?.[0];
  }

  const handoffService = new HandoffService({
    isIsolatedBot: name => config.bots[name]?.isolation?.enabled === true,
    spawnResume: createHandoffSpawnResume(
      agentManager,
      store,
      createEventHandlers,
      (botName) => config.bots[botName],
      async (params) => {
        const resolvedBotName = findBotNameForConfig(params.botConfig);
        return resolveBotSpawnOpts({
          ...params,
          env: { ...config.agents[params.botConfig.agent]?.env, ...params.botConfig.env,
            ...(params.botConfig.larkCliConfigDir ? { LARKSUITE_CLI_CONFIG_DIR: params.botConfig.larkCliConfigDir } : {}),
            ...params.env },
          model: params.model ?? config.agents[params.botConfig.agent]?.defaultModel,
          reasoningEffort: params.reasoningEffort ?? config.agents[params.botConfig.agent]?.defaultEffort,
          sandboxExtraRoots: config.sandboxExtraRoots,
          otherProtectedRoots: resolvedBotName ? await collectOtherProtectedRoots(resolvedBotName) : [],
        });
      },
      key => {
        const sender = senders.get(key);
        return sender ? buildSenderEnv({ channel: sender.platform, userId: sender.userId, userName: sender.userName, chatId: sender.chatId, chatType: sender.chatType }) : {};
      },
      captureReadiness,
    ),
    getSession: async (sessionKey) => store.getByKey(sessionKey),
    updateState: async (id, state) => store.updateState(id, state),
    getAgentCapabilities: (agentName) => agentManager.getPlugin(agentName)?.capabilities,
    getBotAgent: (botName) => config.bots[botName]?.agent,
    getBotPlatform: (botName) => config.bots[botName]?.platform,
    isSessionBusy: (agentName, id, key) => agentManager.isSessionInUse(agentName, id, key),
  });

  function createEventHandlers(sessionKey: SessionKey): AgentManagerEvents {
    const botName = sessionKey.split(':')[2];
    const chatId = sessionKey.split(':')[1];
    const cardController = cardControllers.get(botName);
    const tgStream = telegramStreams.get(botName);
    const rawAdapter = adapters.get(botName);
    const adapter = rawAdapter && bindReplyRoute(rawAdapter, routes.get(sessionKey) ?? {});
    const voiceResponseBuffer = { value: '' };

    return {
      onEvent: createRuntimeEventHandler({
        ...(config.bots[botName]?.isolation?.enabled ? {
          onSessionId: isolation.captureRecorder(sessionKey),
          readOutbound: async (file: import('./types.js').FilePayload, signal: AbortSignal) => {
            await isolation.assert(sessionKey);
            const policy = isolation.policy(sessionKey);
            if (!policy) throw new Error('Isolation outbound policy unavailable');
            return { ...file, data: await sandboxReadFile(file.path, policy, { signal }) };
          },
        } : {}),
        onTerminal: async (state, text, context) => {
          const process = agentManager.getProcess(sessionKey);
          if (process) memoryInjector.terminal(process, state);
          const completion = busyTasks.finish(sessionKey, context.signal);
          // Claim completion before any disk wait. A later turn keeps its running state.
          const saved = recovery.save(sessionKey, { status: state === 'completed' ? 'completed' : 'error', text })
            .catch(() => console.error('[recovery] result_save_failed'));
          await store.updatePreferences(sessionKey, { taskState: completion.remaining ? 'running' : state, taskUpdatedAt: Date.now() }, completion.isCurrent);
          await saved;
        },
        sessionKey,
        store,
        voiceSessions,
        cardController,
        tgStream,
        adapter,
        voiceResponseBuffer,
        stopTyping,
        sendVoiceReply,
        relayDeps: {
          relayManager,
          config,
          agentManager,
          adapters,
          messageProcessors,
          queue,
        },
      }),
      onToolBlocked: async (_sk, command, requestId) => {
        if (adapter) {
          const content = buildPermissionBlockedCard(command, requestId);
          await adapter.send(chatId, {
            card: {
              type: 'permission',
              title: '权限审批',
              content,
              buttons: [
                { text: '允许一次', value: `perm:allow:${requestId}`, type: 'primary' },
                { text: '允许这次', value: `perm:allow_session:${requestId}`, type: 'primary' },
                { text: '拒绝', value: `perm:deny:${requestId}`, type: 'danger' },
              ],
            },
          });
        }
      },
      onPermissionTimeout: async () => {
        if (adapter) {
          await adapter.send(chatId, { text: '危险操作已超时自动拒绝' });
        }
      },
      onQuestion: async (_sk, requestId, questions) => {
        if (!adapter) {
          agentManager.answerQuestion(sessionKey, requestId, {});
          return;
        }
        const pending = questionBoard.open(sessionKey, requestId, questions);
        try {
          pending.messageId = await adapter.send(chatId, { card: buildQuestionCard(pending) });
        } catch (err) {
          questionBoard.close(sessionKey, requestId);
          agentManager.answerQuestion(sessionKey, requestId, {});
          throw err;
        }
      },
      onQuestionTimeout: async (_sk, requestId) => {
        if (questionBoard.close(sessionKey, requestId) && adapter) {
          await adapter.send(chatId, { text: '提问 30 分钟无人回答，已按未回答继续。' });
        }
      },
      onProcessExit: createRuntimeProcessExitHandler({
        onExit: async context => {
          const cancellation = busyTasks.cancel(sessionKey, context.signal);
          if (cancellation.remaining) return false;
          if ((await store.getPreferences(sessionKey)).taskState === 'running')
            await store.updatePreferences(sessionKey, { taskState: 'interrupted', taskUpdatedAt: Date.now() }, cancellation.isCurrent);
          return cancellation.isCurrent();
        },
        sessionKey,
        store,
        stopTyping,
        voiceSessions,
        cardController,
        tgStream,
        adapter,
        voiceResponseBuffer,
        sendVoiceReply,
        getCurrentContext: (key) => agentManager.getCurrentContext(key),
      }),
    };
  }

  for (const [botName, adapter] of adapters) {
    const botConfig = config.bots[botName];
    const reportFailure = (error: unknown, key: string, msg: InboundMessage) => reportMessageFailure(error, key as SessionKey, msg, {
      busyTasks, store, adapter: bindReplyRoute(adapter, routes.get(key as SessionKey) ?? {}),
    });
    const processMessage = withMessageFailureCleanup(botName, createMessageProcessor(botName, botConfig, adapter), reportFailure);
    messageProcessors.set(botName, processMessage);
    const batcher = new MessageBatcher(queue, { delayMs: botConfig.debounceMs ?? 800, forgetIsControl: botConfig.memory === true });
    batchers.set(botName, batcher);
    const admit = async (msg: InboundMessage, isCallback = false) => {
      if (!lifecycle.status(botName).acceptsMessages) return;
      if (getBotAccessRejection(msg, botConfig)
        || getGroupMessageSkipReason(msg, botConfig, getAdapterBotOpenId(adapter))) return;
      const key = buildSessionKey(msg.platform, msg.chatId, botName, msg.threadId);
      try {
        if (!isCallback && !await recovery.acceptIncoming(msg.platform, botName, msg.messageId ? `${msg.chatId}:${msg.messageId}` : '')) return;
        if (!lifecycle.status(botName).acceptsMessages) return;
        const parsedCmd = parseBridgeCommand(msg.text);
        if (['stop', 'kill'].includes(parsedCmd?.command ?? '')) {
          preparation.cancel(key);
          busyTasks.cancel(key);
          pendingQueuedMsgs.delete(key);
          queueNoticeIds.delete(key);
        }
        const memory = memoryContext(botName, msg);
        if (memory) {
          if (['remember', 'memory', 'forget'].includes(parsedCmd?.command ?? '')) memorySessions.track(key, memory.identity.principal);
          else if (await memorySessions.bind(key, memory.identity.principal) && !parsedCmd) {
            await bindReplyRoute(adapter, msg.threadId ? { threadId: msg.threadId, replyToMessageId: msg.messageId } : {}).send(msg.chatId,
              { text: '原会话身份或记忆代次已变化，已开始新会话。旧记录仍保留。' });
          }
        }
        if (
          !isCallback
          && !msg.isRelay
          && !parsedCmd
          && config.newMessageBehavior !== 'interrupt'
          && busyTasks.has(key)
          && !questionBoard.get(key)
        ) {
          const list = pendingQueuedMsgs.get(key) ?? [];
          list.push(msg);
          pendingQueuedMsgs.set(key, list);
          const pendingCount = queue.status(key).pending + list.length;
          const noticeRoute = bindReplyRoute(
            adapter,
            msg.threadId ? { threadId: msg.threadId, replyToMessageId: msg.messageId } : {},
          );
          void noticeRoute.send(msg.chatId, {
            card: buildQueueNoticeCard(pendingCount, msg.text),
          }).then((noticeId) => {
            if (noticeId) queueNoticeIds.set(key, noticeId);
          }).catch(() => {});
        }
        await batcher.enqueue(key, msg, processMessage);
      }
      catch (error) {
        if (error instanceof QueueCancelledError) return;
        await reportFailure(error, key, msg);
      }
    };
    adapter.onMessage(msg => { void admit(msg); });

    const callbackHandler = createCallbackHandler({
      botName, botConfig, adapter, store, agentManager, handoffService, queue, capturePreparation: captureReadiness,
      resumeIsolated: (callback, id) => resumeIsolated(callback, id, botName),
      cardController: cardControllers.get(botName), tgStreamController: telegramStreams.get(botName),
      handleControl: async (callback, text) => admit({
        platform: callback.platform, chatId: callback.chatId, userId: callback.userId,
        chatType: callback.chatType, messageId: callback.messageId, threadId: callback.threadId,
        text, mentions: getAdapterBotOpenId(adapter) ? [getAdapterBotOpenId(adapter)!] : [],
      }, true),
      steerCancelQueue: async (callback) => {
        const key = buildSessionKey(callback.platform, callback.chatId, botName, callback.threadId);
        const batchCancelled = batcher.cancel(key);
        const queueCancelled = queue.cancelPending(key);
        const hadQueued = pendingQueuedMsgs.has(key);
        pendingQueuedMsgs.delete(key);
        const noticeId = queueNoticeIds.get(key);
        queueNoticeIds.delete(key);
        const route = bindReplyRoute(
          adapter,
          callback.threadId ? { threadId: callback.threadId, replyToMessageId: callback.messageId } : {},
        );
        const content = batchCancelled > 0 || queueCancelled > 0 || hadQueued
          ? '已取消待执行的排队消息。'
          : '当前没有待取消的排队消息。';
        if (noticeId && adapter.replaceCard) {
          await adapter.replaceCard(noticeId, {
            type: 'final',
            title: '排队已取消',
            content,
          }).catch(() => {});
        } else {
          await route.send(callback.chatId, { text: content, plainText: true });
        }
      },
      steerInterrupt: async (callback) => {
        const key = buildSessionKey(callback.platform, callback.chatId, botName, callback.threadId);
        const mergedQueued = popMergedQueuedMessage(key);
        const noticeId = queueNoticeIds.get(key);
        queueNoticeIds.delete(key);
        preparation.cancel(key);
        batcher.cancel(key);
        queue.cancelPending(key);
        busyTasks.cancel(key);
        await queue.control(key, async () => {
          agentManager.cancelAgent(key);
          cardControllers.get(botName)?.interruptCard(key);
          clearSessionScopedBuffers(key, {
            voiceSessions,
            tgStreamController: telegramStreams.get(botName),
          });
          if ((await store.getPreferences(key)).taskState === 'running') {
            await store.updatePreferences(key, { taskState: 'interrupted', taskUpdatedAt: Date.now() });
          }
        });
        const route = bindReplyRoute(
          adapter,
          callback.threadId ? { threadId: callback.threadId, replyToMessageId: callback.messageId } : {},
        );
        if (noticeId && adapter.replaceCard) {
          await adapter.replaceCard(noticeId, {
            type: 'final',
            title: '⚡ 已中断并插队执行',
            headerTemplate: 'green',
            content: mergedQueued ? '已中断当前任务，正在立即执行该消息。' : '已发送中断信号。',
          }).catch(() => {});
        } else {
          await route.send(callback.chatId, {
            text: mergedQueued ? '已中断当前任务，正在立即执行该消息。' : '已发送中断信号。',
            plainText: true,
          });
        }
        if (mergedQueued) {
          void queue.enqueue(key, () => processMessage(mergedQueued)).catch((error) => {
            if (error instanceof QueueCancelledError) return;
            return reportFailure(error, key, mergedQueued);
          });
        }
      },
    });
    adapter.onCallback?.(callback => {
      if (!lifecycle.status(botName).acceptsMessages || !isCallbackAuthorized(callback, botConfig)) return;
      const scope = cardScopes.get(`${botName}:${callback.chatId}:${callback.messageId}`);
      if (scope) {
        if (callback.threadId && callback.threadId !== scope.threadId) return;
        callback.threadId = scope.threadId;
      }
      const key = buildSessionKey(callback.platform, callback.chatId, botName, callback.threadId);
      const question = parseQuestionCallbackData(callback.data);
      if (question) {
        void handleQuestionCallback(key, bindReplyRoute(adapter, routes.get(key) ?? {}), callback.chatId, question)
          .catch(() => console.error('[pipeline] question_callback_failed'));
        return;
      }
      senders.set(key, { platform: callback.platform, chatId: callback.chatId, userId: callback.userId, chatType: callback.chatType, messageId: callback.messageId, threadId: callback.threadId, text: '' });
      routes.set(key, callback.threadId ? { threadId: callback.threadId, replyToMessageId: callback.messageId } : {});
      if ((botConfig.memory || botConfig.isolation?.enabled) && parseSessionResumeCallback(callback.data)) {
        const ensureReady = captureReadiness(key);
        void (async () => {
          const memory = memoryContext(botName, senders.get(key)!);
          if (memory) await memorySessions.bind(key, memory.identity.principal);
          ensureReady();
          callbackHandler(callback);
        })().catch(() => console.error('[pipeline] memory_resume_preparation_failed'));
      } else callbackHandler(callback);
    });
    lifecycle.register(botName, {
      start: async () => {
        assertNetworkReady();
        await adapter.connect();
        const telegramIds = new Map<string, string>();
        for (const [name, connected] of adapters) if (connected.appKey) telegramIds.set(name, connected.appKey);
        resolvePeople(config.memory?.people, botIdentities, telegramIds);
      },
      stop: async () => {
        preparation.cancelBot(botName);
        for (const key of queue.keys()) if (key.split(':')[2] === botName) queue.cancelPending(key);
        for (const key of busyTasks.keys()) if (key.split(':')[2] === botName) busyTasks.cancel(key);
        for (const key of batcher.keys()) batcher.cancel(key);
        for (const session of await store.listByBot(botName)) {
          queue.cancelPending(session.key);
          agentManager.cancelAgent(session.key);
          cardControllers.get(botName)?.interruptCard(session.key);
          clearSessionScopedBuffers(session.key, { voiceSessions, tgStreamController: telegramStreams.get(botName) });
          if ((await store.getPreferences(session.key)).taskState === 'running') {
            await store.updatePreferences(session.key, { taskState: 'interrupted', taskUpdatedAt: Date.now() });
          }
        }
        await adapter.disconnect();
      },
    }, { enabled: botConfig.enabled !== false });
  }

  function createMessageProcessor(
    botName: string,
    botConfig: BotConfig,
    baseAdapter: PlatformAdapter,
  ): (msg: InboundMessage) => Promise<void> {
    return async (msg) => {
      const scopedKey = buildSessionKey(msg.platform, msg.chatId, botName, msg.threadId);
      if (!lifecycle.status(botName).acceptsMessages) throw new QueueCancelledError();
      if (!msg.isRelay && !parseBridgeCommand(msg.text)) {
        const queued = pendingQueuedMsgs.get(scopedKey);
        if (queued?.length) {
          if (queue.status(scopedKey).pending === 0) {
            pendingQueuedMsgs.delete(scopedKey);
            queueNoticeIds.delete(scopedKey);
          } else {
            const remaining = queued.filter((item) => item !== msg && item.messageId !== msg.messageId);
            if (remaining.length > 0) pendingQueuedMsgs.set(scopedKey, remaining);
            else {
              pendingQueuedMsgs.delete(scopedKey);
              queueNoticeIds.delete(scopedKey);
            }
          }
        }
      }
      senders.set(scopedKey, msg);
      routes.set(scopedKey, msg.threadId ? { threadId: msg.threadId, replyToMessageId: msg.messageId } : {});
      const adapter = bindReplyRoute(baseAdapter, routes.get(scopedKey) ?? {}, messageId => {
        cardScopes.set(`${botName}:${msg.chatId}:${messageId}`, { threadId: msg.threadId });
        if (cardScopes.size > 5000) cardScopes.delete(cardScopes.keys().next().value!);
      });
      // Lazy relay registration on first group message
      if (msg.chatType === 'group' && botConfig.relay?.enabled) {
        relayManager.registerBot(botName, msg.chatId, botConfig.relay.maxConsecutiveRounds ?? 10);
      }

      // Reset relay counter on human messages
      if (!msg.isRelay) {
        relayManager.onHumanMessage(msg.chatId);
      }

      const relayBotCount = relayManager.getBotsInChat(msg.chatId).length;
      const botOpenId = getAdapterBotOpenId(adapter);
      logInboundMessageSummary(botName, msg, relayBotCount, Boolean(botOpenId));
      const groupSkipReason = getGroupMessageSkipReason(
        msg,
        botConfig,
        botOpenId,
        relayBotCount,
      );
      if (groupSkipReason) {
        console.log(`[pipeline] ${scrubLog(botName)}: Rejected: ${scrubLog(groupSkipReason)}`);
        return;
      }

      const ctx = pipeline.process(msg, botName);
      if ('rejected' in ctx) {
        console.log(`[pipeline] Rejected: ${ctx.reason}`);
        return;
      }

      const memory = memoryContext(botName, msg);
      if (memory) {
        if (['remember', 'memory', 'forget'].includes(ctx.bridgeCommand?.command ?? '')) memorySessions.track(ctx.sessionKey, memory.identity.principal);
        else if (await memorySessions.bind(ctx.sessionKey, memory.identity.principal) && !ctx.bridgeCommand) {
          await adapter.send(msg.chatId, { text: '原会话身份或记忆代次已变化，已开始新会话。旧记录仍保留。' });
        }
      }
      if (ctx.bridgeCommand) {
        if (['stop', 'kill'].includes(ctx.bridgeCommand.command)) {
          preparation.cancel(scopedKey);
          busyTasks.cancel(scopedKey);
        }
        await handleBridgeCommand(
          ctx.bridgeCommand,
          ctx.sessionKey,
          botName,
          msg.chatId,
          adapter,
          store,
          agentManager,
          handoffService,
          cardControllers.get(botName),
          telegramStreams.get(botName),
          voiceSessions,
          runtimeState,
          botConfig,
          {
            platform: msg.platform,
            chatType: msg.chatType,
            userId: msg.userId,
            threadId: msg.threadId,
            messageId: msg.messageId,
          },
          notificationService,
          { defaultModel: config.agents[botConfig.agent]?.defaultModel, defaultEffort: config.agents[botConfig.agent]?.defaultEffort, queue, lifecycle, memory,
            resumeIsolated: (callback, id) => resumeIsolated(callback, id, botName),
            isolatedSessions: async () => {
              const cwd = (await store.getByKey(ctx.sessionKey))?.workingDirectory ?? resolveExecutionScope(botConfig, msg).workingDirectory;
              const opts = await prepareIsolation(botName, msg, ctx.sessionKey, cwd, false, true);
              const ids = new Map<string, string>();
              for (const [name, connected] of adapters) if (connected.appKey) ids.set(name, connected.appKey);
              const { identity } = resolveRuntimeMemoryIdentity(botName, botIdentities, config.memory?.people, ids, msg);
              return isolation.listDomain({ bot: botName, principal: identity.principal, scope: cwd, policyFingerprint: opts.isolation!.fingerprint });
            },
            runPrompt: prompt => processMessagePrompt(botName, msg, prompt),
            doctor: diagnose, controlBot, reloadConfig: reloadRuntimeConfig, readResult: key => recovery.read(key),
            capturePreparation: captureReadiness,
            cancelScope: key => { preparation.cancel(key); busyTasks.cancel(key); },
          },
        );
        return;
      }

      // A text reply while Claude waits on AskUserQuestion is the answer, not a new prompt.
      const pendingQuestion = !msg.isRelay && msg.text ? questionBoard.get(ctx.sessionKey) : undefined;
      if (pendingQuestion) {
        if (agentManager.hasPendingQuestion(ctx.sessionKey, pendingQuestion.requestId)) {
          await submitQuestion(ctx.sessionKey, adapter, msg.chatId, answersFromText(pendingQuestion, msg.text));
          return;
        }
        questionBoard.close(ctx.sessionKey, pendingQuestion.requestId);
      }

      assertNetworkReady();
      const sessionKey = ctx.sessionKey;
      const checkPreparation = preparation.capture(sessionKey);
      const ensureReady = () => {
        checkPreparation();
        if (!lifecycle.status(botName).acceptsMessages) throw new QueueCancelledError();
        assertNetworkReady();
      };
      const session = await ensureExecutionSession({
        bot: botConfig, message: msg, key: sessionKey, store,
        reset: key => {
          agentManager.forgetSession(key);
          clearSessionScopedBuffers(key, { voiceSessions, tgStreamController: telegramStreams.get(botName) });
        },
      });

      ensureReady();
      const isolatedOpts = botConfig.isolation?.enabled
        ? await prepareIsolation(botName, msg, sessionKey, session.workingDirectory) : undefined;
      if (isolatedOpts) await reconcileIsolatedSession({ runtime: isolation, manager: agentManager, store, session, key: sessionKey,
        notify: () => adapter.send(msg.chatId, { text: '原会话不符合当前隔离范围或已被撤销，已开始新会话。旧记录仍保留。' }) });
      ensureReady();
      const previousTask = await store.getPreferences(sessionKey);
      if (previousTask.taskState === 'interrupted') {
        await adapter.send(msg.chatId, { text: '上次任务在中途停止，没有自动重跑。这条新消息会继续当前对话。' });
      }
      ensureReady();
      let shouldStartNewProcess = false;
      if (config.newMessageBehavior === 'interrupt' && agentManager.hasProcess(sessionKey)) {
        busyTasks.cancel(sessionKey);
        agentManager.cancelAgent(sessionKey);
        shouldStartNewProcess = true;
        cardControllers.get(botName)?.interruptCard(sessionKey);
        telegramStreams.get(botName)?.interrupt(sessionKey);
      }
      const task = busyTasks.begin(sessionKey);
      await store.updatePreferences(sessionKey, { taskState: 'running', taskUpdatedAt: Date.now() });
      await store.touch(session.id);
      ensureReady();

      const sender: import('./types.js').SenderInfo = msg.isRelay
        ? {
            channel: 'relay',
            userId: msg.userId,
            botName: msg.userId.replace('relay:', ''),
            userName: msg.userName,
            chatId: msg.chatId,
            chatType: msg.chatType,
          }
        : {
            channel: msg.platform,
            userId: msg.userId,
            userName: msg.userName,
            chatId: msg.chatId,
            chatType: msg.chatType,
          };
      const senderHeader = buildSenderHeader(sender);
      await downloadInboundAttachments(msg, adapter, join(expandHome(session.workingDirectory), 'inbox'), isolatedOpts?.isolation);

      ensureReady();
      let pendingVoiceChatId: string | undefined;
      if (msg.isVoice && botConfig.speech?.stt !== false) {
        const audioAttachment = msg.attachments?.find(a => a.type === 'audio' && a.localPath);
        if (audioAttachment?.localPath) {
          const audioBuffer = await readFile(audioAttachment.localPath);
          const format = audioAttachment.mimeType?.includes('ogg') ? 'ogg' : 'mp3';
          ensureReady();
          const transcript = await transcribeAudio(audioBuffer, format);
          ensureReady();
          if (transcript) {
            msg.text = sanitizeVoiceTranscript(transcript);
            msg.attachments = msg.attachments?.filter(a => a !== audioAttachment);
            if (botConfig.speech?.tts !== false) pendingVoiceChatId = msg.chatId;
            console.log(`[voice] stt=success textLength=${msg.text.length}`);
          } else {
            console.warn('[voice] stt=failed fallback=attachment');
          }
        }
      }

      ensureReady();
      const safeQuoted = msg.quotedText ? scanUntrustedExternalText('quoted_message', msg.quotedText) : '';
      const quote = safeQuoted ? `[引用的消息]\n${safeQuoted}\n[/引用的消息]\n\n` : '';
      // Claude Code only dispatches slash commands and skills that start the prompt.
      const messageText = botConfig.agent === 'claude-code' && msg.text.startsWith('/')
        ? `${msg.text}\n\n${quote}${senderHeader.trimEnd()}`
        : senderHeader + quote + msg.text;
      if (isolatedOpts) isolatedOpts.initialPrompt = messageText;
      const userMessage = await buildUserMessageForAgent(
        botConfig.agent,
        messageText,
        msg.attachments,
      );

      ensureReady();
      const cardController = cardControllers.get(botName);
      if (!cardController && adapter) {
        startTyping(msg.chatId, adapter);
      }
      const isNewProcess = shouldStartNewProcess || !agentManager.hasProcess(sessionKey);
      await cardController?.startCard(
        msg.chatId,
        sessionKey,
        botConfig.agent,
        isNewProcess ? '正在开始…' : undefined,
        routes.get(sessionKey),
      );

      ensureReady();
      // Card setup may outlive the old process, just like attachment preparation.
      if (shouldStartNewProcess || !agentManager.hasProcess(sessionKey)) {
        console.log(`[pipeline] ${scrubLog(botName)}: agent=${scrubLog(botConfig.agent)} action=spawn`);
        const handlers = createEventHandlers(sessionKey);

        const senderEnv = buildSenderEnv(sender);
        const larkCliEnv: Record<string, string> = botConfig.larkCliConfigDir
          ? { LARKSUITE_CLI_CONFIG_DIR: botConfig.larkCliConfigDir }
          : {};
        const spawnEnv = { ...config.agents[botConfig.agent]?.env, ...botConfig.env, ...senderEnv, ...larkCliEnv };

        const sessionPrefs = await store.getPreferences(sessionKey);
        const spawnOpts = isolatedOpts ?? await resolveBotSpawnOpts({
          botConfig,
          workingDirectory: session.workingDirectory,
          env: spawnEnv,
          model: sessionPrefs.model ?? config.agents[botConfig.agent]?.defaultModel,
          autoApprove: botConfig.autoApprove,
          turnTimeoutMs: botConfig.turnTimeoutMs,
          idleTimeoutMs: botConfig.idleTimeoutMs,
          sandboxMode: botConfig.sandboxMode,
          reasoningEffort: runtimeState.fastModeBySession.get(sessionKey)
            ? 'low'
            : (sessionPrefs.effort ?? config.agents[botConfig.agent]?.defaultEffort),
          initialPrompt: messageText,
        });

        ensureReady();
        const plugin = agentManager.getPlugin(botConfig.agent);
        const latestId = agentManager.getLatestSessionId(sessionKey) ?? session.agentSessionId;
        if (latestId && plugin?.capabilities.sessionResume) {
          console.log(`[pipeline] ${scrubLog(botName)}: agent=${scrubLog(botConfig.agent)} action=resume`);
        } else {
          console.log(`[pipeline] ${scrubLog(botName)}: agent=${scrubLog(botConfig.agent)} action=fresh_spawn`);
        }
        await startAgentProcessForSession({
          agentManager,
          store,
          session,
          sessionKey,
          agentName: botConfig.agent,
          spawnOpts,
          handlers,
          ensureReady,
        });
      }

      ensureReady();
      if (pendingVoiceChatId) {
        commitVoiceSessionWhenContextReady(sessionKey, pendingVoiceChatId, {
          voiceSessions,
          hasProcess: (key) => agentManager.hasProcess(key),
          getContextSignal: (key) => agentManager.getContextSignal(key),
        });
      }
      if (isolatedOpts) await isolation.assert(sessionKey);
      const memoryDocument = memory && botConfig.memory === true ? await memoryStore.read(memory.identity.principal) : undefined;
      ensureReady();
      const memoryProcess = agentManager.getProcess(sessionKey);
      const preparedMemory = memoryDocument && memoryProcess
        ? memoryInjector.prepare(memoryProcess, memoryDocument, userMessage, agentManager.getContextSignal(sessionKey))
        : undefined;
      let delivered = false;
      try {
        delivered = await sendAgentMessageOrNotify({
          agentManager,
          adapter,
          chatId: msg.chatId,
          sessionKey,
          agentName: botConfig.agent,
          message: preparedMemory?.message ?? userMessage,
          onDelivered: () => {
            const signal = agentManager.getContextSignal(sessionKey);
            if (signal) task.dispatch(signal);
          },
        });
      } finally {
        if (!delivered) preparedMemory?.cancel();
      }
      if (!delivered) {
        busyTasks.cancel(sessionKey);
        await store.updatePreferences(sessionKey, { taskState: 'failed', taskUpdatedAt: Date.now() });
      }
    };
  }

  async function processMessagePrompt(botName: string, original: InboundMessage, prompt: string): Promise<void> {
    const processor = messageProcessors.get(botName);
    if (processor) await processor({ ...original, text: prompt });
  }

  async function controlBot(name: string, action: 'start' | 'stop' | 'restart' | 'reload'): Promise<void> {
    const botConfig = config.bots[name];
    if (!botConfig) throw new Error('Unknown bot');
    if (action === 'reload') {
      const agentConfig = config.agents[botConfig.agent];
      if (!agentConfig) throw new Error(`Unknown agent: ${botConfig.agent}`);
      await hotReloadAgentPlugin({
        agentManager,
        agentName: botConfig.agent,
        agentConfig,
      });
      const botSessions = await store.listByBot(name);
      for (const s of botSessions) {
        if (
          agentManager.hasProcess(s.key)
          && !busyTasks.has(s.key)
          && (await store.getPreferences(s.key)).taskState !== 'running'
        ) {
          agentManager.killAgent(s.key);
        }
      }
      console.log(`[cli2im] Reloaded plugin agent=${scrubLog(botConfig.agent)} via bot=${scrubLog(name)}`);
      return;
    }
    if (action !== 'stop') assertNetworkReady();
    if (action === 'restart') { await lifecycle.restart(name, 'cancel'); return; }
    const enabled = action === 'start';
    const update = configUpdate.catch(() => {}).then(() => saveBotEnabled(CONFIG_PATH, name, enabled));
    configUpdate = update;
    await update;
    botConfig.enabled = enabled;
    await lifecycle.setEnabled(name, enabled, 'cancel');
  }
  function isolationIdentityMapping() {
    const telegramIds = new Map<string, string>();
    for (const [name, adapter] of adapters) if (adapter.appKey) telegramIds.set(name, adapter.appKey);
    return [...resolvePeople(config.memory?.people, botIdentities, telegramIds).entries()].sort();
  }
  async function diagnose(options?: { online?: boolean }): Promise<string> {
    const network = networkPolicyStatus();
    const report = await runDoctor({ config, lifecycle: lifecycle.list(),
      getPlugin: name => agentManager.getPlugin(name),
      network: { state: network.ready ? 'ok' : 'error', detail: `${network.mode}; ${network.dns}` },
      contentGuard: contentGuardStatus(), speechKeyConfigured: Boolean(process.env.DASHSCOPE_STT_API_KEY || process.env.DASHSCOPE_API_KEY),
      activeTasks: busyTasks.size(),
    });
    const isolationReport = await runIsolationDoctor({ config, runtime: isolation, paths: policyPaths(config), identityMapping: isolationIdentityMapping(), force: true });
    let output = formatDoctorReport(report) + '\n\n' + formatIsolationReport(isolationReport) + '\n\n' + formatServiceInventory(report.services);
    if (options?.online) {
      const online = await runOnlineDoctorProbes(config);
      output += '\n\n' + formatOnlineDoctorSection(online);
    }
    return output;
  }

  async function buildDashboardHtml(): Promise<string> {
    const network = networkPolicyStatus();
    const watchTargets = await store.listWatchTargets();
    const bots = lifecycle.list().map((status) => {
      const bot = config.bots[status.name];
      const agent = bot ? config.agents[bot.agent] : undefined;
      return {
        name: status.name,
        platform: bot?.platform ?? 'feishu',
        agent: bot?.agent ?? 'unknown',
        model: agent?.defaultModel,
        effort: agent?.defaultEffort,
        state: status.state,
        acceptsMessages: status.acceptsMessages,
        error: status.error,
      };
    });
    return renderDashboardHtml({
      generatedAt: Date.now(),
      uptimeMs: Date.now() - startedAt,
      activeTasks: busyTasks.size(),
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      contentGuardStatus: contentGuardStatus(),
      contentGuardBackend: contentGuardBackend(),
      networkSummary: `${network.mode}; ${network.dns}`,
      watchTargets: watchTargets.length,
      bots,
    });
  }

  const httpServer = new HttpServer(config.server.token, {
    captureHandoffReadiness: req => {
      if (typeof req.botName !== 'string' || !config.bots[req.botName]) return () => {};
      const key = buildSessionKey(config.bots[req.botName].platform, typeof req.chatId === 'string' ? req.chatId : 'default', req.botName, typeof req.threadId === 'string' ? req.threadId : undefined);
      return captureReadiness(key);
    },
    acceptHandoff: (req, requestReady) => {
      if (!lifecycle.status(req.botName).acceptsMessages) return Promise.resolve({ success: false, error: 'Bot not running' });
      const platform = req.platform ?? config.bots[req.botName].platform;
      const key = buildSessionKey(platform, req.chatId ?? 'default', req.botName, req.threadId);
      if (req.threadId) {
        if (platform === 'feishu' && !routes.get(key)?.replyToMessageId) return Promise.resolve({ success: false, error: '请先在目标话题发送 /status，再接管' });
        if (platform === 'telegram') routes.set(key, { threadId: req.threadId });
      }
      return handoffService.acceptHandoff(req, { ensureReady: requestReady ?? captureReadiness(key) });
    },
    getBotStatus: () => lifecycle.list().map((status) => {
      const bot = config.bots[status.name];
      return {
        ...status,
        platform: bot?.platform,
        agent: bot?.agent,
      };
    }),
    controlBot,
    reloadConfig: reloadRuntimeConfig,
    doctor: diagnose,
    notify: (body) => deliverCliNotification(body, { config, store, adapters }),
    getDashboardHtml: buildDashboardHtml,
    releaseHandoff: (sessionKey) => handoffService.releaseHandoff(sessionKey as SessionKey),
    getStatus: () => ({
      uptime: Date.now() - startedAt,
      activeSessions: busyTasks.size(),
      bots: Object.keys(config.bots),
    }),
  }, {
    botNames: Object.keys(config.bots),
    agentNames: Object.keys(config.agents),
    botAgents: Object.fromEntries(Object.entries(config.bots).map(([name, bot]) => [name, bot.agent])),
    validateWorkDir: async (body) => {
      const botConfig = config.bots[body.botName];
      if (!botConfig) return false;
      try {
        await resolveBotSpawnOpts({
          botConfig,
          workingDirectory: body.workDir,
          sandboxExtraRoots: config.sandboxExtraRoots,
        });
        return true;
      } catch {
        return false;
      }
    },
  });

  await runIsolationDoctor({ config, runtime: isolation, paths: policyPaths(config), identityMapping: isolationIdentityMapping(), force: true });
  const stopIsolationMonitor = isolation.monitor();
  await httpServer.start(config.server.host, config.server.port);

  await Promise.allSettled([...adapters.entries()].map(async ([botName, adapter]) => {
    try {
      await lifecycle.start(botName);
      console.log(`[cli2im] Bot "${scrubLog(botName)}" state=${lifecycle.status(botName).state} platform=${scrubLog(adapter.name)}`);
    } catch {
      console.error(`[cli2im] Bot "${scrubLog(botName)}" connection_failed`);
    }
  }));

  await startNotificationServiceBeforeReady(notificationService);

  let networkChecking = false;
  let shuttingDown = false;
  const networkTimer = config.network ? setInterval(() => {
    if (networkChecking || shuttingDown) return;
    networkChecking = true;
    void (async () => {
      const state = await refreshNetworkPolicy(async () => { await lifecycle.stopAll('cancel'); });
      if (!state.ready || shuttingDown) { await lifecycle.stopAll('cancel'); return; }
      for (const bot of lifecycle.list()) {
        if (shuttingDown) return;
        if (config.bots[bot.name].enabled !== false && !bot.acceptsMessages) await lifecycle.start(bot.name).catch(() => {});
      }
    })().catch(() => console.error('[network] refresh_failed')).finally(() => { networkChecking = false; });
  }, 10000) : undefined;

  const logRotateTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      if (rotateLogFileIfNeeded(logPath)) console.log('[housekeeping] Rotated cli2im.log');
    } catch (err) {
      console.warn(`[housekeeping] log_rotate_failed reason=${scrubLog(err instanceof Error ? err.message : String(err))}`);
    }
  }, 3600_000);
  logRotateTimer.unref();

  const housekeepingTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      const prunedMedia = pruneStaleMediaFiles(mediaDir);
      const prunedDb = store.pruneStaleRecords({ pruneMissingCursorFiles: true });
      if (prunedMedia > 0 || prunedDb.deletedCursors + prunedDb.deletedDeliveries + prunedDb.deletedTasks > 0) {
        console.log(
          `[housekeeping] periodic media=${prunedMedia} cursors=${prunedDb.deletedCursors}`
          + ` deliveries=${prunedDb.deletedDeliveries} tasks=${prunedDb.deletedTasks}`,
        );
      }
    } catch (err) {
      console.warn(`[housekeeping] periodic_failed reason=${scrubLog(err instanceof Error ? err.message : String(err))}`);
    }
  }, 24 * 3600_000);
  housekeepingTimer.unref();

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(logRotateTimer);
    clearInterval(housekeepingTimer);
    if (networkTimer) clearInterval(networkTimer);
    stopIsolationMonitor();
    console.log('[cli2im] Shutting down...');
    await httpServer.stop();
    await notificationService?.stop();
    await agentManager.shutdownPlugins();
    await lifecycle.stopAll('cancel');
    store.flush();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  process.on('SIGHUP', () => {
    void reloadRuntimeConfig()
      .then((res) => console.log(`[config] Hot-reloaded via SIGHUP bots=${res.updatedBots.length} warnings=${res.warnings.length}`))
      .catch((err) => console.warn(`[config] Hot-reload failed: ${scrubLog(err instanceof Error ? err.message : String(err))}`));
  });
}

export async function startNotificationServiceBeforeReady(
  service: Pick<CodexNotificationService, 'start'> | undefined,
  reportReady: () => void = () => console.log('[cli2im] Ready'),
): Promise<void> {
  await service?.start();
  reportReady();
}

export function createCallbackHandler(params: {
  botName: string;
  botConfig: BotConfig;
  adapter: PlatformAdapter;
  store: Parameters<typeof handleCLISessionResume>[0]['store'];
  agentManager: Parameters<typeof handleCLISessionResume>[0]['agentManager']
    & Pick<AgentManager, 'approvePermission' | 'denyPermission'>;
  handoffService: Parameters<typeof handleCLISessionResume>[0]['handoffService'];
  queue: Pick<ChatQueue, 'enqueue'>;
  cardController?: StreamingCardController;
  tgStreamController?: TelegramStreamController;
  handleSessionResume?: typeof handleCLISessionResume;
  resumeIsolated?: Parameters<typeof handleCLISessionResume>[0]['resumeIsolated'];
  capturePreparation?: (key: SessionKey) => () => void;
  handleControl?: (callback: import('./types.js').CallbackQuery, text: string) => Promise<void>;
  steerInterrupt?: (callback: import('./types.js').CallbackQuery) => Promise<void>;
  steerCancelQueue?: (callback: import('./types.js').CallbackQuery) => Promise<void>;
}): (callback: import('./types.js').CallbackQuery) => void {
  const {
    botName,
    botConfig,
    adapter,
    store,
    agentManager,
    handoffService,
    queue,
    cardController,
    tgStreamController,
    handleSessionResume = handleCLISessionResume,
  } = params;

  return (callback) => {
    const steer = parseQueueSteerAction(callback.data);
    if (steer) {
      if (!isCallbackAuthorized(callback, botConfig)) return;
      const handler = steer === 'interrupt_now' ? params.steerInterrupt : params.steerCancelQueue;
      void handler?.(callback).catch(() => console.error('[pipeline] steer_failed'));
      return;
    }
    const modelOrEffort = parseModelOrEffortAction(callback.data);
    if (modelOrEffort) {
      if (!isCallbackAuthorized(callback, botConfig)) return;
      const cmdText = modelOrEffort.kind === 'model'
        ? `/model ${modelOrEffort.model}`
        : `/effort ${modelOrEffort.effort}`;
      void params.handleControl?.(callback, cmdText).catch(() => console.error('[pipeline] model_effort_failed'));
      return;
    }
    const control = parseControlAction(callback.data);
    const project = parseProjectAction(callback.data);
    if (control || project) {
      if (!isCallbackAuthorized(callback, botConfig)) return;
      void params.handleControl?.(callback, control ?? `/projects ${project}`).catch(() => console.error('[pipeline] control_failed'));
      return;
    }
    const permission = parsePermissionCallbackData(callback.data);
    if (permission) {
      if (!isCallbackAuthorized(callback, botConfig)) {
        void adapter.send(callback.chatId, { text: 'Unauthorized callback user' });
        return;
      }

      const accepted = handlePermissionCallback(callback, agentManager, botConfig, botName);
      if (accepted) return;
    }

    const resume = parseSessionResumeCallback(callback.data);
    if (resume) {
      if (!isCallbackAuthorized(callback, botConfig)) {
        void adapter.send(callback.chatId, { text: 'Unauthorized callback user' });
        return;
      }

      const callbackKey = buildSessionKey(callback.platform, callback.chatId, botName, callback.threadId);
      const ensureReady = params.capturePreparation?.(callbackKey);
      void queue.enqueue(callbackKey, () =>
        handleSessionResume({
          callback,
          resume,
          resumeIsolated: params.resumeIsolated,
          botName,
          botConfig,
          adapter: bindReplyRoute(adapter, callback.threadId ? { threadId: callback.threadId, replyToMessageId: callback.messageId } : {}),
          store,
          agentManager,
          handoffService,
          cardController,
          tgStreamController,
          ensureReady,
        })
      ).catch((err) => {
        console.error('[pipeline] callback=session_resume_failed');
        void adapter.send(callback.chatId, {
          text: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
      return;
    }

    console.log(
      `[pipeline] callback=ignored platform=${callbackPlatformCategory(callback.platform)}`
      + ` chat=${callbackChatCategory(callback.chatType)}`
      + ` data=${callback.data.length > 0 ? 'present' : 'absent'}`,
    );
  };
}

function callbackPlatformCategory(value: unknown): string {
  return value === 'feishu' || value === 'telegram' ? value : 'unknown';
}

function callbackChatCategory(value: unknown): string {
  return value === 'p2p' || value === 'group' || value === 'supergroup' || value === 'channel'
    ? value
    : 'unknown';
}

export async function sendAgentMessageOrNotify(params: {
  agentManager: Pick<AgentManager, 'sendMessage'>;
  adapter: PlatformAdapter;
  chatId: string;
  sessionKey: SessionKey;
  agentName: string;
  message: UserMessage;
  onDelivered?: () => void;
}): Promise<boolean> {
  const { agentManager, adapter, chatId, sessionKey, agentName, message } = params;
  const delivered = agentManager.sendMessage(sessionKey, agentName, message);
  if (delivered) {
    params.onDelivered?.();
    return true;
  }

  console.warn(
    `[pipeline] message_delivery=failed reason=session_transition agent=${scrubLog(agentName)}`,
  );
  await adapter.send(chatId, { text: '消息未送达（会话正在切换或重启），请重发' });
  return false;
}

export function createHandoffSpawnResume(
  agentManager: Pick<AgentManager, 'resumeAgent'> & Partial<Pick<AgentManager, 'killAgent'>>,
  store: Pick<
    SessionStore,
    'getOrCreate' | 'updateWorkingDirectory' | 'updateAgentSessionId' | 'updateState' | 'touch'
  >,
  createEventHandlers: (sessionKey: SessionKey) => AgentManagerEvents,
  getBotConfig?: (botName: string) => BotConfig | undefined,
  resolveSpawnOpts?: BotSpawnOptsResolver,
  resolveSenderEnv?: (key: SessionKey) => Record<string, string>,
  capturePreparation?: (key: SessionKey) => () => void,
): (
  sessionKey: SessionKey,
  agentName: string,
  sessionId: string,
  workDir: string,
  ensureReady?: () => void,
) => Promise<{ pid: number; sessionId: string }> {
  return async (sessionKey, agentName, sessionId, workDir, checkRequest) => {
    const localCheck = capturePreparation?.(sessionKey);
    const ensureReady = () => { checkRequest?.(); localCheck?.(); assertNetworkReady(); };
    ensureReady();
    const handlers = createEventHandlers(sessionKey);
    const botName = sessionKey.split(':')[2];
    const botConfig = getBotConfig?.(botName);
    assertNetworkReady();
    if (!botConfig) throw new Error('Unknown bot');
    if (botConfig.isolation?.enabled) throw new Error('隔离机器人禁用 handoff');
    const session = await store.getOrCreate(sessionKey, { agentName, workingDirectory: expandHome(workDir) });
    ensureReady();
    const prefs = 'getPreferences' in store ? await (store as SessionStore).getPreferences(sessionKey) : {};
    ensureReady();
    const spawnOpts = await (resolveSpawnOpts ?? resolveBotSpawnOpts)({
      botConfig, workingDirectory: workDir,
      env: { ...(botConfig.larkCliConfigDir ? { LARKSUITE_CLI_CONFIG_DIR: botConfig.larkCliConfigDir } : {}), ...resolveSenderEnv?.(sessionKey) },
      model: prefs.model,
      reasoningEffort: prefs.effort,
      autoApprove: botConfig.autoApprove, sandboxMode: botConfig.sandboxMode,
      turnTimeoutMs: botConfig.turnTimeoutMs, idleTimeoutMs: botConfig.idleTimeoutMs,
    });
    ensureReady();
    const proc = await agentManager.resumeAgent(
      sessionKey,
      agentName,
      sessionId,
      spawnOpts,
      handlers,
    );
    try {
      ensureReady();
      const normalizedWorkDir = expandHome(workDir);
      await store.updateWorkingDirectory(session.id, normalizedWorkDir);
      ensureReady();
      await store.updateAgentSessionId(session.id, sessionId);
      ensureReady();
      await store.updateState(session.id, 'active');
      ensureReady();
      await store.touch(session.id);
      ensureReady();
    } catch (error) {
      agentManager.killAgent?.(sessionKey, proc);
      throw error;
    }
    return { pid: proc.pid, sessionId };
  };
}

export async function startAgentProcessForSession(params: {
  agentManager: Pick<AgentManager, 'getPlugin' | 'getLatestSessionId' | 'resumeAgent' | 'spawnAgent'>;
  store: Pick<SessionStore, 'updateAgentSessionId'>;
  session: import('./types.js').Session;
  sessionKey: SessionKey;
  agentName: string;
  spawnOpts: SpawnOpts;
  handlers: AgentManagerEvents;
  ensureReady?: () => void;
}): Promise<void> {
  const {
    agentManager,
    store,
    session,
    sessionKey,
    agentName,
    spawnOpts,
    handlers,
  } = params;
  const plugin = agentManager.getPlugin(agentName);
  const latestId = agentManager.getLatestSessionId(sessionKey) ?? session.agentSessionId;

  if (latestId && plugin?.capabilities.sessionResume) {
    if (latestId !== session.agentSessionId) {
      await store.updateAgentSessionId(session.id, latestId);
    }
    params.ensureReady?.();
    await agentManager.resumeAgent(sessionKey, agentName, latestId, spawnOpts, handlers);
    return;
  }

  params.ensureReady?.();
  await agentManager.spawnAgent(sessionKey, agentName, spawnOpts, handlers);
}

function getAdapterBotOpenId(adapter: PlatformAdapter): string | undefined {
  const candidate = adapter as PlatformAdapter & { getBotOpenId?: () => string | undefined };
  return candidate.getBotOpenId?.();
}

function getSessionBotName(sessionKey: SessionKey): string | undefined {
  const parts = sessionKey.split(':');
  return parts[2];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[cli2im] Fatal error; inspect /doctor and configuration validity');
    process.exit(1);
  });
}
