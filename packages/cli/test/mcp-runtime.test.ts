import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, test } from 'vitest';
import { createMemoryMcpServer } from '@reporecall/mcp';
import type { RepoRecallConfig } from '../src/config.js';
import { createMcpRuntime } from '../src/index.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; config: RepoRecallConfig }> {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-cli-mcp-runtime-'));
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
      processorMode: 'conservative',
      sources: [],
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CLI-created MCP runtime', () => {
  test('shares processor stores and Inbox with the explicit MCP tool', async () => {
    const { root, config } = await fixture();
    const configured = createMcpRuntime(config);
    const server = createMemoryMcpServer(configured.runtime);
    const client = new Client({ name: 'reporecall-cli-mcp-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await configured.index.rebuild([
        { root: config.brainPath, scope: 'global' },
        {
          root: config.projectMemoryDir,
          scope: 'project',
          project: { id: 'demo', root: join(root, 'project'), name: 'Demo' },
        },
        {
          root: config.projectMemoryDir,
          scope: 'session',
          project: { id: 'demo', root: join(root, 'project'), name: 'Demo' },
        },
      ]);
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({
        name: 'memory_process',
        arguments: {
          content: 'Decision: use the shared MCP processor runtime.',
          projectId: 'demo',
          projectRoot: join(root, 'project'),
          projectName: 'Demo',
        },
      });

      expect(result.structuredContent).toMatchObject({
        provider: 'agent-native',
        mode: 'conservative',
        durable: [],
        inbox: [{ suggested: { content: 'use the shared MCP processor runtime.' } }],
      });
      expect(await configured.runtime.listInbox?.(10)).toMatchObject([
        { suggested: { content: 'use the shared MCP processor runtime.' } },
      ]);
      expect(await readdir(join(config.projectMemoryDir, 'sessions'))).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      configured.close();
    }
  });
});
