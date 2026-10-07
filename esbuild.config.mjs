import { build } from 'esbuild';
import { chmodSync, cpSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const buildDir = process.env.CLI2IM_BUILD_DIR || 'dist';
// Explicit candidate builds must not overwrite the live plugin's hook artifacts.
const pluginBuildDir = process.env.CLI2IM_BUILD_DIR
  ? join(buildDir, 'plugins', 'codex-task-notifier', 'dist')
  : join('plugins', 'codex-task-notifier', 'dist');

async function main() {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: join(buildDir, 'index.js'),
    external: ['sql.js', '@larksuiteoapi/node-sdk', '@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', 'content-guard'],
    sourcemap: true,
    banner: { js: "import { createRequire as _cR } from 'module'; const require = _cR(import.meta.url);" },
  });

  await build({
    entryPoints: ['cli/cli2im.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: join(buildDir, 'cli2im.js'),
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  });

  await build({
    entryPoints: ['src/notifications/hook-client.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: join(buildDir, 'codex-notify-hook.js'),
    banner: { js: '#!/usr/bin/env node' },
  });
  chmodSync(join(buildDir, 'codex-notify-hook.js'), 0o755);

  await build({
    entryPoints: ['src/notifications/lifecycle-hook-client.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: join(pluginBuildDir, 'lifecycle-hook.js'),
    banner: { js: '#!/usr/bin/env node' },
  });
  await build({
    entryPoints: ['src/notifications/mcp-server.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: join(pluginBuildDir, 'mcp-server.js'),
    banner: { js: '#!/usr/bin/env node' },
  });
  chmodSync(join(pluginBuildDir, 'lifecycle-hook.js'), 0o755);
  chmodSync(join(pluginBuildDir, 'mcp-server.js'), 0o755);

  const sqlJsDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  mkdirSync(buildDir, { recursive: true });
  cpSync(join(sqlJsDir, 'sql-wasm.wasm'), join(buildDir, 'sql-wasm.wasm'));

  console.log(`Build complete: ${buildDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
