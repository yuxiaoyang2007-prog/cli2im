import type { CardPayload } from '../types.js';
import { unwrapCardAction } from './control-panel.js';

export interface ProjectShortcut {
  description?: string;
  prompt: string;
  project?: string;
}

export interface ProjectRegistryOptions {
  projects?: Record<string, string>;
  shortcuts?: Record<string, ProjectShortcut>;
  /** Must check real paths against the caller's allowed roots on EVERY access. */
  validateDirectory: (candidate: string, scopeKey: string) => Promise<string>;
  loadRecent?: (scopeKey: string) => Promise<readonly string[]>;
  saveRecent?: (scopeKey: string, directories: string[]) => Promise<void>;
  recentLimit?: number;
}

export interface ProjectChoice {
  name: string;
  directory: string;
  recent: boolean;
}

export class ProjectRegistry {
  private recent = new Map<string, string[]>();
  private updates = new Map<string, Promise<void>>();

  constructor(private options: ProjectRegistryOptions) {}

  async list(scopeKey: string): Promise<ProjectChoice[]> {
    const choices: ProjectChoice[] = [];
    const recent = await this.getRecent(scopeKey);
    const knownDirectories = new Set<string>();
    for (const [name, directory] of Object.entries(this.options.projects ?? {})) {
      try {
        const canonical = await this.options.validateDirectory(directory, scopeKey);
        choices.push({ name, directory: canonical, recent: recent.includes(canonical) });
        knownDirectories.add(canonical);
      } catch {
        // Never advertise a configured project the current caller cannot access.
      }
    }
    for (const directory of recent) {
      try {
        const canonical = await this.options.validateDirectory(directory, scopeKey);
        if (knownDirectories.has(canonical)) continue;
        choices.push({ name: canonical, directory: canonical, recent: true });
        knownDirectories.add(canonical);
      } catch {
        // Permissions, directory existence, or symlink targets may have changed.
      }
    }
    return choices;
  }

  async select(scopeKey: string, nameOrDirectory: string): Promise<string> {
    const projects = this.options.projects ?? {};
    const candidate = Object.hasOwn(projects, nameOrDirectory) ? projects[nameOrDirectory] : nameOrDirectory;
    const canonical = await this.options.validateDirectory(candidate, scopeKey);
    await this.remember(scopeKey, canonical);
    return canonical;
  }

  listShortcuts(): Array<{ name: string; description: string }> {
    return Object.entries(this.options.shortcuts ?? {}).map(([name, shortcut]) => ({
      name,
      description: shortcut.description ?? name,
    }));
  }

  /** Returns a configured prompt; it never runs shell commands or templates. */
  async resolveShortcut(scopeKey: string, name: string): Promise<{ prompt: string; directory?: string }> {
    const shortcuts = this.options.shortcuts ?? {};
    if (!Object.hasOwn(shortcuts, name)) throw new Error('未配置这个快捷任务');
    const shortcut = shortcuts[name];
    if (!shortcut.prompt.trim()) throw new Error('快捷任务内容为空');
    const directory = shortcut.project ? await this.select(scopeKey, shortcut.project) : undefined;
    return { prompt: shortcut.prompt, directory };
  }

  async remember(scopeKey: string, directory: string): Promise<void> {
    const previous = this.updates.get(scopeKey) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const canonical = await this.options.validateDirectory(directory, scopeKey);
      const current = await this.getRecent(scopeKey);
      const limit = Math.max(1, Math.min(20, this.options.recentLimit ?? 8));
      const next = [canonical, ...current.filter((item) => item !== canonical)].slice(0, limit);
      if (this.options.saveRecent) await this.options.saveRecent(scopeKey, next);
      this.recent.set(scopeKey, next);
    });
    this.updates.set(scopeKey, operation);
    try {
      await operation;
    } finally {
      if (this.updates.get(scopeKey) === operation) this.updates.delete(scopeKey);
    }
  }

  private async getRecent(scopeKey: string): Promise<readonly string[]> {
    return this.options.loadRecent ? this.options.loadRecent(scopeKey) : this.recent.get(scopeKey) ?? [];
  }
}

export function buildProjectPanel(choices: ProjectChoice[]): CardPayload {
  return {
    type: 'final',
    title: '选择项目',
    content: choices.length
      ? choices.map((choice) => `${choice.recent ? '最近 · ' : ''}${choice.name}\n${choice.directory}`).join('\n\n')
      : '暂时没有可用项目。可以用 /cd 切换到获准使用的目录。',
    buttons: choices
      .filter((choice) => Buffer.byteLength(`project:${choice.name}`, 'utf8') <= 64)
      .map((choice) => ({ text: choice.name.slice(0, 40), value: `project:${choice.name}` })),
  };
}

/** Selection still needs ProjectRegistry.select and callback authorization. */
export function parseProjectAction(data: string): string | null {
  const action = unwrapCardAction(data);
  if (!action.startsWith('project:')) return null;
  const name = action.slice('project:'.length);
  return name && !/[\r\n\x00]/.test(name) ? name : null;
}
