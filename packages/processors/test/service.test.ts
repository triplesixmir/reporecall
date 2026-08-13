import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { MemoryRecord } from '@reporecall/core';
import { FileMemoryStore } from '@reporecall/storage';
import { FileInboxStore, createMemoryProcessingService } from '../src/index.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-processing-service-'));
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

describe('MemoryProcessingService', () => {
  test('returns provider and mode metadata and refreshes durable records', async () => {
    const { memory, inbox } = await fixture();
    const refreshed: MemoryRecord[] = [];
    const service = createMemoryProcessingService({
      store: memory,
      stores: { project: memory },
      inbox,
      providerKind: 'agent-native',
      mode: 'balanced',
      afterDurable: (record) => {
        refreshed.push(record);
        return Promise.resolve();
      },
    });

    const result = await service.process({
      content: 'Decision: keep Markdown canonical.',
      project: { id: 'demo', root: '/tmp/demo', name: 'Demo' },
    });

    expect(result).toMatchObject({ provider: 'agent-native', mode: 'balanced' });
    expect(result.durable).toHaveLength(1);
    expect(refreshed.map((record) => record.id)).toEqual([result.durable[0]?.id]);
  });

  test('does not allow automatic mode without per-call opt-in', async () => {
    const { memory, inbox } = await fixture();
    const service = createMemoryProcessingService({
      store: memory,
      inbox,
      providerKind: 'agent-native',
      mode: 'automatic',
    });

    await expect(
      service.process({ content: 'Decision: this requires approval.' }),
    ).rejects.toThrow(/automatic.*allow/i);
    await expect(
      service.process(
        { content: 'Decision: this is explicitly approved.' },
        { allowAutomatic: true },
      ),
    ).resolves.toMatchObject({ durable: [{ content: 'this is explicitly approved.' }] });
  });

  test('reports redaction without exposing the original secret', async () => {
    const { memory, inbox } = await fixture();
    const service = createMemoryProcessingService({
      store: memory,
      inbox,
      providerKind: 'agent-native',
    });

    const result = await service.process({
      content: 'Keep this private. token=sk-proj-1234567890abcdef',
    });

    expect(result.warnings.join('\n')).toMatch(/redact/i);
    expect(result.warnings.join('\n')).not.toContain('sk-proj-1234567890abcdef');
    expect(await memory.list()).toHaveLength(0);
    expect(await inbox.list()).toHaveLength(0);
  });
});
