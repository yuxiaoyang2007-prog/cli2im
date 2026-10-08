import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateChecks, globalInstructionEvidence, scanSessionResidue, type EvidenceCheck } from '../src/isolation/check-evidence.js';

describe('slice 9 isolation check evidence', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const id = '12345678-1234-4321-a123-123456789abc';
  const otherId = '12345678-1234-4321-a123-123456789abd';
  beforeEach(() => {
    root = mkdtempSync(join(fileURLToPath(new URL('./', import.meta.url)), '.tmp-check-evidence-'));
    env = { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude') };
    for (const path of [env.HOME!, env.CODEX_HOME!, env.CLAUDE_CONFIG_DIR!]) mkdirSync(path);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const sessionRoot = (agent: 'claude-code' | 'codex') => agent === 'claude-code'
    ? join(env.CLAUDE_CONFIG_DIR!, 'projects') : join(env.CODEX_HOME!, 'sessions');
  it.each(['claude-code', 'codex'] as const)('integration: %s detects only its own persisted session by filename', async agent => {
    const directory = join(sessionRoot(agent), 'nested'); mkdirSync(directory, { recursive: true });
    const filename = (value: string) => agent === 'codex' ? `rollout-2026-10-07T00-00-00-${value}.jsonl` : `${value}.jsonl`;
    writeFileSync(join(directory, filename(otherId)), 'unrelated concurrent session');
    writeFileSync(join(directory, filename(`a${id}`)), 'uuid has no left boundary');
    writeFileSync(join(directory, filename(`${id}a`)), 'uuid has no right boundary');
    expect(await scanSessionResidue(agent, env, [id])).toMatchObject({ status: 'PASS' });
    writeFileSync(join(directory, filename(id)), 'file content must never be read', { mode: 0 });
    expect(await scanSessionResidue(agent, env, [id])).toEqual({ name: 'session-residue', status: 'ERROR', errorCategory: 'session-persisted' });
  });
  it.each(['claude-code', 'codex'] as const)('%s rejects missing/invalid ids and accepts an absent sessions directory', async agent => {
    expect(await scanSessionResidue(agent, env, [])).toMatchObject({ status: 'ERROR' });
    expect(await scanSessionResidue(agent, env, ['not-a-uuid'])).toMatchObject({ status: 'ERROR' });
    expect(await scanSessionResidue(agent, env, [id])).toMatchObject({ status: 'PASS' });
    writeFileSync(sessionRoot(agent), 'not a directory');
    expect(await scanSessionResidue(agent, env, [id])).toMatchObject({ status: 'ERROR' });
  });
  it('does not follow nested symlinks or a symlink session root', async () => {
    const outside = join(root, 'outside'); mkdirSync(outside);
    writeFileSync(join(outside, `${id}.jsonl`), 'unrelated target');
    mkdirSync(sessionRoot('claude-code'));
    symlinkSync(outside, join(sessionRoot('claude-code'), 'link'));
    expect(await scanSessionResidue('claude-code', env, [id])).toMatchObject({ status: 'PASS' });
    symlinkSync(outside, sessionRoot('codex'));
    expect(await scanSessionResidue('codex', env, [id])).toMatchObject({ status: 'ERROR', errorCategory: 'invalid-session-directory' });
  });
  it('uses default state directories only under the supplied synthetic HOME', async () => {
    const localEnv = { HOME: env.HOME };
    for (const [agent, directory, name] of [
      ['claude-code', '.claude/projects', `${id}.jsonl`],
      ['codex', '.codex/sessions', `rollout-${id}.jsonl`],
    ] as const) {
      mkdirSync(join(env.HOME!, directory), { recursive: true });
      writeFileSync(join(env.HOME!, directory, name), '');
      expect(await scanSessionResidue(agent, localEnv, [id])).toMatchObject({ status: 'ERROR', errorCategory: 'session-persisted' });
    }
  });
  it.each(['claude-code', 'codex'] as const)('%s reports absent source and missing request evidence separately', async agent => {
    expect(await globalInstructionEvidence(agent, env, [])).toEqual({ name: 'global-instructions', status: 'PASS', errorCategory: 'absent' });
    writeFileSync(join(agent === 'codex' ? env.CODEX_HOME! : env.CLAUDE_CONFIG_DIR!, agent === 'codex' ? 'AGENTS.md' : 'CLAUDE.md'), 'Synthetic confidential rule');
    expect(await globalInstructionEvidence(agent, env, [])).toMatchObject({ status: 'ERROR', errorCategory: 'missing-instruction-evidence' });
    expect(await globalInstructionEvidence(agent, env, [{ input: [{ role: 'user', content: 'Synthetic confidential rule' }] }])).toMatchObject({ status: 'LEAK' });
  });
  it.each([
    { system: [{ type: 'text', text: 'Wrapper\n私密甲\nend' }] },
    { instructions: 'Wrapper\n私密甲\nend' },
    { input: [{ role: 'developer', content: [{ type: 'input_text', text: '私密甲' }] }] },
    { messages: [{ role: 'system', content: '私密甲' }] },
    { input: [{ role: 'developer', content: 'ordinary system text' }, { role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n<INSTRUCTIONS>\n私密甲\n</INSTRUCTIONS>' }] }] },
  ])('detects short sensitive source fragments in supported request instruction shapes', async request => {
    writeFileSync(join(env.CODEX_HOME!, 'AGENTS.md'), '# Fixture\n私密甲\nA longer private rule');
    const result = await globalInstructionEvidence('codex', env, [request]);
    expect(result).toEqual({ name: 'global-instructions', status: 'LEAK', errorCategory: 'global-instruction-fragment' });
    expect(JSON.stringify(result)).not.toContain('私密甲');
  });
  it('compares normalized multiline content and preserves short word boundaries', async () => {
    writeFileSync(join(env.CODEX_HOME!, 'AGENTS.md'), 'hi');
    expect(await globalInstructionEvidence('codex', env, [{ instructions: 'this is ordinary' }])).toMatchObject({ status: 'PASS' });
    expect(await globalInstructionEvidence('codex', env, [{ instructions: 'say hi now' }])).toMatchObject({ status: 'LEAK' });
    writeFileSync(join(env.CODEX_HOME!, 'AGENTS.md'), 'private\nname');
    expect(await globalInstructionEvidence('codex', env, [{ instructions: 'private   name' }])).toMatchObject({ status: 'LEAK' });
  });
  it('checks both default Claude global instructions and its explicit config directory', async () => {
    mkdirSync(join(env.HOME!, '.claude'));
    writeFileSync(join(env.HOME!, '.claude/CLAUDE.md'), 'default-private');
    writeFileSync(join(env.CLAUDE_CONFIG_DIR!, 'CLAUDE.md'), 'override-private');
    for (const text of ['default-private', 'override-private']) {
      expect(await globalInstructionEvidence('claude-code', env, [{ system: text }])).toMatchObject({ status: 'LEAK' });
    }
  });
  it.each(['effective', 'personal'])('detects both instruction filenames from the %s Codex home, including auxiliary requests', async location => {
    const directory = location === 'effective' ? env.CODEX_HOME! : join(env.HOME!, '.codex');
    mkdirSync(directory, { recursive: true });
    for (const filename of ['AGENTS.md', 'AGENTS.override.md']) {
      const fragment = `canary-${filename}`;
      writeFileSync(join(directory, filename), fragment);
      expect(await globalInstructionEvidence('codex', env, [{ tools: [], instructions: fragment }])).toMatchObject({ status: 'LEAK' });
    }
  });
  it('scans only the effective Codex home and marks only absent keychains as UNCOVERED', async () => {
    const personal = join(env.HOME!, '.codex/sessions'); mkdirSync(personal, { recursive: true });
    writeFileSync(join(personal, `rollout-${id}.jsonl`), 'unrelated personal session');
    expect(await scanSessionResidue('codex', env, [id])).toMatchObject({ status: 'PASS' });
    expect(aggregateChecks(['environment.keychain'], [{ name: 'environment.keychain', status: 'UNCOVERED', errorCategory: 'ENOENT' }]).status).toBe('VERIFIED');
    expect(aggregateChecks(['environment.keychain'], [{ name: 'environment.keychain', status: 'UNCOVERED', errorCategory: 'OTHER' }]).status).toBe('ERROR');
  });

  it('fails closed for an unreadable instruction source without returning source text', async () => {
    mkdirSync(join(env.CODEX_HOME!, 'AGENTS.md'));
    expect(await globalInstructionEvidence('codex', env, [{ instructions: 'fixture' }])).toEqual({ name: 'global-instructions', status: 'ERROR', errorCategory: 'instruction-source-unreadable' });
  });
  it('verifies only complete unique evidence, allowing absent sensitive probes alone to be uncovered', () => {
    const complete: EvidenceCheck[] = [{ name: 'positive:workspace', status: 'PASS' }, { name: 'sensitive:ssh', status: 'UNCOVERED', errorCategory: 'absent' }];
    expect(aggregateChecks(complete.map(item => item.name), complete).status).toBe('VERIFIED');
    expect(aggregateChecks(['positive:workspace'], []).status).toBe('ERROR');
    expect(aggregateChecks([], []).status).toBe('ERROR');
    expect(aggregateChecks(['positive:workspace'], [complete[0], complete[0]]).status).toBe('ERROR');
    expect(aggregateChecks(['positive:workspace'], [{ name: 'positive:workspace', status: 'UNCOVERED', errorCategory: 'absent' }]).status).toBe('ERROR');
    expect(aggregateChecks(['sensitive:ssh'], [{ name: 'sensitive:ssh', status: 'UNCOVERED' }]).status).toBe('ERROR');
    expect(aggregateChecks(['positive:workspace'], [{ name: 'different', status: 'PASS' }]).status).toBe('ERROR');
  });
  it('preserves actual leaks over execution errors and never verifies unsupported evidence', () => {
    const results: EvidenceCheck[] = [{ name: 'negative:read', status: 'LEAK' }, { name: 'positive:tmp', status: 'ERROR' }];
    expect(aggregateChecks(results.map(item => item.name), results).status).toBe('LEAK');
    expect(aggregateChecks(['capabilities'], [{ name: 'capabilities', status: 'UNSUPPORTED' }]).status).toBe('UNSUPPORTED');
    expect(aggregateChecks(['capabilities', 'missing'], [{ name: 'capabilities', status: 'UNSUPPORTED' }]).status).toBe('ERROR');
  });
});
