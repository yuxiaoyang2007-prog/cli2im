import { execFileSync, spawn as spawnProcess } from 'node:child_process';
import { Transform, Writable, type TransformCallback } from 'node:stream';
import type {
  AgentCapabilities,
  AgentEvent,
  AgentPlugin,
  AgentProcess,
  SpawnOpts,
  UserMessage,
} from '../types.js';

export interface GeminiEventMappingState {
  sessionId: string;
  toolNamesById: Map<string, string>;
}

export type GeminiStreamEvent = {
  type?: string;
  session_id?: string;
  role?: string;
  content?: unknown;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: unknown;
  status?: string;
  stats?: {
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
  };
};

export function createGeminiEventMappingState(): GeminiEventMappingState {
  return {
    sessionId: '',
    toolNamesById: new Map(),
  };
}

export function mapGeminiEvent(
  event: GeminiStreamEvent,
  state: GeminiEventMappingState = createGeminiEventMappingState(),
): AgentEvent[] {
  if (event.type === 'init') {
    state.sessionId = event.session_id ?? state.sessionId;
    return [{ type: 'status', sessionId: state.sessionId }];
  }

  if (
    event.type === 'message'
    && event.role === 'assistant'
    && event.delta === true
  ) {
    return [{ type: 'text', content: typeof event.content === 'string' ? event.content : '' }];
  }

  if (event.type === 'tool_use') {
    const id = event.tool_id ?? '';
    const name = event.tool_name ?? '';
    state.toolNamesById.set(id, name);
    return [{
      type: 'tool_use',
      id,
      name,
      input: asRecord(event.parameters),
    }];
  }

  if (event.type === 'tool_result') {
    const id = event.tool_id ?? '';
    return [{
      type: 'tool_result',
      id,
      name: state.toolNamesById.get(id) ?? '',
      output: event.status ?? '',
    }];
  }

  if (event.type === 'result') {
    if (event.status === 'success') {
      return [{
        type: 'result',
        sessionId: state.sessionId,
        usage: {
          inputTokens: event.stats?.input_tokens ?? 0,
          outputTokens: event.stats?.output_tokens ?? 0,
          cacheReadTokens: event.stats?.cached,
        },
      }];
    }

    return [{ type: 'error', message: event.status ?? 'Gemini CLI failed' }];
  }

  return [];
}

export class GeminiStreamParser extends Transform {
  private buffer = '';
  private readonly state = createGeminiEventMappingState();

  constructor() {
    super({ readableObjectMode: true });
  }

  _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        this.parseLine(line);
      }

      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _flush(callback: TransformCallback): void {
    try {
      if (this.buffer.trim()) {
        this.parseLine(this.buffer);
      }
      this.buffer = '';
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: GeminiStreamEvent;
    try {
      parsed = JSON.parse(trimmed) as GeminiStreamEvent;
    } catch {
      return;
    }

    for (const event of mapGeminiEvent(parsed, this.state)) {
      this.push(event);
    }
  }
}

export class GeminiPlugin implements AgentPlugin {
  name = 'gemini';
  displayName = 'Gemini CLI';
  private binary: string;

  capabilities: AgentCapabilities = {
    streamJson: true,
    permissionPrompt: false,
    sessionResume: false,
    gracefulCancel: false,
    slashCommands: [],
  };

  constructor(binary: string) {
    this.binary = binary;
  }

  async preflight(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const output = execFileSync(this.binary, ['--version'], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      return { ok: true, version: output.trim() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  spawn(opts: SpawnOpts): AgentProcess {
    return this.createCliProcess(opts);
  }

  resume(sessionId: string, opts: SpawnOpts): AgentProcess {
    return this.createCliProcess(opts, sessionId);
  }

  buildSpawnArgs(opts: SpawnOpts, sessionId?: string): string[] {
    const args: string[] = [];

    if (sessionId) {
      args.push('--resume', sessionId);
    } else {
      args.push('--prompt', opts.initialPrompt ?? '');
    }

    args.push(
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '--skip-trust',
    );

    if (opts.model) {
      args.push('--model', opts.model);
    }

    return args;
  }

  createStdoutParser(): Transform {
    return new GeminiStreamParser();
  }

  formatStdinMessage(_msg: UserMessage): string {
    return '';
  }

  formatPermissionResponse(_requestId: string, _decision: 'allow' | 'deny'): string {
    return '';
  }

  private createCliProcess(opts: SpawnOpts, sessionId?: string): AgentProcess {
    const child = spawnProcess('script', ['-q', '/dev/null', this.binary, ...this.buildSpawnArgs(opts, sessionId)], {
      cwd: opts.workingDirectory,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const noopStdin = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
    });

    return {
      pid: child.pid ?? process.pid,
      sessionId: sessionId ?? '',
      stdin: noopStdin,
      stdout: child.stdout,
      kill: (signal = 'SIGTERM') => {
        child.kill(signal);
      },
      on: (event, handler) => {
        child.on(event, handler);
      },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
