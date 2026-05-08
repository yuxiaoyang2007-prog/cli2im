import type { FeishuAdapter } from './adapter.js';
import type { AgentEvent } from '../../types.js';

interface StreamingCardState {
  chatId: string;
  messageId: string | null;
  content: string;
  toolStatus: string;
  thinking: string;
  lastUpdateAt: number;
  lastUpdateLength: number;
  updateSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
  finalized: boolean;
  startedAt: number;
}

interface ThrottleConfig {
  intervalMs: number;
  minDeltaChars: number;
}

export class StreamingCardController {
  private adapter: FeishuAdapter;
  private cards = new Map<string, StreamingCardState>();
  private showThinkingBySession = new Map<string, boolean>();
  private throttle: ThrottleConfig;

  constructor(
    adapter: FeishuAdapter,
    throttle: ThrottleConfig = { intervalMs: 200, minDeltaChars: 30 },
  ) {
    this.adapter = adapter;
    this.throttle = throttle;
  }

  async startCard(chatId: string, sessionKey: string, title: string, initialText?: string): Promise<void> {
    const messageId = await this.adapter.sendCard(chatId, {
      type: 'streaming',
      content: initialText ?? 'Processing...',
      title,
    });

    this.cards.set(sessionKey, {
      chatId,
      messageId,
      content: '',
      toolStatus: '',
      thinking: '',
      lastUpdateAt: 0,
      lastUpdateLength: 0,
      updateSeq: 0,
      timer: null,
      finalized: false,
      startedAt: Date.now(),
    });
  }

  handleEvent(sessionKey: string, event: AgentEvent): void {
    const card = this.cards.get(sessionKey);
    if (!card || card.finalized) return;

    switch (event.type) {
      case 'text':
        card.thinking = '';
        card.content += event.content;
        this.scheduleUpdate(sessionKey);
        break;

      case 'thinking':
        card.thinking = event.content;
        this.scheduleUpdate(sessionKey);
        break;

      case 'tool_use':
        card.toolStatus = `${event.name}...`;
        this.scheduleUpdate(sessionKey);
        break;

      case 'tool_result':
        card.toolStatus = event.isError ? `${event.name} failed` : event.name;
        this.scheduleUpdate(sessionKey);
        break;

      case 'status':
        // Metadata only. Status events must not finalize the streaming card.
        break;

      case 'result':
        void this.finalizeCard(sessionKey, 'completed');
        break;

      case 'error':
        card.content += `\n\nError: ${event.message}`;
        void this.finalizeCard(sessionKey, 'error');
        break;
    }
  }

  interruptCard(sessionKey: string): void {
    void this.finalizeCard(sessionKey, 'interrupted');
  }

  isThinkingVisible(sessionKey: string): boolean {
    return this.showThinkingBySession.get(sessionKey) ?? true;
  }

  setThinkingVisible(sessionKey: string, visible: boolean): void {
    this.showThinkingBySession.set(sessionKey, visible);
    void this.flushUpdate(sessionKey);
  }

  private scheduleUpdate(sessionKey: string): void {
    const card = this.cards.get(sessionKey);
    if (!card || card.finalized || card.timer) return;

    const elapsed = Date.now() - card.lastUpdateAt;
    const delta = card.content.length - card.lastUpdateLength;

    if (elapsed >= this.throttle.intervalMs && delta >= this.throttle.minDeltaChars) {
      void this.flushUpdate(sessionKey);
    } else {
      card.timer = setTimeout(() => {
        card.timer = null;
        void this.flushUpdate(sessionKey);
      }, this.throttle.intervalMs);
    }
  }

  private async flushUpdate(sessionKey: string): Promise<void> {
    const card = this.cards.get(sessionKey);
    if (!card || card.finalized || !card.messageId) return;

    const display = this.buildDisplayContent(sessionKey, card);
    card.updateSeq++;
    card.lastUpdateAt = Date.now();
    card.lastUpdateLength = card.content.length;

    try {
      await this.adapter.updateCard(card.messageId, display, card.updateSeq);
    } catch {
      // Card update failures should not interrupt the agent stream.
    }
  }

  private async finalizeCard(
    sessionKey: string,
    status: 'completed' | 'error' | 'interrupted',
  ): Promise<void> {
    const card = this.cards.get(sessionKey);
    if (!card || card.finalized) return;

    card.finalized = true;
    if (card.timer) {
      clearTimeout(card.timer);
      card.timer = null;
    }

    const elapsed = Math.round((Date.now() - card.startedAt) / 1000);
    const statusText =
      status === 'completed' ? 'Completed' : status === 'error' ? 'Error' : 'Interrupted';

    const footer = `\n\n---\n${statusText} · ${this.formatDuration(elapsed)}`;
    const display = this.buildDisplayContent(sessionKey, card) + footer;

    if (card.messageId) {
      try {
        await this.adapter.updateCard(card.messageId, display, ++card.updateSeq);
      } catch {
        // Best effort final update.
      }
    }

    this.cards.delete(sessionKey);
  }

  private buildDisplayContent(sessionKey: string, card: StreamingCardState): string {
    const parts: string[] = [];

    if (card.thinking && this.isThinkingVisible(sessionKey)) {
      parts.push('*Thinking...*');
    }

    if (card.content) {
      parts.push(card.content);
    }

    if (card.toolStatus) {
      parts.push(card.toolStatus);
    }

    return parts.join('\n\n') || 'Processing...';
  }

  private formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }
}
