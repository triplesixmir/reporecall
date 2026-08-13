import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createMemoryRecord,
  type ProcessorProviderResult,
  type ProcessorSuggestion,
  type RedactedSessionCapture,
} from '@reporecall/core';
import { FileInboxStore, createMemoryProcessor } from '../src/index.js';
import { FileMemoryStore } from '@reporecall/storage';

const roots: string[] = [];

function capture(
  root: string,
  overrides: Partial<RedactedSessionCapture> = {},
): RedactedSessionCapture {
  return {
    sessionId: 'session-processor',
    capturedAt: '2026-08-13T12:00:00.000Z',
    project: { id: 'demo', root, name: 'Demo' },
    content: 'A redacted session capture.',
    ...overrides,
  };
}

function provider(result: ProcessorProviderResult) {
  return { suggest: () => Promise.resolve(result) };
}

function suggestion(
  root: string,
  overrides: Partial<ProcessorSuggestion> = {},
): ProcessorSuggestion {
  return {
    content: 'Use a rebuildable local index.',
    scope: 'project',
    type: 'decision',
    project: { id: 'demo', root, name: 'Demo' },
    confidence: 0.75,
    ...overrides,
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-processor-'));
  roots.push(root);
  return {
    root,
    memory: new FileMemoryStore({ root, scope: 'project' }),
    inbox: new FileInboxStore({ root }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ConsolidatingMemoryProcessor', () => {
  test('persists explicit records but routes provider suggestions to Inbox in conservative mode', async () => {
    const { root, memory, inbox } = await setup();
    const processor = createMemoryProcessor({
      store: memory,
      inbox,
      provider: provider({ suggestions: [suggestion(root)], warnings: [] }),
      mode: 'conservative',
    });

    const result = await processor.process(
      capture(root, {
        explicit: [{ content: 'Explicit user checkpoint.', scope: 'project', type: 'event' }],
      }),
    );

    expect(result.durable).toHaveLength(1);
    expect(result.durable[0]?.content).toBe('Explicit user checkpoint.');
    expect(result.inbox).toHaveLength(1);
    expect(result.inbox[0]?.status).toBe('pending');
    await expect(memory.list()).resolves.toHaveLength(1);
    await expect(inbox.list()).resolves.toHaveLength(1);
  });

  test('requires explicit opt-in before automatic durable writes', async () => {
    const { root, memory, inbox } = await setup();
    expect(() =>
      createMemoryProcessor({
        store: memory,
        inbox,
        provider: provider({ suggestions: [suggestion(root, { confidence: 0.5 })], warnings: [] }),
        mode: 'automatic',
      }),
    ).toThrow(/automatic/i);

    const processor = createMemoryProcessor({
      store: memory,
      inbox,
      provider: provider({ suggestions: [suggestion(root, { confidence: 0.5 })], warnings: [] }),
      mode: 'automatic',
      allowAutomatic: true,
    });

    const result = await processor.process(capture(root));

    expect(result.durable).toHaveLength(1);
    expect(result.inbox).toHaveLength(0);
    expect((await memory.list())[0]?.source).toMatchObject({ kind: 'processor' });
  });

  test('persists high-confidence suggestions in balanced mode and keeps weaker ones in Inbox', async () => {
    const { root, memory, inbox } = await setup();
    const processor = createMemoryProcessor({
      store: memory,
      inbox,
      provider: provider({
        suggestions: [
          suggestion(root, { content: 'High confidence decision.', confidence: 0.95 }),
          suggestion(root, { content: 'Needs human review.', confidence: 0.5 }),
        ],
        warnings: [],
      }),
      mode: 'balanced',
    });

    const result = await processor.process(capture(root));

    expect(result.durable.map((record) => record.content)).toEqual(['High confidence decision.']);
    expect(result.inbox).toMatchObject([{ suggested: { content: 'Needs human review.' } }]);
  });

  test('keeps processor-suggested relations on durable records', async () => {
    const { root, memory, inbox } = await setup();
    const target = await memory.create({
      content: 'Previous storage decision.',
      scope: 'project',
      type: 'decision',
      project: { id: 'demo', root, name: 'Demo' },
    });
    const processor = createMemoryProcessor({
      store: memory,
      inbox,
      provider: provider({
        suggestions: [
          suggestion(root, {
            content: 'The new decision supersedes the previous one.',
            confidence: 1,
            relations: [{ type: 'supersedes', targetId: target.id }],
          }),
        ],
        warnings: [],
      }),
      mode: 'automatic',
      allowAutomatic: true,
    });

    const result = await processor.process(capture(root));

    expect(result.durable[0]?.relations).toEqual([{ type: 'supersedes', targetId: target.id }]);
  });

  test('uses a deterministic normalized content/type/project duplicate key', async () => {
    const { root, memory, inbox } = await setup();
    const existing = createMemoryRecord(
      {
        content: 'Use a rebuildable local index.',
        scope: 'project',
        type: 'decision',
        project: { id: 'demo', root, name: 'Demo' },
      },
      { id: 'mem_existing', now: '2026-08-13T12:00:00.000Z' },
    );
    const storedExisting = await memory.create(existing);
    const processor = createMemoryProcessor({
      store: memory,
      inbox,
      provider: provider({
        suggestions: [
          suggestion(root, {
            content: '  USE a rebuildable\u00a0local index!!! ',
            confidence: 1,
          }),
        ],
        warnings: [],
      }),
      mode: 'automatic',
      allowAutomatic: true,
    });

    const result = await processor.process(capture(root));

    expect(result.durable).toEqual([]);
    expect(result.duplicates).toMatchObject([{ existing: { id: storedExisting.id } }]);
    expect(result.inbox[0]).toMatchObject({ duplicateOf: storedExisting.id, status: 'pending' });
    await expect(memory.list()).resolves.toHaveLength(1);
  });

  test('redacts capture and suggestion secrets and refuses secret-only durable writes', async () => {
    const { root, memory, inbox } = await setup();
    let providerCapture: RedactedSessionCapture | undefined;
    const processor = createMemoryProcessor({
      store: memory,
      inbox,
      provider: {
        suggest: (nextCapture) => {
          providerCapture = nextCapture;
          return Promise.resolve({
            suggestions: [suggestion(root, { content: 'sk-proj-1234567890abcdef' })],
            warnings: [],
          });
        },
      },
      mode: 'automatic',
      allowAutomatic: true,
    });

    const result = await processor.process(
      capture(root, { content: 'Keep this note. token=sk-proj-1234567890abcdef' }),
    );

    expect(providerCapture?.content).toContain('[REDACTED api-key]');
    expect(result.durable).toEqual([]);
    expect(result.inbox).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/secret/i);
    await expect(memory.list()).resolves.toHaveLength(0);
    await expect(inbox.list()).resolves.toHaveLength(0);
  });
});
