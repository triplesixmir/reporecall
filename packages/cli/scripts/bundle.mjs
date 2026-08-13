import { chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDir, '../../..');

const shared = {
  alias: {
    '@reporecall/context': resolve(repositoryRoot, 'packages/context/src/index.ts'),
    '@reporecall/core': resolve(repositoryRoot, 'packages/core/src/index.ts'),
    '@reporecall/index': resolve(repositoryRoot, 'packages/index/src/index.ts'),
    '@reporecall/integrations': resolve(repositoryRoot, 'packages/integrations/src/index.ts'),
    '@reporecall/mcp': resolve(repositoryRoot, 'packages/mcp/src/index.ts'),
    '@reporecall/processors': resolve(repositoryRoot, 'packages/processors/src/index.ts'),
    '@reporecall/storage': resolve(repositoryRoot, 'packages/storage/src/index.ts'),
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  sourcemap: false,
  target: 'node22',
  external: [
    '@hono/node-server',
    '@iarna/toml',
    '@inquirer/prompts',
    '@modelcontextprotocol/sdk',
    'better-sqlite3',
    'cac',
    'hono',
    'yaml',
    'zod',
  ],
};

await Promise.all([
  build({
    ...shared,
    banner: { js: '#!/usr/bin/env node' },
    entryPoints: ['src/bin.ts'],
    outfile: 'dist/bin.js',
  }),
  build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/index.js' }),
]);

if (process.platform !== 'win32') await chmod('dist/bin.js', 0o755);
