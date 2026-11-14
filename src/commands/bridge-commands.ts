import { realpath, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import type { AgentManager } from '../agents/manager.js';
import { contains } from '../isolation/policy.js';
import { expandHome } from '../media.js';
import { handleMemoryCommand, type MemoryCommandContext } from '../memory/commands.js';
import type { CodexNotificationService } from '../notifications/service.js';
import type { StreamingCardController } from '../platforms/feishu/cards.js';
import {
  buildCLISessionCard,
  buildHandoffReleaseNotification,
} from '../platforms/feishu/markdown.js';
import { buildCLISessionText } from '../platforms/telegram/markdown.js';
import type { TelegramStreamController } from '../platforms/telegram/stream.js';
import type { BotLifecycle } from '../runtime/bot-lifecycle.js';
import { buildControlPanel } from '../runtime/control-panel.js';
import { resolveExecutionScope } from '../runtime/execution-scope.js';
import { ProjectRegistry, buildProjectPanel } from '../runtime/projects.js';
import type { RecoveredResult } from '../runtime/result-recovery.js';
import { handleCLISessionResume, scanAgentSessions } from '../runtime/session-resume.js';
import { clearSessionScopedBuffers } from '../runtime/session-scoped-cleanup.js';
import { textPage } from '../runtime/text-page.js';
import { canAccessSession, getBotAccessRejection, isBotAdmin } from '../security/access-policy.js';
import type { HandoffService } from '../services/handoff.js';
import type { ChatQueue } from '../session/queue.js';
import type { RuntimePreferences, SessionStore } from '../session/store.js';
import type { BotConfig, PlatformAdapter, SessionKey } from '../types.js';
import type { SessionProvenance } from '../isolation/provenance.js';

export interface RuntimeCommandState {
  fastModeBySession: Map<SessionKey, boolean>;
}

export interface BridgeControls {
  resumeIsolated?: Parameters<typeof handleCLISessionResume>[0]['resumeIsolated'];
  isolatedSessions?: () => Promise<SessionProvenance[]>;
  memory?: MemoryCommandContext;
  defaultModel?: string;
  defaultEffort?: string;
  queue?: ChatQueue;
  lifecycle?: BotLifecycle;
  runPrompt?: (prompt: string) => Promise<void>;
  doctor?: () => Promise<string>;
  capturePreparation?: (key: SessionKey) => () => void;
  cancelScope?: (key: SessionKey) => void;
  readResult?: (key: SessionKey) => Promise<RecoveredResult | null>;
  controlBot?: (name: string, action: 'start' | 'stop' | 'restart' | 'reload') => Promise<void>;
  reloadConfig?: () => Promise<{ reloadedAt: number; updatedBots: string[]; warnings: string[] }>;
}

export interface BridgeCommandSender {
  platform: string;
  chatType?: string;
  userId: string;
  threadId?: string;
  messageId?: string;
}

export async function resolveStrictDirectory(path: string): Promise<string> {
  const resolved = await realpath(expandHome(path));
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Invalid working directory: ${path}`);
  }
  return resolved;
}

export function isPathWithinAnyRoot(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, path);
    return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith('/'));
  });
}

function formatDateTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
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
    if (botConfig.isolation?.enabled) return [];
    const sessions = await store.listByBot(botName);
    return (
      await Promise.all(
        sessions.map(async (session) =>
          (await canAccessSession({ bot: botConfig, actor, sessionKey, session })) ? session : null,
        ),
      )
    ).filter((session): session is NonNullable<typeof session> => session !== null);
  };
  const projects = new ProjectRegistry({
    projects: botConfig.projects,
    shortcuts: botConfig.shortcuts,
    validateDirectory: async (candidate) => {
      const path = await resolveStrictDirectory(candidate);
      if (botConfig.isolation?.enabled) {
        if (!contains(resolveExecutionScope(botConfig, actor).workingDirectory, path)) {
          throw new Error('目录不在当前隔离范围');
        }
        return path;
      }
      if (isBotAdmin(botConfig, actor.userId)) return path;
      const roots = [
        resolveExecutionScope(botConfig, actor).workingDirectory,
        ...Object.values(botConfig.projects ?? {}),
      ];
      const canonicalRoots = await Promise.all(
        roots.map((root) => resolveStrictDirectory(root).catch(() => '')),
      );
      if (!isPathWithinAnyRoot(path, canonicalRoots.filter(Boolean))) {
        throw new Error('这个目录不在当前机器人的项目范围内');
      }
      return path;
    },
    loadRecent: async (key) => (await store.getPreferences(key as SessionKey)).recentDirectories ?? [],
    saveRecent: async (key, recentDirectories) =>
      store.updatePreferences(key as SessionKey, { recentDirectories }),
  });

  switch (cmd.command) {
    case 'remember':
    case 'memory':
    case 'forget': {
      if (getBotAccessRejection(actor, botConfig)) return;
      await adapter.send(chatId, {
        text: await handleMemoryCommand(cmd, botConfig, actor.userId, controls.memory),
        plainText: true,
      });
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

    case 'watch': {
      const sub = cmd.args[0]?.toLowerCase();
      if (sub === 'off' || sub === 'clear' || sub === 'disable') {
        const removed = await store.removeWatchTarget(botName);
        await adapter.send(chatId, {
          text: removed ? `已取消 ${botName} 的默认推送绑定。` : `${botName} 当前未绑定主动推送目标。`,
        });
        break;
      }
      if (sub === 'status') {
        const current = await store.getWatchTarget(botName);
        await adapter.send(chatId, {
          text: current
            ? `${botName} 已绑定到 ${current.platform} 会话（${current.threadId ? '话题/线程' : '当前会话'}），更新于 ${new Date(current.updatedAt).toISOString()}。发送 /watch off 可解绑。`
            : `${botName} 尚未绑定主动推送目标。在目标会话发送 /watch 即可绑定。`,
        });
        break;
      }
      const platform = (commandSender?.platform || botConfig.platform) as 'feishu' | 'telegram';
      await store.setWatchTarget({
        botName,
        platform,
        chatId,
        threadId: commandSender?.threadId,
        userId: commandSender?.userId || actor.userId || botConfig.allowFrom[0] || '',
        updatedAt: Date.now(),
      });
      await adapter.send(chatId, {
        text: `已将此会话设为 ${botName} 的默认通知接收窗口（cli2im notify --bot ${botName} --message "..." 将投递至此）。发送 /watch off 可取消绑定。`,
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
      const supported = ['/new', '/projects', '/model', '/effort', '/status', '/stop'];
      if (agentManager.getPlugin(botConfig.agent)?.capabilities.sessionResume) supported.push('/sessions');
      await adapter.send(chatId, {
        card: buildControlPanel({
          botName,
          agentName: botConfig.agent,
          model: prefs.model ?? controls.defaultModel,
          effort: prefs.effort ?? controls.defaultEffort,
          projectName: session?.workingDirectory ?? botConfig.workingDirectory,
          running,
          queued: controls.queue?.status(sessionKey).pending,
          error: prefs.taskState === 'interrupted' ? '上次任务中途停止，未自动重跑' : undefined,
          supportedCommands: supported,
        }),
      });
      break;
    }

    case 'projects': {
      if (cmd.args.length) {
        await handleBridgeCommand(
          { command: 'cwd', args: [cmd.args.join(' ')] },
          sessionKey,
          botName,
          chatId,
          adapter,
          store,
          agentManager,
          handoffService,
          cardController,
          tgStreamController,
          voiceSessions,
          runtimeState,
          botConfig,
          commandSender,
          notificationService,
          controls,
        );
      } else {
        await adapter.send(chatId, { card: buildProjectPanel(await projects.list(sessionKey)) });
      }
      break;
    }

    case 'task': {
      if (!cmd.args[0]) {
        const shortcuts = projects.listShortcuts();
        await adapter.send(chatId, {
          text: shortcuts.length
            ? shortcuts.map((item) => `/task ${item.name} · ${item.description}`).join('\n')
            : '尚未配置快捷任务',
        });
        break;
      }
      try {
        const shortcut = await projects.resolveShortcut(sessionKey, cmd.args[0]);
        if (shortcut.directory) {
          if ((await store.getPreferences(sessionKey)).taskState === 'running') {
            throw new Error('请先停止当前任务再切换项目');
          }
          controls.cancelScope?.(sessionKey);
          agentManager.forgetSession(sessionKey);
          const current = await store.getOrCreate(sessionKey, {
            agentName: botConfig.agent,
            workingDirectory: shortcut.directory,
          });
          await store.updateWorkingDirectory(current.id, shortcut.directory);
          await store.clearAgentSessionId(current.id);
          store.save();
        }
        if (!controls.runPrompt) throw new Error('当前入口不支持快捷任务');
        await controls.runPrompt(shortcut.prompt);
      } catch (error) {
        await adapter.send(chatId, { text: error instanceof Error ? error.message : '快捷任务失败' });
      }
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

    case 'diff-review': {
      if (!controls.runPrompt) {
        await adapter.send(chatId, { text: '当前入口不支持触发代码审查' });
        break;
      }
      if ((await store.getPreferences(sessionKey)).taskState === 'running') {
        await adapter.send(chatId, { text: '请等待当前任务完成，或先 /stop 再执行代码审查' });
        break;
      }
      const focus = cmd.args.join(' ').trim();
      const prompt =
        '请对当前工作区执行代码审查：运行 `git status --short` 与 `git diff`（若工作区干净，则查看最近一次提交 `git show --stat` 与 `git diff HEAD~1`），按严重程度（High / Medium / Low）列出潜在 Bug、回归风险、安全隐患与缺失测试，并给出具体修复建议。'
        + (focus ? `\n\n重点关注：${focus}` : '');
      await controls.runPrompt(prompt);
      break;
    }

    case 'doctor': {
      if (!isBotAdmin(botConfig, actor.userId)) {
        await adapter.send(chatId, { text: '只有该机器人的管理员可以查看运行诊断' });
        break;
      }
      const report = controls.doctor ? await controls.doctor() : '运行诊断未接入';
      await adapter.send(chatId, { text: textPage(report, cmd.args[0], 'doctor'), plainText: true });
      break;
    }

    case 'bots': {
      if (!isBotAdmin(botConfig, actor.userId) || !controls.lifecycle) {
        await adapter.send(chatId, { text: '只有该机器人的管理员可以管理启停' });
        break;
      }
      const [action, target = botName] = cmd.args;
      if (target !== botName) {
        await adapter.send(chatId, { text: '请通过目标机器人或本机管理命令操作，避免跨机器人更改' });
        break;
      }
      if (!action) {
        await adapter.send(chatId, { text: `${botName}: ${controls.lifecycle.status(botName).state}` });
        break;
      }
      if (action === 'config-reload') {
        if (!controls.reloadConfig) {
          await adapter.send(chatId, { text: '当前入口不支持配置热重载' });
          break;
        }
        const res = await controls.reloadConfig();
        const warnText = res.warnings.length > 0 ? `\n提示：${res.warnings.join('；')}` : '';
        await adapter.send(chatId, {
          text: `配置已零中断热重载：更新 ${res.updatedBots.length} 个机器人（无需重启活跃进程）。${warnText}`,
        });
        break;
      }
      if (!['start', 'stop', 'restart', 'reload'].includes(action)) {
        await adapter.send(chatId, { text: '用法：/bots start|stop|restart|reload|config-reload' });
        break;
      }
      if (action === 'reload' && !controls.controlBot) {
        await adapter.send(chatId, { text: '当前入口不支持插件热重载' });
        break;
      }
      await adapter.send(chatId, {
        text:
          action === 'reload'
            ? '正在热重载当前机器人插件，不影响运行中任务。'
            : `正在${action === 'stop' ? '停止' : action === 'start' ? '启动' : '重启'}当前机器人，当前任务会中断。`,
      });
      if (controls.controlBot) {
        await controls.controlBot(botName, action as 'start' | 'stop' | 'restart' | 'reload');
        break;
      }
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
      if ((await store.getPreferences(sessionKey)).taskState === 'running') {
        await store.updatePreferences(sessionKey, { taskState: 'interrupted', taskUpdatedAt: Date.now() });
      }
      await adapter.send(chatId, { text: '已发送中断信号' });
      break;
    }

    case 'kill': {
      agentManager.killAgent(sessionKey);
      cardController?.interruptCard(sessionKey);
      clearSessionScopedBuffers(sessionKey, { voiceSessions, tgStreamController });
      if ((await store.getPreferences(sessionKey)).taskState === 'running') {
        await store.updatePreferences(sessionKey, { taskState: 'interrupted', taskUpdatedAt: Date.now() });
      }
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
      const session = await store.getOrCreate(sessionKey, {
        agentName: botConfig.agent,
        workingDirectory: resolvedNewDir,
      });
      await store.updateWorkingDirectory(session.id, resolvedNewDir);
      await store.clearAgentSessionId(session.id);
      await store.updatePreferences(sessionKey, { taskState: undefined, taskUpdatedAt: undefined });
      store.save();
      await adapter.send(chatId, {
        text: `工作目录已切换到 ${resolvedNewDir}，下一条消息会新建该项目的对话`,
      });
      break;
    }

    case 'switch':
    case 'resume': {
      const sessionId = cmd.args[0];
      if (!sessionId || !commandSender) {
        await adapter.send(chatId, { text: '用法：/resume <历史对话编号>' });
        break;
      }
      await handleCLISessionResume({
        callback: { ...commandSender, chatId, data: '', messageId: commandSender.messageId ?? '' },
        resume: { sessionId, cwd: '' },
        botName,
        botConfig,
        adapter,
        store,
        agentManager,
        handoffService,
        cardController,
        tgStreamController,
        ensureReady: controls.capturePreparation?.(sessionKey),
        resumeIsolated: controls.resumeIsolated,
      });
      store.save();
      break;
    }

    case 'handoff': {
      if (botConfig.isolation?.enabled) {
        await adapter.send(chatId, { text: '隔离机器人禁用 handoff' });
        break;
      }
      try {
        const result = await handoffService.releaseHandoff(sessionKey);
        controls.cancelScope?.(sessionKey);
        if ((await store.getPreferences(sessionKey)).taskState === 'running') {
          await store.updatePreferences(sessionKey, { taskState: 'interrupted', taskUpdatedAt: Date.now() });
        }
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

      const accepted =
        decision === 'deny'
          ? agentManager.denyPermission(sessionKey, requestId)
          : agentManager.approvePermission(sessionKey, requestId);
      if (!accepted) {
        await adapter.send(chatId, { text: `审批失败或已过期: \`${requestId}\`` });
        break;
      }

      await adapter.send(chatId, {
        text:
          decision === 'deny'
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
      if (botConfig.isolation?.enabled) {
        const records = (await controls.isolatedSessions?.()) ?? [];
        await adapter.send(chatId, {
          text: records.length
            ? records.map((r) => `- ${r.agentSessionId}`).join('\n')
            : '当前隔离范围没有可恢复的会话',
        });
        break;
      }
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

      const requestedAgent =
        ({
          codex: 'codex',
          gemini: 'gemini',
          agy: 'agy',
          antigravity: 'agy',
          claude: 'claude-code',
        } as Record<string, string>)[sub ?? ''] ?? botConfig.agent;
      if (requestedAgent !== botConfig.agent) {
        await adapter.send(chatId, { text: '请在对应 AI 的机器人中查看历史对话' });
        break;
      }
      const agentLabel = agentManager.getPlugin(botConfig.agent)?.displayName ?? botConfig.agent;
      const bindings = await store.listSessionAccess(sessionKey);
      const sessions = await scanAgentSessions(botConfig.agent, {
        accept: async (candidate) => {
          const binding = bindings.find(
            (item) => item.agentName === botConfig.agent && item.agentSessionId === candidate.sessionId,
          );
          return canAccessSession({
            bot: botConfig,
            actor,
            sessionKey,
            session: binding ?? { ...candidate, agentName: botConfig.agent },
          });
        },
      });

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
        const prefs = await store.getPreferences(sessionKey);
        const selected = prefs.model ?? controls.defaultModel ?? 'AI 默认模型';
        const candidates = buildModelCandidates(botConfig.agent, controls.defaultModel, prefs.model);
        await adapter.send(chatId, {
          card: {
            type: 'final',
            title: '切换模型',
            content: `当前选择：**${selected}**${controls.defaultModel ? `\n默认配置：\`${controls.defaultModel}\`` : ''}\n点击下方按钮切换，或发送 \`/model <模型名>\`（\`/model default\` 恢复默认）。`,
            buttons: candidates.map((item) => ({
              text: item === 'default'
                ? (prefs.model ? '恢复默认' : '✓ 默认')
                : item === prefs.model
                  ? `✓ ${item}`
                  : item,
              value: `model:${item}`,
              type: (item === prefs.model || (item === 'default' && !prefs.model)) ? 'primary' : 'default',
            })),
          },
        });
        break;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:/\[\]-]{0,127}$/.test(model)) {
        await adapter.send(chatId, { text: '模型名格式无效' });
        break;
      }
      if ((await store.getPreferences(sessionKey)).taskState === 'running') {
        await adapter.send(chatId, { text: '请等待当前任务完成，或先 /stop 再切换模型' });
        break;
      }
      await store.updatePreferences(sessionKey, { model: model === 'default' ? undefined : model });
      agentManager.killAgent(sessionKey);
      await adapter.send(chatId, {
        text: `模型选择已保存：${model === 'default' ? '默认模型' : model}；下一条消息启动时使用。模型是否可用由该 AI 服务确认。`,
      });
      break;
    }

    case 'effort': {
      const rawLevel = cmd.args[0]?.toLowerCase();
      if (!rawLevel) {
        const prefs = await store.getPreferences(sessionKey);
        const fastMode = runtimeState.fastModeBySession.get(sessionKey) ?? false;
        const effective = fastMode ? 'low (fast)' : (prefs.effort ?? controls.defaultEffort ?? '默认');
        const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'default'] as const;
        await adapter.send(chatId, {
          card: {
            type: 'final',
            title: '切换推理强度 (Effort)',
            content: `当前推理强度：**${effective}**${controls.defaultEffort ? `\n默认配置：\`${controls.defaultEffort}\`` : ''}\n点击下方按钮切换，或发送 \`/effort <low|medium|high|xhigh|max|default>\`。`,
            buttons: levels.map((item) => ({
              text: item === 'default'
                ? (prefs.effort ? '恢复默认' : '✓ 默认')
                : item === prefs.effort
                  ? `✓ ${item}`
                  : item,
              value: `effort:${item}`,
              type: (item === prefs.effort || (item === 'default' && !prefs.effort)) ? 'primary' : 'default',
            })),
          },
        });
        break;
      }
      if (rawLevel !== 'default' && !VALID_EFFORT_LEVELS.has(rawLevel)) {
        await adapter.send(chatId, { text: '无效的推理强度，可选值：low、medium、high、xhigh、max、default' });
        break;
      }
      if ((await store.getPreferences(sessionKey)).taskState === 'running') {
        await adapter.send(chatId, { text: '请等待当前任务完成，或先 /stop 再调整推理强度' });
        break;
      }
      await store.updatePreferences(sessionKey, {
        effort: rawLevel === 'default' ? undefined : rawLevel as RuntimePreferences['effort'],
      });
      if (rawLevel !== 'default') {
        runtimeState.fastModeBySession.delete(sessionKey);
      }
      agentManager.killAgent(sessionKey);
      await adapter.send(chatId, {
        text: `推理强度已保存：${rawLevel === 'default' ? '默认' : rawLevel}；下一条消息启动时使用。`,
      });
      break;
    }

    default:
      await adapter.send(chatId, { text: `未知指令: /${cmd.command}` });
  }
}

const VALID_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

const AGENT_MODEL_PRESETS: Record<string, string[]> = {
  'claude-code': ['claude-opus-5-5[1m]', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  codex: ['gpt-6-astra', 'gpt-5.4', 'gpt-5.3-codex', 'o3'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  agy: ['gemini-4-argon-high', 'gemini-4-carbon-high', 'gemini-3.8-flash-high', 'claude-opus-5-5-high'],
  'kimi-work': ['k3-agent'],
  zcode: [],
};

function buildModelCandidates(agent: string, defaultModel?: string, currentModel?: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (item?: string) => {
    // Keep Telegram inline button callback_data ("model:<id>") safely within 64 bytes.
    if (!item || seen.has(item) || item.length > 56) return;
    seen.add(item);
    ordered.push(item);
  };
  push(currentModel);
  push(defaultModel);
  for (const preset of AGENT_MODEL_PRESETS[agent] ?? []) {
    push(preset);
  }
  ordered.push('default');
  return ordered;
}
