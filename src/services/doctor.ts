import type { AgentPlugin, AppConfig } from '../types.js';
import type { BotRuntimeStatus } from '../runtime/bot-lifecycle.js';

export type DoctorState = 'ok' | 'warning' | 'error' | 'unknown' | 'off';

export interface DoctorCheck {
  key: string;
  title: string;
  state: DoctorState;
  detail: string;
}

export interface ServiceInventoryEntry {
  service: string;
  purpose: string;
  data: string;
  usedBy: string[];
}

export interface DoctorOptions {
  config: AppConfig;
  lifecycle?: readonly BotRuntimeStatus[];
  getPlugin?: (name: string) => Pick<AgentPlugin, 'preflight'> | undefined;
  network?: { state: 'ok' | 'error' | 'unknown'; detail: string };
  contentGuard?: 'active' | 'unavailable' | 'disabled';
  speechKeyConfigured: boolean;
  activeTasks?: number;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  services: ServiceInventoryEntry[];
}

/** No message sending, login attempts, raw configuration, credential values or chat text. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { config } = options;
  const checks: DoctorCheck[] = [];
  const activeBots = Object.entries(config.bots).filter(([, bot]) => bot.enabled !== false);
  const agents = [...new Set(activeBots.map(([, bot]) => bot.agent))];

  checks.push({
    key: 'network', title: '代理', state: options.network?.state ?? 'unknown',
    detail: options.network?.detail ?? '尚未检查当前代理；不能据此判断是否存在直连或 DNS 绕行。',
  });
  checks.push({
    key: 'active-tasks', title: '正在运行的任务',
    state: Number.isInteger(options.activeTasks) && options.activeTasks! >= 0 ? 'ok' : 'unknown',
    detail: Number.isInteger(options.activeTasks) && options.activeTasks! >= 0 ? `${options.activeTasks} 个` : '尚未取得任务运行状态。',
  });

  for (const [name, bot] of Object.entries(config.bots)) {
    const runtime = options.lifecycle?.find((item) => item.name === name);
    let state: DoctorState = 'unknown';
    let detail = '已配置；尚未取得运行状态。';
    if (bot.enabled === false || runtime?.state === 'disabled') {
      state = 'off'; detail = '已停用。';
    } else if (runtime?.state === 'failed') {
      state = 'error'; detail = '启动或停止失败，请查看已脱敏的运行日志。';
    } else if (runtime?.state === 'running') {
      state = 'ok'; detail = '本地连接流程已启动；未发送验证消息，不能证明远端可正常收发。';
    } else if (runtime?.state === 'stopped') {
      state = 'off'; detail = '已停止。';
    } else if (runtime) {
      state = 'warning'; detail = runtime.state === 'starting' ? '正在启动。' : '正在停止。';
    }
    checks.push({ key: `bot:${name}`, title: `机器人 ${name}`, state, detail });
    if (bot.enabled !== false) {
      checks.push({
        key: `speech:${name}`, title: `${name} 语音`,
        state: bot.speech?.stt === false && bot.speech?.tts === false ? 'off' : options.speechKeyConfigured ? 'unknown' : 'warning',
        detail: `识别${bot.speech?.stt === false ? '关闭' : '开启'}；回复${bot.speech?.tts === false ? '关闭' : '开启'}。${options.speechKeyConfigured ? '密钥已配置；尚未联网验证额度和服务可用性。' : '尚未配置语音服务密钥。'}`,
      });
    }
  }

  const agentChecks = await Promise.all(agents.map(async (name): Promise<DoctorCheck[]> => {
    const plugin = options.getPlugin?.(name);
    let binaryState: DoctorState = 'unknown';
    let binaryDetail = '尚未检查本地程序。';
    if (plugin) {
      try {
        const result = await plugin.preflight();
        binaryState = result.ok ? 'ok' : 'error';
        binaryDetail = result.ok ? '本地程序基础检查通过；这不代表账号可用。' : '本地程序基础检查失败，请检查安装与本地配置。';
      } catch {
        binaryState = 'error';
        binaryDetail = '本地程序检查失败；错误详情未输出，避免带出凭据。';
      }
    }
    return [
      { key: `agent:${name}`, title: `${name} 程序`, state: binaryState, detail: binaryDetail },
      { key: `login:${name}`, title: `${name} 登录`, state: 'unknown', detail: '尚未验证账号是否有效；程序存在或凭据文件存在不等于登录有效。' },
    ];
  }));
  checks.push(...agentChecks.flat());

  const guard = config.contentGuard?.enabled === false ? 'disabled' : options.contentGuard;
  checks.push({
    key: 'content-guard', title: '外部内容检测',
    state: guard === 'active' ? 'ok' : guard === 'disabled' ? 'off' : guard === 'unavailable' ? 'warning' : 'unknown',
    detail: guard === 'active' ? '检测器已加载；仅检查接入的外部工具输出，不代替权限或运行隔离。'
      : guard === 'disabled' ? '已关闭。'
        : guard === 'unavailable' ? '配置要求开启，但检测器未加载，当前没有这项保护。' : '尚未取得检测器实际加载状态。',
  });

  return { checks, services: buildServiceInventory(config) };
}

/** Inventory follows active bots and actual bridge integrations, never NO_PROXY names. */
export function buildServiceInventory(config: AppConfig): ServiceInventoryEntry[] {
  const bots = Object.entries(config.bots).filter(([, bot]) => bot.enabled !== false);
  const services: ServiceInventoryEntry[] = [];
  for (const platform of ['feishu', 'telegram'] as const) {
    const usedBy = bots.filter(([, bot]) => bot.platform === platform).map(([name]) => name);
    if (usedBy.length) services.push({
      service: platform === 'feishu' ? '飞书 / Lark' : 'Telegram',
      purpose: '接收消息、发送回复和文件',
      data: '机器人对话、回复、附件及平台要求的会话标识', usedBy,
    });
  }
  for (const agent of [...new Set(bots.map(([, bot]) => bot.agent))]) {
    services.push({
      service: `${agent} 所配置的模型服务`,
      purpose: '处理任务和生成回复；实际供应商及地址以该 CLI 配置为准',
      data: '发给 AI 的提示、相关对话、附件及任务所需的文件或工具结果',
      usedBy: bots.filter(([, bot]) => bot.agent === agent).map(([name]) => name),
    });
  }
  const sttBots = bots.filter(([, bot]) => bot.speech?.stt !== false).map(([name]) => name);
  const ttsBots = bots.filter(([, bot]) => bot.speech?.tts !== false).map(([name]) => name);
  if (sttBots.length) services.push({ service: 'DashScope 语音识别', purpose: '将语音转成文字', data: '用户发送的完整语音文件', usedBy: sttBots });
  if (ttsBots.length) services.push({ service: 'DashScope 语音回复', purpose: '将回复转成语音', data: '需要朗读的回复文字', usedBy: ttsBots });
  return services;
}

export function formatDoctorReport(report: DoctorReport): string {
  const states: Record<DoctorState, string> = { ok: '通过', warning: '需处理', error: '异常', unknown: '未验证', off: '关闭' };
  return report.checks.map((check) => `[${states[check.state]}] ${check.title}：${check.detail}`).join('\n');
}

export function formatServiceInventory(entries: ServiceInventoryEntry[]): string {
  return entries.map((entry) => `${entry.service}\n用途：${entry.purpose}\n会发送：${entry.data}\n使用者：${entry.usedBy.join('、')}`).join('\n\n');
}
