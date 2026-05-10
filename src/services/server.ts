import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { HandoffRequest } from '../types.js';

export interface ServerDeps {
  acceptHandoff: (req: HandoffRequest) => Promise<{ success: boolean; error?: string }>;
  releaseHandoff: (sessionKey: string) => Promise<{ sessionId: string; resumeCommand: string }>;
  getStatus: () => { uptime: number; activeSessions: number; bots: string[] };
}

export class HttpServer {
  private server: ReturnType<typeof createServer> | null = null;
  private token: string;
  private deps: ServerDeps;

  constructor(token: string, deps: ServerDeps) {
    this.token = token;
    this.deps = deps;
  }

  async start(host: string, port: number): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    return new Promise((resolve) => {
      this.server!.listen(port, host, () => {
        console.log(`[server] HTTP server listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === '/health' && req.method === 'GET') {
      this.json(res, 200, { status: 'ok', ...this.deps.getStatus() });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!isAuthorizedBearerToken(authHeader, this.token)) {
      this.json(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      if (path === '/api/handoff/accept' && req.method === 'POST') {
        const body = await this.readBody(req);
        if (!body.botName || !body.sessionId || !body.workDir || !body.agentName) {
          this.json(res, 400, {
            error: 'Missing required fields: botName, sessionId, workDir, agentName',
          });
          return;
        }
        const result = await this.deps.acceptHandoff(body as unknown as HandoffRequest);
        this.json(res, result.success ? 200 : 400, result);
        return;
      }

      if (path === '/api/handoff/release' && req.method === 'POST') {
        const body = await this.readBody(req);
        if (!body.sessionKey || typeof body.sessionKey !== 'string') {
          this.json(res, 400, { error: 'Missing required field: sessionKey (string)' });
          return;
        }
        const result = await this.deps.releaseHandoff(body.sessionKey);
        this.json(res, 200, result);
        return;
      }

      if (path === '/api/handoff/status' && req.method === 'GET') {
        this.json(res, 200, this.deps.getStatus());
        return;
      }

      this.json(res, 404, { error: 'Not found' });
    } catch (err) {
      this.json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage, maxSize = 1_048_576): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          req.destroy();
          reject(new Error('Body too large'));
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(body) as Record<string, unknown>);
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }
}

export function isAuthorizedBearerToken(authHeader: string | undefined, token: string): boolean {
  if (!authHeader) return false;

  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(authHeader);
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}
