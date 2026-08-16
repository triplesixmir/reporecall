import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import {
  projectRecordSchema,
  type ProjectRecord,
} from '@reporecall/core';

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1 as const;

export type ProjectRegistration = ProjectRecord & {
  root: string;
  memoryDir: string;
  manifestPath: string;
  lastSeenAt: string;
};

export type ProjectRegistrationInput = Omit<ProjectRegistration, 'lastSeenAt'> & {
  lastSeenAt?: string;
};

type ProjectRegistryDocument = {
  schema: typeof PROJECT_REGISTRY_SCHEMA_VERSION;
  projects: ProjectRegistration[];
};

export type FileProjectRegistryOptions = {
  brainPath: string;
  now?: () => string;
};

export function projectRegistryPath(brainPath: string): string {
  return join(dirname(resolve(brainPath)), 'projects.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid project registry "${path}": ${field} must be a non-empty string`);
  }
  return value;
}

function validateRegistration(value: unknown, path: string): ProjectRegistration {
  if (!isObject(value)) throw new Error(`Invalid project registry "${path}": project must be an object`);
  const { root: rawRoot, memoryDir: rawMemoryDir, manifestPath: rawManifestPath, lastSeenAt: rawLastSeenAt, ...record } = value;
  const project = projectRecordSchema.safeParse(record);
  if (!project.success) {
    throw new Error(`Invalid project registry "${path}": ${project.error.message}`);
  }
  const root = requiredString(rawRoot, 'root', path);
  const memoryDir = requiredString(rawMemoryDir, 'memoryDir', path);
  const manifestPath = requiredString(rawManifestPath, 'manifestPath', path);
  const lastSeenAt = requiredString(rawLastSeenAt, 'lastSeenAt', path);
  if (Number.isNaN(Date.parse(lastSeenAt))) {
    throw new Error(`Invalid project registry "${path}": lastSeenAt must be an ISO date`);
  }
  return {
    ...(project.data as ProjectRecord),
    root,
    memoryDir,
    manifestPath,
    lastSeenAt,
  };
}

function parseDocument(value: unknown, path: string): ProjectRegistryDocument {
  if (!isObject(value) || value.schema !== PROJECT_REGISTRY_SCHEMA_VERSION || !Array.isArray(value.projects)) {
    throw new Error(`Invalid project registry "${path}": expected schema 1 with a projects array`);
  }
  const projects = value.projects.map((project) => validateRegistration(project, path));
  return { schema: PROJECT_REGISTRY_SCHEMA_VERSION, projects };
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export class FileProjectRegistry {
  readonly path: string;
  private readonly now: () => string;

  constructor(options: FileProjectRegistryOptions) {
    this.path = projectRegistryPath(options.brainPath);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async read(): Promise<ProjectRegistryDocument> {
    let source: string;
    try {
      source = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { schema: PROJECT_REGISTRY_SCHEMA_VERSION, projects: [] };
      }
      throw error;
    }
    try {
      return parseDocument(JSON.parse(source) as unknown, this.path);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async list(): Promise<ProjectRegistration[]> {
    const document = await this.read();
    return [...document.projects].sort((left, right) => left.id.localeCompare(right.id));
  }

  async upsert(input: ProjectRegistrationInput): Promise<ProjectRegistration> {
    const registration = validateRegistration(
      { ...input, lastSeenAt: input.lastSeenAt ?? this.now() },
      this.path,
    );
    const document = await this.read();
    const projects = document.projects.filter((project) => project.id !== registration.id);
    projects.push(registration);
    projects.sort((left, right) => left.id.localeCompare(right.id));
    await atomicWrite(
      this.path,
      `${JSON.stringify({ schema: PROJECT_REGISTRY_SCHEMA_VERSION, projects }, null, 2)}\n`,
    );
    return registration;
  }
}
