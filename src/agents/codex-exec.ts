import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { buildChildEnv } from '../security/child-env.js';
import { codexConfigSources, codexPermissionArgs, tomlString } from '../isolation/codex.js';
import type { SpawnOpts } from '../types.js';
import type { CodexInput, CodexThread, CodexThreadEvent } from './codex.js';

export function codexExecArgs(opts: SpawnOpts, sessionId?: string, images: string[] = []): string[] {
  if (!opts.isolation) throw new Error('Codex exec adapter requires isolation');
  const args = ['exec', '--json', ...codexPermissionArgs(opts.isolation), '--skip-git-repo-check', '-C', opts.workingDirectory,
    '-c', `approval_policy=${tomlString(opts.autoApprove || opts.permissionMode === 'bypass' ? 'never' : 'on-request')}`];
  if (opts.model) args.push('--model', opts.model);
  if (opts.reasoningEffort) args.push('-c', `model_reasoning_effort=${tomlString(opts.reasoningEffort)}`);
  if (sessionId) args.push('resume');
  for (const image of images) args.push('--image', image);
  args.push('--');
  if (sessionId) args.push(sessionId);
  args.push('-');
  return args;
}

/** Same turn/event contract as the SDK; a fresh exec process for each turn. */
export function createCodexExecThread(binary: string, opts: SpawnOpts, initialId?: string): CodexThread {
  let sessionId = initialId;
  return {
    async runStreamed(input: CodexInput, { signal } = {}) {
      const env = buildChildEnv('codex', opts.env);
      codexConfigSources(opts.workingDirectory, env.HOME ?? '/');
      const parts = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input;
      const images = parts.flatMap(p => p.type === 'local_image' ? [p.path] : []);
      const prompt = parts.flatMap(p => p.type === 'text' ? [p.text] : []).join('\n\n');
      async function* events(): AsyncIterable<CodexThreadEvent> {
        if (signal?.aborted) throw new Error('Codex exec cancelled');
        const child = spawn(binary, codexExecArgs(opts, sessionId, images), { cwd: opts.workingDirectory, env, stdio: ['pipe', 'pipe', 'pipe'] });
        const cancel = () => child.kill('SIGTERM');
        signal?.addEventListener('abort', cancel, { once: true });
        let failure: Error | undefined;
        const closed = new Promise<number | null>(resolve => {
          child.on('error', error => { failure = error; });
          child.on('close', resolve);
        });
        child.stdin.on('error', () => { failure ??= new Error('Codex exec input failed'); });
        // Diagnostics may contain prompts or credentials; never forward stderr.
        child.stderr.resume();
        child.stdin.end(prompt);
        const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
        let completed = false;
        try {
          for await (const line of lines) {
            if (!line.trim()) continue;
            let event: CodexThreadEvent;
            try { event = JSON.parse(line); }
            catch { throw new Error('Invalid Codex JSONL event'); }
            if (!event || typeof event.type !== 'string') throw new Error('Invalid Codex JSONL event');
            if (event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id;
            if (event.type === 'turn.completed' || event.type === 'turn.failed') completed = true;
            yield event;
          }
          const code = await closed;
          if (failure) throw new Error('Codex exec could not start or receive input');
          if (signal?.aborted) throw new Error('Codex exec cancelled');
          if (code !== 0) throw new Error(`Codex exec exited with code ${code}`);
          if (!completed) throw new Error('Codex exec ended before turn completion');
        } finally {
          lines.close();
          signal?.removeEventListener('abort', cancel);
          if (child.exitCode === null) child.kill('SIGTERM');
        }
      }
      return { events: events() };
    },
  };
}
