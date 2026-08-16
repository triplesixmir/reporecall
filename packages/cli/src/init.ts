import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  REPORECALL_BEGIN_MARKER,
  REPORECALL_END_MARKER,
  REPORECALL_MANAGED_BLOCK,
} from '@reporecall/integrations';
import { stringifyConfig } from './config.js';
import { discoverProject, ensureProject } from './project.js';

const BEGIN_MARKER = REPORECALL_BEGIN_MARKER;
const END_MARKER = REPORECALL_END_MARKER;
const MANAGED_BLOCK = REPORECALL_MANAGED_BLOCK;

export type InitializeOptions = {
  cwd?: string;
  brainPath: string;
  brainConfigPath?: string;
  projectMemoryDir?: string;
  agentsPath?: string;
};

export type InitializeReport = {
  projectRoot?: string;
  projectId?: string;
  manifestPath?: string;
  brainPath: string;
  configPath: string;
  agentsPath?: string;
  managedBlockAdded: boolean;
  createdDirectories: string[];
};

async function ensureMemoryDirectories(root: string): Promise<string[]> {
  const directories = [root, join(root, 'memories'), join(root, 'inbox'), join(root, 'sessions')];
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
  return directories;
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  try {
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function mergeManagedBlock(existing: string): { content: string; added: boolean } {
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
    throw new Error('AGENTS.md contains an incomplete RepoRecall managed block');
  }
  if (begin !== -1 && end !== -1) {
    const endExclusive = end + END_MARKER.length;
    return {
      content: `${existing.slice(0, begin)}${MANAGED_BLOCK}${existing.slice(endExclusive)}`,
      added: false,
    };
  }
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  return { content: `${existing}${separator}\n${MANAGED_BLOCK}\n`, added: true };
}

async function updateAgents(path: string): Promise<{ added: boolean }> {
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const merged = mergeManagedBlock(existing);
  if (merged.content !== existing) await atomicWrite(path, merged.content);
  return { added: merged.added };
}

export async function initializeBrain(options: { brainPath: string }): Promise<InitializeReport> {
  const brainPath = resolve(options.brainPath);
  const createdDirectories = await ensureMemoryDirectories(brainPath);
  const configRoot = join(brainPath, '.reporecall');
  await mkdir(configRoot, { recursive: true });
  const configPath = join(configRoot, 'config.toml');
  await writeIfMissing(
    configPath,
    stringifyConfig({ processor: 'disabled', processorMode: 'conservative' }),
  );
  return { brainPath, configPath, managedBlockAdded: false, createdDirectories };
}

export async function initializeProject(options: InitializeOptions): Promise<InitializeReport> {
  const discovered = await discoverProject(resolve(options.cwd ?? process.cwd()));
  const projectRoot = discovered.root;
  const brain = await initializeBrain({ brainPath: options.brainPath });
  const project = await ensureProject(projectRoot, options.projectMemoryDir, {
    projectConfig: stringifyConfig({
      brainPath: options.brainConfigPath ?? '~/.reporecall/brain',
      indexPath: 'index.sqlite',
      processor: 'disabled',
      processorMode: 'conservative',
    }),
  });
  const createdDirectories = await ensureMemoryDirectories(project.memoryDir);
  const configPath = join(project.memoryDir, 'config.toml');
  const agentsPath = resolve(options.agentsPath ?? join(projectRoot, 'AGENTS.md'));
  await mkdir(dirname(agentsPath), { recursive: true });
  const agents = await updateAgents(agentsPath);
  return {
    projectRoot,
    projectId: project.id,
    manifestPath: project.manifestPath,
    brainPath: brain.brainPath,
    configPath,
    agentsPath,
    managedBlockAdded: agents.added,
    createdDirectories: [...brain.createdDirectories, ...createdDirectories],
  };
}

export { BEGIN_MARKER, END_MARKER, MANAGED_BLOCK };
