import type { CardPayload } from '../types.js';

const CONTROLS = [
  ['new', '新对话', '/new'],
  ['sessions', '历史对话', '/sessions'],
  ['projects', '换项目', '/projects'],
  ['stop', '停止', '/stop'],
  ['status', '刷新状态', '/status'],
] as const;

export interface ControlPanelState {
  botName: string;
  agentName: string;
  model?: string;
  projectName?: string;
  running: boolean;
  queued?: number;
  error?: string;
  /** The actual bridge commands supported by this bot, including their slash. */
  supportedCommands: readonly string[];
}

/** Uses ordinary card payloads, so Feishu and Telegram share the same controls. */
export function buildControlPanel(state: ControlPanelState): CardPayload {
  const status = state.error ? '需要处理' : state.running ? '正在处理' : '等待消息';
  const lines = [
    `机器人：${label(state.botName)}`,
    `AI：${label(state.agentName)}${state.model ? ` · ${label(state.model)}` : ''}`,
    `项目：${label(state.projectName ?? '默认项目')}`,
    `状态：${status}${state.queued ? ` · 排队 ${state.queued} 条` : ''}`,
  ];
  if (state.error) lines.push(`提示：${label(state.error)}`);
  return {
    type: 'final',
    title: '机器人控制台',
    content: lines.join('\n'),
    buttons: CONTROLS
      .filter(([, , command]) => state.supportedCommands.includes(command))
      .filter(([action]) => action !== 'stop' || state.running || Boolean(state.queued))
      .map(([action, text]) => ({
        text,
        value: `control:${action}`,
        type: action === 'stop' ? 'danger' : 'default',
      })),
  };
}

/** Parsing is not authorization: the callback handler must recheck the sender. */
export function parseControlAction(data: string): string | null {
  const action = unwrapCardAction(data);
  return CONTROLS.find(([name]) => action === `control:${name}`)?.[2] ?? null;
}

export function unwrapCardAction(data: string): string {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed && typeof parsed === 'object' && 'action' in parsed && typeof parsed.action === 'string') {
      return parsed.action;
    }
  } catch {
    // Telegram callback data is already a compact string.
  }
  return data;
}

function label(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160);
}
