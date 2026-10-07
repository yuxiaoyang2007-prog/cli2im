// Opt-in runtime smoke. Uses only ephemeral loopback listeners and never contacts the internet.
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { once } from 'node:events';
import { applyProxyEnvironment } from '../../src/security/network-policy.ts';

let directRequests = 0;
let proxyRequests = 0;
const sockets = new Set();
const origin = http.createServer((_req, res) => { directRequests += 1; res.end('DIRECT'); });
const proxy = http.createServer((_req, res) => {
  proxyRequests += 1;
  res.setHeader('Connection', 'close');
  res.end('PROXIED');
});
proxy.on('connect', (_req, socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.on('error', () => undefined);
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  socket.once('data', () => {
    proxyRequests += 1;
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nPROXIED');
  });
});

function getText(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.once('end', () => resolve(text));
    });
    request.setTimeout(1500, () => request.destroy(new Error('local smoke request timed out')));
    request.once('error', reject);
  });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

try {
  const originPort = await listen(origin);
  const proxyPort = await listen(proxy);
  const address = `http://127.0.0.1:${proxyPort}`;
  applyProxyEnvironment({ httpProxy: address, httpsProxy: address, noProxy: '' });
  assert.equal(typeof http.setGlobalProxyFromEnv, 'function', 'requires the runtime proxy API');
  http.setGlobalProxyFromEnv(process.env);
  const url = `http://127.0.0.1:${originPort}/probe`;
  assert.equal(await getText(url), 'PROXIED');
  assert.equal(await (await fetch(url, { signal: AbortSignal.timeout(1500) })).text(), 'PROXIED');
  assert.equal(proxyRequests, 2, 'http and fetch must both visit the proxy');
  assert.equal(directRequests, 0, 'the direct origin must not be contacted');

  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => proxy.close(resolve));
  await assert.rejects(getText(url));
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1500) }));
  assert.equal(directRequests, 0, 'proxy failure must not fall back to the direct origin');
  console.log(JSON.stringify({ node: process.version, httpViaProxy: true, fetchViaProxy: true, proxyDownRejects: true, directRequests }));
} finally {
  for (const socket of sockets) socket.destroy();
  proxy.closeAllConnections();
  origin.closeAllConnections();
  proxy.close();
  origin.close();
}
