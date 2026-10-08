export interface SessionProvenance {
  agentSessionId: string;
  bot: string;
  principal: string;
  scope: string;
  policyFingerprint: string;
  memoryGeneration: number;
}
export type ProvenanceContext = Omit<SessionProvenance, 'agentSessionId'>;
export function canResumeIsolated(record: SessionProvenance | undefined, expected: ProvenanceContext): boolean {
  return !!record && record.bot === expected.bot && record.principal === expected.principal
    && record.scope === expected.scope && record.policyFingerprint === expected.policyFingerprint
    && record.memoryGeneration === expected.memoryGeneration;
}
