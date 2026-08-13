import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ProcessorSuggestion } from '@reporecall/core';
import { FileInboxStore } from '../src/index.js';

const roots: string[] = [];

function suggestion(root: string): ProcessorSuggestion {
  return {
    content: 'Use Markdown files as the durable source of truth.',
    scope: 'project',
    type: 'decision',
    priority: 'high',
    tags: [{ name: 'architecture', origin: 'ai', confidence: 0.92 }],
    project: { id: 'demo', root, name: 'Demo' },
    confidence: 0.92,
    reason: 'The session explicitly settled the storage boundary.',
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileInboxStore', () => {
  test('round-trips a pending suggestion as canonical Markdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reporecall-inbox-'));
    roots.push(root);
    const store = new FileInboxStore({ root });

    const item = await store.create({
      suggested: suggestion(root),
      source: { kind: 'processor', provider: 'agent-native', method: 'consolidation' },
      reason: 'Review before making this durable.',
    });

    const path = join(root, 'inbox', `${item.id}.md`);
    await expect(readFile(path, 'utf8')).resolves.toContain(
      'Use Markdown files as the durable source of truth.',
    );
    await expect(readFile(path, 'utf8')).resolves.toContain('status: pending');
    await expect(store.get(item.id)).resolves.toEqual(item);
    await expect(store.list({ status: 'pending' })).resolves.toEqual([item]);
  });

  test('updates review status without changing the suggestion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reporecall-inbox-status-'));
    roots.push(root);
    const store = new FileInboxStore({ root });
    const item = await store.create({ suggested: suggestion(root) });

    const dismissed = await store.update(item.id, { status: 'dismissed' });

    expect(dismissed).toMatchObject({
      id: item.id,
      status: 'dismissed',
      suggested: item.suggested,
    });
    await expect(store.list({ status: 'pending' })).resolves.toEqual([]);
    await expect(store.list({ status: 'dismissed' })).resolves.toEqual([dismissed]);
  });

  test('reports malformed inbox files and preserves them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reporecall-inbox-invalid-'));
    roots.push(root);
    const store = new FileInboxStore({ root });
    const inboxRoot = join(root, 'inbox');
    await mkdir(inboxRoot, { recursive: true });
    await writeFile(
      join(inboxRoot, 'inbox_broken.md'),
      '---\nid: inbox_broken\n---\nNot valid.',
      'utf8',
    );

    const report = await store.validateAll();

    expect(report.valid).toBe(0);
    expect(report.invalid).toHaveLength(1);
    expect(report.invalid[0]?.path).toContain('inbox_broken.md');
    await expect(readdir(inboxRoot)).resolves.toContain('inbox_broken.md');
    await expect(readFile(join(inboxRoot, 'inbox_broken.md'), 'utf8')).resolves.toContain(
      'Not valid.',
    );
  });
});
