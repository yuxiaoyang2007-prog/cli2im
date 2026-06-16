import type { FeishuAdapter } from './adapter.js';
import type { AgentEvent } from '../../types.js';
import type { AbortableOptions } from '../../abort.js';

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
  // Serializes patch (updateCard) calls for this card in call order. The Feishu
  // adapter's updateCard ignores its seq arg and just overwrites the message, so
  // without this a slow in-flight patch (e.g. the previous turn's fire-and-forget
  // finalize) could land after a reopened turn's update and revert the message.
  patchChain: Promise<unknown>;
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
      patchChain: Promise.resolve(),
    });
  }

  // Serialize a patch behind any in-flight patches for this card so a slow
  // earlier patch can't land after a later one (the adapter ignores seq).
  private patchCard(
    card: StreamingCardState,
    messageId: string,
    display: string,
    seq: number,
    options: AbortableOptions,
  ): Promise<void> {
    const run = () =>
      options.signal
        ? this.adapter.updateCard(messageId, display, seq, { signal: options.signal })
        : this.adapter.updateCard(messageId, display, seq);
    const result = card.patchChain.then(run);
    card.patchChain = result.catch(() => {});
    return result;
  }

  handleEvent(sessionKey: string, event: AgentEvent, options: AbortableOptions = {}): void {
    if (options.signal?.aborted) return;
    const card = this.cards.get(sessionKey);
    if (!card) return;

    if (card.finalized) {
      // The previous turn finalized this card. A fresh content event — or a
      // terminal error (a drained turn can fail before emitting any text) —
      // means a new turn began without the pipeline opening a card, e.g. a
      // prompt the plugin drained from its internal queue after the previous
      // turn ended. Reopen the same card so the new turn's output isn't dropped.
      // status / result / a stray late delta of the finished turn do not reopen.
      if (!this.isContentEvent(event) && event.type !== 'error') return;
      this.reopenCard(card);
      // fall through to render this event on the reopened card
    }

    switch (event.type) {
      case 'text':
        card.thinking = '';
        card.content += event.content;
        this.scheduleUpdate(sessionKey, card, options);
        break;

      case 'thinking':
        card.thinking = event.content;
        this.scheduleUpdate(sessionKey, card, options);
        break;

      case 'tool_use':
        card.toolStatus = `${event.name}...`;
        this.scheduleUpdate(sessionKey, card, options);
        break;

      case 'tool_result':
        card.toolStatus = event.isError ? `${event.name} failed` : event.name;
        this.scheduleUpdate(sessionKey, card, options);
        break;

      case 'status':
        // Metadata only. Status events must not finalize the streaming card.
        break;

      case 'result':
        void this.finalizeCard(sessionKey, 'completed', card, options);
        break;

      case 'error':
        card.content += `\n\nError: ${event.message}`;
        void this.finalizeCard(sessionKey, 'error', card, options);
        break;
    }
  }

  // Content events carry a turn's visible output; their arrival on a finalized
  // card signals a new turn. status/result/error are control/terminal events
  // and must not, on their own, reopen a card.
  private isContentEvent(event: AgentEvent): boolean {
    return (
      event.type === 'text' ||
      event.type === 'thinking' ||
      event.type === 'tool_use' ||
      event.type === 'tool_result'
    );
  }

  // Reuse the same Feishu card message for a new turn, separating it from the
  // previous (finalized) turn's output. The previous content is kept so the
  // earlier reply isn't erased; messageId/updateSeq are preserved so the same
  // message is edited in place (avoids the async race of sending a new card).
  private reopenCard(card: StreamingCardState): void {
    card.content = card.content ? `${card.content}\n\n---\n\n` : '';
    card.toolStatus = '';
    card.thinking = '';
    card.finalized = false;
    card.startedAt = Date.now();
    card.lastUpdateAt = 0;
    card.lastUpdateLength = card.content.length;
  }

  interruptCard(sessionKey: string, options: AbortableOptions = {}): void {
    if (options.signal?.aborted) return;
    const card = this.cards.get(sessionKey);
    if (!card) return;
    void this.finalizeCard(sessionKey, 'interrupted', card, options);
  }

  isThinkingVisible(sessionKey: string): boolean {
    return this.showThinkingBySession.get(sessionKey) ?? true;
  }

  setThinkingVisible(sessionKey: string, visible: boolean): void {
    this.showThinkingBySession.set(sessionKey, visible);
    void this.flushUpdate(sessionKey);
  }

  private scheduleUpdate(
    sessionKey: string,
    card: StreamingCardState,
    options: AbortableOptions = {},
  ): void {
    if (options.signal?.aborted || !this.isCurrentCard(sessionKey, card) || card.finalized || card.timer) return;

    const elapsed = Date.now() - card.lastUpdateAt;
    const delta = card.content.length - card.lastUpdateLength;

    if (elapsed >= this.throttle.intervalMs && delta >= this.throttle.minDeltaChars) {
      void this.flushUpdate(sessionKey, undefined, options);
    } else {
      card.timer = setTimeout(() => {
        card.timer = null;
        void this.flushUpdate(sessionKey, card, options);
      }, this.throttle.intervalMs);
    }
  }

  private async flushUpdate(
    sessionKey: string,
    expectedCard?: StreamingCardState,
    options: AbortableOptions = {},
  ): Promise<void> {
    const card = expectedCard ?? this.cards.get(sessionKey);
    if (options.signal?.aborted || !card || !this.isCurrentCard(sessionKey, card) || card.finalized || !card.messageId) return;

    const display = this.buildDisplayContent(sessionKey, card);
    card.updateSeq++;
    card.lastUpdateAt = Date.now();
    card.lastUpdateLength = card.content.length;

    try {
      await this.patchCard(card, card.messageId, display, card.updateSeq, options);
    } catch {
      // Card update failures should not interrupt the agent stream.
    }
  }

  private async finalizeCard(
    sessionKey: string,
    status: 'completed' | 'error' | 'interrupted',
    card: StreamingCardState,
    options: AbortableOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted || !this.isCurrentCard(sessionKey, card) || card.finalized) return;

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

    if (card.messageId && !options.signal?.aborted) {
      try {
        await this.patchCard(card, card.messageId, display, ++card.updateSeq, options);
      } catch {
        // Best effort final update.
      }
    }

    // Intentionally keep the finalized card in the map (don't delete): a prompt
    // the plugin later drains from its internal queue produces events with no
    // pipeline-opened card, and handleEvent reopens this one to render them.
    // A normal next message overwrites it via startCard.
  }

  private isCurrentCard(sessionKey: string, card: StreamingCardState): boolean {
    return this.cards.get(sessionKey) === card;
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
