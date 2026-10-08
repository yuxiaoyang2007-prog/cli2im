import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';

export type CapturedRequest = Record<string, unknown>;
export interface ScriptCall {
  name: string; input: Record<string, unknown> | string; type?: 'function' | 'custom';
  checkName?: string;
  beforeCall?: () => void | Promise<void>;
}
export interface ScriptResult { id: string; name: string; output: unknown; isError: boolean; checkName?: string }
export interface MockModelOptions {
  protocol: 'anthropic' | 'responses';
  /** Per-check placeholder; protects evidence from unrelated loopback clients. */
  apiKey?: string;
  script: (request: CapturedRequest) => ScriptCall[] | Promise<ScriptCall[]>;
}
export interface MockModel {
  url: string;
  /** Sensitive request data stays in memory and must never be logged or persisted. */
  requests: CapturedRequest[];
  results: ScriptResult[];
  readonly completed: boolean;
  readonly error: string | undefined;
  readonly failureStatus?: 'UNSUPPORTED' | 'ERROR';
  close(): Promise<void>;
}
interface PendingCall extends ScriptCall { id: string }
type Event = Record<string, unknown> & { type: string };
const encode = (events: Event[]) => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
type Decompress = (input: Uint8Array, options: { maxOutputLength: number }) => Buffer;
const zstdDecoder = (zlib as unknown as { zstdDecompressSync?: Decompress }).zstdDecompressSync;
export class ModelProtocolError extends Error {
  constructor(readonly status: number, readonly category: string) { super(category); }
}
export function decodeModelRequest(bytes: Buffer, encoding = 'identity', zstd: Decompress | null = zstdDecoder ?? null): Buffer {
  if (bytes.length > MAX_REQUEST_BYTES) throw new ModelProtocolError(413, 'request-too-large');
  const options = { maxOutputLength: MAX_REQUEST_BYTES };
  if (encoding === 'identity') return bytes;
  if (encoding === 'gzip') return zlib.gunzipSync(bytes, options);
  if (encoding === 'zstd') {
    if (!zstd) throw new ModelProtocolError(415, 'unsupported-zstd-runtime');
    return zstd(bytes, options);
  }
  throw new ModelProtocolError(415, 'unsupported-content-encoding');
}

