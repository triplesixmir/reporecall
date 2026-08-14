import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ProjectRecord } from '@reporecall/core';
import { createProjectManifest, readProjectManifest } from '../src/index.js';

const project: ProjectRecord = {
  schema: 1,
  kind: 'project',
  id: 'proj_local_00000000-0000-4000-8000-000000000000',
  name: 'Demo project',
  identity: 'local',
  createdAt: '2026-08-14T10:00:00.000Z',
  updatedAt: '2026-08-14T10:00:00.000Z',
};

async function fixture(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'reporecall-project-store-'));
}

describe('project manifest storage', () => {
  test('creates a manifest once and preserves it on repeat calls', async () => {
    const root = await fixture();
    const path = join(root, 'проект with spaces', '.reporecall', 'project.md');

    const first = await createProjectManifest(path, project);
    const second = await createProjectManifest(path, { ...project, name: 'Changed name' });

    expect(first).toEqual({ record: project, created: true });
    expect(second).toEqual({ record: project, created: false });
    await expect(readProjectManifest(path)).resolves.toEqual(project);
  });

  test('returns null for a missing manifest and preserves malformed content', async () => {
    const root = await fixture();
    const path = join(root, '.reporecall', 'project.md');

    await expect(readProjectManifest(path)).resolves.toBeNull();
    await mkdir(join(root, '.reporecall'), { recursive: true });
    const source = 'not a project manifest';
    await writeFile(path, source, 'utf8');

    await expect(readProjectManifest(path)).rejects.toThrow(/project\.md/i);
    await expect(readFile(path, 'utf8')).resolves.toBe(source);
  });

  test('concurrent creators converge on one valid manifest', async () => {
    const root = await fixture();
    const path = join(root, '.reporecall', 'project.md');

    const results = await Promise.all([
      createProjectManifest(path, project),
      createProjectManifest(path, project),
    ]);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.map((result) => result.record)).toEqual([project, project]);
    await expect(readProjectManifest(path)).resolves.toEqual(project);
  });

  test('does not leave temporary files after creation', async () => {
    const root = await fixture();
    const directory = join(root, '.reporecall');
    const path = join(directory, 'project.md');

    await createProjectManifest(path, project);

    const entries = await readdir(directory);
    expect(entries).toEqual(['project.md']);
    await rm(root, { recursive: true, force: true });
  });
});
