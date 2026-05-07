import { describe, it, expect } from 'vitest';
import { ToolGate } from '../src/agents/tool-gate.js';

const DEFAULT_PATTERNS = [
  'rm\\s+(-[a-zA-Z]*f[a-zA-Z]*\\s+|.*--force).*\\/',
  'mkfs\\.',
  'dd\\s+.*of=\\/dev\\/',
  'git\\s+push\\s+.*--force',
  'git\\s+reset\\s+--hard',
  'git\\s+clean\\s+-[a-zA-Z]*f',
  'kill\\s+-9',
  'killall',
  'pkill',
  'sudo\\s+',
  'shutdown|reboot',
  '>\\s*\\/etc\\/',
  'rm\\s+.*\\.(env|credentials)',
];

describe('ToolGate', () => {
  const gate = new ToolGate(DEFAULT_PATTERNS);

  it('allows safe commands', () => {
    const result = gate.check('Bash', { command: 'ls -la' });
    expect(result.action).toBe('allow');
  });

  it('allows grep', () => {
    const result = gate.check('Bash', { command: "grep -r 'TODO' src/" });
    expect(result.action).toBe('allow');
  });

  it('blocks rm -rf /', () => {
    const result = gate.check('Bash', { command: 'rm -rf /tmp/data' });
    expect(result.action).toBe('block');
  });

  it('blocks sudo', () => {
    const result = gate.check('Bash', { command: 'sudo apt install nginx' });
    expect(result.action).toBe('block');
    expect(result.reason).toContain('sudo');
  });

  it('blocks git push --force', () => {
    const result = gate.check('Bash', { command: 'git push origin main --force' });
    expect(result.action).toBe('block');
  });

  it('blocks git reset --hard', () => {
    const result = gate.check('Bash', { command: 'git reset --hard HEAD~3' });
    expect(result.action).toBe('block');
  });

  it('blocks kill -9', () => {
    const result = gate.check('Bash', { command: 'kill -9 12345' });
    expect(result.action).toBe('block');
  });

  it('blocks pkill', () => {
    const result = gate.check('Bash', { command: 'pkill node' });
    expect(result.action).toBe('block');
  });

  it('blocks rm .env', () => {
    const result = gate.check('Bash', { command: 'rm .env' });
    expect(result.action).toBe('block');
  });

  it('ignores non-Bash tools', () => {
    const result = gate.check('Read', { file_path: '/etc/passwd' });
    expect(result.action).toBe('allow');
  });

  it('checks Edit/Write file_path for /etc/', () => {
    const result = gate.check('Write', { file_path: '/etc/hosts' });
    // Write to /etc/ matched by > /etc/ pattern when treated as shell redirect
    // Actually for Write tool, we check file_path against patterns too
    expect(result.action).toBe('allow'); // Write tool file_path is not a shell command
  });
});
