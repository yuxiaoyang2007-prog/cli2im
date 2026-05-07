import { Transform, type TransformCallback } from 'node:stream';
import { spawn as nodeSpawn } from 'node:child_process';
import type {
  AgentPlugin,
  AgentProcess,
  AgentEvent,
  AgentCapabilities,
  SpawnOpts,
  UserMessage,
} from '../types.js';

class StreamJsonParser extends Transform {
  private buffer = '';

  constructor() {
    super({ objectMode: true });
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const obj = JSON.parse(trimmed);
        const events = this.parseStreamJsonObject(obj);
        for (const event of events) {
          this.push(event);
        }
      } catch {
        // skip unparseable lines
      }
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.buffer.trim()) {
      try {
        const obj = JSON.parse(this.buffer.trim());
        const events = this.parseStreamJsonObject(obj);
        for (const event of events) {
          this.push(event);
        }
      } catch {
        // ignore
      }
    }
    callback();
  }

  private parseStreamJsonObject(obj: any): AgentEvent[] {
    const events: AgentEvent[] = [];

    if (obj.type === 'tool_use_permission') {
      events.push({
        type: 'permission_request',
        id: obj.tool_use_id,
        tool: obj.tool_name,
        input: obj.input ?? {},
      });
      return events;
    }

    if (obj.type === 'result') {
      const textParts = obj.result?.content?.filter((c: any) => c.type === 'text') ?? [];
      for (const part of textParts) {
        events.push({ type: 'text', content: part.text });
      }
      events.push({
        type: 'result',
        sessionId: obj.session_id ?? '',
        usage: obj.usage
          ? {
              inputTokens: obj.usage.input_tokens ?? 0,
              outputTokens: obj.usage.output_tokens ?? 0,
              cacheReadTokens: obj.usage.cache_read_tokens,
              cacheWriteTokens: obj.usage.cache_write_tokens,
            }
          : undefined,
      });
      return events;
    }

    if (obj.type === 'assistant' && obj.message?.content) {
      for (const block of obj.message.content) {
        if (block.type === 'text') {
          events.push({ type: 'text', content: block.text });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
          });
        } else if (block.type === 'thinking') {
          events.push({ type: 'thinking', content: block.thinking ?? '' });
        }
      }
    }

    if (obj.type === 'tool_result') {
      events.push({
        type: 'tool_result',
        id: obj.tool_use_id ?? '',
        name: obj.tool_name ?? '',
        output: typeof obj.output === 'string' ? obj.output : JSON.stringify(obj.output ?? ''),
        isError: obj.is_error,
      });
    }

    return events;
  }
}

export class ClaudeCodePlugin implements AgentPlugin {
  name = 'claude-code';
  displayName = 'Claude Code';
  private binary: string;

  capabilities: AgentCapabilities = {
    streamJson: true,
    permissionPrompt: true,
    sessionResume: true,
    gracefulCancel: true,
    slashCommands: [
      '/compact', '/review', '/ultrareview', '/cost', '/doctor',
      '/permissions', '/config', '/memory', '/init', '/help',
    ],
  };

  constructor(binary: string) {
    this.binary = binary;
  }

  async preflight(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const { execFileSync } = await import('node:child_process');
      const output = execFileSync(this.binary, ['--version'], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      const version = output.trim();
      return { ok: true, version };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  buildSpawnArgs(opts: SpawnOpts): string[] {
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--verbose',
    ];

    if (opts.model) {
      args.push('--model', opts.model);
    }

    if (opts.systemPrompt) {
      args.push('--system-prompt', opts.systemPrompt);
    }

    return args;
  }

  spawn(opts: SpawnOpts): AgentProcess {
    const args = this.buildSpawnArgs(opts);
    const proc = nodeSpawn(this.binary, args, {
      cwd: opts.workingDirectory,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      pid: proc.pid!,
      sessionId: '',
      stdin: proc.stdin!,
      stdout: proc.stdout!,
      kill: (signal = 'SIGTERM') => proc.kill(signal),
      on: (event: string, handler: (...args: any[]) => void) => {
        proc.on(event, handler);
      },
    };
  }

  resume(sessionId: string, opts: SpawnOpts): AgentProcess {
    const args = ['--resume', sessionId, ...this.buildSpawnArgs(opts)];
    const proc = nodeSpawn(this.binary, args, {
      cwd: opts.workingDirectory,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      pid: proc.pid!,
      sessionId,
      stdin: proc.stdin!,
      stdout: proc.stdout!,
      kill: (signal = 'SIGTERM') => proc.kill(signal),
      on: (event: string, handler: (...args: any[]) => void) => {
        proc.on(event, handler);
      },
    };
  }

  createStdoutParser(): Transform {
    return new StreamJsonParser();
  }

  formatStdinMessage(msg: UserMessage): string {
    return JSON.stringify({
      type: 'user',
      message: msg,
    }) + '\n';
  }

  formatPermissionResponse(requestId: string, decision: 'allow' | 'deny'): string {
    return JSON.stringify({
      type: 'tool_use_permission_response',
      tool_use_id: requestId,
      decision,
    }) + '\n';
  }

  formatCancelMessage(): string {
    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: '/stop',
      },
    }) + '\n';
  }
}
