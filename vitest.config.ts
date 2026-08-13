import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@reporecall/core': resolve('packages/core/src/index.ts'),
      '@reporecall/storage': resolve('packages/storage/src/index.ts'),
      '@reporecall/index': resolve('packages/index/src/index.ts'),
      '@reporecall/context': resolve('packages/context/src/index.ts'),
      '@reporecall/integrations': resolve('packages/integrations/src/index.ts'),
      '@reporecall/processors': resolve('packages/processors/src/index.ts'),
      '@reporecall/mcp': resolve('packages/mcp/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
