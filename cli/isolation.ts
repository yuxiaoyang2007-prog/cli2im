import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/loader.js';
import { policyPaths } from '../src/isolation/policy.js';
import { VerificationStore } from '../src/isolation/verification.js';
import { IsolationRuntime } from '../src/isolation/runtime.js';
import { runIsolationCheck } from '../src/isolation/check.js';
import { SessionStore } from '../src/session/store.js';
import { MemoryStore } from '../src/memory/store.js';
import { runIsolationDoctor, formatIsolationReport, isolationExitCode } from '../src/services/isolation-doctor.js';

export async function doctorIsolation(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { config: { type: 'string' } } });
  const config = loadConfig(values.config ?? join(homedir(), '.cli2im', 'config.yaml'));
  const paths = policyPaths(config);
  const store = await SessionStore.create(':memory:');
  try {
    const runtime = new IsolationRuntime({ config, paths, store, verification: new VerificationStore(join(paths.dataDir, 'isolation', 'verification.json')),
      memory: new MemoryStore(paths.memoryDir), invalidate: () => {}, runCheck: runIsolationCheck });
    const rows = await runIsolationDoctor({ config, paths, runtime, force: true });
    console.log(formatIsolationReport(rows));
    return isolationExitCode(rows);
  } finally { store.close(); }
}
