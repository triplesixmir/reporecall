import { readdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RepoRecallConfig } from '../src/config.js';
import { createProcessingRuntime } from '../src/processing.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; config: RepoRecallConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-cli-processing-'));
  roots.push(root);
  return {
    root,
    config: {
      brainPath: join(root, 'brain'),
      projectMemoryDir: join(root, 'project', '.reporecall'),
      indexPath: join(root, 'cache', 'index.sqlite'),
      port: 4_317,
      ignoredPaths: [],
      processor: 'agent-native',
      processorMode: 'balanced',
      sources: [],
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CLI processing runtime', () => {
  test('writes durable output and updates the disposable index immediately', async () => {
    const { root, config } = await fixture();
    const runtime = createProcessingRuntime(config);
    try {
      const result = await runtime.processCapture({
        content: 'Decision: keep Markdown canonical.\nPrivate capture text stays temporary.',
        project: { id: 'demo', root: join(root, 'project'), name: 'Demo' },
      });

      expect(result).toMatchObject({ provider: 'agent-native', mode: 'balanced' });
      expect(result.durable).toMatchObject([{ content: 'keep Markdown canonical.' }]);
      const search = await runtime.index.search({ query: 'Markdown canonical' });
      expect(search).toMatchObject([{ record: { content: 'keep Markdown canonical.' } }]);
      await expect(
        readFile(join(config.projectMemoryDir, 'memories', `${result.durable[0]?.id}.md`), 'utf8'),
      ).resolves.toContain('keep Markdown canonical.');
      await expect(readdir(join(config.projectMemoryDir, 'sessions'))).resolves.toEqual([]);
    } finally {
      runtime.close();
    }
  });
});
