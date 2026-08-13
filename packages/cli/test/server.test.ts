import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RepoRecallConfig } from '../src/config.js';
import {
  createApiApp,
  createDebouncedIndexer,
  createMemoryWatcher,
  createServeRuntime,
  startServe,
  type ServeRuntime,
} from '../src/server.js';
import { FileInboxStore } from '@reporecall/processors';

const roots: string[] = [];
const runtimes: ServeRuntime[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-api-'));
  roots.push(root);
  const config: RepoRecallConfig = {
    brainPath: join(root, 'brain'),
    projectMemoryDir: join(root, 'project', '.reporecall'),
    indexPath: join(root, 'cache', 'index.sqlite'),
    port: 0,
    ignoredPaths: [],
    processor: 'disabled',
    processorMode: 'conservative',
    sources: [],
  };
  const runtime = createServeRuntime(config);
  runtimes.push(runtime);
  await runtime.rebuild();
  return { root, config, runtime, app: createApiApp(runtime) };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RepoRecall local API', () => {
  test('supports memory CRUD, recent records, and health without opening TCP', async () => {
    const { app } = await fixture();

    await expect(app.request('/api/health')).resolves.toMatchObject({ status: 200 });
    const createdResponse = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'API-created decision.',
        type: 'decision',
        priority: 'high',
        tags: ['api'],
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await json<{ memory: { id: string; content: string } }>(createdResponse);
    expect(created.memory.content).toBe('API-created decision.');

    const listedResponse = await app.request('/api/memories?type=decision&tag=api');
    expect(listedResponse.status).toBe(200);
    expect(await json<{ count: number }>(listedResponse)).toMatchObject({ count: 1 });

    const updatedResponse = await app.request(`/api/memories/${created.memory.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Updated API decision.', status: 'resolved' }),
    });
    expect(updatedResponse.status).toBe(200);
    expect(
      await json<{ memory: { content: string; status: string } }>(updatedResponse),
    ).toMatchObject({
      memory: { content: 'Updated API decision.', status: 'resolved' },
    });

    const recentResponse = await app.request('/api/recent?limit=5');
    expect(await json<{ records: Array<{ id: string }> }>(recentResponse)).toMatchObject({
      records: [{ id: created.memory.id }],
    });

    const deletedResponse = await app.request(`/api/memories/${created.memory.id}`, {
      method: 'DELETE',
    });
    expect(deletedResponse.status).toBe(200);
    expect(await app.request(`/api/memories/${created.memory.id}`)).toMatchObject({ status: 404 });
  });

  test('redacts secrets before writing and relocates scope changes', async () => {
    const { app } = await fixture();
    const response = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Keep sk-test-abcdefghijklmnop private.', type: 'fact' }),
    });
    expect(response.status).toBe(201);
    const created = await json<{
      memory: { id: string; content: string; scope: string };
      warnings: string[];
    }>(response);
    expect(created.memory).toMatchObject({ scope: 'project' });
    expect(created.memory.content).toContain('[REDACTED api-key]');
    expect(created.warnings).toHaveLength(1);

    const moved = await app.request(`/api/memories/${created.memory.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'session' }),
    });
    expect(moved.status).toBe(200);
    expect(await json<{ memory: { scope: string } }>(moved)).toMatchObject({
      memory: { scope: 'session' },
    });
    expect(
      await json<{ count: number }>(await app.request('/api/memories?scope=session')),
    ).toMatchObject({
      count: 1,
    });

    const blocked = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'sk-test-abcdefghijklmnop' }),
    });
    expect(blocked.status).toBe(400);
  });

  test('serves overview, projects, tags, search, and relation graph data', async () => {
    const { app, runtime } = await fixture();
    const project = { id: 'demo', root: '/tmp/demo', name: 'Demo' };
    const first = await runtime.stores.project.create({
      content: 'Canonical Markdown is the source of truth.',
      scope: 'project',
      type: 'decision',
      project,
      tags: [{ name: 'architecture', origin: 'user' }],
    });
    await runtime.stores.project.create({
      content: 'SQLite remains a disposable cache.',
      scope: 'project',
      type: 'constraint',
      project,
      relations: [{ type: 'related_to', targetId: first.id }],
      tags: [{ name: 'architecture', origin: 'ai', confidence: 0.8 }],
    });
    await runtime.rebuild();

    const search = await app.request('/api/memories?query=disposable');
    expect(await json<{ count: number }>(search)).toMatchObject({ count: 1 });
    const overview = await json<{ memoryCount: number; projectCount: number; tagCount: number }>(
      await app.request('/api/overview'),
    );
    expect(overview).toMatchObject({ memoryCount: 2, projectCount: 1, tagCount: 1 });
    expect(
      await json<{ projects: Array<{ id: string }> }>(await app.request('/api/projects')),
    ).toMatchObject({
      projects: [{ id: 'demo' }],
    });
    expect(
      await json<{ tags: Array<{ name: string; count: number }> }>(await app.request('/api/tags')),
    ).toMatchObject({
      tags: [{ name: 'architecture', count: 2 }],
    });
    const graph = await json<{ nodes: Array<{ id: string }>; edges: Array<{ target: string }> }>(
      await app.request('/api/graph'),
    );
    expect(graph.nodes.some((node) => node.id === first.id)).toBe(true);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ target: first.id, type: 'related_to' });
  });

  test('lists Inbox and accepts or dismisses suggestions with user choices', async () => {
    const { app, root } = await fixture();
    const inbox = new FileInboxStore({ root: join(root, 'project', '.reporecall') });
    const accepted = await inbox.create({
      suggested: {
        content: 'Accepted processor suggestion.',
        scope: 'project',
        type: 'decision',
        priority: 'normal',
        project: { id: 'demo', root: '/tmp/demo', name: 'Demo' },
        tags: [{ name: 'ai-tag', origin: 'ai', confidence: 0.7 }],
      },
    });
    const dismissed = await inbox.create({
      suggested: { content: 'Dismissed processor suggestion.', scope: 'project', type: 'fact' },
    });

    expect(await json<{ count: number }>(await app.request('/api/inbox'))).toMatchObject({
      count: 2,
    });
    const acceptedResponse = await app.request(`/api/inbox/${accepted.id}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'global', priority: 'high', tags: ['confirmed'] }),
    });
    expect(acceptedResponse.status).toBe(201);
    expect(
      await json<{ memory: { scope: string; priority: string; content: string } }>(
        acceptedResponse,
      ),
    ).toMatchObject({
      memory: { scope: 'global', priority: 'high', content: 'Accepted processor suggestion.' },
    });

    const dismissedResponse = await app.request(`/api/inbox/${dismissed.id}/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Not durable.' }),
    });
    expect(dismissedResponse.status).toBe(200);
    expect(
      await json<{ item: { status: string; reason: string } }>(dismissedResponse),
    ).toMatchObject({
      item: { status: 'dismissed', reason: 'Not durable.' },
    });
    expect(await json<{ count: number }>(await app.request('/api/inbox'))).toMatchObject({
      count: 0,
    });
  });
});

