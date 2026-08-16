import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  FileProjectRegistry,
  type ProjectRegistration,
} from '../src/project-registry.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-project-registry-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function registration(root: string, lastSeenAt: string): ProjectRegistration {
  return {
    schema: 1,
    kind: 'project',
    id: 'proj_git_demo',
    name: 'Demo',
    identity: 'git-remote',
    remoteFingerprint: 'sha256:demo',
    createdAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:00:00.000Z',
    root,
    memoryDir: join(root, '.reporecall'),
    manifestPath: join(root, '.reporecall', 'project.md'),
    lastSeenAt,
  };
}

describe('FileProjectRegistry', () => {
  test('persists a project and updates its latest local checkout', async () => {
    const root = await fixture();
    const registry = new FileProjectRegistry({
      brainPath: join(root, 'brain'),
      now: () => '2026-08-16T11:00:00.000Z',
    });
    const first = registration(join(root, 'first'), '2026-08-16T10:00:00.000Z');
    const second = registration(join(root, 'second'), '2026-08-16T11:00:00.000Z');

    await registry.upsert(first);
    expect(await registry.list()).toEqual([first]);

    await registry.upsert(second);
    expect(await registry.list()).toEqual([second]);
  });
});
