import { describe, it, expect, vi } from 'vitest';
import { StreamingCardController } from '../src/platforms/feishu/cards.js';
import type { FeishuAdapter } from '../src/platforms/feishu/adapter.js';

describe('StreamingCardController', () => {
  it('does not finalize or update card on status events', async () => {
    const adapter = {
      sendCard: vi.fn().mockResolvedValue('msg_1'),
      updateCard: vi.fn().mockResolvedValue(undefined),
    } as unknown as FeishuAdapter;
    const controller = new StreamingCardController(adapter);

    await controller.startCard('chat_1', 'feishu:chat_1:ccbot', 'Claude Code');
    controller.handleEvent('feishu:chat_1:ccbot', {
      type: 'status',
      sessionId: 'ses_1',
      message: 'thread started',
    });

    expect(adapter.updateCard).not.toHaveBeenCalled();
  });
});
