import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { HandoffRequest } from '../types.js';
import { validateWorkingDirectory } from '../security/validators.js';

export interface ServerDeps {
  acceptHandoff: (req: HandoffRequest) => Promise<{ success: boolean; error?: string }>;
  releaseHandoff: (sessionKey: string) => Promise<{ sessionId: string; resumeCommand: string }>;
  getStatus: () => { uptime: number; activeSessions: number; bots: string[] };
}

export interface HandoffValidationConfig {
  botNames: string[];
  agentNames: string[];
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CONTROL_OR_COLON_PATTERN = /[:\x00-\x1F\x7F]/;
const VALID_PLATFORMS = new Set(['feishu', 'telegram']);

class HttpRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class HttpServer {
  private server: ReturnType<typeof createServer> | null = null;
  private token: string;
  private deps: ServerDeps;
  private handoffValidation?: HandoffValidationConfig;

  constructor(token: string, deps: ServerDeps, handoffValidation?: HandoffValidationConfig) {
    this.token = token;
    this.deps = deps;
    this.handoffValidation = handoffValidation;
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
        const validationError = await validateHandoffRequestBody(body, this.handoffValidation);
        if (validationError) {
          this.json(res, 400, {
            error: validationError,
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
      if (err instanceof HttpRequestError) {
        this.json(res, err.status, { error: err.message });
        return;
      }
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
          const parsed = JSON.parse(body) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            reject(new HttpRequestError(400, 'Invalid request body'));
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch {
          reject(new HttpRequestError(400, 'Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }
}

export async function validateHandoffRequestBody(
  body: Record<string, unknown>,
  config?: HandoffValidationConfig,
): Promise<string | undefined> {
  if (
    typeof body.botName !== 'string'
    || typeof body.sessionId !== 'string'
    || typeof body.workDir !== 'string'
    || typeof body.agentName !== 'string'
  ) {
    return 'Missing required fields: botName, sessionId, workDir, agentName';
  }

  if (!SESSION_ID_PATTERN.test(body.sessionId)) {
    return 'Invalid sessionId';
  }

  if (!(await validateWorkingDirectory(body.workDir))) {
    return 'Invalid workDir';
  }

  if (body.chatId !== undefined) {
    if (typeof body.chatId !== 'string' || CONTROL_OR_COLON_PATTERN.test(body.chatId)) {
      return 'Invalid chatId';
    }
  }

  if (body.platform !== undefined) {
    if (
      typeof body.platform !== 'string'
      || CONTROL_OR_COLON_PATTERN.test(body.platform)
      || !VALID_PLATFORMS.has(body.platform)
    ) {
      return 'Invalid platform';
    }
  }

  if (config && !config.botNames.includes(body.botName)) {
    return 'Unknown botName';
  }

  if (config && !config.agentNames.includes(body.agentName)) {
    return 'Unknown agentName';
  }

  return undefined;
}

export function isAuthorizedBearerToken(authHeader: string | undefined, token: string): boolean {
  if (!authHeader) return false;

  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(authHeader);
  if (actual.length !== expected.length) return false;

  return timingSafeEqual(actual, expected);
}
