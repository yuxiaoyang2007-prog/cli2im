import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  extractFileMarkerCandidates,
  stripFileMarkers,
  resolveSafeFilePayloads,
  resolveSafeFilePaths,
} from '../src/agents/codex-file-markers.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cli2im-file-marker-'));
}

describe('extractFileMarkerCandidates', () => {
  it('returns [] for empty / no-marker text', () => {
    expect(extractFileMarkerCandidates('')).toEqual([]);
    expect(extractFileMarkerCandidates('hello world')).toEqual([]);
  });

  it('extracts a single marker', () => {
    expect(extractFileMarkerCandidates('see [[file:./report.md]]')).toEqual(['./report.md']);
  });

  it('extracts multiple markers in order, dedupes', () => {
    const text = '[[file:a.md]] then [[file:b.pdf]] and again [[file:a.md]]';
    expect(extractFileMarkerCandidates(text)).toEqual(['a.md', 'b.pdf']);
  });

  it('trims whitespace around the path', () => {
    expect(extractFileMarkerCandidates('[[file:   ./x.md  ]]')).toEqual(['./x.md']);
  });

  it('tolerates whitespace (including newlines) around the path', () => {
    // Robust against LLM line-wrap artifacts.
    expect(extractFileMarkerCandidates('[[file:\nfoo.md]]')).toEqual(['foo.md']);
    expect(extractFileMarkerCandidates('[[file:  bar.md\t]]')).toEqual(['bar.md']);
  });

  it('extracts when adjacent to punctuation', () => {
    expect(extractFileMarkerCandidates('done. [[file:./final.docx]]！')).toEqual(['./final.docx']);
  });
});

describe('stripFileMarkers', () => {
  it('removes markers from text', () => {
    expect(stripFileMarkers('hello [[file:a.md]] world')).toBe('hello  world');
  });

  it('collapses excessive blank lines after stripping', () => {
    const text = 'top\n\n[[file:a.md]]\n\n\nbottom';
    const out = stripFileMarkers(text);
    expect(out).not.toContain('[[file:');
    expect(out).toMatch(/top\n\n+bottom/);
    expect(out.match(/\n/g)!.length).toBeLessThanOrEqual(4);
  });

  it('is a no-op when no markers present', () => {
    expect(stripFileMarkers('plain text')).toBe('plain text');
  });
});

describe('resolveSafeFilePaths', () => {
  it('resolves a file inside the working directory', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'report.md'), '# hi');
      const paths = await resolveSafeFilePaths(['./report.md'], dir);
      expect(paths).toEqual([realpathSync(join(dir, 'report.md'))]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts working-dir-relative path without ./ prefix', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'note.txt'), 'x');
      const paths = await resolveSafeFilePaths(['note.txt'], dir);
      expect(paths).toEqual([realpathSync(join(dir, 'note.txt'))]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts common generated code files', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'tool.ts'), 'export const x = 1;');
      const paths = await resolveSafeFilePaths(['tool.ts'], dir);
      expect(paths).toEqual([realpathSync(join(dir, 'tool.ts'))]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns metadata payloads for runtime replacement checks', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'report.md'), '# hi');
      const [file] = await resolveSafeFilePayloads(['report.md'], dir);
      expect(file).toMatchObject({
        path: realpathSync(join(dir, 'report.md')),
        name: 'report.md',
        size: 4,
      });
      expect(typeof file.dev).toBe('number');
      expect(typeof file.ino).toBe('number');
      expect(typeof file.mtimeMs).toBe('number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects path traversal (../)', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'inside.md'), 'x');
      const paths = await resolveSafeFilePaths(['../outside.md', '../../etc/passwd'], dir);
      expect(paths).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not confuse an inside filename starting with two dots for traversal', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, '..report.md'), 'x');
      const paths = await resolveSafeFilePaths(['..report.md'], dir);
      expect(paths).toEqual([realpathSync(join(dir, '..report.md'))]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects absolute path outside working directory', async () => {
    const dir = makeTempDir();
    try {
      const paths = await resolveSafeFilePaths(['/etc/passwd', '/tmp/cli2im-not-in-wd'], dir);
      expect(paths).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects symlink pointing outside working directory', async () => {
    const dir = makeTempDir();
    const outsideTarget = mkdtempSync(join(tmpdir(), 'cli2im-outside-target-'));
    try {
      writeFileSync(join(outsideTarget, 'secret.txt'), 'sensitive');
      symlinkSync(join(outsideTarget, 'secret.txt'), join(dir, 'leak.txt'));
      const paths = await resolveSafeFilePaths(['leak.txt'], dir);
      expect(paths).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideTarget, { recursive: true, force: true });
    }
  });

  it('rejects non-existent file', async () => {
    const dir = makeTempDir();
    try {
      const paths = await resolveSafeFilePaths(['ghost.md'], dir);
      expect(paths).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects directory (not a regular file)', async () => {
    const dir = makeTempDir();
    try {
      mkdirSync(join(dir, 'sub'));
      const paths = await resolveSafeFilePaths(['sub'], dir);
      expect(paths).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces size limit', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'big.bin'), Buffer.alloc(2048));
      const paths = await resolveSafeFilePaths(['big.bin'], dir, { maxSizeBytes: 1024 });
      expect(paths).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dedupes identical resolutions', async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, 'r.md'), 'x');
      const paths = await resolveSafeFilePaths(['./r.md', 'r.md'], dir);
      expect(paths.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps total files', async () => {
    const dir = makeTempDir();
    try {
      const cands: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        writeFileSync(join(dir, `f${i}.md`), 'x');
        cands.push(`f${i}.md`);
      }
      const paths = await resolveSafeFilePaths(cands, dir, { maxFiles: 3 });
      expect(paths.length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns [] for empty inputs', async () => {
    expect(await resolveSafeFilePaths([], '/tmp')).toEqual([]);
    expect(await resolveSafeFilePaths(['x'], '')).toEqual([]);
  });
});
