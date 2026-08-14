import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { initializeBrain, initializeProject } from '../src/init.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-init-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('initialization', () => {
  test('is idempotent and preserves text outside the managed AGENTS block', async () => {
    const root = await fixture();
    const project = join(root, 'project with spaces');
    const brain = join(root, 'brain с памятью');
    const agentsPath = join(project, 'AGENTS.md');
    await mkdir(project, { recursive: true });
    await writeFile(agentsPath, '# Existing guidance\n\nKeep this text.\n', 'utf8');

    const first = await initializeProject({ cwd: project, brainPath: brain });
    const second = await initializeProject({ cwd: project, brainPath: brain });
    const agents = await readFile(agentsPath, 'utf8');
    const beginCount = agents.split('<!-- BEGIN REPORECALL MANAGED BLOCK -->').length - 1;

    expect(first.managedBlockAdded).toBe(true);
    expect(second.managedBlockAdded).toBe(false);
    expect(beginCount).toBe(1);
    expect(agents).toContain('# Existing guidance');
    expect(agents).toContain('Keep this text.');
    expect(agents).toContain('Canonical memory files are Markdown');
    expect(agents).toContain('memory_auto_capture');
    expect(agents).toContain('meaningful task');
    await expect(readFile(join(project, '.reporecall', 'config.toml'), 'utf8')).resolves.toContain(
      'brain_path',
    );
    await expect(readdir(join(brain, 'memories'))).resolves.toEqual([]);
  });

  test('initializes a custom brain without touching a project', async () => {
    const root = await fixture();
    const brain = join(root, 'custom brain');

    const report = await initializeBrain({ brainPath: brain });

    expect(report.brainPath).toBe(brain);
    await expect(readFile(join(brain, '.reporecall', 'config.toml'), 'utf8')).resolves.toContain(
      'processor',
    );
  });
});
