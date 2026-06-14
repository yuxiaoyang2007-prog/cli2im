import { mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventMapper } from '../src/agents/pty/EventMapper.js';
import { JsonlTailer } from '../src/agents/pty/JsonlTailer.js';
import { TurnController } from '../src/agents/pty/TurnController.js';
import { validateInput } from '../src/agents/pty/InputInjector.js';
import { SettingsInjector } from '../src/agents/pty/SettingsInjector.js';

describe('claude pty transcript layer', () => {
  it('maps transcript records to cli2im agent events and retains usage/session fallback', () => {
    const mapper = new EventMapper();

    expect(mapper.mapRecord({
      type: 'assistant',
      session_id: 'sess_1',
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 5,
        },
        content: [
          { type: 'thinking', thinking: 'checking' },
          { type: 'text', text: 'hello' },
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/tmp/a.png' } },
        ],
      },
    })).toEqual([
      { type: 'thinking', content: 'checking' },
      { type: 'text', content: 'hello' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/tmp/a.png' } },
    ]);

    expect(mapper.mapRecord({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: [{ type: 'text', text: 'ok' }] },
        ],
      },
    })).toEqual([
      {
        type: 'tool_result',
        id: 'tool_1',
        name: 'Read',
        output: JSON.stringify([{ type: 'text', text: 'ok' }]),
        isError: undefined,
      },
    ]);

    expect(mapper.mapRecord({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 } })).toEqual([
      {
        type: 'result',
        sessionId: 'sess_1',
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      },
    ]);
  });

  it('seekToEnd skips existing and partial transcript content before draining new records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli2im-tail-'));
    const transcript = join(dir, 'transcript.jsonl');
    await writeFile(transcript, '{"type":"assistant","message":{"content":[{"type":"text","text":"old"}]}}\n{"partial"');

    const tailer = new JsonlTailer(transcript);
    await tailer.seekToEnd();
    await appendFile(transcript, '\n{"type":"assistant","message":{"content":[{"type":"text","text":"new"}]}}\n');

    expect(await tailer.drain()).toEqual([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'new' }] } },
    ]);
  });

  it('finalizes on deadline when a terminal assistant result is already observed', async () => {
    const tailer = new JsonlTailer(join(tmpdir(), 'missing-transcript.jsonl'));
    const controller = new TurnController({ tailer, sessionId: 'sess_2' });
    controller.beginTurn();
    controller.observeRecords([
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'late answer' }],
          usage: { input_tokens: 7, output_tokens: 8 },
        },
      },
    ]);

    expect(controller.finalizeOnDeadline(180_000)).toEqual({
      branch: 'result',
      events: [
        { type: 'text', content: 'late answer' },
        {
          type: 'result',
          sessionId: 'sess_2',
          usage: { inputTokens: 7, outputTokens: 8 },
        },
      ],
      sessionId: 'sess_2',
      transcriptPath: undefined,
      elapsedMs: 180_000,
      reason: undefined,
    });
  });

  it('rejects control sequences before injecting bracketed paste input', () => {
    expect(() => validateInput('normal text')).not.toThrow();
    expect(() => validateInput('bad\x1b[31m')).toThrow(/ESC/);
    expect(() => validateInput('bad\rinput')).toThrow(/bare carriage return/);
    expect(() => validateInput('bad [200~ sentinel')).toThrow(/bracketed-paste/);
  });

  it('builds settings that point at the repo pty hook resources by default', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'cli2im-settings-'));
    const settings = await new SettingsInjector({ runtimeDir }).build({ handle: 'test' });
    const raw = await readFile(settings.settingsPath, 'utf8');

    expect(raw).toContain('/resources/pty-statusline.cjs');
    expect(raw).toContain('/resources/pty-stop-hook.cjs');
    expect(raw).not.toContain('/src/resources/');
  });
});
