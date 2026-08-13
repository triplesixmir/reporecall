import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createMemoryRecord, serializeMemory, type CreateMemoryInput } from '@reporecall/core';
import { SqliteMemoryIndex } from '../src/index.js';

const roots: string[] = [];

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-index-'));
  roots.push(root);
  await mkdir(join(root, 'memories'), { recursive: true });
  return root;
}

async function writeMemory(root: string, id: string, content: string, overrides: Partial<CreateMemoryInput> = {}) {
  const record = createMemoryRecord(
    {
      content,
      scope: 'project',
      type: 'decision',
      project: { id: 'demo', root, name: 'Demo' },
      tags: [{ name: 'architecture', origin: 'user' }],
      ...overrides,
    },
    { id, now: '2026-08-13T12:00:00.000Z' },
  );
  const path = join(root, 'memories', `${id}.md`);
  await writeFile(path, serializeMemory(record), 'utf8');
  return { path, record };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SqliteMemoryIndex', () => {
  test('rebuilds session checkpoints from the canonical sessions directory', async () => {
    const root = await createFixture();
    const record = createMemoryRecord(
      {
        content: 'Explicit checkpoint should survive an index rebuild.',
        scope: 'session',
        type: 'event',
        source: { kind: 'user', method: 'checkpoint' },
      },
      { id: 'mem_session', now: '2026-08-13T12:00:00.000Z' },
    );
    const path = join(root, 'sessions', 'mem_session.md');
    await mkdir(join(root, 'sessions'), { recursive: true });
    await writeFile(path, serializeMemory(record), 'utf8');

    const index = new SqliteMemoryIndex({ path: join(root, 'index.sqlite') });
    await expect(index.rebuild([{ root, scope: 'session' }])).resolves.toMatchObject({ indexed: 1, invalid: [] });
    await expect(index.search({ query: 'checkpoint', scope: 'session' })).resolves.toHaveLength(1);
    index.close();
  });

  test('rebuilds canonical files and searches FTS with metadata filters', async () => {
    const root = await createFixture();
    await writeMemory(root, 'mem_alpha', 'Canonical Markdown is the durable source of truth.');
    await writeMemory(root, 'mem_beta', 'A different implementation note.', { tags: [] });

    const index = new SqliteMemoryIndex({ path: join(root, 'index.sqlite') });
    const report = await index.rebuild([{ root, scope: 'project' }]);

    expect(report).toMatchObject({ indexed: 2, deleted: 0, invalid: [] });
    const results = await index.search({
      query: 'canonical durable',
      projectId: 'demo',
      type: 'decision',
      tag: 'architecture',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.record.id).toBe('mem_alpha');
    expect(results[0]?.snippet).toContain('Canonical');
    expect(results[0]?.snippet).toContain('Markdown');
    index.close();
  });

  test('updates a manually edited file and removes deleted files incrementally', async () => {
    const root = await createFixture();
    const { path, record } = await writeMemory(root, 'mem_edit', 'Original content.');
    const index = new SqliteMemoryIndex({ path: join(root, 'index.sqlite') });
    await index.rebuild([{ root, scope: 'project' }]);

    const edited = { ...record, content: 'Updated content after a manual edit.', updatedAt: '2026-08-13T13:00:00.000Z' };
    await writeFile(path, serializeMemory(edited), 'utf8');
    await expect(index.update([path])).resolves.toMatchObject({ indexed: 1, deleted: 0, invalid: [] });
    await expect(index.search({ query: 'updated' })).resolves.toHaveLength(1);

    await rm(path);
    await expect(index.update([path])).resolves.toMatchObject({ indexed: 0, deleted: 1, invalid: [] });
    await expect(index.search({ query: 'updated' })).resolves.toHaveLength(0);
    index.close();
  });

  test('records malformed files without replacing the source file', async () => {
    const root = await createFixture();
    const path = join(root, 'memories', 'broken.md');
    const source = '---\nid: broken\n---\nNot a valid record.';
    await writeFile(path, source, 'utf8');
    const index = new SqliteMemoryIndex({ path: join(root, 'index.sqlite') });

    const report = await index.rebuild([{ root, scope: 'project' }]);

    expect(report.indexed).toBe(0);
    expect(report.invalid).toHaveLength(1);
    await expect(readFile(path, 'utf8')).resolves.toBe(source);
    const errors = await index.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe(path);
    expect(errors[0]?.message).toMatch(/invalid memory/i);
    index.close();
  });

  test('can rebuild from scratch after the disposable database is deleted', async () => {
    const root = await createFixture();
    await writeMemory(root, 'mem_rebuild', 'Rebuild this index after deletion.');
    const dbPath = join(root, 'index.sqlite');
    const first = new SqliteMemoryIndex({ path: dbPath });
    await first.rebuild([{ root, scope: 'project' }]);
    first.close();
    await rm(dbPath);

    const second = new SqliteMemoryIndex({ path: dbPath });
    await expect(second.rebuild([{ root, scope: 'project' }])).resolves.toMatchObject({ indexed: 1 });
    await expect(second.search({ query: 'rebuild index' })).resolves.toHaveLength(1);
    second.close();
  });

  test('applies scope, status, and priority metadata filters', async () => {
    const root = await createFixture();
    await writeMemory(root, 'mem_global', 'Shared memory note.', { scope: 'global', priority: 'low' });
    await writeMemory(root, 'mem_critical', 'Project memory note.', { priority: 'critical' });
    await writeMemory(root, 'mem_resolved', 'Resolved memory note.', { status: 'resolved' });
    const index = new SqliteMemoryIndex({ path: join(root, 'index.sqlite') });
    await index.rebuild([{ root, scope: 'project' }]);

    const globalResults = await index.search({ query: 'memory', scope: 'global' });
    expect(globalResults.map(({ record }) => record.id)).toEqual(['mem_global']);
    const criticalResults = await index.search({ query: 'memory', priority: 'critical' });
    expect(criticalResults.map(({ record }) => record.id)).toEqual(['mem_critical']);
    const resolvedResults = await index.search({ query: 'memory', status: 'resolved' });
    expect(resolvedResults.map(({ record }) => record.id)).toEqual(['mem_resolved']);
    index.close();
  });

  test('creates parent directories for an arbitrary SQLite path', async () => {
    const root = await createFixture();
    const index = new SqliteMemoryIndex({ path: join(root, 'nested', 'cache', 'index.sqlite') });

    await expect(index.rebuild([{ root, scope: 'project' }])).resolves.toMatchObject({ indexed: 0 });
    index.close();
  });

  test('uses stable updatedAt and id tie breakers for equal matches', async () => {
    const root = await createFixture();
    await writeMemory(root, 'mem_zeta', 'Same searchable memory.');
    await writeMemory(root, 'mem_alpha', 'Same searchable memory.');
    const index = new SqliteMemoryIndex({ path: join(root, 'index.sqlite') });
    await index.rebuild([{ root, scope: 'project' }]);

    const results = await index.search({ query: 'same searchable' });

    expect(results.map(({ record }) => record.id)).toEqual(['mem_alpha', 'mem_zeta']);
    index.close();
  });
});
