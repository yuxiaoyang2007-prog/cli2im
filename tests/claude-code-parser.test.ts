import { describe, it, expect } from 'vitest';
import { ClaudeCodePlugin } from '../src/agents/claude-code.js';
import { Readable } from 'node:stream';
import type { AgentEvent } from '../src/types.js';

function collectEvents(parser: NodeJS.ReadWriteStream, input: string): Promise<AgentEvent[]> {
  return new Promise((resolve, reject) => {
    const events: AgentEvent[] = [];
    const readable = Readable.from([input]);
    readable
      .pipe(parser)
      .on('data', (event: AgentEvent) => events.push(event))
      .on('end', () => resolve(events))
      .on('error', reject);
  });
}

describe('ClaudeCodePlugin stdout parser', () => {
  const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');

  it('parses assistant text message', async () => {
    const input = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    }) + '\n';

    const events = await collectEvents(plugin.createStdoutParser(), input);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'text', content: 'Hello world' });
  });

  it('parses tool_use event', async () => {
    const input = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }],
      },
    }) + '\n';

    const events = await collectEvents(plugin.createStdoutParser(), input);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('parses tool_result event', async () => {
    const input = JSON.stringify({
      type: 'result',
      result: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
      },
      session_id: 'ses_abc',
    }) + '\n';

    const events = await collectEvents(plugin.createStdoutParser(), input);
    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent).toBeDefined();
    expect((resultEvent as any).sessionId).toBe('ses_abc');
  });

  it('parses permission_request', async () => {
    const input = JSON.stringify({
      type: 'tool_use_permission',
      tool_use_id: 'tu_2',
      tool_name: 'Bash',
      input: { command: 'rm -rf /' },
    }) + '\n';

    const events = await collectEvents(plugin.createStdoutParser(), input);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'permission_request',
      id: 'tu_2',
      tool: 'Bash',
      input: { command: 'rm -rf /' },
    });
  });

  it('handles multiple events in sequence', async () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a.ts' } }] } }),
    ].join('\n') + '\n';

    const events = await collectEvents(plugin.createStdoutParser(), lines);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('tool_use');
  });
});

describe('ClaudeCodePlugin formatStdinMessage', () => {
  const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');

  it('formats user text message', () => {
    const msg = plugin.formatStdinMessage({ role: 'user', content: 'hello' });
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content).toBe('hello');
  });
});

describe('ClaudeCodePlugin formatPermissionResponse', () => {
  const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');

  it('formats allow response', () => {
    const msg = plugin.formatPermissionResponse('tu_1', 'allow');
    const parsed = JSON.parse(msg);
    expect(parsed.type).toBe('tool_use_permission_response');
    expect(parsed.tool_use_id).toBe('tu_1');
    expect(parsed.decision).toBe('allow');
  });

  it('formats deny response', () => {
    const msg = plugin.formatPermissionResponse('tu_1', 'deny');
    const parsed = JSON.parse(msg);
    expect(parsed.decision).toBe('deny');
  });
});

describe('ClaudeCodePlugin buildSpawnArgs', () => {
  const plugin = new ClaudeCodePlugin('/usr/local/bin/claude');

  it('includes stream-json flags', () => {
    const args = plugin.buildSpawnArgs({
      workingDirectory: '~/projects',
      permissionMode: 'blacklist',
    });
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--output-format');
    expect(args).toContain('--permission-prompt-tool');
    expect(args).toContain('stdio');
  });

  it('includes model when specified', () => {
    const args = plugin.buildSpawnArgs({
      workingDirectory: '~/projects',
      permissionMode: 'blacklist',
      model: 'claude-sonnet-4-20250514',
    });
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-20250514');
  });
});
