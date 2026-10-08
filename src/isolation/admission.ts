import { assertIsolationSearchPath, type IsolationPolicy } from './policy.js';
import type { AgentBinary, VerificationStore } from './verification.js';
import { canResumeIsolated, type ProvenanceContext, type SessionProvenance } from './provenance.js';

export const ISOLATION_PAUSED = '隔离检查未通过，已暂停执行，请管理员查看 /doctor';
export class IsolationAdmissionError extends Error {
  constructor(message = ISOLATION_PAUSED, readonly status: 'ERROR' | 'UNSUPPORTED' = 'ERROR') { super(message); }
}
export const PROVIDER_CREDENTIAL_NAMES = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY',
  'CODEX_API_KEY', 'CTI_CODEX_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'ZAI_API_KEY', 'ZHIPU_API_KEY', 'ZHIPUAI_API_KEY',
  'KIMI_API_KEY', 'KIMI_CODE_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'AZURE_OPENAI_API_KEY', 'AZURE_API_KEY',
  'GOOGLE_AUTH_TOKEN', 'GOOGLE_ACCESS_TOKEN',
];
export const PROVIDER_CREDENTIAL = new RegExp(`^(?:${PROVIDER_CREDENTIAL_NAMES.join('|')})$`, 'i');
export function assertNoProviderCredentials(env: NodeJS.ProcessEnv): void {
  if (Object.entries(env).some(([key, value]) => PROVIDER_CREDENTIAL.test(key) && value !== undefined)) {
    throw new IsolationAdmissionError(`${ISOLATION_PAUSED}（子进程包含 provider 凭据变量）`);
  }
}
export function assertIsolationAdmission(params: {
  verification: VerificationStore; policy: IsolationPolicy; binary: AgentBinary; expected: ProvenanceContext;
  sessionId?: string; provenance?: SessionProvenance; env: NodeJS.ProcessEnv;
}): void {
  assertNoProviderCredentials(params.env);
  try { assertIsolationSearchPath(params.env, params.policy); }
  catch { throw new IsolationAdmissionError(ISOLATION_PAUSED, 'UNSUPPORTED'); }
  if (params.verification.state(params.expected.bot, params.policy.scopeKey, params.policy.fingerprint, params.binary) !== 'VERIFIED') {
    throw new IsolationAdmissionError(ISOLATION_PAUSED);
  }
  if (params.sessionId && !canResumeIsolated(params.provenance, params.expected)) throw new IsolationAdmissionError('该会话不属于当前隔离范围或已被撤销，无法恢复');
}
