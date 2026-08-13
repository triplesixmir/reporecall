import { describe, expect, test } from 'vitest';
import {
  createMemoryRecord,
  memoryRecordSchema,
  migrateMemoryRecord,
  type CreateMemoryInput,
} from '../src/index.js';

const input: CreateMemoryInput = {
  content: 'Markdown files are the durable source of truth.',
  scope: 'project',
  type: 'decision',
  priority: 'high',
  project: { id: 'reporecall', root: '/tmp/RepoRecall', name: 'RepoRecall' },
  tags: [{ name: 'architecture', origin: 'user' }],
};

describe('memory schema', () => {
  test('creates a complete versioned memory record with safe defaults', () => {
    const record = createMemoryRecord(input, { now: '2026-08-13T12:00:00.000Z', id: 'mem_test' });

    expect(record).toMatchObject({
      schema: 1,
      id: 'mem_test',
      scope: 'project',
      type: 'decision',
      priority: 'high',
      status: 'active',
      pinned: false,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
      confidence: 1,
    });
    expect(memoryRecordSchema.parse(record)).toEqual(record);
  });

  test('rejects confidence outside the inclusive range', () => {
    const result = memoryRecordSchema.safeParse({
      ...createMemoryRecord(input, { id: 'mem_test' }),
      confidence: 1.1,
    });

    expect(result.success).toBe(false);
  });

  test('does not allow AI metadata to erase user tag origin', () => {
    const result = memoryRecordSchema.safeParse({
      ...createMemoryRecord(input, { id: 'mem_test' }),
      tags: [{ name: 'architecture', origin: 'ai', confidence: 0.9 }],
    });

    expect(result.success).toBe(true);
  });

  test('forward-migrates a sparse legacy record with safe defaults', () => {
    const original = createMemoryRecord(input, { id: 'mem_test' });
    const updated = original;
    const result = migrateMemoryRecord({
      schema: 0,
      id: updated.id,
      scope: updated.scope,
      type: updated.type,
      content: updated.content,
    }, { now: '2026-08-13T12:00:00.000Z' });

    expect(result).toMatchObject({ migrated: true, fromSchema: 0 });
    expect(result.record).toMatchObject({
      schema: 1,
      id: 'mem_test',
      priority: 'normal',
      status: 'active',
      pinned: false,
      createdAt: '2026-08-13T12:00:00.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
    });
  });

  test('rejects records from a future schema version', () => {
    expect(() => migrateMemoryRecord({ schema: 2 })).toThrow(/newer than supported/i);
  });
});
