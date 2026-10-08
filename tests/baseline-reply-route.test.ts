import { it, expect, vi } from 'vitest';
import { bindReplyRoute } from '../src/runtime/reply-route.js';
import type { PlatformAdapter } from '../src/types.js';

it('F07 binds Feishu audio replies to the originating topic', async () => {
  const adapter = { sendAudio: vi.fn(async () => 'audio-message') };
  const routed = bindReplyRoute(adapter as unknown as PlatformAdapter & typeof adapter, { threadId: 'topic', replyToMessageId: 'source' });
  await (routed.sendAudio as Function)('chat', Buffer.from('audio'));
  expect(adapter.sendAudio).toHaveBeenCalledWith('chat', expect.any(Buffer), { threadId: 'topic', replyToMessageId: 'source' });
});
