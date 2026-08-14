import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, test } from 'vitest';
import { DeterministicContextBuilder } from '@reporecall/context';
import { runCodexHook, type HookIO } from '@reporecall/integrations';
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

  test('automatically persists a candidate and recalls it through SessionStart context', async () => {
    const { root, config } = await fixture();
    const configured = createMcpRuntime(config);
    const server = createMemoryMcpServer(configured.runtime);
    const client = new Client({ name: 'reporecall-cli-auto-capture-test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      const projectRoot = join(root, 'project');
      await configured.index.rebuild([
        { root: config.brainPath, scope: 'global' },
        {
          root: config.projectMemoryDir,
          scope: 'project',
          project: { id: 'demo', root: projectRoot },
        },
        {
          root: config.projectMemoryDir,
          scope: 'session',
          project: { id: 'demo', root: projectRoot },
        },
      ]);
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const result = await client.callTool({
        name: 'memory_auto_capture',
        arguments: {
          content: 'Completed the automatic memory integration.',
          sessionId: 'session-auto-2',
          projectId: 'demo',
          projectRoot,
          memories: [
            {
              content: 'The CLI runtime persists agent-native decisions.',
              scope: 'project',
              type: 'decision',
              priority: 'high',
            },
          ],
        },
      });
      const data = result.structuredContent as {
        durable: Array<{ id: string; content: string }>;
      };
      expect(data.durable).toEqual([
        expect.objectContaining({ content: 'The CLI runtime persists agent-native decisions.' }),
      ]);
      const durableId = data.durable[0]?.id;
      expect(durableId).toBeDefined();
      await expect(
        readFile(join(config.projectMemoryDir, 'memories', `${durableId}.md`), 'utf8'),
      ).resolves.toContain('The CLI runtime persists agent-native decisions.');

      const output: string[] = [];
      const errors: string[] = [];
      const io: HookIO = {
        stdout: (value) => output.push(value),
        stderr: (value) => errors.push(value),
      };
      await expect(
        runCodexHook(
          { hook_event_name: 'SessionStart', session_id: 'session-auto-2', cwd: projectRoot },
          {
            contextBuilder: new DeterministicContextBuilder(configured.index),
            projectRoot,
            projectId: 'demo',
            tokenBudget: 500,
          },
          io,
        ),
      ).resolves.toBe(0);
      expect(errors).toEqual([]);
      expect(output.join(' ')).toContain('The CLI runtime persists agent-native decisions.');

      await expect(
        runCodexHook(
          {
            hook_event_name: 'SessionEnd',
            session_id: 'session-auto-2',
            cwd: projectRoot,
            transcript_path: '/private/raw-transcript-with-sk-proj-1234567890abcdef',
          },
          { runtimeRoot: config.projectMemoryDir },
          io,
        ),
      ).resolves.toBe(0);
      const marker = await readFile(
        join(config.projectMemoryDir, 'runtime', 'session-events.jsonl'),
        'utf8',
      );
      expect(marker).toContain('session-auto-2');
      expect(marker).not.toContain('raw-transcript');
      expect(marker).not.toContain('sk-proj-1234567890abcdef');
    } finally {
      await client.close();
      await server.close();
      configured.close();
    }
  });
});
