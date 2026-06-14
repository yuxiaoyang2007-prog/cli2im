import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SandboxPathRule =
  | { type: 'subpath'; path: string }
  | { type: 'literal'; path: string }
  | { type: 'regex'; pattern: string };

export interface SandboxProfileInput {
  boxRoots: string[];
  homeDir: string;
  ptyHandleDir: string;
  denyReadPaths: SandboxPathRule[];
  otherProtectedRoots: string[];
}

export interface WriteSandboxProfileInput {
  handle: string;
  ptyHandleDir: string;
  profile: string;
}

export function buildSandboxProfile(input: SandboxProfileInput): string {
  const claudeRuntimeWriteDirs = [
    'projects',
    'todos',
    'statsig',
    'shell-snapshots',
    'sessions',
    'session-env',
  ].map((dir) => subpathRule(join(input.homeDir, '.claude', dir)));
  const writeRules = [
    ...input.boxRoots.map(subpathRule),
    // Narrow allowlist for claude runtime dirs. Secrets are denied for read+write
    // symmetry below, and exec-config paths under ~/.claude plus ~/.claude.json
    // get a late write deny so box roots cannot re-enable them.
    // session-env is required: the interactive SessionStart hook mkdirs it during
    // init, and omitting it causes the TUI startup to hang.
    ...claudeRuntimeWriteDirs,
    subpathRule(input.ptyHandleDir),
    regexRule('^/private/tmp/claude-[^/]+'),
    subpathRule('/dev'),
  ];
  const otherProtectedRules = input.otherProtectedRoots.map(subpathRule);
  const claudeExecutableConfigWriteDenyRules = [
    ...input.denyReadPaths,
    literalRule(join(input.homeDir, '.claude', 'settings.json')),
    literalRule(join(input.homeDir, '.claude', 'CLAUDE.md')),
    subpathRule(join(input.homeDir, '.claude', 'hooks')),
    subpathRule(join(input.homeDir, '.claude', 'commands')),
    subpathRule(join(input.homeDir, '.claude', 'agents')),
    subpathRule(join(input.homeDir, '.claude', 'skills')),
    subpathRule(join(input.homeDir, '.claude', 'plugins')),
    literalRule(join(input.homeDir, '.claude.json')),
  ];

  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-map-executable)',
    // file-ioctl is REQUIRED for the interactive TUI: claude calls setRawMode
    // (tcsetattr/TIOCSETA on the pty), which is an ioctl. Without this, setRawMode
    // throws EPERM -> the TUI stays in cooked mode -> keyboard input is never ingested
    // -> the bot inits but never processes any message. (claude -p does not enter raw
    // mode, which is why non-interactive worked but the interactive bot hung.)
    // Low risk: file-ioctl does not widen file access; it only permits control ops on
    // fds the file-read*/file-write* rules already allow.
    '(allow file-ioctl)',
    '(allow network-outbound (remote tcp))',
    '(allow file-read*)',
    block('allow file-write*', writeRules),
    block('deny file-read*', input.denyReadPaths),
    block('allow file-read*', [subpathRule(input.ptyHandleDir)]),
    ...(otherProtectedRules.length > 0
      ? [
          block('deny file-read*', otherProtectedRules),
          block('deny file-write*', otherProtectedRules),
        ]
      : []),
    block('deny file-write*', claudeExecutableConfigWriteDenyRules),
    '(deny file-link)',
    '(deny file-clone)',
    '',
  ].join('\n');
}

export async function writeSandboxProfile(input: WriteSandboxProfileInput): Promise<string> {
  await mkdir(input.ptyHandleDir, { recursive: true });
  const profilePath = join(input.ptyHandleDir, `${input.handle}-sandbox.sb`);
  await writeFile(profilePath, input.profile);
  return profilePath;
}

export function defaultDenyReadPaths(homeDir: string): SandboxPathRule[] {
  return [
    subpathRule(join(homeDir, '.ssh')),
    subpathRule(join(homeDir, '.aws')),
    subpathRule(join(homeDir, '.gnupg')),
    subpathRule(join(homeDir, '.config', 'gh')),
    subpathRule(join(homeDir, '.config', 'gcloud')),
    subpathRule(join(homeDir, '.docker')),
    subpathRule(join(homeDir, '.kube')),
    subpathRule(join(homeDir, '.azure')),
    literalRule(join(homeDir, '.netrc')),
    literalRule(join(homeDir, '.npmrc')),
    literalRule(join(homeDir, '.pypirc')),
    literalRule(join(homeDir, '.git-credentials')),
    literalRule(join(homeDir, '.gem', 'credentials')),
    regexRule(`^${escapeRegex(join(homeDir, '.cargo', 'credentials'))}.*`),
    subpathRule(join(homeDir, '.password-store')),
    subpathRule(join(homeDir, '.config', 'op')),
    literalRule(join(homeDir, '.zshrc')),
    literalRule(join(homeDir, '.zshenv')),
    literalRule(join(homeDir, '.zprofile')),
    literalRule(join(homeDir, '.bashrc')),
    literalRule(join(homeDir, '.bash_profile')),
    literalRule(join(homeDir, '.profile')),
    literalRule(join(homeDir, '.zsh_history')),
    literalRule(join(homeDir, '.bash_history')),
    subpathRule(join(homeDir, '.cli2im')),
    subpathRule(join(homeDir, '.openclaw')),
    literalRule(join(homeDir, 'Documents', 'VPS管理信息汇总.md')),
    subpathRule(join(homeDir, 'Library', 'Cookies')),
    subpathRule(join(homeDir, 'Library', 'HTTPStorages')),
    subpathRule(join(homeDir, 'Library', 'Messages')),
    subpathRule(join(homeDir, 'Library', 'Mail')),
    subpathRule(join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome')),
    subpathRule(join(homeDir, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser')),
    subpathRule(join(homeDir, 'Library', 'Application Support', 'Microsoft Edge')),
    subpathRule(join(homeDir, 'Library', 'Application Support', 'Arc')),
    subpathRule(join(homeDir, 'Library', 'Application Support', 'Firefox')),
    subpathRule(join(homeDir, '.codex')),
    subpathRule(join(homeDir, '.gemini')),
    subpathRule(join(homeDir, '.cursor')),
  ];
}

export function protectedSandboxSubtrees(homeDir: string): string[] {
  return [
    join(homeDir, '.claude'),
    ...defaultDenyReadPaths(homeDir)
      .filter((rule): rule is { type: 'subpath'; path: string } => rule.type === 'subpath')
      .map((rule) => rule.path),
  ];
}

function subpathRule(path: string): SandboxPathRule {
  return { type: 'subpath', path };
}

function literalRule(path: string): SandboxPathRule {
  return { type: 'literal', path };
}

function regexRule(pattern: string): SandboxPathRule {
  return { type: 'regex', pattern };
}

function block(name: string, rules: SandboxPathRule[]): string {
  return `(${name}\n${rules.map((rule) => `  ${formatRule(rule)}`).join('\n')})`;
}

function formatRule(rule: SandboxPathRule): string {
  if (rule.type === 'regex') return `(regex #"${rule.pattern.replace(/"/g, '\\"')}")`;
  return `(${rule.type} "${escapeSchemeString(rule.path)}")`;
}

function escapeSchemeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}
