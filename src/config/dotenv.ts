import { chmodSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCli2imDataDir } from '../util/data-dir.js';

function unquoteValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === "'" && last === "'") {
      return trimmed.slice(1, -1);
    }
    if (first === '"' && last === '"') {
      return trimmed
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  }
  const commentIdx = trimmed.search(/\s+#/);
  return (commentIdx >= 0 ? trimmed.slice(0, commentIdx) : trimmed).trim();
}

/**
 * Load key=value pairs from `~/.cli2im/.env` into `targetEnv` without
 * overwriting already-defined environment variables. Rejects symlinks and
 * non-regular files and enforces 0600 permissions best-effort.
 */
export function loadDataDirDotEnv(
  envPath = join(getCli2imDataDir(), '.env'),
  targetEnv: NodeJS.ProcessEnv = process.env,
  options: { overwrite?: boolean } = {},
): number {
  if (targetEnv.CLI2IM_SKIP_DOTENV === '1' || process.env.CLI2IM_SKIP_DOTENV === '1') {
    return 0;
  }

  let stat;
  try {
    stat = lstatSync(envPath);
  } catch {
    return 0;
  }

  if (!stat.isFile()) {
    return 0;
  }

  if ((stat.mode & 0o777) !== 0o600) {
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // Best-effort permission tightening.
    }
  }

  let content: string;
  try {
    content = readFileSync(envPath, 'utf8');
  } catch {
    return 0;
  }

  let loaded = 0;
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const stripped = line.replace(/^export\s+/, '');
    const match = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    const value = unquoteValue(match[2] ?? '');
    if (options.overwrite || targetEnv[key] === undefined) {
      targetEnv[key] = value;
      loaded++;
    }
  }

  return loaded;
}
