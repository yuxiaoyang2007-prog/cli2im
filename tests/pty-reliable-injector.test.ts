import { appendFile, mkdtemp, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CTRL_U, InputInjector, type InputResult } from '../src/agents/pty/InputInjector.js';
import { JsonlTailer } from '../src/agents/pty/JsonlTailer.js';
import {
  createReliableInputInjector,
  peekTranscriptForPromptAck,
} from '../src/agents/pty/ReliableInputInjector.js';

describe('ReliableInputInjector', () => {
  it('acks a matching human prompt without clearing or resending', async () => {
    const transcript = await tempTranscript('');
    const clearInput = vi.fn(async () => {});
    const send = vi.fn(async (text: string): Promise<InputResult> => {
      await appendJsonl(transcript, userPrompt(text));
      return { ok: true, bytes: Buffer.byteLength(text) };
    });
    const inputReady = vi.fn(async () => {});

    const injector = createReliableInputInjector({
      transcriptPath: transcript,
      inputReady,
      injector: { send, clearInput },
      ackWindowMs: 20,
      maxInjectRetries: 3,
      pollIntervalMs: 1,
    });

    await expect(injector.send('hello')).resolves.toMatchObject({ ok: true });
    expect(inputReady).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearInput).not.toHaveBeenCalled();
  });

  it('clears stale input and resends when no ack appears before the window expires', async () => {
    const transcript = await tempTranscript('');
    let attempts = 0;
    const clearInput = vi.fn(async () => {});
    const send = vi.fn(async (text: string): Promise<InputResult> => {
      attempts += 1;
      if (attempts === 2) await appendJsonl(transcript, userPrompt(text));
      return { ok: true, bytes: Buffer.byteLength(text) };
    });
    const inputReady = vi.fn(async () => {});

    const injector = createReliableInputInjector({
      transcriptPath: transcript,
      inputReady,
      injector: { send, clearInput },
      ackWindowMs: 5,
      maxInjectRetries: 2,
      pollIntervalMs: 1,
    });

    await expect(injector.send('retry me')).resolves.toMatchObject({ ok: true });
    expect(inputReady).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(clearInput).toHaveBeenCalledTimes(1);
    expect(send.mock.invocationCallOrder[1]).toBeGreaterThan(clearInput.mock.invocationCallOrder[0]);
  });

  it('does not resend once any human prompt record appears after the injection offset', async () => {
    const transcript = await tempTranscript('');
    const clearInput = vi.fn(async () => {});
    const send = vi.fn(async (): Promise<InputResult> => {
      await appendJsonl(transcript, userPrompt('different human prompt'));
      return { ok: true, bytes: 9 };
    });

    const injector = createReliableInputInjector({
      transcriptPath: transcript,
      inputReady: async () => {},
      injector: { send, clearInput },
      ackWindowMs: 5,
      maxInjectRetries: 3,
      pollIntervalMs: 1,
    });

    await expect(injector.send('our prompt')).resolves.toMatchObject({
      ok: false,
      reason: 'ack_exhausted',
      taintedRuntime: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearInput).not.toHaveBeenCalled();
  });

  it('rejects tool_result, empty content, empty strings, and nonmatching user text as prompt acks', async () => {
    const transcript = await tempTranscript('');
    await appendJsonl(transcript, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
    await appendJsonl(transcript, { type: 'user', message: { role: 'user', content: [] } });
    await appendJsonl(transcript, { type: 'user', message: { role: 'user', content: [{ type: 'image', source: {} }] } });
    await appendJsonl(transcript, { type: 'user', message: { role: 'user', content: '' } });
    await appendJsonl(transcript, userPrompt('other text'));

    await expect(peekTranscriptForPromptAck(transcript, 0, 'expected text')).resolves.toEqual({
      matched: false,
      humanPromptSeen: true,
    });
  });

  it('matches normalized nonempty text blocks with contains semantics', async () => {
    const transcript = await tempTranscript('');
    await appendJsonl(transcript, {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'prefix\nexpected text\nsuffix' }],
      },
    });

    await expect(peekTranscriptForPromptAck(transcript, 0, '\r\nexpected text\r\n')).resolves.toEqual({
      matched: true,
      humanPromptSeen: true,
    });
  });

  it('peeks without consuming the JsonlTailer sequence', async () => {
    const transcript = await tempTranscript('');
    const records = [
      userPrompt('hello'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }] } },
      { type: 'result', session_id: 'sess_1' },
    ];
    for (const record of records) await appendJsonl(transcript, record);
    const tailer = new JsonlTailer(transcript);

    await expect(peekTranscriptForPromptAck(transcript, 0, 'hello')).resolves.toMatchObject({ matched: true });
    await expect(tailer.drain()).resolves.toEqual(records);
  });

  it('treats truncation as no ack and ignores a trailing partial line', async () => {
    const transcript = await tempTranscript('');
    await appendJsonl(transcript, userPrompt('old'));
    const sizeBeforeTruncate = (await stat(transcript)).size;
    await truncate(transcript, 0);
    await writeFile(transcript, `${JSON.stringify(userPrompt('new'))}\n{"type":"user"`);

    await expect(peekTranscriptForPromptAck(transcript, sizeBeforeTruncate, 'new')).resolves.toEqual({
      matched: false,
      humanPromptSeen: false,
    });
    await expect(peekTranscriptForPromptAck(transcript, 0, 'new')).resolves.toEqual({
      matched: true,
      humanPromptSeen: true,
    });
  });

  it('clears input on direct send failure but not on ack hit', async () => {
    const writes: string[] = [];
    const failing = new InputInjector({
      write: async (data) => {
        writes.push(data);
        if (data !== CTRL_U) throw new Error('write failed');
      },
    });

    await expect(failing.send('bad')).resolves.toMatchObject({ ok: false, error: 'write failed' });
    expect(writes).toEqual(['\x1b[200~bad\x1b[201~\r', CTRL_U]);
  });
});

async function tempTranscript(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli2im-reliable-injector-'));
  const transcript = join(dir, 'transcript.jsonl');
  await writeFile(transcript, content);
  return transcript;
}

async function appendJsonl(path: string, record: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

function userPrompt(text: string): unknown {
  return { type: 'user', message: { role: 'user', content: text } };
}
