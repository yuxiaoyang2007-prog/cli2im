import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { anthropicSSE, capturedTools, decodeModelRequest, extractToolResults, responsesSSE, startMockModel } from '../src/isolation/mock-model.js';
import type { MockModel } from '../src/isolation/mock-model.js';

function events(stream: string): Array<Record<string, any>> {
  return stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}

// node:http deliberately avoids ambient HTTP proxy settings for the loopback fixture.
function post(url: string, body: unknown, encoding?: string, apiKey?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(encoding ? { 'content-encoding': encoding } : {}), ...(apiKey ? { 'x-api-key': apiKey } : {}) } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(encoding ? body : JSON.stringify(body));
  });
}

describe('scripted isolation model streaming protocols', () => {
  it('retains built-in and malformed definitions instead of hiding untested capabilities', () => {
    expect(capturedTools({ tools: [{ type: 'web_search' }, { type: 'image_generation' }, null] }).map(tool => tool.name))
      .toEqual(['web_search', 'image_generation', 'invalid-tool']);
  });
  it('bounds decoded request size and reports unsupported zstd runtimes explicitly', () => {
    const input = Buffer.from('{"tools":[]}');
    expect(decodeModelRequest(zlib.gzipSync(input), 'gzip')).toEqual(input);
    expect(() => decodeModelRequest(Buffer.from('fixture'), 'zstd', null)).toThrow('unsupported-zstd-runtime');
    expect(() => decodeModelRequest(input, 'br')).toThrow('unsupported-content-encoding');
    expect(() => decodeModelRequest(zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1)), 'gzip')).toThrow();
    expect(() => decodeModelRequest(Buffer.from('broken gzip'), 'gzip')).toThrow();
  });
  it('Messages emits a streamed tool input, tool_use stop, and final end_turn', () => {
    const stream = events(anthropicSSE('claude-fixture', { id: 'probe', name: 'Bash', input: { command: 'true' } }));
    expect(stream.map(item => item.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(stream[0].message.content).toEqual([]);
    expect(stream[1].content_block).toEqual({ type: 'tool_use', id: 'probe', name: 'Bash', input: {} });
    expect(JSON.parse(stream[2].delta.partial_json)).toEqual({ command: 'true' });
    expect(stream[4].delta.stop_reason).toBe('tool_use');
    expect(events(anthropicSSE('claude-fixture'))[4].delta.stop_reason).toBe('end_turn');
  });

  it.each(['function', 'custom'] as const)('Responses streams %s calls and completed output with contiguous sequence numbers', type => {
    const stream = events(responsesSSE('codex-fixture', { id: 'probe', name: 'apply_patch', type, input: 'fixture-input' }));
    expect(stream.map(item => item.sequence_number)).toEqual(stream.map((_, index) => index));
    expect(stream[0].response.status).toBe('in_progress');
    expect(stream[2].item.call_id).toBe('probe');
    const prefix = type === 'custom' ? 'custom_tool_call_input' : 'function_call_arguments';
    expect(stream[3]).toMatchObject({ type: `response.${prefix}.delta`, delta: 'fixture-input' });
    expect(stream.at(-1)).toMatchObject({ type: 'response.completed', response: { status: 'completed', output: [{ name: 'apply_patch', call_id: 'probe' }] } });
    expect(events(responsesSSE('codex-fixture')).at(-1)?.response.output[0].content[0].type).toBe('output_text');
  });

  it('extracts only protocol tool results, retaining error and multimodal data', () => {
    expect(extractToolResults({ messages: [{ role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'wrong' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'probe', content: [{ type: 'text', text: 'EPERM' }], is_error: true }] }] }, 'anthropic')).toEqual([{ id: 'probe', output: [{ type: 'text', text: 'EPERM' }], isError: true }]);
    expect(extractToolResults({ input: [{ type: 'custom_tool_call_output', call_id: 'probe', output: [{ type: 'input_image', image_url: 'fixture' }] }] }, 'responses')).toEqual([{ id: 'probe', output: [{ type: 'input_image', image_url: 'fixture' }], isError: false }]);
  });
});

