import { loadRuntimeConfig } from './config/loader.js';
import { SessionStore } from './session/store.js';
import { CLISessionScanner } from './session/cli-scanner.js';
import { CodexSessionScanner } from './session/codex-scanner.js';
import { GeminiSessionScanner } from './session/gemini-scanner.js';
import { AntigravitySessionScanner } from './session/antigravity-scanner.js';
import { ChatQueue, MessageBatcher, QueueCancelledError } from './session/queue.js';
import { AgentManager, type AgentManagerEvents } from './agents/manager.js';
import { ToolGate } from './agents/tool-gate.js';
import { ClaudeCodePlugin } from './agents/claude-code.js';
import { CodexPlugin } from './agents/codex.js';
import { GeminiPlugin } from './agents/gemini.js';
import { AgyPlugin } from './agents/agy.js';
import { ZcodePlugin } from './agents/zcode.js';
import { KimiWorkPlugin } from './agents/kimi-work.js';
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
  buildHandoffReleaseNotification,
  buildCLISessionCard,
} from './platforms/feishu/markdown.js';
import { buildCLISessionText } from './platforms/telegram/markdown.js';
import { sanitizeVoiceTranscript } from './security/validators.js';
import {
  buildUserMessageForAgent,
  downloadInboundAttachments,
  expandHome,
} from './media.js';
import { initContentGuard, contentGuardStatus } from './security/content-guard.js';
import {
  handlePermissionCallback,
  isCallbackAuthorized,
  parsePermissionCallbackData,
  parseSessionResumeCallback,
} from './runtime/callbacks.js';
import { handleCLISessionResume, scanAgentSessions } from './runtime/session-resume.js';
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
import { join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { CodexNotificationService } from './notifications/service.js';
import { buildSessionKey } from './types.js';
import { canAccessSession, getBotAccessRejection, isBotAdmin } from './security/access-policy.js';
import { configureNetworkPolicy, refreshNetworkPolicy, assertNetworkReady, networkPolicyStatus } from './security/network-policy.js';
import { BotLifecycle } from './runtime/bot-lifecycle.js';
import { buildControlPanel, parseControlAction } from './runtime/control-panel.js';
import { ProjectRegistry, buildProjectPanel, parseProjectAction } from './runtime/projects.js';
import { bindReplyRoute, type ReplyRoute } from './runtime/reply-route.js';
import { RecoveryStore } from './runtime/result-recovery.js';
import { TaskTracker } from './runtime/task-tracker.js';
import { reportMessageFailure, withMessageFailureCleanup } from './runtime/message-failure.js';
import { MemoryStore } from './memory/store.js';
import { MemoryInjector } from './memory/inject.js';
import { MemorySessions } from './memory/sessions.js';
import { resolvePeople, resolveRuntimeMemoryIdentity } from './memory/principal.js';
import { handleMemoryCommand, type MemoryCommandContext } from './memory/commands.js';
import { resolveExecutionScope, ensureExecutionSession } from './runtime/execution-scope.js';
import { textPage } from './runtime/text-page.js';
import { PreparationGuard } from './runtime/preparation-guard.js';
import { saveBotEnabled } from './config/runtime-update.js';
import { runDoctor, formatDoctorReport, formatServiceInventory } from './services/doctor.js';

const CONFIG_PATH = process.env.CLI2IM_CONFIG ?? join(homedir(), '.cli2im', 'config.yaml');
const startedAt = Date.now();

interface RuntimeCommandState {
  fastModeBySession: Map<SessionKey, boolean>;
}

export interface BridgeControls {
  memory?: MemoryCommandContext;
  defaultModel?: string;
  queue?: ChatQueue;
  lifecycle?: BotLifecycle;
  runPrompt?: (prompt: string) => Promise<void>;
  doctor?: () => Promise<string>;
  capturePreparation?: (key: SessionKey) => () => void;
  cancelScope?: (key: SessionKey) => void;
  readResult?: (key: SessionKey) => Promise<import('./runtime/result-recovery.js').RecoveredResult | null>;
  controlBot?: (name: string, action: 'start' | 'stop' | 'restart') => Promise<void>;
}


export interface BridgeCommandSender {
  platform: string;
  chatType?: string;
  userId: string;
  threadId?: string;
  messageId?: string;
}

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
  console.log('[cli2im] Starting...');

  const { config, botErrors, botIdentities } = loadRuntimeConfig(CONFIG_PATH);
  for (const name of Object.keys(botErrors)) console.warn(`[config] bot=${scrubLog(name)} status=invalid_disabled`);
  await configureNetworkPolicy(config.network);
  console.log(`[cli2im] Loaded config with ${Object.keys(config.bots).length} bot(s)`);
  initContentGuard({ enabled: config.contentGuard?.enabled !== false, blockThreshold: config.contentGuard?.blockThreshold });
  console.log(`[security] content_guard=${contentGuardStatus()}`);

  const dataDir = getCli2imDataDir();
  const mediaDir = join(dataDir, 'media');
  ensurePrivateDirectorySync(dataDir);
  ensurePrivateDirectorySync(mediaDir);
  ensurePrivateDirectorySync(join(dataDir, 'logs'));

  const store = await SessionStore.create(config.session.dbPath.replace('~', homedir()));
  await store.markInterruptedTasks();
  const queue = new ChatQueue();
  const preparation = new PreparationGuard();
  const recovery = new RecoveryStore(join(dataDir, 'recovery'));
  const busyTasks = new TaskTracker();
  const lifecycle = new BotLifecycle();
  const routes = new Map<SessionKey, ReplyRoute>();
  const cardScopes = new Map<string, { threadId?: string }>();
  const senders = new Map<SessionKey, InboundMessage>();
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
  function memoryContext(botName: string, message: InboundMessage): MemoryCommandContext | undefined {
    const bot = config.bots[botName];
    if (bot.memory !== true) return undefined;
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
    if (name === 'claude-code') {
      agentManager.registerPlugin(new ClaudeCodePlugin(agentConfig.binary));
    } else if (name === 'codex') {
      agentManager.registerPlugin(new CodexPlugin(agentConfig.binary));
    } else if (name === 'gemini') {
      agentManager.registerPlugin(new GeminiPlugin(agentConfig.binary));
    } else if (name === 'agy') {
      agentManager.registerPlugin(new AgyPlugin(agentConfig.binary));
    } else if (name === 'zcode') {
      agentManager.registerPlugin(new ZcodePlugin(agentConfig.binary));
    } else if (name === 'kimi-work') {
      agentManager.registerPlugin(new KimiWorkPlugin(agentConfig));
    }
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
      });
      cardControllers.set(botName, cardController);
    } else if (botConfig.platform === 'telegram' && botConfig.telegram) {
      const adapter = new TelegramAdapter({
        token: botConfig.telegram.token,
        botName,
      });
      adapters.set(botName, adapter);
      telegramStreams.set(botName, new TelegramStreamController(adapter, config.streaming.intervalMs, key => routes.get(key) ?? {}));
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
    spawnResume: createHandoffSpawnResume(
      agentManager,
      store,
      createEventHandlers,
      (botName) => config.bots[botName],
      async (params) => {
        const resolvedBotName = findBotNameForConfig(params.botConfig);
        return resolveBotSpawnOpts({
          ...params,
          env: { ...config.agents[params.botConfig.agent]?.env,
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
        if (['stop', 'kill'].includes(parseBridgeCommand(msg.text)?.command ?? '')) {
          preparation.cancel(key);
          busyTasks.cancel(key);
        }
        const memory = memoryContext(botName, msg);
        if (memory) {
          if (['remember', 'memory', 'forget'].includes(parseBridgeCommand(msg.text)?.command ?? '')) memorySessions.track(key, memory.identity.principal);
          else await memorySessions.bind(key, memory.identity.principal);
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
      cardController: cardControllers.get(botName), tgStreamController: telegramStreams.get(botName),
      handleControl: async (callback, text) => admit({
        platform: callback.platform, chatId: callback.chatId, userId: callback.userId,
        chatType: callback.chatType, messageId: callback.messageId, threadId: callback.threadId,
        text, mentions: getAdapterBotOpenId(adapter) ? [getAdapterBotOpenId(adapter)!] : [],
      }, true),
    });
    adapter.onCallback?.(callback => {
      if (!lifecycle.status(botName).acceptsMessages || !isCallbackAuthorized(callback, botConfig)) return;
      const scope = cardScopes.get(`${botName}:${callback.chatId}:${callback.messageId}`);
      if (scope) {
        if (callback.threadId && callback.threadId !== scope.threadId) return;
        callback.threadId = scope.threadId;
      }
      const key = buildSessionKey(callback.platform, callback.chatId, botName, callback.threadId);
      senders.set(key, { platform: callback.platform, chatId: callback.chatId, userId: callback.userId, chatType: callback.chatType, messageId: callback.messageId, threadId: callback.threadId, text: '' });
      routes.set(key, callback.threadId ? { threadId: callback.threadId, replyToMessageId: callback.messageId } : {});
      if (botConfig.memory && parseSessionResumeCallback(callback.data)) {
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
        else await memorySessions.bind(ctx.sessionKey, memory.identity.principal);
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
          { defaultModel: config.agents[botConfig.agent]?.defaultModel, queue, lifecycle, memory,
            runPrompt: prompt => processMessagePrompt(botName, msg, prompt),
            doctor: diagnose, controlBot, readResult: key => recovery.read(key),
            capturePreparation: captureReadiness,
            cancelScope: key => { preparation.cancel(key); busyTasks.cancel(key); },
          },
        );
        return;
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
      await downloadInboundAttachments(msg, adapter, join(expandHome(session.workingDirectory), 'inbox'));

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
      const messageText = senderHeader + msg.text;
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
        const spawnEnv = { ...config.agents[botConfig.agent]?.env, ...senderEnv, ...larkCliEnv };

        const spawnOpts = await resolveBotSpawnOpts({
          botConfig,
          workingDirectory: session.workingDirectory,
          env: spawnEnv,
          model: (await store.getPreferences(sessionKey)).model ?? config.agents[botConfig.agent]?.defaultModel,
          autoApprove: botConfig.autoApprove,
          turnTimeoutMs: botConfig.turnTimeoutMs,
          idleTimeoutMs: botConfig.idleTimeoutMs,
          sandboxMode: botConfig.sandboxMode,
          reasoningEffort: runtimeState.fastModeBySession.get(sessionKey)
            ? 'low'
            : config.agents[botConfig.agent]?.defaultEffort,
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
      const memoryDocument = memory ? await memoryStore.read(memory.identity.principal) : undefined;
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

  let configUpdate = Promise.resolve();
  async function controlBot(name: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    if (!config.bots[name]) throw new Error('Unknown bot');
    if (action !== 'stop') assertNetworkReady();
    if (action === 'restart') { await lifecycle.restart(name, 'cancel'); return; }
    const enabled = action === 'start';
    const update = configUpdate.catch(() => {}).then(() => saveBotEnabled(CONFIG_PATH, name, enabled));
    configUpdate = update;
    await update;
    config.bots[name].enabled = enabled;
    await lifecycle.setEnabled(name, enabled, 'cancel');
  }
  async function diagnose(): Promise<string> {
    const network = networkPolicyStatus();
    const report = await runDoctor({ config, lifecycle: lifecycle.list(),
      getPlugin: name => agentManager.getPlugin(name),
      network: { state: network.ready ? 'ok' : 'error', detail: `${network.mode}; ${network.dns}` },
      contentGuard: contentGuardStatus(), speechKeyConfigured: Boolean(process.env.DASHSCOPE_STT_API_KEY || process.env.DASHSCOPE_API_KEY),
      activeTasks: busyTasks.size(),
    });
    return formatDoctorReport(report) + '\n\n' + formatServiceInventory(report.services);
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
    getBotStatus: () => lifecycle.list(),
    controlBot,
    doctor: diagnose,
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

  await httpServer.start(config.server.host, config.server.port);

  for (const [botName, adapter] of adapters) {
    try {
      await lifecycle.start(botName);
      console.log(`[cli2im] Bot "${scrubLog(botName)}" state=${lifecycle.status(botName).state} platform=${scrubLog(adapter.name)}`);
    } catch (err) {
      console.error(`[cli2im] Bot "${scrubLog(botName)}" connection_failed`);
    }
  }

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

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (networkTimer) clearInterval(networkTimer);
    console.log('[cli2im] Shutting down...');
    await httpServer.stop();
    await notificationService?.stop();
    await agentManager.shutdownPlugins();
    await lifecycle.stopAll('cancel');
    store.save();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

export async function startNotificationServiceBeforeReady(
  service: Pick<CodexNotificationService, 'start'> | undefined,
  reportReady: () => void = () => console.log('[cli2im] Ready'),
): Promise<void> {
  await service?.start();
  reportReady();
}

export async function handleBridgeCommand(
  cmd: { command: string; args: string[] },
  sessionKey: SessionKey,
  botName: string,
  chatId: string,
  adapter: PlatformAdapter,
  store: SessionStore,
  agentManager: AgentManager,
  handoffService: HandoffService,
  cardController: StreamingCardController | undefined,
  tgStreamController: TelegramStreamController | undefined,
  voiceSessions: Map<SessionKey, string>,
  runtimeState: RuntimeCommandState,
  botConfig: BotConfig,
  commandSender?: BridgeCommandSender,
  notificationService?: CodexNotificationService,
  controls: BridgeControls = {},
): Promise<void> {
  const actor = { userId: commandSender?.userId ?? '', chatId, chatType: commandSender?.chatType };
  const visibleSessions = async () => {
    const sessions = await store.listByBot(botName);
    return (await Promise.all(sessions.map(async session =>
      await canAccessSession({ bot: botConfig, actor, sessionKey, session }) ? session : null)))
      .filter((session): session is NonNullable<typeof session> => session !== null);
  };
  const projects = new ProjectRegistry({
    projects: botConfig.projects, shortcuts: botConfig.shortcuts,
    validateDirectory: async (candidate) => {
      const path = await resolveStrictDirectory(candidate);
      if (isBotAdmin(botConfig, actor.userId)) return path;
      const roots = [resolveExecutionScope(botConfig, actor).workingDirectory,
        ...Object.values(botConfig.projects ?? {})];
      const canonicalRoots = await Promise.all(roots.map(root => resolveStrictDirectory(root).catch(() => '')));
      if (!isPathWithinAnyRoot(path, canonicalRoots.filter(Boolean))) throw new Error('这个目录不在当前机器人的项目范围内');
      return path;
    },
    loadRecent: async key => (await store.getPreferences(key as SessionKey)).recentDirectories ?? [],
    saveRecent: async (key, recentDirectories) => store.updatePreferences(key as SessionKey, { recentDirectories }),
  });
  switch (cmd.command) {
    case 'remember':
    case 'memory':
    case 'forget': {
      if (getBotAccessRejection(actor, botConfig)) return;
      await adapter.send(chatId, { text: await handleMemoryCommand(cmd, botConfig, actor.userId, controls.memory), plainText: true });
      break;
    }
    case 'notify-me': {
      if (
        !notificationService
        || botName !== notificationService.botName
        || commandSender?.platform !== 'feishu'
        || commandSender.chatType !== 'p2p'
        || !botConfig.allowFrom.map(String).includes(commandSender.userId)
      ) {
        await adapter.send(chatId, { text: '通知绑定失败：请使用获授权的 codexbot 飞书私聊。' });
        break;
      }
      await notificationService.bindTarget({
        botName,
        platform: 'feishu',
        chatId,
        userId: commandSender.userId,
      });
      await adapter.send(chatId, {
        text: 'Codex 通知已绑定到当前私聊。后续只发送项目、任务和状态。',
      });
      break;
    }

    case 'new': {
      controls.cancelScope?.(sessionKey);
      agentManager.forgetSession(sessionKey);
      clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });
      const existingSession = await store.getByKey(sessionKey);
      if (existingSession) await store.delete(existingSession.id);
      await store.updatePreferences(sessionKey, { taskState: undefined });
      store.save();
      await adapter.send(chatId, { text: '新会话已创建，发消息开始' });
      break;
    }

    case 'help':
    case 'status': {
      const session = await store.getByKey(sessionKey);
      const prefs = await store.getPreferences(sessionKey);
      const running = prefs.taskState === 'running';
      const supported = ['/new', '/projects', '/status', '/stop'];
      if (agentManager.getPlugin(botConfig.agent)?.capabilities.sessionResume) supported.push('/sessions');
      await adapter.send(chatId, { card: buildControlPanel({
        botName, agentName: botConfig.agent, model: prefs.model ?? controls.defaultModel,
        projectName: session?.workingDirectory ?? botConfig.workingDirectory, running,
        queued: controls.queue?.status(sessionKey).pending,
        error: prefs.taskState === 'interrupted' ? '上次任务中途停止，未自动重跑' : undefined,
        supportedCommands: supported,
      }) });
      break;
    }
    case 'projects': {
      if (cmd.args.length) {
        await handleBridgeCommand({ command: 'cwd', args: [cmd.args.join(' ')] }, sessionKey, botName, chatId,
          adapter, store, agentManager, handoffService, cardController, tgStreamController,
          voiceSessions, runtimeState, botConfig, commandSender, notificationService, controls);
      } else await adapter.send(chatId, { card: buildProjectPanel(await projects.list(sessionKey)) });
      break;
    }
    case 'task': {
      if (!cmd.args[0]) {
        const shortcuts = projects.listShortcuts();
        await adapter.send(chatId, { text: shortcuts.length ? shortcuts.map(item => `/task ${item.name} · ${item.description}`).join('\n') : '尚未配置快捷任务' });
        break;
      }
      try {
        const shortcut = await projects.resolveShortcut(sessionKey, cmd.args[0]);
        if (shortcut.directory) {
          if ((await store.getPreferences(sessionKey)).taskState === 'running') throw new Error('请先停止当前任务再切换项目');
          controls.cancelScope?.(sessionKey);
          agentManager.forgetSession(sessionKey);
          const current = await store.getOrCreate(sessionKey, { agentName: botConfig.agent, workingDirectory: shortcut.directory });
          await store.updateWorkingDirectory(current.id, shortcut.directory);
          await store.clearAgentSessionId(current.id);
          store.save();
        }
        if (!controls.runPrompt) throw new Error('当前入口不支持快捷任务');
        await controls.runPrompt(shortcut.prompt);
      } catch (error) { await adapter.send(chatId, { text: error instanceof Error ? error.message : '快捷任务失败' }); }
      break;
    }
    case 'result': {
      const result = await controls.readResult?.(sessionKey);
      const text = result
        ? `上次保存的结果（${formatDateTime(result.savedAt)}）：\n${result.text || '任务已结束，没有可恢复的文字。'}${result.truncated ? '\n结果过长，这里只保留前 1 MiB。' : ''}`
        : '当前对话还没有保存的结果。';
      await adapter.send(chatId, { text: textPage(text, cmd.args[0], 'result'), plainText: true });
      break;
    }
    case 'doctor': {
      if (!isBotAdmin(botConfig, actor.userId)) { await adapter.send(chatId, { text: '只有该机器人的管理员可以查看运行诊断' }); break; }
      const report = controls.doctor ? await controls.doctor() : '运行诊断未接入';
      await adapter.send(chatId, { text: textPage(report, cmd.args[0], 'doctor'), plainText: true });
      break;
    }
    case 'bots': {
      if (!isBotAdmin(botConfig, actor.userId) || !controls.lifecycle) {
        await adapter.send(chatId, { text: '只有该机器人的管理员可以管理启停' }); break;
      }
      const [action, target = botName] = cmd.args;
      if (target !== botName) { await adapter.send(chatId, { text: '请通过目标机器人或本机管理命令操作，避免跨机器人更改' }); break; }
      if (!action) { await adapter.send(chatId, { text: `${botName}: ${controls.lifecycle.status(botName).state}` }); break; }
      if (!['start','stop','restart'].includes(action)) { await adapter.send(chatId, { text: '用法：/bots start|stop|restart' }); break; }
      await adapter.send(chatId, { text: `正在${action === 'stop' ? '停止' : action === 'start' ? '启动' : '重启'}当前机器人，当前任务会中断。` });
      if (controls.controlBot) { await controls.controlBot(botName, action as 'start' | 'stop' | 'restart'); break; }
      if (action === 'stop') await controls.lifecycle.stop(botName, 'cancel');
      else if (action === 'start') await controls.lifecycle.start(botName);
      else await controls.lifecycle.restart(botName, 'cancel');
      break;
    }

    case 'thinking': {
      if (!cardController) {
        await adapter.send(chatId, { text: '当前平台不支持思考卡片显示切换' });
        break;
      }
      const nextVisible = !cardController.isThinkingVisible(sessionKey);
      cardController.setThinkingVisible(sessionKey, nextVisible);
      await adapter.send(chatId, {
        text: nextVisible ? '思考显示已开启' : '思考显示已关闭',
      });
      break;
    }

    case 'fast': {
      const nextFastMode = !(runtimeState.fastModeBySession.get(sessionKey) ?? false);
      if (nextFastMode) {
        runtimeState.fastModeBySession.set(sessionKey, true);
      } else {
        runtimeState.fastModeBySession.delete(sessionKey);
      }

      const suffix = agentManager.hasProcess(sessionKey) ? '，下次进程启动生效' : '';
      await adapter.send(chatId, {
        text: nextFastMode ? `快速模式已开启${suffix}` : `快速模式已关闭${suffix}`,
      });
      break;
    }

    case 'stop': {
      agentManager.cancelAgent(sessionKey);
      cardController?.interruptCard(sessionKey);
      clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });
      if ((await store.getPreferences(sessionKey)).taskState === 'running')
        await store.updatePreferences(sessionKey, { taskState: 'interrupted', taskUpdatedAt: Date.now() });
      await adapter.send(chatId, { text: '已发送中断信号' });
      break;
    }

    case 'kill': {
      agentManager.killAgent(sessionKey);
      cardController?.interruptCard(sessionKey);
      clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });
      if ((await store.getPreferences(sessionKey)).taskState === 'running')
        await store.updatePreferences(sessionKey, { taskState: 'interrupted', taskUpdatedAt: Date.now() });
      await adapter.send(chatId, { text: '已强制终止进程' });
      break;
    }

    case 'cwd': {
      const newDir = cmd.args.join(' ');
      if (!newDir) {
        await adapter.send(chatId, { text: '用法: /cwd <path>' });
        break;
      }
      let resolvedNewDir: string;
      try {
        resolvedNewDir = await projects.select(sessionKey, newDir);
      } catch {
        await adapter.send(chatId, { text: `无效路径: \`${newDir}\`` });
        break;
      }
      clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });
      controls.cancelScope?.(sessionKey);
      agentManager.forgetSession(sessionKey);
      const session = await store.getOrCreate(sessionKey, { agentName: botConfig.agent, workingDirectory: resolvedNewDir });
      await store.updateWorkingDirectory(session.id, resolvedNewDir);
      await store.clearAgentSessionId(session.id);
      await store.updatePreferences(sessionKey, { taskState: undefined, taskUpdatedAt: undefined });
      store.save();
      await adapter.send(chatId, { text: `工作目录已切换到 ${resolvedNewDir}，下一条消息会新建该项目的对话` });
      break;
    }

    case 'switch':
    case 'resume': {
      const sessionId = cmd.args[0];
      if (!sessionId || !commandSender) {
        await adapter.send(chatId, { text: '用法：/resume <历史对话编号>' }); break;
      }
      await handleCLISessionResume({
        callback: { ...commandSender, chatId, data: '', messageId: commandSender.messageId ?? '' },
        resume: { sessionId, cwd: '' }, botName, botConfig, adapter, store, agentManager, handoffService,
        cardController, tgStreamController, ensureReady: controls.capturePreparation?.(sessionKey),
      });
      store.save();
      break;
    }

    case 'handoff': {
      try {
        const result = await handoffService.releaseHandoff(sessionKey);
        controls.cancelScope?.(sessionKey);
        if ((await store.getPreferences(sessionKey)).taskState === 'running')
          await store.updatePreferences(sessionKey, { taskState: 'interrupted', taskUpdatedAt: Date.now() });
        agentManager.cancelAgent(sessionKey);
        clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });
        await adapter.send(chatId, {
          text: buildHandoffReleaseNotification(result),
        });
      } catch (err) {
        await adapter.send(chatId, {
          text: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'perm': {
      const [decision, requestId] = cmd.args;
      if (!decision || !requestId || !['allow', 'allow_session', 'deny'].includes(decision)) {
        await adapter.send(chatId, { text: '用法: /perm allow|allow_session|deny <requestId>' });
        break;
      }

      const accepted = decision === 'deny'
        ? agentManager.denyPermission(sessionKey, requestId)
        : agentManager.approvePermission(sessionKey, requestId);
      if (!accepted) {
        await adapter.send(chatId, { text: `审批失败或已过期: \`${requestId}\`` });
        break;
      }

      await adapter.send(chatId, {
        text: decision === 'deny'
          ? `已拒绝权限请求: \`${requestId}\``
          : `已批准权限请求: \`${requestId}\``,
      });
      break;
    }

    case 'force-approve': {
      const pending = agentManager.getPendingPermissionForSession(sessionKey);
      if (!pending) {
        await adapter.send(chatId, { text: '没有待审批的危险操作' });
        break;
      }
      const approved = agentManager.approvePermission(sessionKey, pending.requestId);
      if (approved) {
        await adapter.send(chatId, { text: `已批准执行: \`${pending.command}\`` });
      } else {
        await adapter.send(chatId, { text: '批准失败（可能已超时）' });
      }
      break;
    }

    case 'list': {
      const sessions = await visibleSessions();
      if (sessions.length === 0) {
        await adapter.send(chatId, { text: '没有活跃会话' });
        break;
      }
      const lines = sessions.map(
        (session) => `- \`${session.agentSessionId ?? session.id}\` ${session.state} | ${session.workingDirectory}`,
      );
      await adapter.send(chatId, { text: `**会话列表:**\n${lines.join('\n')}` });
      break;
    }

    case 'sessions': {
      const sub = cmd.args[0];

      if (sub === 'bot') {
        const sessions = await visibleSessions();
        if (sessions.length === 0) {
          await adapter.send(chatId, { text: '没有活跃会话' });
          break;
        }
        const lines = sessions.map((session) => {
          const [, sessionChatId] = session.key.split(':');
          const processState = agentManager.hasProcess(session.key) ? 'Running' : 'Idle';
          const lastActive = formatDateTime(session.lastActiveAt);
          return [
            `- \`${session.agentSessionId ?? session.id}\``,
            `${session.state}/${processState}`,
            `chat: \`${sessionChatId}\``,
            `agent: ${session.agentName}`,
            `cwd: \`${session.workingDirectory}\``,
            `last: ${lastActive}`,
          ].join(' | ');
        });
        await adapter.send(chatId, { text: `**会话列表:**\n${lines.join('\n')}` });
        break;
      }

      const requestedAgent = ({ codex: 'codex', gemini: 'gemini', agy: 'agy', antigravity: 'agy', claude: 'claude-code' } as Record<string,string>)[sub ?? ''] ?? botConfig.agent;
      if (requestedAgent !== botConfig.agent) { await adapter.send(chatId, { text: '请在对应 AI 的机器人中查看历史对话' }); break; }
      const agentLabel = agentManager.getPlugin(botConfig.agent)?.displayName ?? botConfig.agent;
      const bindings = await store.listSessionAccess(sessionKey);
      const sessions = await scanAgentSessions(botConfig.agent, { accept: async candidate => {
        const binding = bindings.find(item => item.agentName === botConfig.agent && item.agentSessionId === candidate.sessionId);
        return canAccessSession({ bot: botConfig, actor, sessionKey,
          session: binding ?? { ...candidate, agentName: botConfig.agent } });
      } });

      if (sessions.length === 0) {
        await adapter.send(chatId, { text: `没有找到 ${agentLabel} CLI 会话` });
        break;
      }
      if (adapter.name === 'telegram') {
        await adapter.send(chatId, { card: buildCLISessionText(sessions, agentLabel) });
      } else {
        await adapter.send(chatId, { card: buildCLISessionCard(sessions, agentLabel) });
      }
      break;
    }

    case 'model': {
      const model = cmd.args[0];
      if (!model) {
        const selected = (await store.getPreferences(sessionKey)).model ?? controls.defaultModel ?? 'AI 默认模型';
        await adapter.send(chatId, { text: `当前选择：${selected}。用法：/model <模型名>；/model default 恢复默认。` }); break;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:/\[\]-]{0,127}$/.test(model)) {
        await adapter.send(chatId, { text: '模型名格式无效' }); break;
      }
      if ((await store.getPreferences(sessionKey)).taskState === 'running') {
        await adapter.send(chatId, { text: '请等待当前任务完成，或先 /stop 再切换模型' }); break;
      }
      await store.updatePreferences(sessionKey, { model: model === 'default' ? undefined : model });
      agentManager.killAgent(sessionKey);
      await adapter.send(chatId, { text: `模型选择已保存：${model === 'default' ? '默认模型' : model}；下一条消息启动时使用。模型是否可用由该 AI 服务确认。` });
      break;
    }

    default:
      await adapter.send(chatId, { text: `未知指令: /${cmd.command}` });
  }
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
  capturePreparation?: (key: SessionKey) => () => void;
  handleControl?: (callback: import('./types.js').CallbackQuery, text: string) => Promise<void>;
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

export interface ResolveBotSpawnOptsInput {
  botConfig: BotConfig;
  workingDirectory: string;
  env?: Record<string, string>;
  model?: string;
  autoApprove?: boolean;
  turnTimeoutMs?: number;
  idleTimeoutMs?: number;
  sandboxMode?: string;
  reasoningEffort?: SpawnOpts['reasoningEffort'];
  initialPrompt?: string;
  addDirs?: string[];
  sandboxExtraRoots?: string[];
  otherProtectedRoots?: string[];
}

export type BotSpawnOptsResolver = (params: ResolveBotSpawnOptsInput) => Promise<SpawnOpts>;

/** Default per-bot runtime instructions file, read from the working directory. */
export const DEFAULT_AGENTS_FILE = 'AGENTS.md';

/** Upper bound on the runtime instructions file size (bytes). */
export const MAX_AGENTS_FILE_BYTES = 256 * 1024;

/**
 * Resolve and read a bot's runtime instructions file (the "agent runtime"
 * AGENTS.md). Returns the trimmed file contents, or `undefined` when the
 * feature is disabled, the file is missing/empty, or it cannot be read — so a
 * missing AGENTS.md never blocks a bot from spawning.
 *
 * Hardening: the path is `lstat`-ed and must be a regular file. This rejects
 * symlinks (so a file dropped into an untrusted workingDirectory — e.g. a
 * cloned repo — cannot point AGENTS.md at a secret like `~/.ssh/id_rsa` and
 * have it silently injected into the system prompt) and special files such as
 * FIFOs/devices (which would hang the read and block the bot from spawning).
 * Oversized files are skipped rather than blindly loaded into the prompt.
 */
export async function readAgentsInstructions(
  agentsFile: string | false | undefined,
  workingDirectory: string,
): Promise<string | undefined> {
  if (agentsFile === false || agentsFile === '') return undefined;
  const candidate = expandHome(agentsFile ?? DEFAULT_AGENTS_FILE);
  const filePath = isAbsolute(candidate) ? candidate : join(workingDirectory, candidate);
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.size > MAX_AGENTS_FILE_BYTES) return undefined;
    const content = await readFile(filePath, 'utf-8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveBotSpawnOpts(params: ResolveBotSpawnOptsInput): Promise<SpawnOpts> {
  const workingDirectory = expandHome(params.workingDirectory);
  const addDirs = params.addDirs?.length
    ? params.addDirs.map((dir) => expandHome(dir))
    : undefined;
  const appendSystemPrompt = await readAgentsInstructions(
    params.botConfig.agentsFile,
    workingDirectory,
  );

  return {
    workingDirectory,
    permissionMode: params.botConfig.permissionMode,
    env: params.env,
    model: params.model,
    autoApprove: params.autoApprove,
    turnTimeoutMs: params.turnTimeoutMs,
    idleTimeoutMs: params.idleTimeoutMs,
    sandboxMode: params.sandboxMode,
    reasoningEffort: params.reasoningEffort,
    initialPrompt: params.initialPrompt,
    addDirs,
    appendSystemPrompt,
  };
}

async function resolveStrictDirectory(path: string): Promise<string> {
  const resolved = await realpath(expandHome(path));
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Invalid working directory: ${path}`);
  }
  return resolved;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

async function resolveExistingDirectories(paths: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const path of paths) {
    try {
      resolved.push(await resolveStrictDirectory(path));
    } catch {
      // Missing inactive bot roots should not prevent the current bot from starting.
    }
  }
  return uniquePaths(resolved);
}

function isPathWithinAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/'));
  });
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
    const session = await store.getOrCreate(sessionKey, { agentName, workingDirectory: expandHome(workDir) });
    ensureReady();
    const prefs = 'getPreferences' in store ? await (store as SessionStore).getPreferences(sessionKey) : {};
    ensureReady();
    const spawnOpts = await (resolveSpawnOpts ?? resolveBotSpawnOpts)({
      botConfig, workingDirectory: workDir,
      env: { ...(botConfig.larkCliConfigDir ? { LARKSUITE_CLI_CONFIG_DIR: botConfig.larkCliConfigDir } : {}), ...resolveSenderEnv?.(sessionKey) },
      model: prefs.model,
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

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
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
