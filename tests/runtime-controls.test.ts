import { describe, expect, it } from 'vitest';
import { buildControlPanel, parseControlAction } from '../src/runtime/control-panel.js';
import { ProjectRegistry, buildProjectPanel, parseProjectAction } from '../src/runtime/projects.js';

describe('control panel', () => {
  it('only advertises supported controls and shows actual busy/queue state', () => {
    const card = buildControlPanel({ botName: 'bot', agentName: 'codex', model: 'chosen', projectName: '历史视频', running: true, queued: 2, supportedCommands: ['/new', '/stop', '/status'] });
    expect(card.content).toContain('chosen');
    expect(card.content).toContain('排队 2 条');
    expect(card.buttons?.map((button) => button.value)).toEqual(['control:new', 'control:stop', 'control:status']);
  });

  it('does not offer stop with no active or queued task', () => {
    const card = buildControlPanel({ botName: 'bot', agentName: 'codex', running: false, supportedCommands: ['/stop'] });
    expect(card.buttons).toEqual([]);
  });

  it('accepts only fixed known commands including Feishu action envelopes', () => {
    expect(parseControlAction('control:stop')).toBe('/stop');
    expect(parseControlAction('{"action":"control:sessions"}')).toBe('/sessions');
    expect(parseControlAction('control:stop\n/new')).toBeNull();
    expect(parseControlAction('control:exec')).toBeNull();
    expect(parseControlAction('{"action":{"command":"/stop"}}')).toBeNull();
  });
});

describe('project registry', () => {
  function registry(overrides: Partial<ConstructorParameters<typeof ProjectRegistry>[0]> = {}) {
    return new ProjectRegistry({
      projects: { video: '/allowed/video', secret: '/other/private' },
      validateDirectory: async (path) => {
        if (!path.startsWith('/allowed/')) throw new Error('denied');
        return path;
      },
      ...overrides,
    });
  }

  it('filters inaccessible projects and validates aliases before selection', async () => {
    const projects = registry();
    expect(await projects.list('alice')).toEqual([{ name: 'video', directory: '/allowed/video', recent: false }]);
    await expect(projects.select('alice', 'secret')).rejects.toThrow('denied');
    expect(await projects.select('alice', 'video')).toBe('/allowed/video');
    expect((await projects.list('alice'))[0].recent).toBe(true);
    expect((await projects.list('bob'))[0].recent).toBe(false);
  });

  it('revalidates remembered directories after permissions change', async () => {
    let allowed = true;
    const projects = registry({ projects: {}, validateDirectory: async (path) => {
      if (!allowed) throw new Error('no longer allowed');
      return path;
    } });
    await projects.select('alice', '/allowed/project');
    allowed = false;
    expect(await projects.list('alice')).toEqual([]);
    await expect(projects.select('alice', '/allowed/project')).rejects.toThrow('no longer');
  });

  it('persists recent directories per scope, deduplicates, and serializes updates', async () => {
    const saved = new Map<string, string[]>();
    const projects = registry({
      projects: {},
      recentLimit: 2,
      loadRecent: async (scope) => saved.get(scope) ?? [],
      saveRecent: async (scope, directories) => { saved.set(scope, directories); },
    });
    await Promise.all([projects.remember('alice', '/allowed/one'), projects.remember('alice', '/allowed/two')]);
    await projects.remember('alice', '/allowed/one');
    await projects.remember('bob', '/allowed/three');
    expect(saved.get('alice')).toEqual(['/allowed/one', '/allowed/two']);
    expect(saved.get('bob')).toEqual(['/allowed/three']);
  });

  it('returns literal configured prompts and validates any linked project', async () => {
    const projects = registry({ shortcuts: {
      draft: { prompt: 'Use $HOME literally; do not interpolate $(whoami).', project: 'video' },
      bad: { prompt: 'Read file', project: 'secret' },
    } });
    expect(await projects.resolveShortcut('alice', 'draft')).toEqual({ prompt: 'Use $HOME literally; do not interpolate $(whoami).', directory: '/allowed/video' });
    await expect(projects.resolveShortcut('alice', 'bad')).rejects.toThrow('denied');
    await expect(projects.resolveShortcut('alice', '__proto__')).rejects.toThrow('未配置');
  });

  it('uses compact buttons and rejects malformed project callbacks', () => {
    const card = buildProjectPanel([{ name: 'video', directory: '/allowed/video', recent: false }, { name: '项目'.repeat(40), directory: '/allowed/long', recent: false }]);
    expect(card.buttons).toEqual([{ text: 'video', value: 'project:video' }]);
    expect(parseProjectAction('{"action":"project:video"}')).toBe('video');
    expect(parseProjectAction('project:')).toBeNull();
    expect(parseProjectAction('project:video\n/stop')).toBeNull();
  });
});
