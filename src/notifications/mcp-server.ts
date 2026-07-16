import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

const TOOLS = [
  {
    name: 'mark_waiting',
    description: 'Report that the main Codex task is waiting for a user answer or confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', enum: ['question', 'confirmation'] },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'mark_completed',
    description: 'Report that the main Codex task has been fully completed and delivered.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export function handleMcpMessage(input: unknown): Record<string, unknown> | null {
  if (!isRequest(input)) return error(null, -32600, 'Invalid Request');
  if (input.method === 'notifications/initialized') return null;
  const id = input.id ?? null;
  switch (input.method) {
    case 'initialize':
      return success(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'codex-task-notifier', version: '0.1.0' },
      });
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, { tools: TOOLS });
    case 'tools/call':
      return handleToolCall(id, input.params);
    default:
      return error(id, -32601, 'Method not found');
  }
}

function handleToolCall(id: JsonRpcRequest['id'], params: unknown): Record<string, unknown> {
  if (!isRecord(params) || typeof params.name !== 'string' || !isRecord(params.arguments)) {
    return error(id ?? null, -32602, 'Invalid params');
  }
  const keys = Object.keys(params.arguments);
  if (params.name === 'mark_completed') {
    if (keys.length !== 0) return error(id ?? null, -32602, 'Invalid params');
  } else if (params.name === 'mark_waiting') {
    if (keys.length !== 1 || !Object.hasOwn(params.arguments, 'reason')
      || (params.arguments.reason !== 'question' && params.arguments.reason !== 'confirmation')) {
      return error(id ?? null, -32602, 'Invalid params');
    }
  } else {
    return error(id ?? null, -32602, 'Unknown tool');
  }
  return success(id ?? null, {
    content: [{ type: 'text', text: 'Task status recorded by Codex lifecycle hooks.' }],
    isError: false,
  });
}

function success(id: JsonRpcRequest['id'], result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function error(id: JsonRpcRequest['id'], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value)
    && value.jsonrpc === '2.0'
    && typeof value.method === 'string'
    && (value.id === undefined || value.id === null || typeof value.id === 'string' || typeof value.id === 'number');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function runMcpServer(): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    try {
      const response = handleMcpMessage(JSON.parse(line) as unknown);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify(error(null, -32700, 'Parse error'))}\n`);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMcpServer();
