import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyNativeResult, createNativeChecks, shellCall } from '../src/isolation/native-check.js';
import type { IsolationPolicy } from '../src/isolation/policy.js';
import type { ScriptResult } from '../src/isolation/mock-model.js';

describe('Codex native probe contracts', () => {
  it.each([
    ['exec_command', { cmd: 'probe', workdir: '/fixture', yield_time_ms: 30000, max_output_tokens: 12000 }],
    ['shell_command', { command: 'probe', workdir: '/fixture' }],
    ['shell', { command: ['/bin/sh', '-c', 'probe'], workdir: '/fixture' }],
  ])('uses advertised %s schema rather than assuming a shell interface', (name, input) => {
    expect(shellCall({ tools: [{ type: 'function', name }] }, 'probe', '/fixture')).toEqual({ name, input });
  });
  it('unwraps namespaces and rejects incompatible shell schemas', () => {
    expect(shellCall({ tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec_command', parameters: { properties: { cmd: { type: 'string' } } } }] }] }, 'probe', '/fixture')).toEqual({ name: 'functions.exec_command', input: { cmd: 'probe' } });
    expect(() => shellCall({ tools: [{ name: 'exec_command', parameters: { properties: { path: {} } } }] }, 'probe', '/fixture')).toThrow('UNSUPPORTED');
    expect(() => shellCall({ tools: [] }, 'probe', '/fixture')).toThrow('UNSUPPORTED');
  });
  it('requires genuine permission errors, never treating missing or unexecuted probes as denial', () => {
    const result = (output: unknown, isError = true): ScriptResult => ({ id: 'fixture', name: 'apply_patch', output, isError });
    expect(classifyNativeResult(result('EPERM: Operation not permitted'), false, false)).toBe('PASS');
    expect(classifyNativeResult(result('EACCES: Permission denied'), false, false)).toBe('PASS');
    expect(classifyNativeResult(result('ENOENT: No such file'), false, false)).toBe('ERROR');
    expect(classifyNativeResult(result('not found: permission denied'), false, false)).toBe('ERROR');
    expect(classifyNativeResult(undefined, false, false)).toBe('ERROR');
    expect(classifyNativeResult(result('Success. Updated the following files', false), false, false)).toBe('LEAK');
    expect(classifyNativeResult(result([{ type: 'input_image', image_url: 'synthetic' }], false), false, true)).toBe('LEAK');
    expect(classifyNativeResult(result('image request finished', false), true, true)).toBe('ERROR');
  });
});

describe('Codex native probe fixture integration', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function setup() {
    const root = mkdtempSync(resolve('tests/.native-check-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const readonly = join(root, 'readonly');
    for (const path of [workspace, outside, readonly]) mkdirSync(path);
    const canaryPath = join(outside, 'original-canary');
    const readonlyTarget = join(readonly, 'original-canary');
    writeFileSync(canaryPath, 'original outside fixture');
    writeFileSync(readonlyTarget, 'original read-only fixture');
    const policy: IsolationPolicy = { workspace, scopeKey: workspace, tmpdir: workspace, inbox: readonly, readable: [workspace, readonly], writable: [workspace], runtimeRead: [], hardDeny: [outside], readExceptions: [], tools: [], plugins: [], skills: [], binaryPath: '/bin/cat', searchPath: ['/usr/bin', '/bin'], searchPathDenied: [], fingerprint: 'fixture' };
    return { policy, canaryPath, readonlyTarget, nonce: 'synthetic', workspace, outside, readonly };
  }
  it('covers both native tools, read-only writes, symlinks and an actually replaced parent without changing caller canaries', async () => {
    const fixture = setup();
    const plan = await createNativeChecks({ tools: [{ type: 'custom', name: 'apply_patch' }, { type: 'function', name: 'view_image', parameters: { properties: { path: {} } } }] }, fixture);
    expect(plan.names).toEqual([
      'native.apply_patch.inside', 'native.apply_patch.outside', 'native.apply_patch.readonly', 'native.apply_patch.symlink', 'native.apply_patch.parent-replacement',
      'native.view_image.inside', 'native.view_image.outside', 'native.view_image.symlink', 'native.view_image.parent-replacement',
    ]);
    const results: ScriptResult[] = [];
    for (const call of plan.calls) {
      await call.beforeCall?.();
      const inside = call.checkName!.endsWith('.inside');
      if (inside && call.name === 'apply_patch') {
        const path = String(call.input).match(/\*\*\* Update File: (.+)/)![1];
        writeFileSync(path, 'cli2im-native-synthetic-after\n');
      }
      if (inside && call.name === 'view_image') {
        const png = readFileSync((call.input as Record<string, string>).path);
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        for (let offset = 8; offset < png.length;) {
          const length = png.readUInt32BE(offset);
          let crc = 0xffffffff;
          for (const byte of png.subarray(offset + 4, offset + 8 + length)) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
          }
          expect((~crc) >>> 0).toBe(png.readUInt32BE(offset + 8 + length));
          offset += length + 12;
        }
      }
      if (call.checkName!.endsWith('.parent-replacement')) {
        const path = call.name === 'view_image' ? (call.input as Record<string, string>).path : String(call.input).match(/\*\*\* Update File: (.+)/)![1];
        expect(realpathSync(path).startsWith(fixture.outside)).toBe(true);
      }
      results.push({ id: call.checkName!, name: call.name, checkName: call.checkName, isError: !inside, output: inside
        ? call.name === 'view_image' ? [{ type: 'input_image', image_url: 'synthetic' }] : 'Success. Updated the following files'
        : 'EPERM: Operation not permitted' });
    }
    expect(plan.evaluate(results).every(check => check.status === 'PASS')).toBe(true);
    expect(readFileSync(fixture.canaryPath, 'utf8')).toBe('original outside fixture');
    expect(readFileSync(fixture.readonlyTarget, 'utf8')).toBe('original read-only fixture');
    await plan.cleanup();
    expect(readdirSync(fixture.workspace)).toEqual([]);
    expect(readdirSync(fixture.outside)).toEqual(['original-canary']);
    expect(readdirSync(fixture.readonly)).toEqual(['original-canary']);
  });
  it('fails unexecuted replacement and missing native results; unknown file tools are UNSUPPORTED', async () => {
    const fixture = setup();
    const plan = await createNativeChecks({ tools: [{ type: 'function', name: 'view_image' }, { type: 'function', name: 'read_file' }] }, fixture);
    const denied = plan.calls.map(call => ({ id: call.checkName!, name: call.name, checkName: call.checkName, output: 'EACCES: permission denied', isError: true }));
    expect(plan.evaluate(denied).find(check => check.name.endsWith('parent-replacement'))?.status).toBe('ERROR');
    expect(plan.evaluate([]).filter(check => check.status === 'ERROR')).toHaveLength(4);
    expect(plan.evaluate([]).find(check => check.name.includes('read_file'))?.status).toBe('UNSUPPORTED');
    await plan.cleanup();
    expect(readdirSync(fixture.workspace)).toEqual([]);
  });
  it('classifies leaked read-only creation and cleans only its exact generated sentinel', async () => {
    const fixture = setup();
    const plan = await createNativeChecks({ tools: [{ name: 'apply_patch', type: 'function', parameters: { properties: { patch: { type: 'string' } } } }] }, fixture);
    const call = plan.calls.find(call => call.checkName?.endsWith('.readonly'))!;
    const patch = (call.input as Record<string, string>).patch;
    const path = patch.match(/\*\*\* Add File: (.+)/)![1];
    writeFileSync(path, 'cli2im-native-synthetic-after\n', { flag: 'wx' });
    const results = [{ id: 'fixture', name: call.name, checkName: call.checkName, output: 'Success. Updated the following files', isError: false }];
    expect(plan.evaluate(results).find(check => check.name.endsWith('.readonly'))?.status).toBe('LEAK');
    await plan.cleanup();
    expect(readdirSync(fixture.readonly)).toEqual(['original-canary']);
  });
  it('rejects replaced fixture ancestors during cleanup and preserves external files', async () => {
    const fixture = setup();
    const plan = await createNativeChecks({ tools: [{ name: 'view_image', type: 'function' }] }, fixture);
    const root = join(fixture.workspace, '.cli2im-native-synthetic');
    const retired = `${root}-retired`;
    const external = join(fixture.outside, 'foreign');
    mkdirSync(external);
    writeFileSync(join(external, 'inside.png'), 'untouched foreign file');
    renameSync(root, retired);
    symlinkSync(external, root);
    await expect(plan.cleanup()).rejects.toThrow('Native fixture cleanup failed');
    expect(readFileSync(join(external, 'inside.png'), 'utf8')).toBe('untouched foreign file');
  });
  it('rejects replaced inode and read-only parent during cleanup without removing replacements', async () => {
    const fixture = setup();
    const plan = await createNativeChecks({ tools: [{ name: 'apply_patch', type: 'custom' }] }, fixture);
    const root = join(fixture.workspace, '.cli2im-native-synthetic');
    renameSync(join(root, 'inside.txt'), join(root, 'owned-retired.txt'));
    writeFileSync(join(root, 'inside.txt'), 'foreign replacement');
    const external = join(fixture.outside, 'foreign');
    mkdirSync(external);
    writeFileSync(join(external, '.cli2im-native-synthetic-readonly.txt'), 'cli2im-native-synthetic-after\n');
    renameSync(fixture.readonly, `${fixture.readonly}-retired`);
    symlinkSync(external, fixture.readonly);
    await expect(plan.cleanup()).rejects.toThrow('Native fixture cleanup failed');
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('foreign replacement');
    expect(readFileSync(join(external, '.cli2im-native-synthetic-readonly.txt'), 'utf8')).toBe('cli2im-native-synthetic-after\n');
  });
});
