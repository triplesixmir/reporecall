import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  discoverProject,
  ensureProject,
  type GitCommandRunner,
  type ProjectResolverOptions,
} from '../src/project.js';

const now = () => '2026-08-14T10:00:00.000Z';
const roots: string[] = [];

function fakeGit(options: { root: string; remote?: string }): GitCommandRunner {
  return (args) => {
    if (args.includes('rev-parse')) return Promise.resolve(`${options.root}\n`);
    if (args.includes('get-url')) {
      if (options.remote === undefined) return Promise.reject(new Error('no origin'));
      return Promise.resolve(`${options.remote}\n`);
    }
    if (args[0] === 'remote') {
      return Promise.resolve(options.remote === undefined ? '' : 'origin\n');
    }
    return Promise.reject(new Error(`Unexpected fake Git command: ${args.join(' ')}`));
  };
}

const missingGit: GitCommandRunner = () => Promise.reject(new Error('not a Git repository'));

async function projectDirectory(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `reporecall-project-${name}-`));
  roots.push(root);
  return root;
}

function options(runGit: GitCommandRunner): ProjectResolverOptions {
  return { now, runGit };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('project resolver', () => {
  test('normalizes equivalent SSH and HTTPS remotes to one identity', async () => {
    const first = await discoverProject('/tmp/clone-a/src', {
      ...options(fakeGit({ root: '/tmp/clone-a', remote: 'git@github.com:Example/Repo.git' })),
    });
    const second = await discoverProject('/tmp/clone-b/src', {
      ...options(fakeGit({ root: '/tmp/clone-b', remote: 'https://github.com/Example/Repo.git' })),
    });

    expect(first.id).toBe(second.id);
    expect(first.identity).toBe('git-remote');
    expect(first.remoteFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('does not merge same-named repositories with different remotes', async () => {
    const first = await discoverProject('/tmp/a/app', {
      ...options(fakeGit({ root: '/tmp/a/app', remote: 'https://github.com/a/app.git' })),
    });
    const second = await discoverProject('/tmp/b/app', {
      ...options(fakeGit({ root: '/tmp/b/app', remote: 'https://github.com/b/app.git' })),
    });

    expect(basename(first.root)).toBe(basename(second.root));
    expect(first.id).not.toBe(second.id);
  });

  test('creates and reuses a local UUID without a Git remote', async () => {
    const root = await projectDirectory('local');
    const first = await ensureProject(root, undefined, options(missingGit));
    const second = await ensureProject(root, undefined, options(missingGit));

    expect(first.id).toMatch(/^proj_local_/);
    expect(second.id).toBe(first.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await readFile(first.manifestPath, 'utf8')).not.toContain(root);
  });

  test('creates project scope directories and a default project config', async () => {
    const root = await projectDirectory('bootstrap');
    const memoryDir = join(root, 'custom memory', '.reporecall');
    const project = await ensureProject(root, memoryDir, options(missingGit));

    await expect(readFile(project.manifestPath, 'utf8')).resolves.toContain('kind: project');
    await expect(readFile(join(memoryDir, 'config.toml'), 'utf8')).resolves.toContain(
      'processor = "disabled"',
    );
    await expect(mkdir(join(memoryDir, 'memories'))).rejects.toThrow(/exist/i);
    await expect(mkdir(join(memoryDir, 'inbox'))).rejects.toThrow(/exist/i);
    await expect(mkdir(join(memoryDir, 'sessions'))).rejects.toThrow(/exist/i);
  });

  test('keeps absolute path aliases for memories created before stable project IDs', async () => {
    const root = await projectDirectory('legacy-aliases');
    const project = await ensureProject(root, undefined, options(missingGit));

    expect(project.legacyIds).toContain(root);
    expect(project.legacyIds).toContain(project.memoryDir);
  });

  test('preserves a malformed existing manifest', async () => {
    const root = await projectDirectory('malformed');
    const manifestPath = join(root, '.reporecall', 'project.md');
    await mkdir(join(root, '.reporecall'), { recursive: true });
    await (await import('node:fs/promises')).writeFile(manifestPath, 'broken', 'utf8');

    await expect(ensureProject(root, undefined, options(missingGit))).rejects.toThrow(
      /project\.md/i,
    );
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe('broken');
  });
});
