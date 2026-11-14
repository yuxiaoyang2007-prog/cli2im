import type { PlatformAdapter, SessionKey } from '../../types.js';
import { scrubLog } from '../../security/logging.js';
import type { AbortableOptions } from '../../abort.js';
import { stripFileMarkers } from '../../agents/codex-file-markers.js';

export const MAX_TELEGRAM_CHUNK_CHARS = 3800;

export function splitTelegramChunks(text: string, maxChars = MAX_TELEGRAM_CHUNK_CHARS): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars || maxChars <= 0) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < Math.floor(maxChars * 0.4)) cut = slice.lastIndexOf('\n');
    if (cut < Math.floor(maxChars * 0.4)) cut = slice.lastIndexOf(' ');
    if (cut <= 0) cut = maxChars;

    const head = remaining.slice(0, cut).trimEnd();
    if (head) chunks.push(head);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

interface TelegramBufferState {
  chatId: string;
  buffer: string;
  finalizing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  liveMessageId?: string;
  lastRenderedText: string;
  patchChain: Promise<void>;
}

export class TelegramStreamController {
  private states = new Map<SessionKey, TelegramBufferState>();
  private adapter: PlatformAdapter;
  private intervalMs: number;

  constructor(
    adapter: PlatformAdapter,
    intervalMs = 1200,
    private resolveRoute: (key: SessionKey) => AbortableOptions = () => ({}),
  ) {
    this.adapter = adapter;
    this.intervalMs = intervalMs;
  }

  appendText(sessionKey: SessionKey, chatId: string, text: string): void {
    let state = this.states.get(sessionKey);
    if (!state || state.finalizing) {
      state = {
        chatId,
        buffer: '',
        finalizing: false,
        timer: null,
        lastRenderedText: '',
        patchChain: Promise.resolve(),
      };
      this.states.set(sessionKey, state);
    }
    state.buffer += text;

    if (typeof this.adapter.editMessage === 'function' && this.intervalMs > 0 && !state.timer) {
      const targetState = state;
      targetState.timer = setTimeout(() => {
        targetState.timer = null;
        void this.flushLive(sessionKey, targetState);
      }, this.intervalMs);
      targetState.timer.unref?.();
    }
  }

  private flushLive(sessionKey: SessionKey, state: TelegramBufferState): Promise<void> {
    const run = async () => {
      if (state.finalizing || !this.isCurrentState(sessionKey, state)) return;
      const cleaned = (state.buffer.includes('[[file:') ? stripFileMarkers(state.buffer) : state.buffer).trim();
      if (!cleaned) return;

      const chunks = splitTelegramChunks(cleaned);
      const base = chunks[0];
      const preview = chunks.length > 1
        ? `${base.slice(0, MAX_TELEGRAM_CHUNK_CHARS - 8)}\n\n⏳ …`
        : base;
      if (!preview || preview === state.lastRenderedText) return;

      try {
        if (!state.liveMessageId) {
          state.liveMessageId = await this.sendChunk(state.chatId, sessionKey, preview);
          state.lastRenderedText = preview;
        } else {
          await this.adapter.editMessage?.(state.chatId, state.liveMessageId, preview);
          state.lastRenderedText = preview;
        }
      } catch (err) {
        console.error(`[tg-stream] live flush error for ${scrubLog(sessionKey)}:`, scrubLog(err));
      }
    };

    const next = state.patchChain.then(run, run);
    state.patchChain = next.catch(() => undefined);
    return next;
  }

  async finalize(sessionKey: SessionKey, options: AbortableOptions = {}): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state || state.finalizing) return;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    if (options.signal?.aborted) {
      if (this.isCurrentState(sessionKey, state)) {
        this.states.delete(sessionKey);
      }
      return;
    }
    state.finalizing = true;

    try {
      await state.patchChain;
      if (options.signal?.aborted) return;

      const text = (state.buffer.includes('[[file:') ? stripFileMarkers(state.buffer) : state.buffer).trim();
      if (!text) return;

      const chunks = splitTelegramChunks(text);
      if (chunks.length === 0) return;

      if (state.liveMessageId && typeof this.adapter.editMessage === 'function') {
        if (chunks[0] !== state.lastRenderedText) {
          await this.adapter.editMessage(state.chatId, state.liveMessageId, chunks[0]);
          state.lastRenderedText = chunks[0];
        }
        for (const chunk of chunks.slice(1)) {
          if (options.signal?.aborted) return;
          await this.sendChunk(state.chatId, sessionKey, chunk, options);
        }
      } else {
        for (const chunk of chunks) {
          if (options.signal?.aborted) return;
          await this.sendChunk(state.chatId, sessionKey, chunk, options);
        }
      }
    } catch (err) {
      console.error(`[tg-stream] send error for ${scrubLog(sessionKey)}:`, scrubLog(err));
    } finally {
      if (this.isCurrentState(sessionKey, state)) {
        this.states.delete(sessionKey);
      }
    }
  }

  interrupt(sessionKey: SessionKey): void {
    const state = this.states.get(sessionKey);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (this.isCurrentState(sessionKey, state)) {
      this.states.delete(sessionKey);
    }
  }

  private async sendChunk(
    chatId: string,
    sessionKey: SessionKey,
    text: string,
    options: AbortableOptions = {},
  ): Promise<string> {
    if (options.signal) {
      return this.adapter.send(chatId, { text }, { ...this.resolveRoute(sessionKey), signal: options.signal });
    }
    const route = this.resolveRoute(sessionKey);
    return Object.keys(route).length
      ? this.adapter.send(chatId, { text }, route)
      : this.adapter.send(chatId, { text });
  }

  private isCurrentState(sessionKey: SessionKey, state: TelegramBufferState): boolean {
    return this.states.get(sessionKey) === state;
  }
}
