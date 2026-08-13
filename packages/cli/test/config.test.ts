import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveConfig } from '../src/config.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-config-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('resolveConfig', () => {
  test('merges CLI, project, brain, user, and default values in precedence order', async () => {
    const root = await fixture();
    const home = join(root, 'home');
    const brain = join(root, 'brain');
    const projectMemory = join(root, 'project', '.reporecall');
    await mkdir(join(home, '.config', 'reporecall'), { recursive: true });
    await mkdir(join(brain, '.reporecall'), { recursive: true });
    await mkdir(projectMemory, { recursive: true });
    await writeFile(
      join(home, '.config', 'reporecall', 'config.toml'),
      'brain_path = "user-brain"\nport = 4100\nprocessor = "ollama"\nignored_paths = ["user-ignore"]\n',
      'utf8',
    );
    await writeFile(
      join(brain, '.reporecall', 'config.toml'),
      'port = 4200\nprocessor_mode = "balanced"\nignored_paths = ["brain-ignore"]\n',
      'utf8',
    );
    await writeFile(
      join(projectMemory, 'config.toml'),
      'port = 4300\nprocessor = "disabled"\n',
      'utf8',
    );

    const config = await resolveConfig({
      cwd: join(root, 'project'),
      homeDir: home,
      userConfigPath: join(home, '.config', 'reporecall', 'config.toml'),
      brainPath: brain,
      cli: { port: 4400 },
    });

    expect(config).toMatchObject({
      brainPath: brain,
      projectMemoryDir: projectMemory,
      port: 4400,
      processor: 'disabled',
      processorMode: 'balanced',
      ignoredPaths: ['brain-ignore'],
    });
    expect(config.sources.map(({ path }) => path)).toEqual([
      join(home, '.config', 'reporecall', 'config.toml'),
      join(brain, '.reporecall', 'config.toml'),
      join(projectMemory, 'config.toml'),
    ]);
  });

  test('resolves relative paths against the config file that declares them', async () => {
    const root = await fixture();
    const project = join(root, 'project');
    const configDir = join(project, '.reporecall');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'config.toml'), 'brain_path = "../shared brain"\nindex_path = "cache/index.sqlite"\n', 'utf8');

    const config = await resolveConfig({ cwd: project, homeDir: join(root, 'home'), userConfigPath: join(root, 'missing.toml') });

    expect(config.brainPath).toBe(join(project, 'shared brain'));
    expect(config.indexPath).toBe(join(configDir, 'cache', 'index.sqlite'));
  });
});
