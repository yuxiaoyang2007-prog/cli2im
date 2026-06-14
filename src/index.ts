import { loadConfig } from './config/loader.js';
import { SessionStore } from './session/store.js';
import { CLISessionScanner } from './session/cli-scanner.js';
import { CodexSessionScanner } from './session/codex-scanner.js';
import { GeminiSessionScanner } from './session/gemini-scanner.js';
import { ChatQueue } from './session/queue.js';
import { AgentManager, type AgentManagerEvents } from './agents/manager.js';
import { ToolGate } from './agents/tool-gate.js';
import { ClaudeCodePlugin } from './agents/claude-code.js';
import { ClaudePtyPlugin } from './agents/claude-pty.js';
import { CodexPlugin } from './agents/codex.js';
import { GeminiPlugin } from './agents/gemini.js';
import { AgyPlugin } from './agents/agy.js';
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
import { initContentGuard } from './security/content-guard.js';
import {
  handlePermissionCallback,
  isCallbackAuthorized,
  parsePermissionCallbackData,
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
import { getCli2imDataDir } from './util/data-dir.js';
import { protectedSandboxSubtrees } from './agents/pty/SandboxProfile.js';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';

const CONFIG_PATH = process.env.CLI2IM_CONFIG ?? join(homedir(), '.cli2im', 'config.yaml');
const startedAt = Date.now();

interface RuntimeCommandState {
  fastModeBySession: Map<SessionKey, boolean>;
}

async function main(): Promise<void> {
  console.log('[cli2im] Starting...');

  const config = loadConfig(CONFIG_PATH);
  console.log(`[cli2im] Loaded config with ${Object.keys(config.bots).length} bot(s)`);
  if (config.contentGuard?.enabled !== false) {
    initContentGuard({ blockThreshold: config.contentGuard?.blockThreshold });
  }

  const dataDir = getCli2imDataDir();
  const mediaDir = join(dataDir, 'media');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(join(dataDir, 'logs'), { recursive: true });

  const store = await SessionStore.create(config.session.dbPath.replace('~', homedir()));
  const queue = new ChatQueue();
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
  const agentManager = new AgentManager(toolGate, (signal, sessionKey) => {
    const botName = sessionKey.split(':')[2];
    bindSessionScopedBufferCleanup(signal, sessionKey, {
      voiceSessions,
      tgStreamController: telegramStreams.get(botName),
    });
  });

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
    } else if (name === 'claude-code-pty') {
      agentManager.registerPlugin(new ClaudePtyPlugin(agentConfig.binary));
    } else if (name === 'codex') {
      agentManager.registerPlugin(new CodexPlugin(agentConfig.binary));
    } else if (name === 'gemini') {
      agentManager.registerPlugin(new GeminiPlugin(agentConfig.binary));
    } else if (name === 'agy') {
      agentManager.registerPlugin(new AgyPlugin(agentConfig.binary));
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
      telegramStreams.set(botName, new TelegramStreamController(adapter, config.streaming.intervalMs));
    }
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
          sandboxExtraRoots: config.sandboxExtraRoots,
          otherProtectedRoots: resolvedBotName ? await collectOtherProtectedRoots(resolvedBotName) : [],
        });
      },
    ),
    getSession: async (sessionKey) => store.getByKey(sessionKey),
    updateState: async (id, state) => store.updateState(id, state),
  });

  function createEventHandlers(sessionKey: SessionKey): AgentManagerEvents {
    const botName = sessionKey.split(':')[2];
    const chatId = sessionKey.split(':')[1];
    const cardController = cardControllers.get(botName);
    const tgStream = telegramStreams.get(botName);
    const adapter = adapters.get(botName);
    const voiceResponseBuffer = { value: '' };

    return {
      onEvent: createRuntimeEventHandler({
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
    const processMessage = createMessageProcessor(botName, botConfig, adapter);
    messageProcessors.set(botName, processMessage);

    adapter.onMessage((msg: InboundMessage) => {
      void queue.enqueue(msg.chatId, () => processMessage(msg)).catch((err) => {
        console.error('[pipeline] Message processing failed:', err);
      });
    });

    adapter.onCallback?.(createCallbackHandler({
      botName,
      botConfig,
      adapter,
      store,
      agentManager,
      handoffService,
      queue,
      cardController: cardControllers.get(botName),
      tgStreamController: telegramStreams.get(botName),
    }));
  }

  function createMessageProcessor(
    botName: string,
    botConfig: BotConfig,
    adapter: PlatformAdapter,
  ): (msg: InboundMessage) => Promise<void> {
    return async (msg) => {
      console.log(`[pipeline] ${scrubLog(botName)}: incoming ${scrubLog(msg.chatType ?? '')} from=${scrubLog(msg.userId)} isRelay=${!!msg.isRelay} mentions=${scrubLog(msg.mentions ?? [])} text=${scrubLog(msg.text, 60)}`);

      // Lazy relay registration on first group message
      if (msg.chatType === 'group' && botConfig.relay?.enabled) {
        relayManager.registerBot(botName, msg.chatId, botConfig.relay.maxConsecutiveRounds ?? 10);
      }

      // Reset relay counter on human messages
      if (!msg.isRelay) {
        relayManager.onHumanMessage(msg.chatId);
      }

      const relayBotCount = relayManager.getBotsInChat(msg.chatId).length;
      console.log(`[pipeline] ${scrubLog(botName)}: relayBotCount=${relayBotCount} botOpenId=${scrubLog(getAdapterBotOpenId(adapter) ?? 'none')}`);
      const groupSkipReason = getGroupMessageSkipReason(
        msg,
        botConfig,
        getAdapterBotOpenId(adapter),
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

      if (ctx.bridgeCommand) {
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
        );
        return;
      }

      const sessionKey = ctx.sessionKey;
      const workingDirectory = (
        botConfig.userOverrides?.[msg.userId]?.workingDirectory
        ?? botConfig.workingDirectory
      ).replace('~', homedir());
      const session = await store.getOrCreate(sessionKey, {
        agentName: botConfig.agent,
        workingDirectory,
      });

      await store.touch(session.id);

      let shouldStartNewProcess = false;
      if (config.newMessageBehavior === 'interrupt' && agentManager.hasProcess(sessionKey)) {
        agentManager.cancelAgent(sessionKey);
        shouldStartNewProcess = true;
        cardControllers.get(botName)?.interruptCard(sessionKey);
        telegramStreams.get(botName)?.interrupt(sessionKey);
      }

      const sender: import('./types.js').SenderInfo = msg.isRelay
        ? {
            channel: 'relay',
            userId: msg.userId,
            botName: msg.userId.replace('relay:', ''),
            userName: msg.userName,
          }
        : { channel: msg.platform, userId: msg.userId, userName: msg.userName };
      const senderHeader = buildSenderHeader(sender);
      await downloadInboundAttachments(msg, adapter, join(expandHome(session.workingDirectory), 'inbox'));

      let pendingVoiceChatId: string | undefined;
      if (msg.isVoice) {
        const audioAttachment = msg.attachments?.find(a => a.type === 'audio' && a.localPath);
        if (audioAttachment?.localPath) {
          const audioBuffer = await readFile(audioAttachment.localPath);
          const format = audioAttachment.mimeType?.includes('ogg') ? 'ogg' : 'mp3';
          const transcript = await transcribeAudio(audioBuffer, format);
          if (transcript) {
            msg.text = sanitizeVoiceTranscript(transcript);
            msg.attachments = msg.attachments?.filter(a => a !== audioAttachment);
            pendingVoiceChatId = msg.chatId;
            console.log(`[voice] STT transcribed for ${scrubLog(sessionKey)}: ${scrubLog(msg.text, 80)}`);
          } else {
            console.warn(`[voice] STT failed for ${scrubLog(sessionKey)}, sending as attachment`);
          }
        }
      }

      const relayDirective = msg.isRelay
        ? '<cti-relay>CRITICAL: This is an automated bot-to-bot relay. Rules: (1) Do NOT use brainstorming, planning, or design skills. (2) Do NOT ask questions or seek confirmation. (3) Keep your response under 200 words. (4) If the task is done, say "DONE" and stop. (5) If reviewing code, give only actionable findings — no praise, no summary.</cti-relay>\n\n'
        : '';
      const messageText = senderHeader + relayDirective + msg.text;
      const userMessage = await buildUserMessageForAgent(
        botConfig.agent,
        messageText,
        msg.attachments,
      );

      const cardController = cardControllers.get(botName);
      if (!cardController && adapter) {
        startTyping(msg.chatId, adapter);
      }
      const isNewProcess = shouldStartNewProcess || !agentManager.hasProcess(sessionKey);
      await cardController?.startCard(
        msg.chatId,
        sessionKey,
        botConfig.agent,
        isNewProcess ? 'Starting...' : undefined,
      );

      if (isNewProcess) {
        console.log(`[pipeline] ${scrubLog(botName)}: spawning ${scrubLog(botConfig.agent)} in ${scrubLog(session.workingDirectory)}`);
        const handlers = createEventHandlers(sessionKey);

        const senderEnv = buildSenderEnv(sender);
        const larkCliEnv: Record<string, string> = botConfig.larkCliConfigDir
          ? { LARKSUITE_CLI_CONFIG_DIR: botConfig.larkCliConfigDir }
          : {};
        const spawnEnv = { ...config.agents[botConfig.agent]?.env, ...senderEnv, ...larkCliEnv };

        const isPtyAgent = botConfig.agent === 'claude-code-pty';
        const spawnOpts = await resolveBotSpawnOpts({
          botConfig,
          workingDirectory: session.workingDirectory,
          env: spawnEnv,
          model: config.agents[botConfig.agent]?.defaultModel,
          autoApprove: botConfig.autoApprove,
          turnTimeoutMs: isPtyAgent ? undefined : botConfig.turnTimeoutMs,
          idleTimeoutMs: isPtyAgent
            ? Math.max(botConfig.idleTimeoutMs ?? 600_000, 600_000)
            : botConfig.idleTimeoutMs,
          sandboxMode: botConfig.sandboxMode,
          reasoningEffort: runtimeState.fastModeBySession.get(sessionKey)
            ? 'low'
            : config.agents[botConfig.agent]?.defaultEffort,
          initialPrompt: messageText,
          sandboxExtraRoots: config.sandboxExtraRoots,
          otherProtectedRoots: await collectOtherProtectedRoots(botName),
        });

        const plugin = agentManager.getPlugin(botConfig.agent);
        const latestId = agentManager.getLatestSessionId(sessionKey) ?? session.agentSessionId;
        if (latestId && plugin?.capabilities.sessionResume) {
          console.log(`[pipeline] ${scrubLog(botName)}: resuming session ${scrubLog(latestId)}`);
        } else {
          console.log(`[pipeline] ${scrubLog(botName)}: fresh spawn`);
        }
        await startAgentProcessForSession({
          agentManager,
          store,
          session,
          sessionKey,
          agentName: botConfig.agent,
          spawnOpts,
          handlers,
        });
      }

      if (pendingVoiceChatId) {
        commitVoiceSessionWhenContextReady(sessionKey, pendingVoiceChatId, {
          voiceSessions,
          hasProcess: (key) => agentManager.hasProcess(key),
          getContextSignal: (key) => agentManager.getContextSignal(key),
        });
      }
      await sendAgentMessageOrNotify({
        agentManager,
        adapter,
        chatId: msg.chatId,
        sessionKey,
        agentName: botConfig.agent,
        message: userMessage,
      });
    };
  }

  const httpServer = new HttpServer(config.server.token, {
    acceptHandoff: (req) => handoffService.acceptHandoff(req),
    releaseHandoff: (sessionKey) => handoffService.releaseHandoff(sessionKey as SessionKey),
    getStatus: () => ({
      uptime: Date.now() - startedAt,
      activeSessions: [...adapters.keys()].reduce(
        (count) => count + (agentManager.listPlugins().length > 0 ? 1 : 0),
        0,
      ),
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
      await adapter.connect();
      console.log(`[cli2im] Bot "${scrubLog(botName)}" connected to ${scrubLog(adapter.name)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cli2im] Failed to connect bot "${scrubLog(botName)}": ${scrubLog(message)}`);
    }
  }

  console.log('[cli2im] Ready');

  const shutdown = async () => {
    console.log('[cli2im] Shutting down...');
    await httpServer.stop();
    for (const adapter of adapters.values()) {
      await adapter.disconnect();
    }
    store.save();
    store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
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
): Promise<void> {
  switch (cmd.command) {
    case 'new': {
      agentManager.killAgent(sessionKey);
      clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });
      const existingSession = await store.getByKey(sessionKey);
      if (existingSession) await store.delete(existingSession.id);
      await adapter.send(chatId, { text: '新会话已创建，发消息开始' });
      break;
    }

    case 'status': {
      const session = await store.getByKey(sessionKey);
      const hasProcess = agentManager.hasProcess(sessionKey);
      const lines = [
        `**Bot:** ${botName}`,
        `**Agent:** ${session?.agentName ?? 'none'}`,
        `**Session:** \`${session?.agentSessionId ?? 'none'}\``,
        `**Working Dir:** \`${session?.workingDirectory ?? 'none'}\``,
        `**Process:** ${hasProcess ? 'Running' : 'Idle'}`,
        `**State:** ${session?.state ?? 'none'}`,
      ];
      await adapter.send(chatId, { text: lines.join('\n') });
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
      await adapter.send(chatId, { text: '已发送中断信号' });
      break;
    }

    case 'kill': {
      agentManager.killAgent(sessionKey);
      cardController?.interruptCard(sessionKey);
      clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });
      await adapter.send(chatId, { text: '已强制终止进程' });
      break;
    }

    case 'cwd': {
      const newDir = cmd.args[0];
      if (!newDir) {
        await adapter.send(chatId, { text: '用法: /cwd <path>' });
        break;
      }
      let resolvedNewDir: string;
      try {
        resolvedNewDir = await resolveStrictDirectory(newDir);
      } catch {
        await adapter.send(chatId, { text: `无效路径: \`${newDir}\`` });
        break;
      }
      clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });
      const session = await store.getByKey(sessionKey);
      if (session) {
        await store.updateWorkingDirectory(session.id, resolvedNewDir);
        agentManager.killAgent(sessionKey);
        await adapter.send(chatId, { text: `工作目录已切换到 \`${newDir}\`，下次消息生效` });
      } else {
        await adapter.send(chatId, { text: '当前没有会话，发消息后会使用默认目录创建' });
      }
      break;
    }

    case 'resume': {
      const sessionId = cmd.args[0];
      if (!sessionId) {
        await adapter.send(chatId, { text: '用法: /resume <sessionId>' });
        break;
      }
      const result = await handoffService.acceptHandoff({
        botName,
        sessionId,
        workDir: botConfig.workingDirectory,
        agentName: botConfig.agent,
        chatId,
      });
      if (result.success) {
        await adapter.send(chatId, {
          text: buildHandoffNotification({
            sessionId,
            workDir: botConfig.workingDirectory,
            agentName: botConfig.agent,
          }),
        });
      } else {
        await adapter.send(chatId, { text: `Resume failed: ${result.error}` });
      }
      break;
    }

    case 'handoff': {
      try {
        const result = await handoffService.releaseHandoff(sessionKey);
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
      const sessions = await store.listByBot(botName);
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
        const sessions = await store.listByBot(botName);
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

      const useOwnGemini = !sub && (botConfig.agent === 'gemini' || botConfig.agent === 'agy');
      const useGemini = sub === 'gemini' || useOwnGemini;
      const useCodex = sub === 'codex' || (!sub && botConfig.agent === 'codex');
      const agentLabel = useGemini ? 'Gemini' : useCodex ? 'Codex' : 'Claude Code';
      const sessions = useGemini
        ? useOwnGemini
          ? await new GeminiSessionScanner(join(homedir(), '.gemini')).scan({
              cwdFilter: botConfig.workingDirectory,
            })
          : await new GeminiSessionScanner(join(homedir(), '.gemini')).scan()
        : useCodex
          ? await new CodexSessionScanner(join(homedir(), '.codex')).scan()
          : botConfig.agent === 'claude-code-pty'
            ? await new CLISessionScanner(join(homedir(), '.claude')).scan({
                cwdFilter: botConfig.workingDirectory,
              })
            : await new CLISessionScanner(join(homedir(), '.claude')).scan();

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

    case 'switch': {
      const targetId = cmd.args[0];
      if (!targetId) {
        await adapter.send(chatId, { text: '用法: /switch <sessionId>' });
        break;
      }
      await adapter.send(chatId, { text: `切换到会话 \`${targetId}\`（下次消息生效）` });
      break;
    }

    case 'model': {
      const model = cmd.args[0];
      if (!model) {
        await adapter.send(chatId, { text: '用法: /model <model-name>' });
        break;
      }
      await adapter.send(chatId, { text: `模型已切换为 \`${model}\`（下次 spawn 生效）` });
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

      void queue.enqueue(callback.chatId, () =>
        handleSessionResume({
          callback,
          resume,
          botName,
          botConfig,
          adapter,
          store,
          agentManager,
          handoffService,
          cardController,
          tgStreamController,
        })
      ).catch((err) => {
        console.error('[pipeline] CLI session resume failed:', scrubLog(err));
        void adapter.send(callback.chatId, {
          text: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
      return;
    }

    console.log(`[pipeline] Ignored callback: ${scrubLog(callback.data)}`);
  };
}

export async function sendAgentMessageOrNotify(params: {
  agentManager: Pick<AgentManager, 'sendMessage'>;
  adapter: PlatformAdapter;
  chatId: string;
  sessionKey: SessionKey;
  agentName: string;
  message: UserMessage;
}): Promise<boolean> {
  const { agentManager, adapter, chatId, sessionKey, agentName, message } = params;
  const delivered = agentManager.sendMessage(sessionKey, agentName, message);
  if (delivered) return true;

  console.warn(
    `[pipeline] message not delivered (session switching/restarting): session=${scrubLog(sessionKey)} agent=${scrubLog(agentName)}`,
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

export async function resolveBotSpawnOpts(params: ResolveBotSpawnOptsInput): Promise<SpawnOpts> {
  // Sandbox only applies to the claude-code-pty agent (it confines THAT claude child).
  // Other agents (codex/agy) must never get a box root computed: their workdir may be
  // home (e.g. codexbot at /Users/<user>), which assertSafeBoxRoot rejects — that would
  // break those bots even though they were never meant to be sandboxed.
  const sandbox = params.botConfig.agent === 'claude-code-pty'
    ? (params.botConfig.sandbox ?? 'workdir')
    : 'off';
  // Only the sandbox path needs a strictly-validated (realpath'd, existing) box root.
  // Non-sandbox bots keep the legacy lenient behavior (expandHome only) so a missing or
  // non-realpath workdir does not break them — matches pre-sandbox behavior for codex/agy
  // (and for claude-code-pty when sandbox is explicitly off).
  const workingDirectory = sandbox === 'workdir'
    ? await resolveStrictDirectory(params.workingDirectory)
    : expandHome(params.workingDirectory);
  const addDirs = params.addDirs?.length
    ? await Promise.all(params.addDirs.map((dir) => resolveStrictDirectory(dir)))
    : undefined;

  let sandboxBoxRoots: string[] | undefined;
  let sandboxOtherProtectedRoots: string[] | undefined;
  if (sandbox === 'workdir') {
    const homeDir = await realpath(homedir());
    sandboxBoxRoots = uniquePaths([
      workingDirectory,
      ...await Promise.all((params.sandboxExtraRoots ?? []).map((dir) => resolveStrictDirectory(dir))),
    ]);
    for (const root of sandboxBoxRoots) {
      assertSafeBoxRoot(root, homeDir);
    }
    for (const addDir of addDirs ?? []) {
      if (!isPathWithinAnyRoot(addDir, sandboxBoxRoots)) {
        throw new Error(`Sandbox add-dir outside box roots: ${addDir}`);
      }
    }
    // Cross-bot protected roots (other bots' workdirs). Drop any that would deny THIS bot's
    // own workspace — an ancestor-or-equal of a box root — or that are overly broad
    // (home/ancestors, or outside the user home trees). A sibling non-PTY bot can have a
    // home/broad workdir (e.g. codex running in ~); denying that whole tree would break this
    // PTY bot instead of isolating the sibling. Secrets stay covered by the deny-read list.
    sandboxOtherProtectedRoots = (await resolveExistingDirectories(params.otherProtectedRoots ?? []))
      .filter((root) =>
        !sandboxBoxRoots!.some((box) => isPathWithinAnyRoot(box, [root]))
        && !isPathWithinAnyRoot(homeDir, [root])
        && (root.startsWith('/Users/') || root.startsWith('/home/')));
  }

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
    sandbox,
    ...(sandboxBoxRoots ? { sandboxBoxRoots } : {}),
    ...(sandboxOtherProtectedRoots?.length ? { sandboxOtherProtectedRoots } : {}),
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

function assertSafeBoxRoot(root: string, homeDir: string): void {
  if (isPathWithinAnyRoot(homeDir, [root])) {
    throw new Error(`Unsafe sandbox box root: ${root}`);
  }
  if (!root.startsWith('/Users/') && !root.startsWith('/home/')) {
    throw new Error(`Unsafe sandbox box root: ${root}`);
  }
  if (isPathWithinAnyRoot(root, protectedSandboxSubtrees(homeDir))) {
    throw new Error(`Unsafe sandbox box root: ${root}`);
  }
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
  agentManager: Pick<AgentManager, 'resumeAgent'>,
  store: Pick<
    SessionStore,
    'getOrCreate' | 'updateWorkingDirectory' | 'updateAgentSessionId' | 'updateState' | 'touch'
  >,
  createEventHandlers: (sessionKey: SessionKey) => AgentManagerEvents,
  getBotConfig?: (botName: string) => BotConfig | undefined,
  resolveSpawnOpts?: BotSpawnOptsResolver,
): (
  sessionKey: SessionKey,
  agentName: string,
  sessionId: string,
  workDir: string,
) => Promise<{ pid: number; sessionId: string }> {
  return async (sessionKey, agentName, sessionId, workDir) => {
    const handlers = createEventHandlers(sessionKey);
    const botName = getSessionBotName(sessionKey);
    const botConfig = botName ? getBotConfig?.(botName) : undefined;
    let spawnOpts: SpawnOpts;
    if (agentName === 'claude-code-pty') {
      if (botConfig?.agent !== 'claude-code-pty') {
        throw new Error('claude-code-pty handoff requires a PTY bot configuration');
      }
      if (!resolveSpawnOpts) {
        throw new Error('claude-code-pty handoff requires a strict spawn resolver');
      }
      spawnOpts = await resolveSpawnOpts({
        botConfig,
        workingDirectory: workDir,
        turnTimeoutMs: undefined,
        idleTimeoutMs: Math.max(botConfig.idleTimeoutMs ?? 600_000, 600_000),
      });
    } else {
      spawnOpts = {
        workingDirectory: workDir,
        permissionMode: 'blacklist',
      };
    }
    const proc = await agentManager.resumeAgent(
      sessionKey,
      agentName,
      sessionId,
      spawnOpts,
      handlers,
    );
    const normalizedWorkDir = expandHome(workDir);
    const session = await store.getOrCreate(sessionKey, { agentName, workingDirectory: normalizedWorkDir });
    await store.updateWorkingDirectory(session.id, normalizedWorkDir);
    await store.updateAgentSessionId(session.id, sessionId);
    await store.updateState(session.id, 'active');
    await store.touch(session.id);
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
    await agentManager.resumeAgent(sessionKey, agentName, latestId, spawnOpts, handlers);
    return;
  }

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
  return parts[parts.length - 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[cli2im] Fatal error:', err);
    process.exit(1);
  });
}
