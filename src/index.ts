import { loadConfig } from './config/loader.js';
import { SessionStore } from './session/store.js';
import { CLISessionScanner } from './session/cli-scanner.js';
import { CodexSessionScanner } from './session/codex-scanner.js';
import { GeminiSessionScanner } from './session/gemini-scanner.js';
import { ChatQueue } from './session/queue.js';
import { AgentManager, type AgentManagerEvents } from './agents/manager.js';
import { ToolGate } from './agents/tool-gate.js';
import { ClaudeCodePlugin } from './agents/claude-code.js';
import { CodexPlugin } from './agents/codex.js';
import { GeminiPlugin } from './agents/gemini.js';
import { FeishuAdapter } from './platforms/feishu/adapter.js';
import { TelegramAdapter } from './platforms/telegram/adapter.js';
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
  buildCrashNotification,
  buildCLISessionCard,
} from './platforms/feishu/markdown.js';
import { buildCLISessionText } from './platforms/telegram/markdown.js';
import { validateWorkingDirectory } from './security/validators.js';
import {
  buildUserMessageForAgent,
  downloadInboundAttachments,
} from './media.js';
import { initContentGuard } from './security/content-guard.js';
import { handlePermissionCallback, parseSessionResumeCallback } from './runtime/callbacks.js';
import { transcribeAudio, synthesizeSpeech } from './services/speech.js';
import type {
  SessionKey,
  InboundMessage,
  PlatformAdapter,
  BotConfig,
  SpawnOpts,
  CallbackQuery,
} from './types.js';
import { RelayManager } from './relay/manager.js';
import { relayToOtherBots } from './relay/deliver.js';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const CONFIG_PATH = process.env.CLI2IM_CONFIG ?? join(homedir(), '.cli2im', 'config.yaml');
const startedAt = Date.now();

const TERMINAL_PATTERNS = /^(done|lgtm|confirmed|accepted|acknowledged|agreed|ok|收到|完成|没问题|好的|通过|stop here)/i;

function isTerminalRelayText(text: string): boolean {
  if (text.length > 500) return false;
  const firstLine = text.split('\n')[0].trim();
  return TERMINAL_PATTERNS.test(firstLine);
}

interface RuntimeCommandState {
  fastModeBySession: Map<SessionKey, boolean>;
}

interface TelegramBufferState {
  chatId: string;
  buffer: string;
}

class TelegramStreamController {
  private states = new Map<SessionKey, TelegramBufferState>();
  private adapter: PlatformAdapter;

  constructor(adapter: PlatformAdapter, _intervalMs?: number) {
    this.adapter = adapter;
  }

  appendText(sessionKey: SessionKey, chatId: string, text: string): void {
    let state = this.states.get(sessionKey);
    if (!state) {
      state = { chatId, buffer: '' };
      this.states.set(sessionKey, state);
    }
    state.buffer += text;
  }

  async finalize(sessionKey: SessionKey): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state) return;

    const text = state.buffer.trim();
    this.states.delete(sessionKey);
    if (!text) return;

    try {
      await this.adapter.send(state.chatId, { text });
    } catch (err) {
      console.error(`[tg-stream] send error for ${sessionKey}:`, err instanceof Error ? err.message : err);
    }
  }

  interrupt(sessionKey: SessionKey): void {
    this.states.delete(sessionKey);
  }
}

