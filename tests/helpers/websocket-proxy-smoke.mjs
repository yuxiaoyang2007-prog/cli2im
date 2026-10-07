// Local-only CONNECT routing probe. No DNS resolution or remote traffic is allowed.
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as https from 'node:https';
import { once } from 'node:events';
import WebSocket from 'ws';
import { WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { createWebSocketProxyAgent } from '../../src/security/network-policy.ts';

const proxy = http.createServer();
const connects = [];
let proxySockets = 0;
proxy.on('connection', () => { proxySockets += 1; });
proxy.on('connect', (request, socket) => {
  connects.push(request.url);
  // A deliberate proxy rejection proves routing without reaching a real TLS destination.
  socket.end('HTTP/1.1 502 Local Test Only\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
});
let targetLookups = 0;
async function probe(agent) {
  const priorConnects = connects.length;
  const priorLookups = targetLookups;
  const error = await new Promise((resolve) => {
    const ws = new WebSocket('wss://cli2im-test-target.invalid/socket', {
      agent,
      handshakeTimeout: 1000,
      lookup(_hostname, _options, callback) {
        targetLookups += 1;
        callback(Object.assign(new Error('local target lookup blocked by test'), { code: 'ENOTFOUND' }));
      },
    });
    ws.once('error', resolve);
    ws.once('open', () => { ws.terminate(); resolve(new Error('unexpected live connection')); });
  });
  return { proxyConnects: connects.length - priorConnects, targetLookups: targetLookups - priorLookups, code: error.code ?? 'PROXY_REJECTED' };
}

async function probeRetiredSdkAgent(env) {
  const agent = createWebSocketProxyAgent(env);
  const initialSockets = proxySockets;
  const initialConnects = connects.length;
  let resolveEndpoint;
  let requests = 0;
  let socketCreations = 0;
  let rejection;
  let timeout;
  const rejected = new Promise((resolve, reject) => {
    rejection = resolve;
    timeout = setTimeout(() => reject(new Error(`retired SDK request did not settle: requests=${requests}, sockets=${socketCreations}`)), 1000);
  });
  const addRequest = agent.addRequest;
  agent.addRequest = function (request, options) {
    requests += 1;
    request.once('error', rejection);
    addRequest.call(this, request, options);
  };
  const createConnection = agent.createConnection;
  agent.createConnection = function (...args) {
    socketCreations += 1;
    return createConnection.apply(this, args);
  };
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const client = new WSClient({
    appId: 'cli_0123456789abcdef', appSecret: 'fake-test-secret', agent, logger, autoReconnect: false,
    httpInstance: { request: () => new Promise((resolve) => { resolveEndpoint = resolve; }) },
  });
  try {
    await client.start({ eventDispatcher: new EventDispatcher({ logger }) });
    assert.equal(typeof resolveEndpoint, 'function');
    client.close({ force: true });
    agent.destroy();
    resolveEndpoint({ code: 0, data: {
      URL: 'wss://cli2im-test-target.invalid/socket?device_id=test&service_id=1',
      ClientConfig: { PingInterval: 30, ReconnectCount: 0, ReconnectInterval: 1, ReconnectNonce: 0 },
    } });
    const error = await rejected;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(error.code, 'ERR_PROXY_AGENT_RETIRED');
    assert.equal(requests, 1);
    assert.equal(socketCreations, 0);
    assert.equal(proxySockets - initialSockets, 0);
    assert.equal(connects.length - initialConnects, 0);
    return { lateRequests: requests, socketCreations, proxySockets: proxySockets - initialSockets, proxyConnects: connects.length - initialConnects, code: error.code };
  } finally {
    clearTimeout(timeout);
    client.close({ force: true });
    agent.destroy();
  }
}

try {
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = `http://127.0.0.1:${proxy.address().port}`;
  const env = { HTTP_PROXY: address, HTTPS_PROXY: address, http_proxy: address, https_proxy: address, NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1' };
  http.setGlobalProxyFromEnv(env);
  const globalResult = await probe(https.globalAgent);
  const explicit = createWebSocketProxyAgent({ ...env, CLI2IM_NETWORK_REQUIRED: '1', NO_PROXY: '*', no_proxy: '*' });
  const explicitResult = await probe(explicit);
  assert.equal(explicitResult.proxyConnects, 1);
  assert.equal(explicitResult.targetLookups, 0);
  assert.equal(connects.at(-1), 'cli2im-test-target.invalid:443');
  const retiredSdkResult = await probeRetiredSdkAgent(env);
  await new Promise((resolve) => proxy.close(resolve));
  const downResult = await probe(explicit);
  explicit.destroy();
  assert.equal(downResult.proxyConnects, 0);
  assert.equal(downResult.targetLookups, 0);
  assert.ok(['ECONNREFUSED', 'ERR_PROXY_CONNECTION_FAILED'].includes(downResult.code));
  console.log(JSON.stringify({ node: process.version, globalAgent: globalResult, productionProxyAgent: explicitResult, retiredSdkAgent: retiredSdkResult, proxyDown: downResult }));
} finally {
  proxy.closeAllConnections();
  proxy.close();
}
