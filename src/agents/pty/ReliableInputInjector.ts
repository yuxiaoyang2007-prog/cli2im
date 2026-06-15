import { readFile, stat } from 'node:fs/promises';
import type { InputResult } from './InputInjector.js';

const DEFAULT_ACK_WINDOW_MS = 8_000;
const DEFAULT_MAX_INJECT_RETRIES = 3;
const DEFAULT_POLL_INTERVAL_MS = 50;

export interface ReliableInputTarget {
  send(text: string): Promise<InputResult>;
  clearInput(): Promise<void>;
}

export interface ReliableInputInjectorOptions {
  transcriptPath: string;
  inputReady: () => void | Promise<void>;
  injector: ReliableInputTarget;
  ackWindowMs?: number;
  maxInjectRetries?: number;
  pollIntervalMs?: number;
  // Observability hook (handoff §8): emit per-attempt lines so a soak hang is not a black box.
  // Default logs to console with a [pty-injector] prefix; callers pass a prefixed logger to
  // disambiguate concurrent runtimes.
  log?: (message: string) => void;
}

export interface TranscriptAckPeek {
  matched: boolean;
  humanPromptSeen: boolean;
}

export function createReliableInputInjector(options: ReliableInputInjectorOptions): ReliableInputTarget {
  const ackWindowMs = normalizePositiveFiniteInteger(
    options.ackWindowMs ?? DEFAULT_ACK_WINDOW_MS,
    'ackWindowMs',
  );
  const maxAttempts = normalizePositiveFiniteInteger(
    options.maxInjectRetries ?? DEFAULT_MAX_INJECT_RETRIES,
    'maxInjectRetries',
  );
  const pollIntervalMs = normalizePositiveFiniteInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    'pollIntervalMs',
  );
  const log = options.log ?? ((message: string) => console.log(`[pty-injector] ${message}`));

  return {
    clearInput: () => options.injector.clearInput(),
    async send(text: string): Promise<InputResult> {
      const preview = previewText(text);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const injectOffset = await transcriptSize(options.transcriptPath);
        await options.inputReady();
        const injected = await options.injector.send(text);
        if (!injected.ok) {
          log(`attempt ${attempt}/${maxAttempts} offset=${injectOffset} inject FAILED: ${injected.error ?? 'unknown'}`);
          return injected;
        }
        log(`attempt ${attempt}/${maxAttempts} offset=${injectOffset} injected ${injected.bytes}b waiting ack <=${ackWindowMs}ms: "${preview}"`);

        const ackStart = Date.now();
        const ack = await waitForPromptAck({
          transcriptPath: options.transcriptPath,
          injectOffset,
          expectedText: text,
          ackWindowMs,
          pollIntervalMs,
        });
        const waitedMs = Date.now() - ackStart;
        if (ack.matched) {
          log(`ack matched in ${waitedMs}ms (attempt ${attempt}/${maxAttempts})`);
          return injected;
        }
        if (ack.humanPromptSeen) {
          log(`human prompt seen at offset but NO match after ${waitedMs}ms (attempt ${attempt}/${maxAttempts}) — stop, runtime tainted`);
          break;
        }
        if (attempt < maxAttempts) {
          log(`no ack after ${waitedMs}ms (attempt ${attempt}/${maxAttempts}) — clear input + re-inject`);
          await options.injector.clearInput();
        } else {
          log(`no ack after ${waitedMs}ms (attempt ${attempt}/${maxAttempts}) — attempts exhausted`);
        }
      }

      log(`ack_exhausted: input never acknowledged after ${maxAttempts} attempt(s) — runtime tainted`);
      return {
        ok: false,
        bytes: 0,
        error: 'Claude PTY input was not acknowledged by transcript',
        reason: 'ack_exhausted',
        taintedRuntime: true,
      };
    },
  };
}

function previewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function normalizePositiveFiniteInteger(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
  return Math.max(1, Math.floor(value));
}

export async function peekTranscriptForPromptAck(
  transcriptPath: string,
  injectOffset: number,
  expectedText: string,
): Promise<TranscriptAckPeek> {
  let size: number;
  try {
    size = (await stat(transcriptPath)).size;
  } catch (error) {
    if (isNotFoundError(error)) return { matched: false, humanPromptSeen: false };
    throw error;
  }
  if (size < injectOffset) return { matched: false, humanPromptSeen: false };
  if (size === injectOffset) return { matched: false, humanPromptSeen: false };

  const buffer = await readFile(transcriptPath);
  const chunk = buffer.subarray(injectOffset).toString('utf8');
  const lines = chunk.split('\n');
  if (!chunk.endsWith('\n')) lines.pop();

  let humanPromptSeen = false;
  const expected = normalizeText(expectedText);
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = parseJson(line);
    if (!record) continue;
    const text = humanPromptText(record);
    if (text === undefined) continue;
    humanPromptSeen = true;
    if (normalizeText(text).includes(expected)) {
      return { matched: true, humanPromptSeen: true };
    }
  }
  return { matched: false, humanPromptSeen };
}

async function waitForPromptAck(input: {
  transcriptPath: string;
  injectOffset: number;
  expectedText: string;
  ackWindowMs: number;
  pollIntervalMs: number;
}): Promise<TranscriptAckPeek> {
  const deadline = Date.now() + input.ackWindowMs;
  for (;;) {
    const ack = await peekTranscriptForPromptAck(input.transcriptPath, input.injectOffset, input.expectedText);
    if (ack.matched || ack.humanPromptSeen) return ack;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return ack;
    await sleep(Math.min(input.pollIntervalMs, remainingMs));
  }
}

async function transcriptSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isNotFoundError(error)) return 0;
    throw error;
  }
}

function humanPromptText(record: unknown): string | undefined {
  const value = asRecord(record);
  const message = asRecord(value?.message);
  if (!message || message.role !== 'user') return undefined;
  const content = message.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? content : undefined;
  }
  if (!Array.isArray(content)) return undefined;

  let hasToolResult = false;
  const textBlocks: string[] = [];
  for (const block of content) {
    const item = asRecord(block);
    if (!item) continue;
    if (item.type === 'tool_result') {
      hasToolResult = true;
      break;
    }
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      textBlocks.push(item.text);
    }
  }
  if (hasToolResult || textBlocks.length === 0) return undefined;
  return textBlocks.join('\n');
}

function normalizeText(input: string): string {
  return input.replace(/\r\n/g, '\n').trim();
}

function parseJson(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
