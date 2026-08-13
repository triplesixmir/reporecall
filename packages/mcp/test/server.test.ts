import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, test } from 'vitest';
import { DeterministicContextBuilder } from '@reporecall/context';
import { SqliteMemoryIndex } from '@reporecall/index';
import { FileMemoryStore } from '@reporecall/storage';
import { createMemoryMcpServer, type MemoryMcpRuntime } from '../src/index.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-mcp-'));
  roots.push(root);
  return { root, project: join(root, 'project') };
}

async function connectedRuntime(): Promise<{
  runtime: MemoryMcpRuntime;
  client: Client;
  index: SqliteMemoryIndex;
  root: string;
  close: () => Promise<void>;
  project: string;
}> {
  const { root, project } = await fixture();
  const store = new FileMemoryStore({ root, scope: 'project' });
  const sessionStore = new FileMemoryStore({ root, scope: 'session' });
  const index = new SqliteMemoryIndex({ path: join(root, 'index.sqlite') });
  const contextBuilder = new DeterministicContextBuilder(index, { now: '2026-08-13T10:00:00.000Z' });
  const runtime: MemoryMcpRuntime = {
    store,
    stores: { session: sessionStore },
    index,
    contextBuilder,
    afterWrite: async (record) => index.update([join(root, record.scope === 'session' ? 'sessions' : 'memories', `${record.id}.md`)]),
    listInbox: () => Promise.resolve([]),
  };
  const server = createMemoryMcpServer(runtime);
  const client = new Client({ name: 'reporecall-test-client', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    runtime,
    client,
    index,
    root,
    project,
    close: async () => {
      await client.close();
      await server.close();
      index.close();
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RepoRecall MCP server', () => {
  test('exposes the memory tools and returns structured search results', async () => {
    const connection = await connectedRuntime();
    try {
      const tools = await connection.client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'memory_checkpoint',
        'memory_get_context',
        'memory_get_recent',
        'memory_remember',
        'memory_resolve',
        'memory_review_inbox',
        'memory_search',
        'memory_update',
      ]);

      const created = await connection.runtime.store.create({
        content: 'The MCP server must keep Markdown as the durable source of truth.',
        scope: 'project',
        type: 'decision',
        priority: 'high',
        pinned: true,
        tags: [{ name: 'architecture', origin: 'user' }],
      });
      await connection.index.update([join(connection.root, 'memories', `${created.id}.md`)]);

      const result = await connection.client.callTool({
        name: 'memory_search',
        arguments: { query: 'durable source of truth' },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        results: [{ record: { id: created.id, content: created.content } }],
      });
      expect(result.content[0]).toMatchObject({ type: 'text' });
      expect((result.content[0] as { text: string }).text).toMatch(/found 1/i);
    } finally {
      await connection.close();
    }
  });

  test('writes, updates, resolves, checkpoints, and refreshes the index', async () => {
    const connection = await connectedRuntime();
    try {
      const remembered = await connection.client.callTool({
        name: 'memory_remember',
        arguments: {
          content: 'Use the local index only as a disposable cache.',
          type: 'fact',
          tags: [{ name: 'agent-suggestion', origin: 'user' }],
        },
      });
      const rememberedData = remembered.structuredContent as { record: { id: string; tags: Array<{ origin: string }> } };
      expect(rememberedData.record.tags).toEqual([{ name: 'agent-suggestion', origin: 'ai' }]);

      const userRecord = await connection.runtime.store.create({
        content: 'User-owned preference.',
        scope: 'project',
        type: 'preference',
        tags: [{ name: 'user-owned', origin: 'user' }],
      });
      await connection.index.update([join(connection.root, 'memories', `${userRecord.id}.md`)]);

      const updated = await connection.client.callTool({
        name: 'memory_update',
        arguments: {
          id: userRecord.id,
          content: 'Updated preference with a related agent label.',
          tags: [{ name: 'agent-label', origin: 'ai' }],
        },
      });
      expect(updated.structuredContent).toMatchObject({
        record: {
          id: userRecord.id,
          status: 'active',
          tags: [
            { name: 'user-owned', origin: 'user' },
            { name: 'agent-label', origin: 'ai' },
          ],
        },
      });

      const resolved = await connection.client.callTool({
        name: 'memory_resolve',
        arguments: { id: userRecord.id },
      });
      expect(resolved.structuredContent).toMatchObject({ record: { id: userRecord.id, status: 'resolved' } });

      const checkpoint = await connection.client.callTool({
        name: 'memory_checkpoint',
        arguments: { content: 'Explicit session checkpoint.', projectId: 'demo-project', projectRoot: connection.project },
      });
      expect(checkpoint.structuredContent).toMatchObject({
        record: { type: 'event', scope: 'session', content: 'Explicit session checkpoint.' },
      });
      const checkpointId = (checkpoint.structuredContent as { record: { id: string } }).record.id;
      await expect(readFile(join(connection.root, 'sessions', `${checkpointId}.md`), 'utf8')).resolves.toContain(
        'Explicit session checkpoint.',
      );

      const recent = await connection.client.callTool({ name: 'memory_get_recent', arguments: { limit: 10 } });
      expect(recent.structuredContent).toMatchObject({ count: 3 });
      const context = await connection.client.callTool({
        name: 'memory_get_context',
        arguments: { tokenBudget: 400, projectId: 'demo-project', projectRoot: connection.project },
      });
      const contextData = context.structuredContent as { bundle?: { items?: unknown } } | undefined;
      expect(Array.isArray(contextData?.bundle?.items)).toBe(true);
      const inbox = await connection.client.callTool({ name: 'memory_review_inbox', arguments: {} });
      expect(inbox.structuredContent).toEqual({ items: [], count: 0 });

      const indexed = await connection.runtime.index.search({ query: 'disposable cache' });
      expect(indexed[0]?.record.content).toContain('disposable cache');
    } finally {
      await connection.close();
    }
  });

  test('redacts secrets and rejects secret-only writes', async () => {
    const connection = await connectedRuntime();
    try {
      const warning = await connection.client.callTool({
        name: 'memory_remember',
        arguments: { content: 'Keep this note, token=sk-proj-1234567890abcdef.' },
      });
      expect(warning.structuredContent).toMatchObject({ record: { content: 'Keep this note, token=[REDACTED api-key].' } });

      const blocked = await connection.client.callTool({
        name: 'memory_remember',
        arguments: { content: 'sk-proj-1234567890abcdef' },
      });
      expect(blocked.isError).toBe(true);
      expect(await connection.runtime.store.list()).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  test('does not create a durable session summary implicitly', async () => {
    const connection = await connectedRuntime();
    try {
      const before = await connection.runtime.store.list();
      expect(before).toHaveLength(0);
      const result = await connection.client.callTool({ name: 'memory_get_recent', arguments: { limit: 10 } });
      expect(result.structuredContent).toEqual({ records: [], count: 0 });
      expect(await connection.runtime.store.list()).toHaveLength(0);
      await expect(readFile(join(connection.root, 'sessions', 'session.md'), 'utf8')).rejects.toThrow();
    } finally {
      await connection.close();
    }
  });
});
