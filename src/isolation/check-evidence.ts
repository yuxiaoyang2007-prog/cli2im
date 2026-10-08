import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { codexConfigEnvironment } from './codex.js';
import type { VerificationStatus } from './verification.js';

export interface EvidenceCheck {
  name: string;
  status: 'PASS' | 'UNCOVERED' | 'LEAK' | 'UNSUPPORTED' | 'ERROR';
  errorCategory?: string;
  evidenceMode?: 'static+readonly';
}
type Agent = 'claude-code' | 'codex';
const check = (name: string, status: EvidenceCheck['status'], errorCategory?: string): EvidenceCheck =>
  ({ name, status, ...(errorCategory ? { errorCategory } : {}) });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Inspect names only: unrelated concurrent sessions do not invalidate a check. */
export async function scanSessionResidue(agent: Agent, env: NodeJS.ProcessEnv, ids: readonly string[]): Promise<EvidenceCheck> {
  const name = 'session-residue';
  if (!ids.length || ids.some(id => !uuid.test(id))) return check(name, 'ERROR', 'missing-or-invalid-session-id');
  if (!env.HOME) return check(name, 'ERROR', 'missing-home');
  const root = agent === 'claude-code'
    ? join(env.CLAUDE_CONFIG_DIR || join(env.HOME, '.claude'), 'projects')
    : join(codexConfigEnvironment(env).CODEX_HOME, 'sessions');
  const matches = (filename: string) => ids.some(id => agent === 'claude-code'
    ? filename.toLowerCase() === `${id.toLowerCase()}.jsonl`
    : filename.startsWith('rollout-') && new RegExp(`(?:^|[^0-9a-f])${id}\\.jsonl$`, 'i').test(filename));
  const visit = async (dir: string): Promise<boolean> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // A matching symlink is still a session artifact. Never inspect its target.
      if (matches(entry.name)) return true;
      if (entry.isDirectory() && await visit(join(dir, entry.name))) return true;
    }
    return false;
  };
  try {
    let info;
    try { info = await lstat(root); }
    catch (error) { if (absent(error)) return check(name, 'PASS'); throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) return check(name, 'ERROR', 'invalid-session-directory');
    return await visit(root) ? check(name, 'ERROR', 'session-persisted') : check(name, 'PASS');
  } catch { return check(name, 'ERROR', 'session-scan-failed'); }
}

function textBlocks(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textBlocks);
  if (value && typeof value === 'object') {
    const block = value as Record<string, unknown>;
    if (typeof block.text === 'string') return [block.text];
  }
  return [];
}
function instructions(request: unknown): string[] {
  if (!request || typeof request !== 'object') return [];
  const value = request as Record<string, unknown>;
  const found = [...textBlocks(value.system), ...textBlocks(value.instructions)];
  for (const messages of [value.messages, value.input]) {
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const item = message as Record<string, unknown>;
      // Codex renders AGENTS.md as contextual user fragments, not necessarily developer messages.
      if (['system', 'developer', 'user'].includes(String(item.role))) found.push(...textBlocks(item.content));
    }
  }
  return found;
}
const normalize = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
function containsFragment(text: string, fragment: string): boolean {
  let start = text.indexOf(fragment);
  while (start !== -1) {
    const end = start + fragment.length;
    // Short Latin words must match words, not arbitrary substrings such as "hi" in "this".
    const left = !/^[a-z0-9_]/i.test(fragment) || !/[a-z0-9_]/i.test(text[start - 1] ?? '');
    const right = !/[a-z0-9_]$/i.test(fragment) || !/[a-z0-9_]/i.test(text[end] ?? '');
    if (left && right) return true;
    start = text.indexOf(fragment, start + 1);
  }
  return false;
}

/** Contents and fragments remain local variables; only a categorical result escapes. */
export async function globalInstructionEvidence(agent: Agent, env: NodeJS.ProcessEnv, requests: readonly unknown[]): Promise<EvidenceCheck> {
  const name = 'global-instructions';
  if (!env.HOME) return check(name, 'ERROR', 'missing-home');
  const paths = agent === 'claude-code'
    ? [...new Set([join(env.HOME, '.claude', 'CLAUDE.md'), join(env.CLAUDE_CONFIG_DIR || join(env.HOME, '.claude'), 'CLAUDE.md')])]
    : [...new Set([codexConfigEnvironment(env).CODEX_HOME, join(env.HOME, '.codex')])].flatMap(root => ['AGENTS.md', 'AGENTS.override.md'].map(file => join(root, file)));
  const sources: string[] = [];
  try {
    for (const path of paths) {
      try { sources.push(await readFile(path, 'utf8')); }
      catch (error) { if (!absent(error)) throw error; }
    }
  } catch { return check(name, 'ERROR', 'instruction-source-unreadable'); }
  if (!sources.length) return check(name, 'PASS', 'absent');
  const captured = requests.flatMap(instructions).map(normalize).filter(Boolean);
  if (!captured.length) return check(name, 'ERROR', 'missing-instruction-evidence');
  for (const source of sources) {
    // Keep every meaningful line, including short sensitive names and identifiers.
    // Removing Markdown markers also catches CLIs that render the source first.
    const fragments = [normalize(source), ...source.split(/\r?\n/).map(line => normalize(line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/u, '')))]
      .filter(fragment => /[\p{L}\p{N}]/u.test(fragment));
    if (fragments.some(fragment => captured.some(text => containsFragment(text, fragment)))) return check(name, 'LEAK', 'global-instruction-fragment');
  }
  return check(name, 'PASS');
}

/** No missing probe, duplicate report, or non-sensitive "uncovered" can verify a scope. */
export function aggregateChecks(expectedNames: readonly string[], results: readonly EvidenceCheck[]): { status: VerificationStatus; checks: EvidenceCheck[] } {
  const checks = results.map(result => ({ ...result }));
  const expected = new Set(expectedNames);
  if (!expected.size || expected.size !== expectedNames.length) checks.push(check('check-contract', 'ERROR', 'invalid-expected-checks'));
  for (const name of expected) {
    const count = results.filter(result => result.name === name).length;
    if (count !== 1) checks.push(check(name, 'ERROR', count ? 'duplicate-check' : 'not-executed'));
  }
  for (const result of results) {
    if (!expected.has(result.name)) checks.push(check('check-contract', 'ERROR', 'unexpected-check'));
    if (!['PASS', 'UNCOVERED', 'LEAK', 'UNSUPPORTED', 'ERROR'].includes(result.status)) checks.push(check(result.name, 'ERROR', 'invalid-check-status'));
    if (result.status === 'UNCOVERED' && ((!/^sensitive[.:/-]/.test(result.name) && result.name !== 'environment.keychain') || !['absent', 'ENOENT'].includes(result.errorCategory ?? ''))) {
      checks.push(check(result.name, 'ERROR', 'uncovered-not-permitted'));
    }
  }
  const status = checks.some(item => item.status === 'LEAK') ? 'LEAK'
    : checks.some(item => item.status === 'ERROR') ? 'ERROR'
    : checks.some(item => item.status === 'UNSUPPORTED') ? 'UNSUPPORTED' : 'VERIFIED';
  return { status, checks };
}
