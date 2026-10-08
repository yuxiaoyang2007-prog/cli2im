import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { capturedTools, type CapturedRequest, type ScriptCall, type ScriptResult } from './mock-model.js';
import type { IsolationPolicy } from './policy.js';

export type CapturedToolResult = ScriptResult;
export const toolDefinitions = capturedTools;
export interface EvidenceCheck { name: string; status: 'PASS' | 'LEAK' | 'ERROR' | 'UNSUPPORTED'; errorCategory?: string }
export interface NativeChecks {
  calls: ScriptCall[];
  names: string[];
  evaluate(results: CapturedToolResult[]): EvidenceCheck[];
  cleanup(): Promise<void>;
}
const leaf = (name: string) => name.split('.').at(-1)!;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const parameters = (tool: Record<string, unknown>) => record(tool.parameters) && record(tool.parameters.properties) ? tool.parameters.properties : undefined;

/** Choose the shell actually advertised by this request, without assuming the provider's tool catalog. */
export function shellCall(request: CapturedRequest, command: string, workspace: string): ScriptCall {
  const tools = capturedTools(request);
  const tool = ['exec_command', 'shell_command', 'shell', 'Bash'].flatMap(name => tools.filter(tool => leaf(tool.name) === name))[0];
  if (!tool) throw new Error('UNSUPPORTED: shell-tool-unavailable');
  const name = leaf(tool.name);
  const properties = parameters(tool);
  const key = name === 'exec_command' ? 'cmd' : 'command';
  if (properties && !(key in properties)) throw new Error('UNSUPPORTED: shell-tool-schema');
  const input: Record<string, unknown> = { [key]: name === 'shell' ? ['/bin/sh', '-c', command] : command };
  if (name !== 'Bash' && (!properties || 'workdir' in properties)) input.workdir = workspace;
  if (name === 'exec_command' && (!properties || 'yield_time_ms' in properties)) input.yield_time_ms = 30000;
  if (name === 'exec_command' && (!properties || 'max_output_tokens' in properties)) input.max_output_tokens = 12000;
  if (properties && 'timeout_ms' in properties) input.timeout_ms = 30000;
  return { name: tool.name, input };
}

function textResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textResult).join('\n');
  if (!record(value)) return '';
  // Do not stringify image payloads or unknown structures into diagnostics.
  return ['text', 'output', 'message', 'error'].filter(key => key in value).map(key => textResult(value[key])).join('\n');
}
function hasImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasImage);
  return record(value) && (['input_image', 'image'].includes(String(value.type)) || (Array.isArray(value.content) && value.content.some(hasImage)));
}
export function classifyNativeResult(result: CapturedToolResult | undefined, positive: boolean, image: boolean): EvidenceCheck['status'] {
  if (!result) return 'ERROR';
  const text = textResult(result.output);
  const denied = /\bEPERM\b|\bEACCES\b|operation not permitted|permission denied/i.test(text);
  const absent = /\bENOENT\b|no such file|not found/i.test(text);
  if (positive) {
    if (result.isError || denied || absent) return 'ERROR';
    return image ? hasImage(result.output) ? 'PASS' : 'ERROR'
      : /(?:success|updated the following files)/i.test(text) ? 'PASS' : 'ERROR';
  }
  if (denied && !absent) return 'PASS';
  if (absent || result.isError) return 'ERROR';
  return (image ? hasImage(result.output) : /(?:success|updated the following files)/i.test(text)) ? 'LEAK' : 'ERROR';
}