describe('scripted isolation model HTTP integration', () => {
  const servers: MockModel[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

  it.each([
    { method: 'HEAD', authenticated: false }, { method: 'GET', authenticated: false },
    { method: 'HEAD', authenticated: true }, { method: 'GET', authenticated: true },
  ])('$method /api/hello does not poison a subsequent script (authenticated=$authenticated)', async ({ method, authenticated }) => {
    const apiKey = authenticated ? randomUUID() : undefined;
    const server = await startMockModel({ protocol: 'anthropic', apiKey, script: () => [{ name: 'Bash', input: { command: 'true' } }] });
    servers.push(server);
    const probe = () => new Promise<number>((resolve, reject) => {
      const req = request(`${server.url}/api/hello`, { method }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject); req.end();
    });
    expect(await probe()).toBe(authenticated ? 401 : 404);
    // Unknown non-model POST endpoints also cannot corrupt model evidence.
    expect((await post(`${server.url}/api/hello`, {}, undefined, apiKey)).status).toBe(404);
    expect(server.error).toBeUndefined(); expect(server.failureStatus).toBeUndefined();
    expect(server.requests).toEqual([]); expect(server.results).toEqual([]);
    const endpoint = `${server.url}/v1/messages`;
    const body = { tools: [{ name: 'Bash' }], messages: [] };
    const first = await post(endpoint, body, undefined, apiKey);
    expect(first.status).toBe(200);
    const call = events(first.text)[1].content_block;
    expect(await probe()).toBe(authenticated ? 401 : 404);
    const final = await post(endpoint, { ...body, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'done' }] }] }, undefined, apiKey);
    expect(final.status).toBe(200); expect(server.completed).toBe(true);
    expect(server.requests).toHaveLength(2); expect(server.results).toHaveLength(1);
    expect(server.error).toBeUndefined(); expect(server.failureStatus).toBeUndefined();
  });

  it('rejects unrelated loopback clients without contaminating check evidence', async context => {
    let server: MockModel;
    try { server = await startMockModel({ protocol: 'anthropic', apiKey: 'fixture-placeholder', script: () => [{ name: 'Bash', input: { command: 'true' } }] }); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    servers.push(server);
    const endpoint = `${server.url}/v1/messages`;
    const body = { model: 'fixture', tools: [{ name: 'Bash' }], messages: [] };
    expect((await post(endpoint, body)).status).toBe(401);
    expect((await post(endpoint, body, undefined, 'unrelated-placeholder')).status).toBe(401);
    expect(server.requests).toEqual([]);
    expect(server.error).toBeUndefined();
    const response = await post(endpoint, body, undefined, 'fixture-placeholder');
    expect(response.status).toBe(200);
    const call = events(response.text)[1].content_block;
    const final = { ...body, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'done' }] }] };
    expect((await post(endpoint, final, undefined, 'fixture-placeholder')).status).toBe(200);
    expect(server.completed).toBe(true);
    expect(server.requests).toHaveLength(2);
  });

  for (const encoding of ['gzip', 'zstd'] as const) it(`decodes ${encoding} requests over loopback without forwarding them`, async context => {
    const compressor = encoding === 'gzip' ? zlib.gzipSync : (zlib as unknown as { zstdCompressSync?: (bytes: Buffer) => Buffer }).zstdCompressSync;
    if (!compressor) { context.skip(); return; }
    let server: MockModel;
    try { server = await startMockModel({ protocol: 'responses', script: () => [{ name: 'shell', input: { command: 'fixture' } }] }); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    servers.push(server);
    const tools = [{ name: 'shell', type: 'function' }];
    const firstBody = { tools, input: [], model: 'fixture' };
    const first = await post(`${server.url}/responses`, compressor(Buffer.from(JSON.stringify(firstBody))), encoding);
    expect(first.status).toBe(200);
    const call = events(first.text)[2].item;
    const final = { tools, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'fixture result' }] };
    expect((await post(`${server.url}/responses`, compressor(Buffer.from(JSON.stringify(final))), encoding)).status).toBe(200);
    expect(server.requests[0]).toEqual(firstBody);
    expect(server.completed).toBe(true);
    expect(server.failureStatus).toBeUndefined();
  });

  for (const protocol of ['anthropic', 'responses'] as const) it(`${protocol} executes calls in order and requires every corresponding result`, async context => {
    let server: MockModel;
    try {
      server = await startMockModel({ protocol, script: request => {
        expect(request.tools).toBeDefined();
        return [{ name: 'shell', input: { command: 'probe' } }, { name: 'apply_patch', input: 'fixture patch' }];
      } });
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    servers.push(server);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const tools = [{ name: 'shell', type: 'function' }, { name: 'apply_patch', type: 'custom' }];
    const endpoint = `${server.url}/${protocol === 'anthropic' ? 'v1/messages' : 'responses'}`;
    const history: unknown[] = [];
    const makeBody = () => ({ model: 'fixture', tools, ...(protocol === 'anthropic' ? { messages: [{ role: 'user', content: history }] } : { input: history }) });
    for (const name of ['shell', 'apply_patch']) {
      const response = await post(endpoint, makeBody());
      expect(response.status).toBe(200);
      const stream = events(response.text);
      const call = protocol === 'anthropic' ? stream[1].content_block : stream[2].item;
      expect(call.name).toBe(name);
      expect(server.completed).toBe(false);
      history.push(protocol === 'anthropic'
        ? { type: 'tool_result', tool_use_id: call.id, content: `${name}-result` }
        : { type: name === 'apply_patch' ? 'custom_tool_call_output' : 'function_call_output', call_id: call.call_id, output: `${name}-result` });
    }
    const final = await post(endpoint, makeBody());
    expect(final.status).toBe(200);
    expect(server.completed).toBe(true);
    expect(server.results.map(result => [result.name, result.output])).toEqual([['shell', 'shell-result'], ['apply_patch', 'apply_patch-result']]);
    expect(server.requests).toHaveLength(3);
    expect(server.error).toBeUndefined();
  });

  it.each([false, true])('auxiliary title requests never advance or poison the script (concurrent=%s)', async concurrent => {
    let calls = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const server = await startMockModel({ protocol: 'anthropic', script: async () => {
      calls++; entered(); if (concurrent) await blocked;
      return [{ name: 'Bash', input: { command: 'fixture' } }];
    } });
    servers.push(server);
    const endpoint = `${server.url}/v1/messages`;
    const auxiliary = { tools: [], system: 'auxiliary instruction evidence', messages: [], stream: false };
    expect(JSON.parse((await post(endpoint, auxiliary)).text).stop_reason).toBe('end_turn');
    expect(calls).toBe(0); expect(server.completed).toBe(false);
    const body = { tools: [{ name: 'Bash' }], messages: [], stream: true };
    const main = post(endpoint, body);
    await started;
    if (concurrent) {
      const response = await post(endpoint, { ...auxiliary, stream: true });
      expect(events(response.text).at(-2)?.delta.stop_reason).toBe('end_turn');
      expect(server.results).toEqual([]); release();
    }
    const call = events((await main).text)[1].content_block;
    // Auxiliary arrival while a tool result is pending must not consume it.
    await post(endpoint, auxiliary);
    expect(server.results).toEqual([]); expect(server.completed).toBe(false);
    await post(endpoint, { ...body, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'done' }] }] });
    expect(calls).toBe(1); expect(server.completed).toBe(true); expect(server.error).toBeUndefined();
    expect(server.requests).toContainEqual(auxiliary);
    expect(server.results).toHaveLength(1);
  });

  it('missing results fail closed instead of advancing or inventing success', async context => {
    let server: MockModel;
    try { server = await startMockModel({ protocol: 'responses', script: () => [{ name: 'shell', input: {} }] }); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    servers.push(server);
    const body = { model: 'fixture', tools: [{ type: 'function', name: 'shell' }], input: [] };
    const first = await post(`${server.url}/v1/responses`, body);
    expect(first.status).toBe(200);
    expect((await post(`${server.url}/v1/responses`, body)).status).toBe(409);
    expect(server.completed).toBe(false);
    expect(server.results).toEqual([]);
    expect(server.error).toBe('missing-or-duplicate-tool-result');
    const call = events(first.text)[2].item;
    expect((await post(`${server.url}/v1/responses`, { ...body, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'late result' }] })).status).toBe(409);
    expect(server.completed).toBe(false); expect(server.results).toEqual([]);
  });

  it('awaits fixture preparation and runs the replacement hook before advertising a namespaced call', async context => {
    let replacements = 0;
    let server: MockModel;
    try {
      server = await startMockModel({ protocol: 'responses', script: async () => [{ name: 'functions.view_image', input: { path: '/synthetic.png' }, checkName: 'parent-replacement', beforeCall: async () => { replacements++; } }] });
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { context.skip(); return; }
      throw error;
    }
    servers.push(server);
    const tools = [{ type: 'namespace', name: 'functions', tools: [{ name: 'view_image', type: 'function' }] }];
    const first = await post(`${server.url}/responses`, { tools, input: [] });
    expect(first.status).toBe(200);
    expect(replacements).toBe(1);
    const call = events(first.text)[2].item;
    expect(call.name).toBe('functions.view_image');
    await post(`${server.url}/responses`, { tools, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'permission denied' }] });
    expect(replacements).toBe(1);
    expect(server.results[0].checkName).toBe('parent-replacement');
    expect(server.completed).toBe(true);
  });
});
