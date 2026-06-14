import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSandboxProfile,
  defaultDenyReadPaths,
  writeSandboxProfile,
} from '../src/agents/pty/SandboxProfile.js';

describe('SandboxProfile', () => {
  it('builds the R1 profile with write locks and sensitive read denies', () => {
    const profile = buildSandboxProfile({
      boxRoots: ['/Users/joulian/project box', '/Users/joulian/另一个项目'],
      homeDir: '/Users/joulian',
      ptyHandleDir: '/Users/joulian/.cli2im/pty/handle-1',
      denyReadPaths: defaultDenyReadPaths('/Users/joulian'),
      otherProtectedRoots: ['/Users/joulian/projects/other-bot'],
    });

    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(allow network-outbound (remote tcp))');
    expect(profile).not.toContain('(allow network*)');
    expect(profile).not.toContain('(allow network-outbound)');
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain('(subpath "/Users/joulian/project box")');
    expect(profile).toContain('(subpath "/Users/joulian/另一个项目")');
    // file-ioctl is REQUIRED for the interactive TUI's setRawMode; without it the bot
    // inits but never ingests input (real-machine finding).
    expect(profile).toContain('(allow file-ioctl)');
    // Only claude runtime directories are writable; executable config and
    // ~/.claude.json are explicitly write-denied after broad box-root allows.
    for (const dir of [
      'projects',
      'todos',
      'statsig',
      'shell-snapshots',
      'sessions',
      'session-env',
    ]) {
      expect(profile).toContain(`(subpath "/Users/joulian/.claude/${dir}")`);
    }
    expect(profile).not.toContain('(subpath "/Users/joulian/.claude")');
    expect(profile).toContain('(subpath "/Users/joulian/.cli2im/pty/handle-1")');
    expect(profile).toContain('(regex #"^/private/tmp/claude-[^/]+")');
    expect(profile).toContain('(subpath "/dev")');

    expect(profile).toContain('(subpath "/Users/joulian/.ssh")');
    expect(profile).toContain('(literal "/Users/joulian/.npmrc")');
    expect(profile).toContain('(subpath "/Users/joulian/Library/Cookies")');
    expect(profile).toContain('(subpath "/Users/joulian/Library/Application Support/Google/Chrome")');
    // keychain must stay READABLE (claude reads its OAuth from the login keychain).
    expect(profile).not.toContain('Library/Keychains');

    expect(profile).toContain('(deny file-read*\n  (subpath "/Users/joulian/projects/other-bot"))');
    expect(profile).toContain('(deny file-write*\n  (subpath "/Users/joulian/projects/other-bot"))');
    expect(profile.indexOf('(deny file-read*\n  (subpath "/Users/joulian/.ssh")')).toBeLessThan(
      profile.indexOf('(allow file-read*\n  (subpath "/Users/joulian/.cli2im/pty/handle-1"))'),
    );
    const allowWriteIndex = profile.indexOf('(allow file-write*');
    const protectedWriteDenyIndex = profile.indexOf('(deny file-write*\n  (subpath "/Users/joulian/projects/other-bot"))');
    const lateWriteDenyIndex = profile.lastIndexOf('(deny file-write*');
    expect(lateWriteDenyIndex).toBeGreaterThan(allowWriteIndex);
    expect(lateWriteDenyIndex).toBeGreaterThan(protectedWriteDenyIndex);
    const lateWriteDeny = profile.slice(lateWriteDenyIndex);
    for (const rule of [
      '(subpath "/Users/joulian/.ssh")',
      '(literal "/Users/joulian/.npmrc")',
      '(subpath "/Users/joulian/Library/Cookies")',
      '(subpath "/Users/joulian/.codex")',
      '(literal "/Users/joulian/.claude/settings.json")',
      '(literal "/Users/joulian/.claude/CLAUDE.md")',
      '(subpath "/Users/joulian/.claude/hooks")',
      '(subpath "/Users/joulian/.claude/commands")',
      '(subpath "/Users/joulian/.claude/agents")',
      '(subpath "/Users/joulian/.claude/skills")',
      '(subpath "/Users/joulian/.claude/plugins")',
      '(literal "/Users/joulian/.claude.json")',
    ]) {
      expect(lateWriteDeny).toContain(rule);
    }
    expect(profile.lastIndexOf('(deny file-link)')).toBeGreaterThan(profile.lastIndexOf('(allow file-write*'));
    expect(profile.lastIndexOf('(deny file-clone)')).toBeGreaterThan(profile.lastIndexOf('(allow file-write*'));
  });

  it('escapes Scheme string literals', () => {
    const profile = buildSandboxProfile({
      boxRoots: ['/tmp/project "quoted" \\ root'],
      homeDir: '/Users/test',
      ptyHandleDir: '/Users/test/.cli2im/pty/h',
      denyReadPaths: [],
      otherProtectedRoots: [],
    });

    expect(profile).toContain('(subpath "/tmp/project \\"quoted\\" \\\\ root")');
  });

  it('writes a per-handle profile file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli2im-sandbox-profile-'));
    const profilePath = await writeSandboxProfile({
      handle: 'handle-1',
      ptyHandleDir: dir,
      profile: '(version 1)\n',
    });

    expect(profilePath).toBe(join(dir, 'handle-1-sandbox.sb'));
    await expect(readFile(profilePath, 'utf8')).resolves.toBe('(version 1)\n');
  });
});