/** Fixtures are task-owned, and never replace the caller's canary or readable file. */
export async function createNativeChecks(request: CapturedRequest, options: {
  policy: IsolationPolicy; canaryPath: string; readonlyTarget: string; nonce: string;
}): Promise<NativeChecks> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.nonce)) throw new Error('Invalid native probe nonce');
  const { policy, canaryPath, readonlyTarget, nonce } = options;
  const calls: ScriptCall[] = [];
  const checks: Array<{ name: string; positive: boolean; image: boolean; path?: string; replacement?: () => boolean }> = [];
  const unsupported: EvidenceCheck[] = [];
  const owned: Array<{ path: string; ino: number; dev: number; directory: boolean }> = [];
  const leaks = new Set<string>();
  const parents = new Map<string, { ino: number; dev: number }>();
  const sentinel = `cli2im-native-${nonce}`;
  const before = `${sentinel}-before`;
  const after = `${sentinel}-after`;
  const rememberParent = (path: string) => {
    const parent = dirname(path);
    if (realpathSync(parent) !== resolve(parent)) throw new Error('Native fixture ancestor is a symlink');
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid native fixture parent');
    const previous = parents.get(parent);
    if (previous && (previous.ino !== info.ino || previous.dev !== info.dev)) throw new Error('Native fixture parent was replaced');
    parents.set(parent, { ino: info.ino, dev: info.dev });
  };
  const checkParent = (path: string) => {
    const parent = dirname(path);
    const expected = parents.get(parent);
    const actual = lstatSync(parent);
    if (!expected || realpathSync(parent) !== resolve(parent) || !actual.isDirectory()
      || actual.ino !== expected.ino || actual.dev !== expected.dev) throw new Error('Native fixture parent was replaced');
  };
  const remember = (path: string, directory = false) => {
    rememberParent(path);
    const info = lstatSync(path);
    owned.push({ path, ino: info.ino, dev: info.dev, directory });
  };
  const directory = (path: string) => { rememberParent(path); mkdirSync(path, { mode: 0o700 }); remember(path, true); return path; };
  const file = (path: string, content: string | Buffer) => {
    rememberParent(path);
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
    remember(path);
    return path;
  };
  const link = (path: string, target: string) => { rememberParent(path); symlinkSync(target, path); remember(path); return path; };
  const cleanup = () => {
    let failed = false;
    // A leaked Add File targets a fresh unpredictable path; retain foreign replacements.
    for (const path of leaks) {
      try {
        checkParent(path);
        const expected = Buffer.from(`${after}\n`);
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || info.size !== expected.length) { failed = true; continue; }
          const bytes = Buffer.alloc(expected.length);
          if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || !bytes.equals(expected)) { failed = true; continue; }
          checkParent(path);
          const current = lstatSync(path);
          if (current.isSymbolicLink() || current.ino !== info.ino || current.dev !== info.dev) { failed = true; continue; }
          unlinkSync(path);
        } finally { closeSync(fd); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true; }
    }
    for (const entry of [...owned].reverse()) {
      try {
        checkParent(entry.path);
        const info = lstatSync(entry.path);
        if (info.ino !== entry.ino || info.dev !== entry.dev) { failed = true; continue; }
        if (entry.directory) rmdirSync(entry.path); else unlinkSync(entry.path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true; }
    }
    if (failed) throw new Error('Native fixture cleanup failed');
  };
  try {
    // Only known harmless non-file tools may be omitted. A new catalog needs a new probe adapter.
    const nonFile = new Set(['update_plan', 'request_user_input', 'web_search', 'web_search_preview', 'wait_agent', 'send_input', 'spawn_agent', 'close_agent']);
    const shell = new Set(['exec_command', 'shell', 'shell_command', 'Bash', 'write_stdin']);
    const tools = capturedTools(request);
    const native = tools.filter(tool => !shell.has(leaf(tool.name)) && !nonFile.has(leaf(tool.name)));
    for (const tool of native) if (!['apply_patch', 'view_image'].includes(leaf(tool.name))) {
      unsupported.push({ name: `native.${tool.name}.unsupported`, status: 'UNSUPPORTED' });
    }
    const supported = native.filter(tool => ['apply_patch', 'view_image'].includes(leaf(tool.name)));
    if (!supported.length) return { calls, names: unsupported.map(check => check.name), evaluate: () => unsupported, cleanup: async () => cleanup() };
    const root = directory(join(policy.workspace, `.cli2im-native-${nonce}`));
    const externalRoot = directory(join(dirname(canaryPath), `.cli2im-native-${nonce}`));
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
    const internalText = file(join(root, 'inside.txt'), `${before}\n`);
    const externalText = file(join(externalRoot, 'outside.txt'), `${before}\n`);
    const internalImage = file(join(root, 'inside.png'), png);
    const externalImage = file(join(externalRoot, 'outside.png'), png);
    const symbolicRoot = link(join(root, 'symbolic'), externalRoot);

    for (const tool of supported) {
      const image = leaf(tool.name) === 'view_image';
      const name = `native.${tool.name}`;
      let patchKey: string | undefined;
      if (!image && tool.type !== 'custom') {
        const props = parameters(tool);
        patchKey = props ? ['patch', 'input', 'patch_text'].find(key => key in props) : 'patch';
        if (!patchKey) { unsupported.push({ name: `${name}.schema`, status: 'UNSUPPORTED' }); continue; }
      }
      const add = (suffix: string, path: string, positive = false, addFile = false, hook?: ScriptCall['beforeCall'], replacement?: () => boolean) => {
        const checkName = `${name}.${suffix}`;
        const patch = addFile ? `*** Begin Patch\n*** Add File: ${path}\n+${after}\n*** End Patch`
          : `*** Begin Patch\n*** Update File: ${path}\n@@\n-${before}\n+${after}\n*** End Patch`;
        let input: ScriptCall['input'];
        if (image) {
          const props = parameters(tool);
          if (props && !('path' in props)) { unsupported.push({ name: `${name}.schema`, status: 'UNSUPPORTED' }); return; }
          input = { path };
        } else input = tool.type === 'custom' ? patch : { [patchKey!]: patch };
        calls.push({ name: tool.name, type: tool.type === 'custom' ? 'custom' : 'function', input, checkName, beforeCall: hook });
        checks.push({ name: checkName, positive, image, path: positive && !image ? path : undefined, replacement });
      };
      add('inside', image ? internalImage : internalText, true);
      add('outside', image ? externalImage : externalText);
      if (!image) {
        const readonlyRoot = statSync(readonlyTarget).isDirectory() ? readonlyTarget : dirname(readonlyTarget);
        const target = join(readonlyRoot, `.cli2im-native-${nonce}-readonly.txt`);
        try { lstatSync(target); throw new Error('Native read-only fixture already exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        leaks.add(target);
        rememberParent(target);
        add('readonly', target, false, true);
      }
      add('symlink', join(symbolicRoot, image ? 'outside.png' : 'outside.txt'));
      const parent = directory(join(root, `${leaf(tool.name)}-parent`));
      const backup = `${parent}-original`;
      file(join(parent, image ? 'outside.png' : 'outside.txt'), image ? png : `${before}\n`);
      let replaced = false;
      const replace = () => {
        if (replaced) throw new Error('Parent replacement executed twice');
        renameSync(parent, backup);
        for (const entry of owned) if (entry.path === parent || entry.path.startsWith(`${parent}/`)) entry.path = `${backup}${entry.path.slice(parent.length)}`;
        const identity = parents.get(parent);
        if (identity) { parents.delete(parent); parents.set(backup, identity); }
        link(parent, externalRoot);
        replaced = true;
      };
      add('parent-replacement', join(parent, image ? 'outside.png' : 'outside.txt'), false, false, replace, () => replaced);
    }
    return {
      calls, names: [...checks.map(check => check.name), ...unsupported.map(check => check.name)], cleanup: async () => cleanup(),
      evaluate(results) {
        return [...checks.map((check, index): EvidenceCheck => {
          const matched = results.filter(result => result.checkName === check.name);
          const result = matched.length === 1 ? matched[0] : matched.length ? undefined : results.every(result => !result.checkName) ? results[index] : undefined;
          let status = classifyNativeResult(result, check.positive, check.image);
          if (result?.name !== calls[index].name || (check.replacement && !check.replacement())) status = 'ERROR';
          if (status === 'PASS' && check.path) {
            try {
              checkParent(check.path);
              const original = owned.find(entry => entry.path === check.path);
              const fd = openSync(check.path, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const info = fstatSync(fd);
                const expected = Buffer.from(`${after}\n`);
                if (!original || info.ino !== original.ino || info.dev !== original.dev || info.size !== expected.length) status = 'ERROR';
                else {
                  const bytes = Buffer.alloc(expected.length);
                  if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || !bytes.equals(expected)) status = 'ERROR';
                }
              } finally { closeSync(fd); }
            } catch { status = 'ERROR'; }
          }
          return { name: check.name, status, ...(status === 'ERROR' ? { errorCategory: result ? 'INVALID_RESULT' : 'NOT_EXECUTED' } : {}) };
        }), ...unsupported];
      },
    };
  } catch (error) { cleanup(); throw error; }
}
