import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FileMemoryStore } from '../src/index.js';

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-store-'));
  await mkdir(join(root, 'memories'), { recursive: true });
  return { root, store: new FileMemoryStore({ root, scope: 'project' }) };
}

describe('FileMemoryStore', () => {
  test('stores durable session checkpoints in the sessions directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reporecall-session-store-'));
    const store = new FileMemoryStore({ root, scope: 'session' });
    const record = await store.create({
      content: 'Explicit checkpoint only.',
      scope: 'session',
      type: 'event',
      source: { kind: 'user', method: 'checkpoint' },
    });

    await expect(readFile(join(root, 'sessions', `${record.id}.md`), 'utf8')).resolves.toContain('Explicit checkpoint only.');
    await expect(readdir(join(root, 'memories'))).rejects.toThrow();
  });

  test('creates and lists an inspectable Markdown memory file', async () => {
    const { root, store } = await createStore();

    const record = await store.create({
      content: 'Keep canonical memory in Markdown.',
      scope: 'project',
      type: 'decision',
      project: { id: 'demo', root: root, name: 'Demo' },
      tags: [{ name: 'architecture', origin: 'user' }],
    });

    const source = await readFile(join(root, 'memories', `${record.id}.md`), 'utf8');
    expect(source).toContain('schema: 1');
    expect(source).toContain('Keep canonical memory in Markdown.');
    await expect(store.get(record.id)).resolves.toEqual(record);
    await expect(store.list()).resolves.toEqual([record]);
  });

  test('preserves user tags when an AI update includes the same tag', async () => {
    const { store } = await createStore();
    const record = await store.create({
      content: 'Never silently remove user tags.',
      scope: 'project',
      type: 'constraint',
      tags: [{ name: 'security', origin: 'user' }],
    });

    const updated = await store.update(record.id, {
      tags: [
        { name: 'security', origin: 'ai', confidence: 0.5 },
        { name: 'privacy', origin: 'ai', confidence: 0.8 },
      ],
    }, { actor: 'processor' });

    expect(updated.tags).toEqual([
      { name: 'security', origin: 'user' },
      { name: 'privacy', origin: 'ai', confidence: 0.8 },
    ]);
  });

  test('reports malformed files and leaves them untouched', async () => {
    const { root, store } = await createStore();
    await writeFile(join(root, 'broken.md'), '---\nid: broken\n---\nnot a memory', 'utf8');
    await writeFile(join(root, 'memories', 'broken.md'), '---\nid: broken\n---\nnot a memory', 'utf8');

    const report = await store.validateAll();

    expect(report.valid).toBe(0);
    expect(report.invalid).toHaveLength(1);
    expect(report.invalid[0]?.path).toContain('broken.md');
    await expect(readFile(join(root, 'memories', 'broken.md'), 'utf8')).resolves.toContain('not a memory');
  });

  test('removes a memory from the canonical directory', async () => {
    const { root, store } = await createStore();
    const record = await store.create({
      content: 'Temporary note.',
      scope: 'project',
      type: 'event',
    });

    await store.remove(record.id);

    await expect(store.get(record.id)).resolves.toBeNull();
    await expect(readFile(join(root, 'memories', `${record.id}.md`), 'utf8')).rejects.toThrow();
  });

  test('backs up and rewrites legacy files during an explicit migration', async () => {
    const { root, store } = await createStore();
    const legacyPath = join(root, 'memories', 'mem_legacy.md');
    await writeFile(
      legacyPath,
      '---\nschema: 0\nid: mem_legacy\nscope: project\ntype: fact\n---\n\nLegacy memory.',
      'utf8',
    );

    const report = await store.migrateAll({ now: '2026-08-13T12:00:00.000Z' });

    expect(report.migrated).toBe(1);
    expect(report.invalid).toHaveLength(0);
    expect(report.backups).toHaveLength(1);
    await expect(readFile(legacyPath, 'utf8')).resolves.toContain('schema: 1');
    await expect(readFile(report.backups[0] ?? '', 'utf8')).resolves.toContain('schema: 0');
    await expect(store.get('mem_legacy')).resolves.toMatchObject({
      schema: 1,
      content: 'Legacy memory.',
      createdAt: '2026-08-13T12:00:00.000Z',
    });
    await expect(readdir(join(root, 'memories'))).resolves.toContainEqual(expect.stringMatching(/\.bak\./));
  });
});
