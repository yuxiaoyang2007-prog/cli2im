import { loadConfig } from './config/loader.js';
import { SessionStore } from './session/store.js';
import { ChatQueue } from './session/queue.js';
import { AgentManager, type AgentManagerEvents } from './agents/manager.js';
import { ToolGate } from './agents/tool-gate.js';
import { ClaudeCodePlugin } from './agents/claude-code.js';
import { CodexPlugin } from './agents/codex.js';
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
} from './platforms/feishu/markdown.js';
import { validateWorkingDirectory } from './security/validators.js';
import {
  buildUserMessageForAgent,
  downloadInboundAttachments,
} from './media.js';
import { initContentGuard } from './security/content-guard.js';
import { handlePermissionCallback } from './runtime/callbacks.js';
import type { SessionKey, InboundMessage, PlatformAdapter, BotConfig } from './types.js';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { mkdirSync } from 'node:fs';

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

  const dataDir = join(homedir(), '.cli2im');
  const mediaDir = join(dataDir, 'media');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(join(dataDir, 'logs'), { recursive: true });

  const store = await SessionStore.create(config.session.dbPath.replace('~', homedir()));
  const queue = new ChatQueue();
  const toolGate = new ToolGate(config.dangerousPatterns);
  const agentManager = new AgentManager(toolGate);

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    if (name === 'claude-code') {
      agentManager.registerPlugin(new ClaudeCodePlugin(agentConfig.binary));
    } else if (name === 'codex') {
      agentManager.registerPlugin(new CodexPlugin(agentConfig.binary));
    }
  }

  const adapters = new Map<string, PlatformAdapter>();
  const cardControllers = new Map<string, StreamingCardController>();
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
    const adapter = adapters.get(botName);

    return {
      onEvent: async (_sk, event) => {
        cardController?.handleEvent(sessionKey, event);

        if (!cardController && adapter) {
          if (event.type === 'text' && event.content.trim()) {
            await adapter.send(chatId, { text: event.content });
          } else if (event.type === 'error') {
            await adapter.send(chatId, { text: `Error: ${event.message}` });
          }
        }

        if (event.type === 'result' && event.sessionId) {
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
        cardControllers.get(botName)?.interruptCard(sk);
        if (code !== 0 && adapter) {
          await adapter.send(chatId, { text: buildCrashNotification(code) });
        }
      },
    };
  }

  for (const [botName, adapter] of adapters) {
    const botConfig = config.bots[botName];
    const processMessage = createMessageProcessor(botName, botConfig, adapter);

    adapter.onMessage((msg: InboundMessage) => {
      void queue.enqueue(msg.chatId, () => processMessage(msg)).catch((err) => {
        console.error('[pipeline] Message processing failed:', err);
      });
    });

    adapter.onCallback?.((callback) => {
      const accepted = handlePermissionCallback(callback, agentManager);
      if (!accepted) {
        console.log(`[pipeline] Ignored callback: ${callback.data}`);
      }
    });
  }

  function createMessageProcessor(
    botName: string,
    botConfig: BotConfig,
    adapter: PlatformAdapter,
  ): (msg: InboundMessage) => Promise<void> {
    return async (msg) => {
      const groupSkipReason = getGroupMessageSkipReason(
        msg,
        botConfig,
        getAdapterBotOpenId(adapter),
      );
      if (groupSkipReason) {
        console.log(`[pipeline] Rejected: ${groupSkipReason}`);
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
          runtimeState,
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
      }

      const sender = { channel: msg.platform, userId: msg.userId, userName: msg.userName };

      const cardController = cardControllers.get(botName);
      const isNewProcess = !agentManager.hasProcess(sessionKey);
      console.log(`[pipeline] ${sessionKey}: isNewProcess=${isNewProcess}`);
      await cardController?.startCard(
        msg.chatId,
        sessionKey,
        botConfig.agent,
        isNewProcess ? 'Starting...' : undefined,
      );

      if (isNewProcess) {
        const handlers = createEventHandlers(sessionKey);

        const senderEnv = buildSenderEnv(sender);
        const larkCliEnv: Record<string, string> = botConfig.larkCliConfigDir
          ? { LARKSUITE_CLI_CONFIG_DIR: botConfig.larkCliConfigDir }
          : {};
        const spawnEnv = { ...config.agents[botConfig.agent]?.env, ...senderEnv, ...larkCliEnv };

        if (session.agentSessionId) {
          agentManager.resumeAgent(
            sessionKey,
            botConfig.agent,
            session.agentSessionId,
            {
              workingDirectory: session.workingDirectory,
              permissionMode: botConfig.permissionMode,
              env: spawnEnv,
              model: config.agents[botConfig.agent]?.defaultModel,
              autoApprove: botConfig.autoApprove,
              turnTimeoutMs: botConfig.turnTimeoutMs,
              idleTimeoutMs: botConfig.idleTimeoutMs,
              sandboxMode: botConfig.sandboxMode,
              reasoningEffort: runtimeState.fastModeBySession.get(sessionKey) ? 'low' : undefined,
            },
            handlers,
          );
        } else {
          agentManager.spawnAgent(
            sessionKey,
            botConfig.agent,
            {
              workingDirectory: session.workingDirectory,
              permissionMode: botConfig.permissionMode,
              env: spawnEnv,
              model: config.agents[botConfig.agent]?.defaultModel,
              autoApprove: botConfig.autoApprove,
              turnTimeoutMs: botConfig.turnTimeoutMs,
              idleTimeoutMs: botConfig.idleTimeoutMs,
              sandboxMode: botConfig.sandboxMode,
              reasoningEffort: runtimeState.fastModeBySession.get(sessionKey) ? 'low' : undefined,
            },
            handlers,
          );
        }
      }

      const senderHeader = buildSenderHeader(sender);
      const messageText = senderHeader + msg.text;
      await downloadInboundAttachments(msg, adapter, mediaDir);
      const userMessage = await buildUserMessageForAgent(
        botConfig.agent,
        messageText,
        msg.attachments,
      );

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
  runtimeState: RuntimeCommandState,
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
      await adapter.send(chatId, { text: '已发送中断信号' });
      break;
    }

    case 'kill': {
      agentManager.killAgent(sessionKey);
      cardController?.interruptCard(sessionKey);
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
