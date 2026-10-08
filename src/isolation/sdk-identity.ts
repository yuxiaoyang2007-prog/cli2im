import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
/** Read installed SDK metadata without loading CLI state or executing a CLI. */
export function sdkIdentity(agent: string): Record<string, string> {
  const name = agent === 'claude-code' ? '@anthropic-ai/claude-agent-sdk' : agent === 'codex' ? '@openai/codex-sdk' : undefined;
  if (!name) return {};
  let root = dirname(require.resolve(name));
  for (let depth = 0; depth < 4; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (manifest.name === name && typeof manifest.version === 'string') return { [name]: manifest.version };
    } catch { /* Entry points can live below the package root. */ }
    root = dirname(root);
  }
  throw new Error('Isolation SDK version is unavailable');
}
