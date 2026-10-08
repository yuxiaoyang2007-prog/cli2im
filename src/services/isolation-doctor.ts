import { collectBotIdentities, resolvePeople } from '../memory/principal.js';
import { IsolationAdmissionError } from '../isolation/admission.js';
import { canonicalPath } from '../runtime/execution-scope.js';
import { resolveBotSpawnOpts } from '../runtime/spawn-options.js';
import { isolationWritablePaths, scopeHash, type PolicyPaths } from '../isolation/policy.js';
import type { IsolationRuntime } from '../isolation/runtime.js';
import type { AppConfig, SessionKey } from '../types.js';
import type { VerificationStatus } from '../isolation/verification.js';

export interface IsolationReportRow { bot: string; scope: string; status: VerificationStatus; failures: string[]; staticReadonly?: string[] }
/** No platform connection, credential lookup or user message is needed for a scope check. */
export async function runIsolationDoctor(params: { config: AppConfig; runtime: IsolationRuntime; paths: PolicyPaths; identityMapping?: unknown; force?: boolean }): Promise<IsolationReportRow[]> {
  const rows: IsolationReportRow[] = [];
  const { config, runtime, paths } = params;
  for (const [name, bot] of Object.entries(config.bots)) {
    if (!bot.isolation?.enabled || bot.enabled === false) continue;
    const scopes = [...new Set([bot.workingDirectory, ...Object.values(bot.userOverrides ?? {}).flatMap(o => o.workingDirectory ? [o.workingDirectory] : [])])];
    for (const workspace of scopes) {
      const scope = scopeHash(workspace).slice(0, 8);
      try {
        const workingDirectory = canonicalPath(workspace);
        const key = `${bot.platform}:isolation-${scope}:${name}` as SessionKey;
        const options = await resolveBotSpawnOpts({ botConfig: bot, workingDirectory,
          allWritable: isolationWritablePaths(config, paths), env: { ...config.agents[bot.agent]?.env,
            ...(bot.larkCliConfigDir ? { LARKSUITE_CLI_CONFIG_DIR: bot.larkCliConfigDir } : {}) },
          model: config.agents[bot.agent]?.defaultModel, autoApprove: bot.autoApprove,
          turnTimeoutMs: bot.turnTimeoutMs, idleTimeoutMs: bot.idleTimeoutMs, sandboxMode: bot.sandboxMode,
          reasoningEffort: config.agents[bot.agent]?.defaultEffort });
        options.isolation = await runtime.prepare(key, `isolation-check:${name}:${scope}`, workingDirectory, options, params.identityMapping ?? [...resolvePeople(config.memory?.people, collectBotIdentities(config.bots)).entries()].sort(), false);
        const record = await runtime.check(key, params.force ?? true);
        rows.push({ bot: name, scope, status: record?.status ?? 'UNVERIFIED',
          ...(record?.checks.some(c => c.evidenceMode === 'static+readonly') ? { staticReadonly: record.checks.filter(c => c.evidenceMode === 'static+readonly').map(c => c.name) } : {}),
          failures: record?.checks.filter(c => !['PASS', 'UNCOVERED'].includes(c.status)).map(c => c.name) ?? ['check.not-run'] });
      } catch (error) {
        // Also covers option resolution and explicit check preparation, before runtime.prepare can run.
        let failure = error;
        try { failure = runtime.revokePreparation(name, error); } catch { failure = new IsolationAdmissionError(); }
        rows.push({ bot: name, scope, status: failure instanceof IsolationAdmissionError ? failure.status : 'ERROR', failures: ['check.preparation'] });
      }
    }
    if (rows.filter(row => row.bot === name).every(row => row.status === 'VERIFIED')) {
      try { runtime.clearPreparationFailure(name); }
      catch { rows.push({ bot: name, scope: 'revocation', status: 'ERROR', failures: ['check.preparation'] }); }
    }
  }
  return rows;
}
export function formatIsolationReport(rows: IsolationReportRow[]): string {
  if (!rows.length) return '隔离：未配置启用的隔离范围';
  return rows.map(r => `${r.bot}/${r.scope}: ${r.status}${r.failures.length ? ` (${r.failures.join(', ')})` : ''}${r.staticReadonly?.length ? ` [静态+只读: ${r.staticReadonly.join(', ')}]` : ''}`).join('\n');
}
export function isolationExitCode(rows: IsolationReportRow[]): number {
  return rows.length && rows.every(r => r.status === 'VERIFIED') ? 0 : 1;
}
