import { describe, expect, it } from 'vitest';
import { handleMcpMessage } from '../src/notifications/mcp-server.js';

describe('codex-task-notifier MCP server', () => {
  it('initializes and lists exactly two status tools', () => {
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toMatchObject({
      jsonrpc: '2.0', id: 1, result: { protocolVersion: expect.any(String) },
    });
    const listed = handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as any;
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual(['mark_waiting', 'mark_completed']);
  });

  it('validates waiting and completed arguments', () => {
    expect(handleMcpMessage({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'mark_waiting', arguments: { reason: 'question' } },
    })).toMatchObject({ result: { isError: false } });
    expect(handleMcpMessage({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'mark_completed', arguments: {} },
    })).toMatchObject({ result: { isError: false } });
    expect(handleMcpMessage({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'mark_completed', arguments: { extra: true } },
    })).toMatchObject({ error: { code: -32602 } });
    expect(handleMcpMessage({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'mark_waiting', arguments: { reason: 'later' } },
    })).toMatchObject({ error: { code: -32602 } });
  });

  it('ignores initialized notifications and rejects unknown methods', () => {
    expect(handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'unknown' })).toMatchObject({
      error: { code: -32601 },
    });
  });
});