describe('filesystem indexing helpers', () => {
  test('debounces multiple file changes into one incremental index update', async () => {
    const updates: string[][] = [];
    const debounced = createDebouncedIndexer((paths) => {
      updates.push(paths);
      return Promise.resolve();
    }, 10);

    debounced.schedule(['/tmp/a.md']);
    debounced.schedule(['/tmp/b.md', '/tmp/a.md']);
    await debounced.flush();

    expect(updates).toEqual([['/tmp/a.md', '/tmp/b.md']]);
    await debounced.close();
  });

  test('watches canonical Markdown edits and deletions', async () => {
    const { runtime } = await fixture();
    const record = await runtime.stores.project.create({
      content: 'The original watcher value.',
      scope: 'project',
      type: 'fact',
    });
    await runtime.rebuild();
    const watcher = await createMemoryWatcher({
      sources: runtime.sources,
      debounceMs: 10,
      onPaths: (paths) => runtime.update(paths).then(() => undefined),
    });

    try {
      await runtime.stores.project.update(record.id, {
        content: 'The manually edited watcher value.',
      });
      await expect
        .poll(async () => (await runtime.index.search({ query: 'manually edited' })).length, {
          timeout: 1_000,
        })
        .toBe(1);

      await runtime.stores.project.remove(record.id);
      await expect
        .poll(async () => (await runtime.index.search({ query: 'manually edited' })).length, {
          timeout: 1_000,
        })
        .toBe(0);
    } finally {
      await watcher.close();
    }
  });
});

describe('loopback serve smoke', () => {
  test('serves the health endpoint over loopback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reporecall-serve-smoke-'));
    roots.push(root);
    const config: RepoRecallConfig = {
      brainPath: join(root, 'brain'),
      projectMemoryDir: join(root, 'project', '.reporecall'),
      indexPath: join(root, 'cache', 'index.sqlite'),
      port: 0,
      ignoredPaths: [],
      processor: 'disabled',
      processorMode: 'conservative',
      sources: [],
    };
    const handle = await startServe(config, { watch: false });
    try {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok' });
    } finally {
      await handle.close();
    }
  });
});
