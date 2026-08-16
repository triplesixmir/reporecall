import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type ProjectRecord,
  PROJECT_SCHEMA_VERSION,
} from '@reporecall/core';
import {
  createProjectManifest,
  readProjectManifest,
} from '@reporecall/storage';

const execFile = promisify(execFileCallback);

const DEFAULT_PROJECT_CONFIG = [
  'index_path = "index.sqlite"',
  'processor = "disabled"',
  'processor_mode = "conservative"',
  '',
].join('\n');

export type GitCommandRunner = (args: readonly string[], cwd: string) => Promise<string>;

export type ResolvedProject = ProjectRecord & {
  root: string;
  memoryDir: string;
  manifestPath: string;
  legacyIds: string[];
  created: boolean;
  manifestExists: boolean;
};

export type ProjectResolverOptions = {
  now?: () => string;
  runGit?: GitCommandRunner;
  projectConfig?: string;
};

type GitDiscovery = {
  root: string;
  remote?: string;
};

function defaultNow(): string {
  return new Date().toISOString();
}

async function defaultGitRunner(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFile('git', [...args], { cwd, encoding: 'utf8' });
  return result.stdout.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slugFor(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'project';
}

function normalizeRemote(remote: string): string {
  const value = remote.trim().replace(/#.*$/u, '');
  let host: string;
  let repositoryPath: string;

  const scp = value.match(/^(?:[^@]+@)?([^:/]+):(.+)$/u);
  if (scp !== null && !/^[a-z][a-z\d+.-]*:\/\//iu.test(value)) {
    host = scp[1] ?? '';
    repositoryPath = scp[2] ?? '';
  } else {
    try {
      const parsed = new URL(value);
      host = parsed.hostname;
      repositoryPath = parsed.pathname;
    } catch {
      host = 'local';
      repositoryPath = value;
    }
  }

  const normalizedPath = repositoryPath
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\.git$/iu, '');
  return `${host.toLocaleLowerCase()}/${normalizedPath}`;
}

function remoteIdentity(remote: string): { id: string; fingerprint: string } {
  const fingerprint = createHash('sha256').update(normalizeRemote(remote)).digest('hex');
  return {
    id: `proj_git_${fingerprint}`,
    fingerprint: `sha256:${fingerprint}`,
  };
}

async function discoverGit(cwd: string, runGit: GitCommandRunner): Promise<GitDiscovery> {
  let root: string;
  try {
    const output = await runGit(['rev-parse', '--show-toplevel'], cwd);
    root = resolve(output.trim());
  } catch {
    return { root: resolve(cwd) };
  }

  let remote: string | undefined;
  try {
    const output = await runGit(['remote', 'get-url', 'origin'], root);
    if (output.trim() !== '') remote = output.trim();
  } catch {
    try {
      const names = (await runGit(['remote'], root))
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
      for (const name of names) {
        try {
          const output = await runGit(['remote', 'get-url', name], root);
          if (output.trim() !== '') {
            remote = output.trim();
            break;
          }
        } catch {
          // Try the next configured remote.
        }
      }
    } catch {
      // A Git repository without a readable remote is still a valid local project.
    }
  }
  return { root, ...(remote === undefined ? {} : { remote }) };
}

function legacyIdsFor(root: string, memoryDir: string, currentId: string): string[] {
  return [
    ...new Set([root, memoryDir, slugFor(basename(root)), 'reporecall', slugFor(basename(memoryDir))]),
  ].filter((id) => id !== currentId);
}

function runtimeProject(
  record: ProjectRecord,
  root: string,
  memoryDir: string,
  manifestPath: string,
  created: boolean,
  manifestExists: boolean,
): ResolvedProject {
  return {
    ...record,
    root,
    memoryDir,
    manifestPath,
    legacyIds: legacyIdsFor(root, memoryDir, record.id),
    created,
    manifestExists,
  };
}

export async function discoverProject(
  cwd: string,
  options: ProjectResolverOptions = {},
): Promise<ResolvedProject> {
  const runGit = options.runGit ?? defaultGitRunner;
  const discovery = await discoverGit(resolve(cwd), runGit);
  const root = discovery.root;
  const memoryDir = resolve(join(root, '.reporecall'));
  const manifestPath = join(root, '.reporecall', 'project.md');
  const existing = await readProjectManifest(manifestPath);
  if (existing !== null) return runtimeProject(existing, root, memoryDir, manifestPath, false, true);

  const now = options.now?.() ?? defaultNow();
  const record: ProjectRecord = discovery.remote === undefined
    ? {
        schema: PROJECT_SCHEMA_VERSION,
        kind: 'project',
        id: `proj_local_${randomUUID()}`,
        name: basename(root) || 'project',
        identity: 'local',
        createdAt: now,
        updatedAt: now,
      }
    : (() => {
        const identity = remoteIdentity(discovery.remote);
        return {
          schema: PROJECT_SCHEMA_VERSION,
          kind: 'project' as const,
          id: identity.id,
          name: basename(root) || 'project',
          identity: 'git-remote' as const,
          remoteFingerprint: identity.fingerprint,
          createdAt: now,
          updatedAt: now,
        };
      })();
  return runtimeProject(record, root, memoryDir, manifestPath, false, false);
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (!(isRecord(error) && error.code === 'EEXIST')) throw error;
  }
}

async function ensureScopeDirectories(memoryDir: string): Promise<void> {
  await Promise.all(
    [memoryDir, join(memoryDir, 'memories'), join(memoryDir, 'inbox'), join(memoryDir, 'sessions')].map(
      (path) => mkdir(path, { recursive: true }),
    ),
  );
}

export async function ensureProject(
  cwd: string,
  configuredMemoryDir?: string,
  options: ProjectResolverOptions = {},
): Promise<ResolvedProject> {
  const discovered = await discoverProject(cwd, options);
  const memoryDir = configuredMemoryDir === undefined
    ? discovered.memoryDir
    : isAbsolute(configuredMemoryDir)
      ? resolve(configuredMemoryDir)
      : resolve(discovered.root, configuredMemoryDir);
  let record: ProjectRecord = {
    schema: discovered.schema,
    kind: discovered.kind,
    id: discovered.id,
    name: discovered.name,
    identity: discovered.identity,
    createdAt: discovered.createdAt,
    updatedAt: discovered.updatedAt,
    ...(discovered.remoteFingerprint === undefined
      ? {}
      : { remoteFingerprint: discovered.remoteFingerprint }),
  };
  let created = false;

  if (await readProjectManifest(discovered.manifestPath) === null) {
    const result = await createProjectManifest(discovered.manifestPath, record);
    record = result.record;
    created = result.created;
  } else {
    const existing = await readProjectManifest(discovered.manifestPath);
    if (existing !== null) record = existing;
  }

  await ensureScopeDirectories(memoryDir);
  await writeIfMissing(
    join(memoryDir, 'config.toml'),
    options.projectConfig ?? DEFAULT_PROJECT_CONFIG,
  );
  return runtimeProject(record, discovered.root, memoryDir, discovered.manifestPath, created, true);
}
