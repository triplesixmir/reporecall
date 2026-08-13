import { describe, expect, test } from 'vitest';
import { createMemoryRecord, parseMemoryFile, serializeMemory, type CreateMemoryInput } from '../src/index.js';

const input: CreateMemoryInput = {
  content: 'Use `git pull` to synchronize project memory.\n\nНе хранить секреты.',
  scope: 'project',
  type: 'constraint',
  priority: 'critical',
  tags: [
    { name: 'security', origin: 'user' },
    { name: 'git', origin: 'ai', confidence: 0.91 },
  ],
};

describe('memory Markdown serialization', () => {
  test('round-trips YAML frontmatter and Markdown content', () => {
    const original = createMemoryRecord(input, {
      id: 'mem_roundtrip',
      now: '2026-08-13T12:00:00.000Z',
    });

    const parsed = parseMemoryFile(serializeMemory(original), 'mem_roundtrip.md');

    expect(parsed).toEqual(original);
  });

  test('reports malformed frontmatter without silently accepting it', () => {
    expect(() => parseMemoryFile('---\nid: missing-required-fields\n---\nText', 'broken.md')).toThrow(
      /invalid memory/i,
    );
  });

  test('forward-migrates a schema-0 file while preserving its Markdown body', () => {
    const migrated = parseMemoryFile(
      '---\nschema: 0\nid: mem_legacy\nscope: project\ntype: fact\n---\n\nLegacy body with Unicode: память.',
      'legacy.md',
    );

    expect(migrated).toMatchObject({
      schema: 1,
      id: 'mem_legacy',
      priority: 'normal',
      content: 'Legacy body with Unicode: память.',
    });
  });
});
