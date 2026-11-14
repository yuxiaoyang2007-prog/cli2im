import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { dirname } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
import { AgyPlugin } from '../src/agents/agy.js';

class Child extends EventEmitter {
  chunks: string[] = [];
  stdin = new Writable({
    write: (chunk, _encoding, done) => {
      this.chunks.push(String(chunk));
      done();
    },
  });
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    this.emit('close', null);
    return true;
  });
}

function collectAddDirs(args: string[]): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--add-dir' && args[i + 1]) {
      dirs.push(args[i + 1]);
    }
  }
  return dirs;
}

describe('AGY prompt privacy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.spawn.mockReset();
  });

  it('passes prompts via stream-json stdin and keeps secrets out of args and child env', () => {
    const child = new Child();
    mocks.spawn.mockReturnValue(child);
    vi.stubEnv('FEISHU_APP_SECRET', 'bridge-secret');
    const plugin = new AgyPlugin('/test/agy');
    const proc = plugin.spawn({ workingDirectory: '/project', permissionMode: 'bypass' });
    proc.stdout.resume();
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'private prompt\n--leading-flag' }));

    const [, args, options] = mocks.spawn.mock.calls[0];
    expect(args).not.toContain('--print');
    expect(args).not.toContain('-p');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(JSON.stringify(args)).not.toContain('private prompt');
    expect(JSON.parse(child.chunks.join('').trim())).toEqual({
      event: 'user',
      message: { role: 'user', content: 'private prompt\n--leading-flag' },
    });
    expect(options.env).not.toHaveProperty('FEISHU_APP_SECRET');

    const imgDir = collectAddDirs(args).find((d) => d.includes('cli2im-agy-images-'));
    expect(imgDir).toBeDefined();
    expect(statSync(imgDir!).mode & 0o777).toBe(0o700);

    proc.kill();
    expect(existsSync(imgDir!)).toBe(false);
  });

  it('removes the private image directory when spawning fails synchronously', () => {
    let imgDir = '';
    mocks.spawn.mockImplementation((_binary, args: string[]) => {
      imgDir = collectAddDirs(args).find((d) => d.includes('cli2im-agy-images-')) ?? '';
      throw new Error('spawn failed');
    });
    const plugin = new AgyPlugin('/test/agy');
    const proc = plugin.spawn({ workingDirectory: '/project', permissionMode: 'bypass' });
    proc.stdin.on('error', () => undefined);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'private' }));
    expect(imgDir).not.toBe('');
    expect(existsSync(imgDir)).toBe(false);
    proc.kill();
  });

  it('keeps private image input during the session and removes it when the session closes', () => {
    const child = new Child();
    mocks.spawn.mockReturnValue(child);
    const plugin = new AgyPlugin('/test/agy');
    const proc = plugin.spawn({ workingDirectory: '/project', permissionMode: 'bypass' });
    proc.stdout.resume();
    proc.stdin.write(
      plugin.formatStdinMessage({
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: Buffer.from('image-data').toString('base64'),
            },
          },
        ],
      }),
    );

    const wire = JSON.parse(child.chunks.join('').trim()) as {
      event: string;
      message: { role: string; content: string };
    };
    const path = /- (.+\.png)/.exec(wire.message.content)?.[1];
    expect(path).toBeDefined();
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path!)).mode & 0o777).toBe(0o700);

    child.emit('close', 1);
    expect(existsSync(path!)).toBe(true);
    proc.kill();
    expect(existsSync(dirname(path!))).toBe(false);
  });
});
