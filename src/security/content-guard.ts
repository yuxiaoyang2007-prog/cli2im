let detectInjection: ((text: string) => { detected: boolean; score: number; severity: string }) | undefined;

try {
  const mod = await import('content-guard');
  detectInjection = mod.detectInjection;
} catch {
  // content-guard is optional — scanning disabled when not installed
}

const DEFAULT_BLOCK_THRESHOLD = 15;

let blockThreshold = DEFAULT_BLOCK_THRESHOLD;

export interface ContentGuardOptions {
  blockThreshold?: number;
}

export function initContentGuard(options: ContentGuardOptions = {}): void {
  blockThreshold = options.blockThreshold ?? DEFAULT_BLOCK_THRESHOLD;
}

export function scanToolResult(toolName: string, output: string): string {
  if (!detectInjection || !toolName.startsWith('mcp__')) return output;

  const result = detectInjection(output);
  if (result.score >= blockThreshold) {
    return `[content-guard blocked external tool output: score=${result.score}, severity=${result.severity}]`;
  }
  if (result.detected) {
    return `<external_content trust="untrusted">\n${output}\n</external_content>`;
  }

  return output;
}
