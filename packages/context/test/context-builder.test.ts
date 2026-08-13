import { describe, expect, test } from 'vitest';
import { DeterministicContextBuilder } from '../src/index.js';
import type { ContextRequest, MemoryRecord, SearchResult } from '@reporecall/core';

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    schema: 1,
    id: 'mem_default',
    scope: 'project',
    type: 'fact',
    priority: 'normal',
    status: 'active',
    pinned: false,
    createdAt: '2026-08-01T12:00:00.000Z',
    updatedAt: '2026-08-01T12:00:00.000Z',
    tags: [],
    relations: [],
    content: 'A concise memory sentence.',
    ...overrides,
  };
}

function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return { tokenBudget: 40, project: { id: 'demo', root: '/demo' }, ...overrides };
}

function fakeIndex(results: SearchResult[]) {
  return { search: () => Promise.resolve(results) };
}

describe('DeterministicContextBuilder', () => {
  test('excludes archived, dismissed, and superseded memories', async () => {
    const builder = new DeterministicContextBuilder(
      fakeIndex([
        { record: record({ id: 'mem_active' }), snippet: 'active', score: 1 },
        { record: record({ id: 'mem_archived', status: 'archived' }), snippet: 'archived', score: 1 },
        { record: record({ id: 'mem_dismissed', status: 'dismissed' }), snippet: 'dismissed', score: 1 },
        { record: record({ id: 'mem_superseded', status: 'superseded' }), snippet: 'superseded', score: 1 },
      ]),
      { now: '2026-08-13T12:00:00.000Z' },
    );

    const bundle = await builder.build(request());

    expect(bundle.items.map(({ record: item }) => item.id)).toEqual(['mem_active']);
  });

  test('puts pinned and current-project memories first', async () => {
    const builder = new DeterministicContextBuilder(
      fakeIndex([
        { record: record({ id: 'mem_other', project: { id: 'other', root: '/other' }, priority: 'critical' }), snippet: 'other', score: 1 },
        { record: record({ id: 'mem_current', priority: 'normal', project: { id: 'demo', root: '/demo' } }), snippet: 'current', score: 0 },
        { record: record({ id: 'mem_pinned', pinned: true, project: { id: 'other', root: '/other' } }), snippet: 'pinned', score: 0 },
      ]),
      { now: '2026-08-13T12:00:00.000Z' },
    );

    const bundle = await builder.build(request({ tokenBudget: 100 }));

    expect(bundle.items.slice(0, 2).map(({ record: item }) => item.id)).toEqual(['mem_pinned', 'mem_current']);
  });

  test('caps each excerpt at 25 percent of the budget and respects sentence boundaries', async () => {
    const builder = new DeterministicContextBuilder(
      fakeIndex([
        {
          record: record({ id: 'mem_long', content: 'First short sentence. Second sentence should be omitted because it is too long.' }),
          snippet: 'long',
          score: 1,
        },
      ]),
      { now: '2026-08-13T12:00:00.000Z' },
    );

    const bundle = await builder.build(request({ tokenBudget: 24 }));

    expect(bundle.items[0]?.estimatedTokens).toBeLessThanOrEqual(6);
    expect(bundle.estimatedTokens).toBeLessThanOrEqual(24);
    expect(bundle.items[0]?.excerpt).toBe('First short sentence.');
  });

  test('uses updatedAt and stable id as deterministic tie breakers', async () => {
    const builder = new DeterministicContextBuilder(
      fakeIndex([
        { record: record({ id: 'mem_zeta', updatedAt: '2026-08-10T12:00:00.000Z' }), snippet: 'zeta', score: 1 },
        { record: record({ id: 'mem_alpha', updatedAt: '2026-08-10T12:00:00.000Z' }), snippet: 'alpha', score: 1 },
        { record: record({ id: 'mem_recent', updatedAt: '2026-08-11T12:00:00.000Z' }), snippet: 'recent', score: 1 },
      ]),
      { now: '2026-08-13T12:00:00.000Z' },
    );

    const first = await builder.build(request({ tokenBudget: 100 }));
    const second = await builder.build(request({ tokenBudget: 100 }));

    expect(first.items.map(({ record: item }) => item.id)).toEqual(['mem_recent', 'mem_alpha', 'mem_zeta']);
    expect(second).toEqual(first);
  });
});
