import { describe, expect, it, vi } from 'vitest';
import { StreamingCardController } from '../src/platforms/feishu/cards.js';
import type { FeishuAdapter } from '../src/platforms/feishu/adapter.js';
import {
  buildControlPanel,
  buildQueueNoticeCard,
  parseControlAction,
  parseQueueSteerAction,
} from '../src/runtime/control-panel.js';
import { parseModelOrEffortAction } from '../src/runtime/callbacks.js';

describe('interactive cards, queue steer & model/effort callbacks', () => {
  it('renders stop button on start, keeps it on replaceCard updates, shows thinking preview & token stats on finalize', async () => {
    const replaceCard = vi.fn().mockResolvedValue(undefined);
    const updateCard = vi.fn().mockResolvedValue(undefined);
    const sendCard = vi.fn().mockResolvedValue('msg_1');
    const adapter = { sendCard, updateCard, replaceCard } as unknown as FeishuAdapter;

    const controller = new StreamingCardController(adapter, {
      intervalMs: 10,
      minDeltaChars: 1,
      interactiveStop: true,
    });

    await controller.startCard('chat_1', 'feishu:chat_1:bot', 'agy_bot', 'Thinking...');
    expect(sendCard).toHaveBeenCalledWith(
      'chat_1',
      expect.objectContaining({
        type: 'streaming',
        title: 'agy_bot',
        buttons: [{ text: '⏹ 停止', value: 'control:stop', type: 'danger' }],
      }),
      {},
    );

    const longThinking = 'line1\n' + 'x'.repeat(280);
    controller.handleEvent('feishu:chat_1:bot', { type: 'thinking', content: longThinking });
    await new Promise((r) => setTimeout(r, 30));

    expect(replaceCard).toHaveBeenCalledWith(
      'msg_1',
      expect.objectContaining({
        type: 'streaming',
        title: 'agy_bot',
        content: expect.stringMatching(/^\*Thinking\.\.\.\*\n> …x{200,}/),
        buttons: [{ text: '⏹ 停止', value: 'control:stop', type: 'danger' }],
      }),
    );

    controller.handleEvent('feishu:chat_1:bot', { type: 'text', content: '最终回答' });
    controller.handleEvent('feishu:chat_1:bot', {
      type: 'result',
      sessionId: 'ses_1',
      usage: { inputTokens: 1500, outputTokens: 250 },
    });
    await new Promise((r) => setTimeout(r, 30));

    const lastReplaceCall = replaceCard.mock.calls.at(-1);
    expect(lastReplaceCall?.[0]).toBe('msg_1');
    expect(lastReplaceCall?.[1]).toEqual(
      expect.objectContaining({
        type: 'final',
        title: 'agy_bot',
        content: expect.stringContaining('in 1.5k / out 250'),
      }),
    );
    expect(lastReplaceCall?.[1]?.buttons).toBeUndefined();
    expect(updateCard).not.toHaveBeenCalled();
  });

  it('builds queue notice cards and parses steer, model, effort and control callbacks', () => {
    const notice = buildQueueNoticeCard(2, '先停一下，改为修复登录接口');
    expect(notice.title).toBe('⏳ 消息已排队');
    expect(notice.content).toContain('等待队列共 2 条');
    expect(notice.content).toContain('先停一下');
    expect(notice.buttons?.map((b) => b.value)).toEqual(['steer:interrupt_now', 'steer:cancel_queue']);

    expect(parseQueueSteerAction('steer:interrupt_now')).toBe('interrupt_now');
    expect(parseQueueSteerAction(JSON.stringify({ action: 'steer:cancel_queue' }))).toBe('cancel_queue');
    expect(parseQueueSteerAction('control:stop')).toBeNull();

    expect(parseControlAction('control:model')).toBe('/model');
    expect(parseControlAction('control:effort')).toBe('/effort');

    expect(parseModelOrEffortAction('model:gpt-6-astra')).toEqual({ kind: 'model', model: 'gpt-6-astra' });
    expect(parseModelOrEffortAction(JSON.stringify({ action: 'effort:xhigh' }))).toEqual({
      kind: 'effort',
      effort: 'xhigh',
    });
    expect(parseModelOrEffortAction('control:stop')).toBeNull();

    const panel = buildControlPanel({
      botName: 'ccbot',
      agentName: 'claude-code',
      model: 'claude-opus-5-5[1m]',
      effort: 'xhigh',
      running: false,
      supportedCommands: ['/new', '/model', '/effort', '/status', '/stop'],
    });
    expect(panel.content).toContain('claude-code · claude-opus-5-5[1m] (xhigh)');
    expect(panel.buttons?.map((b) => b.value)).toEqual(['control:new', 'control:model', 'control:effort', 'control:status']);
  });
});