async function main(): Promise<void> {
  console.log('[cli2im] Starting...');

  const config = loadConfig(CONFIG_PATH);
  console.log(`[cli2im] Loaded config with ${Object.keys(config.bots).length} bot(s)`);
  if (config.contentGuard?.enabled !== false) {
    initContentGuard({ blockThreshold: config.contentGuard?.blockThreshold });
  }

  const dataDir = join(homedir(), '.cli2im');
  const mediaDir = join(dataDir, 'media');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(join(dataDir, 'logs'), { recursive: true });

  const store = await SessionStore.create(config.session.dbPath.replace('~', homedir()));
  const queue = new ChatQueue();
  const toolGate = new ToolGate(config.dangerousPatterns);
  const agentManager = new AgentManager(toolGate);
  const typingTimers = new Map<string, ReturnType<typeof setInterval>>();

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

  async function sendVoiceReply(
    adapter: PlatformAdapter,
    chatId: string,
    sessionKey: SessionKey,
    text: string,
  ): Promise<void> {
    const trimmed = text.trim();
    voiceSessions.delete(sessionKey);
    if (!trimmed) return;

    try {
      const audioBuffer = await synthesizeSpeech(trimmed);
      if (audioBuffer) {
        const asTg = adapter as PlatformAdapter & { sendVoice?: (c: string, b: Buffer) => Promise<void> };
        const asFs = adapter as PlatformAdapter & { sendAudio?: (c: string, b: Buffer) => Promise<void> };

        if (typeof asTg.sendVoice === 'function') {
          await asTg.sendVoice(chatId, audioBuffer);
          console.log(`[voice] TTS voice sent for ${sessionKey}`);
          return;
        }
        if (typeof asFs.sendAudio === 'function') {
          await asFs.sendAudio(chatId, audioBuffer);
          console.log(`[voice] TTS voice sent for ${sessionKey}`);
          return;
        }
      }
    } catch (err) {
      console.error(`[voice] TTS failed for ${sessionKey}:`, err instanceof Error ? err.message : err);
    }

    await adapter.send(chatId, { text: trimmed });
  }

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    if (name === 'claude-code') {
      agentManager.registerPlugin(new ClaudeCodePlugin(agentConfig.binary));
    } else if (name === 'codex') {
      agentManager.registerPlugin(new CodexPlugin(agentConfig.binary));
    } else if (name === 'gemini') {
      agentManager.registerPlugin(new GeminiPlugin(agentConfig.binary));
    }
  }

  const relayManager = new RelayManager();
  const adapters = new Map<string, PlatformAdapter>();
  const cardControllers = new Map<string, StreamingCardController>();
  const telegramStreams = new Map<string, TelegramStreamController>();
  const voiceSessions = new Map<SessionKey, string>();
  const messageProcessors = new Map<string, (msg: InboundMessage) => Promise<void>>();
  const runtimeState: RuntimeCommandState = {
    fastModeBySession: new Map(),
  };

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

  const handoffService = new HandoffService({
    spawnResume: async (sessionKey, agentName, sessionId, workDir) => {
      const handlers = createEventHandlers(sessionKey);
      const proc = agentManager.resumeAgent(
        sessionKey,
        agentName,
        sessionId,
        {
          workingDirectory: workDir,
          permissionMode: 'blacklist',
        },
        handlers,
      );
      return { pid: proc.pid, sessionId };
    },
    getSession: async (sessionKey) => store.getByKey(sessionKey),
    updateState: async (id, state) => store.updateState(id, state),
  });

  function createEventHandlers(sessionKey: SessionKey): AgentManagerEvents {
    const botName = sessionKey.split(':')[2];
    const chatId = sessionKey.split(':')[1];
    const cardController = cardControllers.get(botName);
    const tgStream = telegramStreams.get(botName);
    const adapter = adapters.get(botName);
    let voiceResponseBuffer = '';
    let relayTextBuffer = '';

    return {
      onEvent: async (_sk, event) => {
        const isVoiceSession = voiceSessions.has(sessionKey);
        console.log(`[event] ${sessionKey}: type=${event.type} voice=${isVoiceSession} hasCard=${!!cardController} hasTgStream=${!!tgStream}`);

        // Accumulate text for relay
        if (event.type === 'text') {
          relayTextBuffer += event.content;
        }

        if (isVoiceSession && adapter) {
          if (event.type === 'text' && event.content.trim()) {
            voiceResponseBuffer += event.content;
          } else if (event.type === 'error') {
            voiceResponseBuffer += `\n\nError: ${event.message}`;
          }
          cardController?.handleEvent(sessionKey, event);
          if (event.type === 'result' || event.type === 'error') {
            stopTyping(chatId);
            await sendVoiceReply(adapter, chatId, sessionKey, voiceResponseBuffer);
            voiceResponseBuffer = '';
          }
        } else if (cardController) {
          cardController.handleEvent(sessionKey, event);
        } else if (adapter) {
          if (event.type === 'text' && event.content.trim()) {
            if (tgStream) {
              tgStream.appendText(sessionKey, chatId, event.content);
            } else {
              await adapter.send(chatId, { text: event.content });
            }
          } else if (event.type === 'error') {
            stopTyping(chatId);
            if (tgStream) {
              tgStream.appendText(sessionKey, chatId, `\n\nError: ${event.message}`);
              await tgStream.finalize(sessionKey);
            } else {
              await adapter.send(chatId, { text: `Error: ${event.message}` });
            }
          } else if (event.type === 'result') {
            stopTyping(chatId);
            if (tgStream) {
              await tgStream.finalize(sessionKey);
            }
          }
        }

        // Trigger relay on result, reset on error
        if (event.type === 'result') {
          const trimmedRelay = relayTextBuffer.trim();
          const shouldRelay = trimmedRelay.length > 0 && !isTerminalRelayText(trimmedRelay);
          console.log(`[relay-trigger] ${botName}: len=${trimmedRelay.length} relay=${shouldRelay} preview=${trimmedRelay.slice(0, 100)}`);
          relayTextBuffer = '';
          if (shouldRelay) {
            await relayToOtherBots(botName, chatId, trimmedRelay, {
              relayManager,
              config,
              agentManager,
              adapters,
              messageProcessors,
              queue,
            });
          }
        }
        if (event.type === 'error') {
          relayTextBuffer = '';
        }

        if (event.type === 'result' && event.sessionId) {
          const session = await store.getByKey(sessionKey);
          if (session) {
            await store.updateAgentSessionId(session.id, event.sessionId);
          }
        }

        if (event.type === 'status' && event.sessionId) {
          const session = await store.getByKey(sessionKey);
          if (session) {
            await store.updateAgentSessionId(session.id, event.sessionId);
          }
        }

        if (event.type === 'file' && adapter?.sendFile) {
          await adapter.sendFile(chatId, {
            path: event.path,
            name: basename(event.path),
            mimeType: event.mimeType,
          });
        }

        if (event.type === 'result' && event.createdFiles?.length && adapter?.sendFile) {
          for (const path of event.createdFiles) {
            await adapter.sendFile(chatId, {
              path,
              name: basename(path),
            });
          }
        }
      },
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
                { text: '本会话允许', value: `perm:allow_session:${requestId}`, type: 'primary' },
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
      onProcessExit: async (sk, code) => {
        console.log(`[pipeline] ${sk}: process exited with code=${code}`);
        stopTyping(chatId);
        cardControllers.get(botName)?.interruptCard(sk);
        const isVoiceSession = voiceSessions.has(sk);
        if (isVoiceSession) {
          if (code !== 0) voiceResponseBuffer += `\n\n${buildCrashNotification(code)}`;
          if (voiceResponseBuffer.trim()) {
            await sendVoiceReply(adapter!, chatId, sk, voiceResponseBuffer);
          }
          voiceResponseBuffer = '';
        } else if (tgStream) {
          if (code !== 0) {
            tgStream.appendText(sk, chatId, `\n\n${buildCrashNotification(code)}`);
          }
          await tgStream.finalize(sk);
        } else if (code !== 0 && adapter) {
          await adapter.send(chatId, { text: buildCrashNotification(code) });
        }
      },
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

    adapter.onCallback?.((callback) => {
      const accepted = handlePermissionCallback(callback, agentManager);
      if (accepted) return;

      const resume = parseSessionResumeCallback(callback.data);
      if (resume) {
        void handleCLISessionResume({
          callback,
          resume,
          botName,
          botConfig,
          adapter,
          store,
          agentManager,
          handoffService,
          cardController: cardControllers.get(botName),
          tgStreamController: telegramStreams.get(botName),
        }).catch((err) => {
          console.error('[pipeline] CLI session resume failed:', err);
          void adapter.send(callback.chatId, {
            text: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
        return;
      }

      console.log(`[pipeline] Ignored callback: ${callback.data}`);
    });
  }

  function createMessageProcessor(
    botName: string,
    botConfig: BotConfig,
    adapter: PlatformAdapter,
  ): (msg: InboundMessage) => Promise<void> {
    return async (msg) => {
      console.log(`[pipeline] ${botName}: incoming ${msg.chatType} from=${msg.userId} isRelay=${!!msg.isRelay} mentions=${JSON.stringify(msg.mentions ?? [])} text=${msg.text.slice(0, 60)}`);

      // Lazy relay registration on first group message
      if (msg.chatType === 'group' && botConfig.relay?.enabled) {
        relayManager.registerBot(botName, msg.chatId, botConfig.relay.maxConsecutiveRounds ?? 10);
      }

      // Reset relay counter on human messages
      if (!msg.isRelay) {
        relayManager.onHumanMessage(msg.chatId);
      }

      const relayBotCount = relayManager.getBotsInChat(msg.chatId).length;
      console.log(`[pipeline] ${botName}: relayBotCount=${relayBotCount} botOpenId=${getAdapterBotOpenId(adapter) ?? 'none'}`);
      const groupSkipReason = getGroupMessageSkipReason(
        msg,
        botConfig,
        getAdapterBotOpenId(adapter),
        relayBotCount,
      );
      if (groupSkipReason) {
        console.log(`[pipeline] ${botName}: Rejected: ${groupSkipReason}`);
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

      if (config.newMessageBehavior === 'interrupt' && agentManager.hasProcess(sessionKey)) {
        agentManager.cancelAgent(sessionKey);
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
      await downloadInboundAttachments(msg, adapter, mediaDir);

      if (msg.isVoice) {
        const audioAttachment = msg.attachments?.find(a => a.type === 'audio' && a.localPath);
        if (audioAttachment?.localPath) {
          const audioBuffer = await readFile(audioAttachment.localPath);
          const format = audioAttachment.mimeType?.includes('ogg') ? 'ogg' : 'mp3';
          const transcript = await transcribeAudio(audioBuffer, format);
          if (transcript) {
            msg.text = transcript;
            msg.attachments = msg.attachments?.filter(a => a !== audioAttachment);
            voiceSessions.set(sessionKey, msg.chatId);
            console.log(`[voice] STT transcribed for ${sessionKey}: ${transcript.slice(0, 80)}`);
          } else {
            console.warn(`[voice] STT failed for ${sessionKey}, sending as attachment`);
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
      const isNewProcess = !agentManager.hasProcess(sessionKey);
      await cardController?.startCard(
        msg.chatId,
        sessionKey,
        botConfig.agent,
        isNewProcess ? 'Starting...' : undefined,
      );

      if (isNewProcess) {
        console.log(`[pipeline] ${botName}: spawning ${botConfig.agent} in ${session.workingDirectory}`);
        const handlers = createEventHandlers(sessionKey);

        const senderEnv = buildSenderEnv(sender);
        const larkCliEnv: Record<string, string> = botConfig.larkCliConfigDir
          ? { LARKSUITE_CLI_CONFIG_DIR: botConfig.larkCliConfigDir }
          : {};
        const spawnEnv = { ...config.agents[botConfig.agent]?.env, ...senderEnv, ...larkCliEnv };

        const spawnOpts: SpawnOpts = {
          workingDirectory: session.workingDirectory,
          permissionMode: botConfig.permissionMode,
          env: spawnEnv,
          model: config.agents[botConfig.agent]?.defaultModel,
          autoApprove: botConfig.autoApprove,
          turnTimeoutMs: botConfig.turnTimeoutMs,
          idleTimeoutMs: botConfig.idleTimeoutMs,
          sandboxMode: botConfig.sandboxMode,
          reasoningEffort: runtimeState.fastModeBySession.get(sessionKey) ? 'low' : undefined,
          initialPrompt: messageText,
        };

        const plugin = agentManager.getPlugin(botConfig.agent);
        if (session.agentSessionId && plugin?.capabilities.sessionResume) {
          console.log(`[pipeline] ${botName}: resuming session ${session.agentSessionId}`);
          agentManager.resumeAgent(
            sessionKey,
            botConfig.agent,
            session.agentSessionId,
            spawnOpts,
            handlers,
          );
        } else {
          console.log(`[pipeline] ${botName}: fresh spawn`);
          agentManager.spawnAgent(
            sessionKey,
            botConfig.agent,
            spawnOpts,
            handlers,
          );
        }
      }

      agentManager.sendMessage(sessionKey, botConfig.agent, userMessage);
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
  });

  await httpServer.start(config.server.host, config.server.port);

  for (const [botName, adapter] of adapters) {
    try {
      await adapter.connect();
      console.log(`[cli2im] Bot "${botName}" connected to ${adapter.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cli2im] Failed to connect bot "${botName}": ${message}`);
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

async function handleBridgeCommand(
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
  runtimeState: RuntimeCommandState,
  botConfig: BotConfig,
): Promise<void> {
  switch (cmd.command) {
    case 'new': {
      agentManager.killAgent(sessionKey);
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
      tgStreamController?.interrupt(sessionKey);
      await adapter.send(chatId, { text: '已发送中断信号' });
      break;
    }

    case 'kill': {
      agentManager.killAgent(sessionKey);
      cardController?.interruptCard(sessionKey);
      tgStreamController?.interrupt(sessionKey);
      await adapter.send(chatId, { text: '已强制终止进程' });
      break;
    }

    case 'cwd': {
      const newDir = cmd.args[0];
      if (!newDir) {
        await adapter.send(chatId, { text: '用法: /cwd <path>' });
        break;
      }
      if (!validateWorkingDirectory(newDir)) {
        await adapter.send(chatId, { text: `无效路径: \`${newDir}\`` });
        break;
      }
      const session = await store.getByKey(sessionKey);
      if (session) {
        await store.updateWorkingDirectory(session.id, newDir.replace('~', homedir()));
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
        workDir: '~',
        agentName: 'claude-code',
        chatId,
      });
      if (result.success) {
        await adapter.send(chatId, {
          text: buildHandoffNotification({ sessionId, workDir: '~', agentName: 'Claude Code' }),
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
        ? agentManager.denyPermission(requestId)
        : agentManager.approvePermission(requestId);
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
      const pending = agentManager.getPendingPermissionForChat(chatId);
      if (!pending) {
        await adapter.send(chatId, { text: '没有待审批的危险操作' });
        break;
      }
      const approved = agentManager.approvePermission(pending.requestId);
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

      const useGemini = sub === 'gemini' || (!sub && botConfig.agent === 'gemini');
      const useCodex = sub === 'codex' || (!sub && botConfig.agent === 'codex');
      const agentLabel = useGemini ? 'Gemini' : useCodex ? 'Codex' : 'Claude Code';
      const sessions = useGemini
        ? await new GeminiSessionScanner(join(homedir(), '.gemini')).scan()
        : useCodex
          ? await new CodexSessionScanner(join(homedir(), '.codex')).scan()
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

async function handleCLISessionResume(params: {
  callback: CallbackQuery;
  resume: { sessionId: string; cwd: string };
  botName: string;
  botConfig: BotConfig;
  adapter: PlatformAdapter;
  store: SessionStore;
  agentManager: AgentManager;
  handoffService: HandoffService;
  cardController: StreamingCardController | undefined;
  tgStreamController: TelegramStreamController | undefined;
}): Promise<void> {
  const { callback, resume, botName, botConfig, adapter, store, agentManager, handoffService } = params;
  if (!callback.chatId) {
    throw new Error('Missing chat id in callback');
  }

  const platform = callback.platform ?? 'feishu';
  const sessionKey: SessionKey = `${platform}:${callback.chatId}:${botName}`;
  agentManager.cancelAgent(sessionKey);
  params.cardController?.interruptCard(sessionKey);
  params.tgStreamController?.interrupt(sessionKey);

  let workDir = resume.cwd;
  if (!workDir) {
    const scanner = botConfig.agent === 'gemini'
      ? new GeminiSessionScanner(join(homedir(), '.gemini'))
      : botConfig.agent === 'codex'
        ? new CodexSessionScanner(join(homedir(), '.codex'))
        : new CLISessionScanner(join(homedir(), '.claude'));
    const sessions = await scanner.scan();
    const match = sessions.find((s) => s.sessionId === resume.sessionId);
    workDir = match?.cwd || homedir();
  }

  const agentName = botConfig.agent;
  const session = await store.getOrCreate(sessionKey, {
    agentName,
    workingDirectory: workDir,
  });
  await store.updateAgentSessionId(session.id, resume.sessionId);
  await store.updateWorkingDirectory(session.id, workDir);
  await store.updateState(session.id, 'active');
  await store.touch(session.id);

  const result = await handoffService.acceptHandoff({
    botName,
    sessionId: resume.sessionId,
    workDir,
    agentName,
    chatId: callback.chatId,
    platform: callback.platform,
  });

  if (!result.success) {
    await adapter.send(callback.chatId, { text: `Resume failed: ${result.error}` });
    return;
  }

  await adapter.send(callback.chatId, {
    text: buildHandoffNotification({
      sessionId: resume.sessionId,
      workDir,
      agentName,
    }),
  });
}

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function getAdapterBotOpenId(adapter: PlatformAdapter): string | undefined {
  const candidate = adapter as PlatformAdapter & { getBotOpenId?: () => string | undefined };
  return candidate.getBotOpenId?.();
}

main().catch((err) => {
  console.error('[cli2im] Fatal error:', err);
  process.exit(1);
});
