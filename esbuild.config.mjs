import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function main() {
  await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: 'dist/index.js',
    external: ['sql.js', '@larksuiteoapi/node-sdk'],
    sourcemap: true,
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  });

  await build({
    entryPoints: ['cli/cli2im.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: 'dist/cli2im.js',
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
  });

  const sqlJsDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  mkdirSync('dist', { recursive: true });
  cpSync(join(sqlJsDir, 'sql-wasm.wasm'), 'dist/sql-wasm.wasm');

  console.log('Build complete');
}

main().catch(console.error);
