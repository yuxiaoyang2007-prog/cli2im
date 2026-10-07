import type { PlatformAdapter, SessionKey } from '../../types.js';
import { scrubLog } from '../../security/logging.js';
import type { AbortableOptions } from '../../abort.js';

interface TelegramBufferState {
  chatId: string;
  buffer: string;
  finalizing: boolean;
}

export class TelegramStreamController {
  private states = new Map<SessionKey, TelegramBufferState>();
  private adapter: PlatformAdapter;

  constructor(adapter: PlatformAdapter, _intervalMs?: number,
    private resolveRoute: (key: SessionKey) => AbortableOptions = () => ({})) {
    this.adapter = adapter;
  }

  appendText(sessionKey: SessionKey, chatId: string, text: string): void {
    let state = this.states.get(sessionKey);
    if (!state || state.finalizing) {
      state = { chatId, buffer: '', finalizing: false };
      this.states.set(sessionKey, state);
    }
    state.buffer += text;
  }

  async finalize(sessionKey: SessionKey, options: AbortableOptions = {}): Promise<void> {
    const state = this.states.get(sessionKey);
    if (!state) return;
    if (state.finalizing) return;
    if (options.signal?.aborted) {
      if (this.isCurrentState(sessionKey, state)) {
        this.states.delete(sessionKey);
      }
      return;
    }
    state.finalizing = true;

    const text = state.buffer.trim();
    if (!text) {
      if (this.isCurrentState(sessionKey, state)) {
        this.states.delete(sessionKey);
      }
      return;
    }

    try {
      if (options.signal?.aborted) return;
      if (options.signal) {
        await this.adapter.send(state.chatId, { text }, { ...this.resolveRoute(sessionKey), signal: options.signal });
      } else {
        const route = this.resolveRoute(sessionKey);
        await this.adapter.send(state.chatId, { text }, ...(Object.keys(route).length ? [route] : []));
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
    if (this.isCurrentState(sessionKey, state)) {
      this.states.delete(sessionKey);
    }
  }

  private isCurrentState(sessionKey: SessionKey, state: TelegramBufferState): boolean {
    return this.states.get(sessionKey) === state;
  }
}
