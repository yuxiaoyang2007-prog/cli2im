export function assertSupportedIsolationAgent(agent: string): void {
  if (agent !== 'claude-code' && agent !== 'codex') throw new Error('UNSUPPORTED: isolation requires claude-code or codex');
}
