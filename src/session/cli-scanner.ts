import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

export type CLISessionStatus = 'idle' | 'busy' | 'stale' | 'historical';

export interface CLISession {
  sessionId: string;
  cwd: string;
  title: string;
  lastModified: number;
  status: CLISessionStatus;
  fileSize?: number;
  gitBranch?: string;
  pid?: number;
}

interface ActiveSessionJson {
  sessionId?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  status?: unknown;
  entrypoint?: unknown;
  name?: unknown;
}

interface JnlFile {
  sessionId: string;
  path: string;
  mtimeMs: number;
  size: number;
}

const ALLOWED_ENTRYPOINTS = new Set(['cli', 'task']);
const DEFAULT_LIMIT = 15;
const HEAD_BYTES = 4096;
const TAIL_BYTES = 32768;

export class CLISessionScanner {
  constructor(private readonly claudeDir: string) {}

  async scan(opts: { limit?: number } = {}): Promise<CLISession[]> {
    const limit = opts.limit ?? DEFAULT_LIMIT;

    const [allJnl, activeMap] = await Promise.all([
      this.indexJsonlFiles(),
      this.scanActiveSessions(),
    ]);

    allJnl.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const sessions: CLISession[] = [];

    for (const jnl of allJnl) {
      if (sessions.length >= limit) break;

      const active = activeMap.get(jnl.sessionId);
      if (active?.entrypoint && !ALLOWED_ENTRYPOINTS.has(active.entrypoint)) continue;

      const head = await readHead(jnl.path, HEAD_BYTES);
      const tail = await readTail(jnl.path, TAIL_BYTES);
      const combined = head + '\n' + tail;

      const entrypoint = extractEntrypoint(combined);
      if (entrypoint && !ALLOWED_ENTRYPOINTS.has(entrypoint)) continue;

      const titleInfo = extractTitle(combined);
      const cwdInfo = extractField(tail, 'cwd');
      const branch = extractField(tail, 'gitBranch');

      const title = active?.name
        ?? titleInfo.customTitle
        ?? titleInfo.aiTitle
        ?? titleInfo.lastPrompt
        ?? titleInfo.firstUserMessage
        ?? jnl.sessionId.slice(0, 8);

      let status: CLISessionStatus = 'historical';
      if (active) {
        const alive = active.pid === undefined ? true : isPidAlive(active.pid);
        status = alive ? asStatus(active.status) : 'stale';
      }

      sessions.push({
        sessionId: jnl.sessionId,
        cwd: active?.cwd ?? cwdInfo ?? '',
        title,
        lastModified: jnl.mtimeMs,
        status,
        fileSize: jnl.size,
        gitBranch: branch,
        pid: active?.pid,
      });
    }

    return sessions;
  }

  private async indexJsonlFiles(): Promise<JnlFile[]> {
    const projectsDir = join(this.claudeDir, 'projects');
    const results: JnlFile[] = [];

    let projectDirs: string[];
    try {
      projectDirs = (await readdir(projectsDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return results;
    }

    await Promise.all(projectDirs.map(async (dir) => {
      const fullDir = join(projectsDir, dir);
      let files: string[];
      try {
        files = (await readdir(fullDir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        return;
      }

      await Promise.all(files.map(async (file) => {
        const filePath = join(fullDir, file);
        try {
          const fileStat = await stat(filePath);
          if (!fileStat.isFile()) return;
          results.push({
            sessionId: basename(file, '.jsonl'),
            path: filePath,
            mtimeMs: fileStat.mtimeMs,
            size: fileStat.size,
          });
        } catch {
          // Race condition; skip.
        }
      }));
    }));

    return results;
  }

  private async scanActiveSessions(): Promise<Map<string, {
    cwd: string;
    status: string;
    entrypoint: string;
    name?: string;
    pid?: number;
  }>> {
    const dir = join(this.claudeDir, 'sessions');
    const entries = await readDirectoryFiles(dir);
    const map = new Map<string, {
      cwd: string;
      status: string;
      entrypoint: string;
      name?: string;
      pid?: number;
    }>();

    for (const entry of entries.filter((name) => name.endsWith('.json'))) {
      const filePath = join(dir, entry);
      try {
        const raw = await readJsonFile<ActiveSessionJson>(filePath);
        const sessionId = asString(raw.sessionId) ?? asString(raw.session_id);
        if (!sessionId) continue;

        map.set(sessionId, {
          cwd: asString(raw.cwd) ?? '',
          status: typeof raw.status === 'string' ? raw.status : 'idle',
          entrypoint: asString(raw.entrypoint) ?? '',
          name: asString(raw.name),
          pid: parsePid(entry),
        });
      } catch {
        // Skip corrupted.
      }
    }

    return map;
  }
}

async function readHead(filePath: string, bytes: number): Promise<string> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close();
  }
}

async function readTail(filePath: string, bytes: number): Promise<string> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const fileStat = await fh.stat();
    const start = Math.max(0, fileStat.size - bytes);
    const readSize = Math.min(bytes, fileStat.size);
    const buf = Buffer.alloc(readSize);
    await fh.read(buf, 0, readSize, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    await fh?.close();
  }
}

function extractEntrypoint(head: string): string | undefined {
  for (const line of head.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.entrypoint === 'string') return obj.entrypoint;
    } catch {
      // Partial line; skip.
    }
  }
  return undefined;
}

function extractTitle(text: string): {
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  firstUserMessage?: string;
} {
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  let firstUserMessage: string | undefined;

  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
        customTitle = obj.customTitle;
      } else if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        aiTitle = obj.aiTitle;
      } else if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') {
        lastPrompt = obj.lastPrompt;
      } else if (!firstUserMessage && obj.type === 'user' && obj.message) {
        const msg = obj.message as Record<string, unknown>;
        if (typeof msg.content === 'string') {
          firstUserMessage = msg.content;
        }
      }
    } catch {
      // Partial line from head/tail boundary; skip.
    }
  }

  return { customTitle, aiTitle, lastPrompt, firstUserMessage };
}

function extractField(tail: string, field: string): string | undefined {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    try {
      const obj = JSON.parse(lines[i]) as Record<string, unknown>;
      if (typeof obj[field] === 'string' && obj[field]) return obj[field] as string;
    } catch {
      // skip
    }
  }
  return undefined;
}

async function readDirectoryFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function parsePid(fileName: string): number | undefined {
  const value = Number.parseInt(basename(fileName, '.json'), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isNodeError(err) && err.code === 'EPERM';
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asStatus(value: unknown): CLISessionStatus {
  return value === 'busy' ? 'busy' : 'idle';
}

function isMissingPathError(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ENOENT';
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