/** The small Messages subset consumed by the Claude SDK streaming parser. */
export function anthropicSSE(model: string, call?: PendingCall): string {
  const content = call
    ? { type: 'tool_use', id: call.id, name: call.name, input: {} }
    : { type: 'text', text: '' };
  return encode([
    { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: content },
    { type: 'content_block_delta', index: 0, delta: call
      ? { type: 'input_json_delta', partial_json: typeof call.input === 'string' ? call.input : JSON.stringify(call.input) }
      : { type: 'text_delta', text: 'Isolation check complete.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
}

/** Responses supports both JSON function calls and free-form native custom tools. */
export function responsesSSE(model: string, call?: PendingCall): string {
  const id = `resp_${randomUUID()}`;
  const itemId = `${call ? 'fc' : 'msg'}_${randomUUID()}`;
  const custom = call?.type === 'custom';
  const value = call ? (typeof call.input === 'string' ? call.input : JSON.stringify(call.input)) : '';
  const item = call
    ? { type: custom ? 'custom_tool_call' : 'function_call', id: itemId, call_id: call.id, name: call.name, ...(custom ? { input: value } : { arguments: value }), status: 'completed' }
    : { type: 'message', id: itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Isolation check complete.', annotations: [] }] };
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'in_progress', error: null, output: [], parallel_tool_calls: false };
  const events: Event[] = [
    { type: 'response.created', response },
    { type: 'response.in_progress', response },
    { type: 'response.output_item.added', output_index: 0, item: call ? { ...item, status: 'in_progress', ...(custom ? { input: '' } : { arguments: '' }) } : { ...item, status: 'in_progress', content: [] } },
  ];
  if (call) {
    const prefix = custom ? 'response.custom_tool_call_input' : 'response.function_call_arguments';
    events.push(
      { type: `${prefix}.delta`, item_id: itemId, output_index: 0, delta: value },
      { type: `${prefix}.done`, item_id: itemId, output_index: 0, ...(custom ? { input: value } : { arguments: value }) },
    );
  } else {
    const part = { type: 'output_text', text: 'Isolation check complete.', annotations: [] };
    events.push(
      { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { ...part, text: '' } },
      { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: part.text },
      { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: part.text },
      { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part },
    );
  }
  events.push(
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  );
  return encode(events.map((event, sequence_number) => ({ ...event, sequence_number })));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function capturedTools(request: CapturedRequest): Array<Record<string, unknown> & { name: string }> {
  const output: Array<Record<string, unknown> & { name: string }> = [];
  const visit = (tools: unknown, prefix = '') => {
    for (const tool of Array.isArray(tools) ? tools : []) {
      if (!record(tool)) { output.push({ name: `${prefix}invalid-tool` }); continue; }
      const name = typeof tool.name === 'string' ? tool.name : typeof tool.type === 'string' ? tool.type : 'invalid-tool';
      if (tool.type === 'namespace' && typeof tool.name === 'string') visit(tool.tools, `${prefix}${tool.name}.`);
      else output.push({ ...tool, name: `${prefix}${name}` });
    }
  };
  visit(request.tools);
  return output;
}

export function extractToolResults(request: CapturedRequest, protocol: MockModelOptions['protocol']): Array<{ id: string; output: unknown; isError: boolean }> {
  const output: Array<{ id: string; output: unknown; isError: boolean }> = [];
  if (protocol === 'anthropic') {
    for (const message of Array.isArray(request.messages) ? request.messages : []) {
      if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (record(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          output.push({ id: block.tool_use_id, output: block.content, isError: block.is_error === true });
        }
      }
    }
  } else {
    for (const item of Array.isArray(request.input) ? request.input : []) {
      if (record(item) && ['function_call_output', 'custom_tool_call_output'].includes(String(item.type)) && typeof item.call_id === 'string') {
        output.push({ id: item.call_id, output: item.output, isError: item.is_error === true });
      }
    }
  }
  return output;
}

/** Loopback only; no model call or credential is ever forwarded elsewhere. */
export async function startMockModel(options: MockModelOptions): Promise<MockModel> {
  const requests: CapturedRequest[] = [];
  const results: ScriptResult[] = [];
  let script: ScriptCall[] | undefined;
  let pending: PendingCall | undefined;
  let completed = false;
  let error: string | undefined;
  let failureStatus: MockModel['failureStatus'];
  const server = createServer(async (req, res) => {
    const pathname = req.url?.split('?')[0];
    const paths = options.protocol === 'anthropic' ? ['/v1/messages', '/messages', '/v1/messages/count_tokens'] : ['/v1/responses', '/responses'];
    const modelPost = req.method === 'POST' && paths.includes(pathname ?? '');
    const fail = (status: number, name: string) => {
      if (modelPost) {
        error ??= name;
        failureStatus ??= name.startsWith('unsupported-') ? 'UNSUPPORTED' : 'ERROR';
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'isolation_check_error', message: name } }));
    };
    try {
      if (options.apiKey && req.headers['x-api-key'] !== options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
        res.writeHead(401); res.end(); return;
      }
      if (req.method === 'GET' && ['/models', '/v1/models'].includes(pathname ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'isolation-check', object: 'model', owned_by: 'local' }] }));
        return;
      }
      if (!modelPost) return fail(404, 'unsupported-endpoint');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) return fail(413, 'request-too-large');
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(decodeModelRequest(Buffer.concat(chunks), req.headers['content-encoding']).toString('utf8'));
      if (!record(body)) return fail(400, 'invalid-request');
      if (pathname?.endsWith('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1 }));
        return;
      }
      requests.push(body);
      // Auxiliary requests have no access to script/pending state, even while
      // the main request awaits script preparation or a beforeCall hook.
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        const model = typeof body.model === 'string' ? body.model : 'isolation-check';
        if (options.protocol === 'anthropic' && body.stream !== true) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model,
            content: [{ type: 'text', text: 'Isolation diagnostic.' }], stop_reason: 'end_turn',
            stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(options.protocol === 'anthropic' ? anthropicSSE(model) : responsesSSE(model));
        }
        return;
      }
      if (error) return fail(409, error);
      if (!script) {
        script = await options.script(body);
        if (!script.length) return fail(400, 'empty-probe-script');
      }
      if (pending) {
        const matches = extractToolResults(body, options.protocol).filter(result => result.id === pending!.id);
        if (matches.length !== 1) return fail(409, 'missing-or-duplicate-tool-result');
        results.push({ ...matches[0], name: pending.name, ...(pending.checkName ? { checkName: pending.checkName } : {}) });
        pending = undefined;
      }
      if (results.length < script.length) {
        const next = script[results.length];
        const tool = capturedTools(body).find(tool => tool.name === next.name);
        if (!tool) return fail(400, 'script-tool-unavailable');
        await next.beforeCall?.();
        pending = { ...next, type: next.type ?? (record(tool) && tool.type === 'custom' ? 'custom' : 'function'), id: `call_${randomUUID()}` };
      } else completed = true;
      const model = typeof body.model === 'string' ? body.model : 'isolation-check';
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.end(options.protocol === 'anthropic' ? anthropicSSE(model, pending) : responsesSSE(model, pending));
    } catch (caught) {
      if (!res.headersSent) fail(caught instanceof ModelProtocolError ? caught.status : 400,
        caught instanceof ModelProtocolError ? caught.category : 'invalid-model-request');
      else { error ??= 'stream-error'; failureStatus ??= 'ERROR'; res.destroy(); }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests, results,
    get completed() { return completed && !error; },
    get error() { return error; },
    get failureStatus() { return failureStatus; },
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
      server.closeAllConnections();
    }),
  };
}
