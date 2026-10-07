import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { dirname } from 'node:path';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(), spawn: mocks.spawn,
}));
import { AgyPlugin } from '../src/agents/agy.js';

class Child extends EventEmitter {
  chunks: string[] = [];
  stdin = new Writable({ write: (chunk, _encoding, done) => { this.chunks.push(String(chunk)); done(); } });
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => { this.emit('close', null); return true; });
}

describe('AGY prompt privacy', () => {
  afterEach(() => { vi.unstubAllEnvs(); mocks.spawn.mockReset(); });

  it('passes even short prompts only through stdin and removes its private turn log', async () => {
    const child = new Child();
    mocks.spawn.mockReturnValue(child);
    vi.stubEnv('FEISHU_APP_SECRET', 'bridge-secret');
    const plugin = new AgyPlugin('/test/agy');
    const proc = plugin.spawn({ workingDirectory: '/project', permissionMode: 'bypass' });
    proc.stdout.resume();
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'private prompt\n--leading-flag' }));
    const [, args, options] = mocks.spawn.mock.calls[0];
    expect(args).toContain('--print');
    expect(JSON.stringify(args)).not.toContain('private prompt');
    expect(child.chunks.join('')).toBe('private prompt\n--leading-flag');
    expect(options.env).not.toHaveProperty('FEISHU_APP_SECRET');
    const log = args[args.indexOf('--log-file') + 1];
    expect(statSync(dirname(log)).mode & 0o777).toBe(0o700);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    writeFileSync(log, 'temporary diagnostic content');
    child.emit('close', 1);
    expect(existsSync(dirname(log))).toBe(false);
    proc.kill();
  });

  it('removes the turn directory when spawning fails synchronously', () => {
    let log = '';
    mocks.spawn.mockImplementation((_binary, args) => {
      log = args[args.indexOf('--log-file') + 1];
      throw new Error('spawn failed');
    });
    const plugin = new AgyPlugin('/test/agy');
    const proc = plugin.spawn({ workingDirectory: '/project', permissionMode: 'bypass' });
    proc.stdin.on('error', () => undefined);
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: 'private' }));
    expect(existsSync(dirname(log))).toBe(false);
    proc.kill();
  });

  it('keeps private image input during the session and removes it when the session closes', () => {
    const child = new Child();
    mocks.spawn.mockReturnValue(child);
    const plugin = new AgyPlugin('/test/agy');
    const proc = plugin.spawn({ workingDirectory: '/project', permissionMode: 'bypass' });
    proc.stdout.resume();
    proc.stdin.write(plugin.formatStdinMessage({ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('image-data').toString('base64') } },
    ] }));
    const prompt = child.chunks.join('');
    const path = /- (.+\.png)/.exec(prompt)?.[1];
    expect(path).toBeDefined();
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path!)).mode & 0o777).toBe(0o700);
    child.emit('close', 1);
    expect(existsSync(path!)).toBe(true);
    proc.kill();
    expect(existsSync(dirname(path!))).toBe(false);
  });
});
