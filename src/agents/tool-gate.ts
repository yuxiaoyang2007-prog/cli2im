import type { ToolGateResult } from '../types.js';

const BASH_TOOL_NAMES = new Set(['Bash', 'bash', 'shell', 'terminal', 'execute']);

export class ToolGate {
  private patterns: RegExp[];

  constructor(patternStrings: string[]) {
    this.patterns = [];
    for (const p of patternStrings) {
      try {
        this.patterns.push(new RegExp(p, 'i'));
      } catch (err) {
        console.warn(`[tool-gate] Skipping invalid regex pattern: ${p} — ${(err as Error).message}`);
      }
    }
  }

  check(toolName: string, input: Record<string, unknown>): ToolGateResult {
    if (!BASH_TOOL_NAMES.has(toolName)) {
      return { action: 'allow' };
    }

    const command = typeof input.command === 'string' ? input.command : '';
    if (!command) {
      return { action: 'allow' };
    }

    for (const pattern of this.patterns) {
      if (pattern.test(command)) {
        return {
          action: 'block',
          reason: `Matched dangerous pattern: ${pattern.source}`,
          command,
        };
      }
    }

    return { action: 'allow' };
  }
}
