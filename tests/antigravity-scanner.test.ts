import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AntigravitySessionScanner } from '../src/session/antigravity-scanner.js';

describe('AntigravitySessionScanner', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs = [];
  });

  function makeAntigravityDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli2im-agy-'));
    dirs.push(dir);
    return dir;
  }

  async function writeConversation(
    agyDir: string,
    conversationId: string,
    request: string,
  ): Promise<void> {
    const logsDir = join(agyDir, 'brain', conversationId, '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          content: `<USER_REQUEST>\n${request}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignore me\n</ADDITIONAL_METADATA>`,
        }),
        JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'ok' }),
      ].join('\n') + '\n',
      'utf8',
    );
  }

  it('lists antigravity conversations with titles from the USER_REQUEST block', async () => {
    const agyDir = makeAntigravityDir();
    await writeConversation(agyDir, 'conv-1', 'add a caching layer');

    const sessions = await new AntigravitySessionScanner(agyDir).scan();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: 'conv-1',
      cwd: '',
      title: 'add a caching layer',
      status: 'historical',
    });
  });

  it('strips the cti-sender prefix from bot-initiated conversations', async () => {
    const agyDir = makeAntigravityDir();
    await writeConversation(
      agyDir,
      'conv-bot',
      '<cti-sender channel="feishu" user_id="ou_x" name="A"/> 你都能做什么',
    );

    const sessions = await new AntigravitySessionScanner(agyDir).scan();

    expect(sessions[0]?.title).toBe('你都能做什么');
  });

  it('skips conversations whose transcript is missing or empty', async () => {
    const agyDir = makeAntigravityDir();
    await writeConversation(agyDir, 'conv-good', 'real one');
    // brain dir with no transcript file
    await mkdir(join(agyDir, 'brain', 'conv-empty', '.system_generated', 'logs'), { recursive: true });

    const sessions = await new AntigravitySessionScanner(agyDir).scan();

    expect(sessions.map((s) => s.sessionId)).toEqual(['conv-good']);
  });

  it('returns no sessions when the antigravity store is absent', async () => {
    const agyDir = makeAntigravityDir();
    const sessions = await new AntigravitySessionScanner(join(agyDir, 'nope')).scan();
    expect(sessions).toEqual([]);
  });

  it('sorts newest first and honors the limit', async () => {
    const agyDir = makeAntigravityDir();
    await writeConversation(agyDir, 'old', 'older');
    await new Promise((r) => setTimeout(r, 10));
    await writeConversation(agyDir, 'new', 'newer');

    const sessions = await new AntigravitySessionScanner(agyDir).scan({ limit: 1 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('new');
  });
});
