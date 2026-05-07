import { beforeEach, describe, it, expect, vi } from 'vitest';
import { initContentGuard, scanToolResult } from '../src/security/content-guard.js';

const contentGuardMock = vi.hoisted(() => ({
  detectInjection: vi.fn(),
}));

vi.mock('content-guard', () => ({
  detectInjection: contentGuardMock.detectInjection,
}));

const OUTPUT = 'external tool output';

function detection(score: number, detected = score > 0) {
  return {
    detected,
    severity: score >= 15 ? 'critical' : detected ? 'low' : 'none',
    score,
    matches: [],
    summary: detected ? `score=${score}` : 'clean',
  };
}

describe('content guard integration', () => {
  beforeEach(() => {
    initContentGuard();
    contentGuardMock.detectInjection.mockReset();
    contentGuardMock.detectInjection.mockReturnValue(detection(0, false));
  });

  it('passes trusted tool results through unchanged', () => {
    expect(scanToolResult('Bash', OUTPUT)).toBe(OUTPUT);
    expect(contentGuardMock.detectInjection).not.toHaveBeenCalled();
  });

  it('passes clean external tool results through unchanged', () => {
    expect(scanToolResult('mcp__browser__open', OUTPUT)).toBe(OUTPUT);
    expect(contentGuardMock.detectInjection).toHaveBeenCalledWith(OUTPUT);
  });

  it('wraps detected external tool results below the block threshold', () => {
    contentGuardMock.detectInjection.mockReturnValue(detection(4));

    expect(scanToolResult('mcp__browser__open', OUTPUT)).toBe(
      `<external_content trust="untrusted">\n${OUTPUT}\n</external_content>`,
    );
  });

  it('blocks detected external tool results at or above the block threshold', () => {
    contentGuardMock.detectInjection.mockReturnValue(detection(15));

    expect(scanToolResult('mcp__browser__open', OUTPUT)).toBe(
      '[content-guard blocked external tool output: score=15, severity=critical]',
    );
  });

  it('uses configured block threshold', () => {
    initContentGuard({ blockThreshold: 5 });
    contentGuardMock.detectInjection.mockReturnValue(detection(5));

    expect(scanToolResult('mcp__browser__open', OUTPUT)).toBe(
      '[content-guard blocked external tool output: score=5, severity=low]',
    );
  });

  it('initializes without throwing', () => {
    expect(() => initContentGuard()).not.toThrow();
  });

  it('trusts built-in tool names', () => {
    const builtInTools = [
      'Bash',
      'Edit',
      'MultiEdit',
      'Write',
      'Read',
      'Grep',
      'Glob',
      'LS',
      'Task',
      'TodoWrite',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
    ];

    for (const toolName of builtInTools) {
      expect(scanToolResult(toolName, OUTPUT)).toBe(OUTPUT);
    }
  });
});
