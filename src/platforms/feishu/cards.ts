import type { FeishuAdapter } from './adapter.js';
import type { AgentEvent, CardButton, CardPayload, TokenUsage } from '../../types.js';
import type { AbortableOptions } from '../../abort.js';
import { stripFileMarkers } from '../../agents/codex-file-markers.js';

const STOP_CARD_BUTTON: CardButton = {
  text: '⏹ 停止',
  value: 'control:stop',
  type: 'danger',
};

// Long silent steps (builds, background tasks, waiting on a question) still refresh the
// card so the chat can tell a busy turn from a stuck one.
const LIVENESS_INTERVAL_MS = 30_000;
export const MAX_CARD_DISPLAY_CHARS = 22_000;
export const CONTINUATION_CHUNK_CHARS = 20_000;

export function splitCardChunks(text: string, maxChars = CONTINUATION_CHUNK_CHARS): string[] {
  if (!text) return [''];
  if (text.length <= maxChars || maxChars <= 0) return [text];

  const chunks: string[] = [];
  let remaining = text;
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

interface StreamingCardState {
  chatId: string;
  messageId: string | null;
  title: string;
  content: string;
  toolStatus: string;
  thinking: string;
  usage?: TokenUsage;
  lastUpdateAt: number;
  lastUpdateLength: number;
  updateSeq: number;
  timer: ReturnType<typeof setTimeout> | null;
  ticker: ReturnType<typeof setInterval> | null;
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
  interactiveStop?: boolean;
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

  async startCard(chatId: string, sessionKey: string, title: string, initialText?: string, options: AbortableOptions = {}): Promise<void> {
    const startPayload: CardPayload = {
      type: 'streaming',
      content: initialText ?? 'Processing...',
      title,
      ...(this.throttle.interactiveStop ? { buttons: [STOP_CARD_BUTTON] } : {}),
    };
    const messageId = await this.adapter.sendCard(chatId, startPayload, options);

    this.stopTicker(this.cards.get(sessionKey));
    const card: StreamingCardState = {
      chatId,
      messageId,
      title,
      content: '',
      toolStatus: '',
      thinking: '',
      usage: undefined,
      lastUpdateAt: 0,
      lastUpdateLength: 0,
      updateSeq: 0,
      timer: null,
      ticker: null,
      finalized: false,
      startedAt: Date.now(),
      patchChain: Promise.resolve(),
    };
    this.cards.set(sessionKey, card);
    this.startTicker(sessionKey, card, options);
  }

  private startTicker(sessionKey: string, card: StreamingCardState, options: AbortableOptions): void {
    this.stopTicker(card);
    card.ticker = setInterval(() => {
      if (card.finalized || !this.isCurrentCard(sessionKey, card) || options.signal?.aborted) {
        this.stopTicker(card);
        return;
      }
      void this.flushUpdate(sessionKey, card, options);
    }, LIVENESS_INTERVAL_MS);
    card.ticker.unref?.();
  }

  private stopTicker(card: StreamingCardState | undefined): void {
    if (!card?.ticker) return;
    clearInterval(card.ticker);
    card.ticker = null;
  }

  // Serialize a patch behind any in-flight patches for this card so a slow
  // earlier patch can't land after a later one (the adapter ignores seq).
  private patchCard(
    card: StreamingCardState,
    messageId: string,
    display: string,
    seq: number,
    options: AbortableOptions,
    final = false,
  ): Promise<void> {
    const replaceCardFn = this.adapter.replaceCard;
    const run = () => {
      if (this.throttle.interactiveStop && typeof replaceCardFn === 'function') {
        const payload: CardPayload = final
          ? { type: 'final', title: card.title, content: display }
          : { type: 'streaming', title: card.title, content: display, buttons: [STOP_CARD_BUTTON] };
        return options.signal
          ? replaceCardFn.call(this.adapter, messageId, payload, { signal: options.signal })
          : replaceCardFn.call(this.adapter, messageId, payload);
      }
      return options.signal
        ? this.adapter.updateCard(messageId, display, seq, { signal: options.signal })
        : this.adapter.updateCard(messageId, display, seq);
    };
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
      this.startTicker(sessionKey, card, options);
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
        card.usage = event.usage;
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
    card.usage = undefined;
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
    this.stopTicker(card);
    if (card.timer) {
      clearTimeout(card.timer);
      card.timer = null;
    }

    const elapsed = Math.round((Date.now() - card.startedAt) / 1000);
    const statusText =
      status === 'completed' ? 'Completed' : status === 'error' ? 'Error' : 'Interrupted';

    const usageText = card.usage && (card.usage.inputTokens > 0 || card.usage.outputTokens > 0)
      ? ` · in ${this.formatTokens(card.usage.inputTokens)} / out ${this.formatTokens(card.usage.outputTokens)}`
      : '';
    const footer = `\n\n---\n${statusText} · ${this.formatDuration(elapsed)}${usageText}`;
    const fullDisplay = this.buildDisplayContent(sessionKey, card) + footer;

    if (card.messageId && !options.signal?.aborted) {
      if (fullDisplay.length <= MAX_CARD_DISPLAY_CHARS) {
        try {
          await this.patchCard(card, card.messageId, fullDisplay, ++card.updateSeq, options, true);
        } catch {
          // Best effort final update.
        }
      } else {
        const cleaned = (card.content.includes('[[file:') ? stripFileMarkers(card.content) : card.content).trim();
        const chunks = splitCardChunks(cleaned, CONTINUATION_CHUNK_CHARS);
        const total = chunks.length;
        const firstBody = total > 1
          ? `${chunks[0]}\n\n---\n*(1/${total} · 续下张卡片)*`
          : chunks[0] + footer;
        try {
          await this.patchCard(card, card.messageId, firstBody, ++card.updateSeq, options, true);
        } catch {
          // Best effort final update.
        }
        for (let i = 1; i < total; i += 1) {
          if (options.signal?.aborted) break;
          const isLast = i === total - 1;
          const body = isLast
            ? `${chunks[i]}\n\n*(${i + 1}/${total})*${footer}`
            : `${chunks[i]}\n\n*(${i + 1}/${total} · 续下张卡片)*`;
          try {
            await card.patchChain.then(() =>
              this.adapter.sendCard(card.chatId, { type: 'final', content: body }, options),
            );
          } catch {
            // Best effort continuation card.
          }
        }
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
      const cleanedThinking = card.thinking.replace(/\s+/g, ' ').trim();
      const preview = cleanedThinking.length > 240 ? `…${cleanedThinking.slice(-240)}` : cleanedThinking;
      parts.push(preview ? `*Thinking...*\n> ${preview}` : '*Thinking...*');
    }

    const rawContent = card.content.includes('[[file:') ? stripFileMarkers(card.content) : card.content;
    const content = !card.finalized && rawContent.length > CONTINUATION_CHUNK_CHARS
      ? `*(前文已折叠 ${rawContent.length - CONTINUATION_CHUNK_CHARS} 字，正在流式输出最新内容…)*\n\n${rawContent.slice(-CONTINUATION_CHUNK_CHARS)}`
      : rawContent;
    if (content) {
      parts.push(content);
    }

    if (card.toolStatus) {
      parts.push(card.toolStatus);
    }

    const elapsed = Math.round((Date.now() - card.startedAt) / 1000);
    if (!card.finalized && elapsed * 1000 >= LIVENESS_INTERVAL_MS) {
      parts.push(`⏳ 运行中 · ${this.formatDuration(elapsed)}`);
    }

    return parts.join('\n\n') || 'Processing...';
  }

  private formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  private formatTokens(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
    return String(count);
  }
}
