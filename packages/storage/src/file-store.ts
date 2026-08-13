import { randomUUID } from 'node:crypto';
import { copyFile, readdir, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createMemoryRecord,
  memoryRecordSchema,
  parseMemoryFile,
  parseMemoryFileWithMigration,
  serializeMemory,
  updateMemoryRecord,
  type CreateMemoryInput,
  type MemoryFilters,
  type MemoryMigrationOptions,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
  type UpdateMemoryInput,
  type UpdateMemoryOptions,
  type ValidationReport,
} from '@reporecall/core';

export type FileMemoryStoreOptions = {
  root: string;
  scope?: MemoryScope;
};

export type FileMigrationReport = {
  migrated: number;
  unchanged: number;
  backups: string[];
  invalid: ValidationReport['invalid'];
};

function isMemoryId(id: string): boolean {
  return /^mem_[A-Za-z0-9_-]+$/.test(id);
}

function matchesFilters(record: MemoryRecord, filters: MemoryFilters = {}): boolean {
  if (filters.scope !== undefined && record.scope !== filters.scope) return false;
  if (filters.projectId !== undefined && record.project?.id !== filters.projectId) return false;
  if (filters.workspaceId !== undefined && record.workspace?.id !== filters.workspaceId) return false;
  if (filters.type !== undefined && record.type !== filters.type) return false;
  if (filters.priority !== undefined && record.priority !== filters.priority) return false;
  if (filters.status !== undefined && record.status !== filters.status) return false;
  if (filters.tag !== undefined && !record.tags.some((tag) => tag.name === filters.tag)) return false;
  if (
    filters.query !== undefined &&
    !`${record.content}\n${record.tags.map((tag) => tag.name).join(' ')}`
      .toLocaleLowerCase()
      .includes(filters.query.toLocaleLowerCase())
  ) {
    return false;
  }
  return true;
}

export class FileMemoryStore implements MemoryStore {
  readonly root: string;
  readonly scope: MemoryScope;
  private readonly memoriesDir: string;

  constructor(options: FileMemoryStoreOptions) {
    this.root = options.root;
    this.scope = options.scope ?? 'project';
    this.memoriesDir = join(this.root, 'memories');
  }

  private pathFor(id: string): string {
    if (!isMemoryId(id)) throw new Error(`Invalid memory id: ${id}`);
    return join(this.memoriesDir, `${id}.md`);
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.memoriesDir, { recursive: true });
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, content, 'utf8');
      await rename(temporaryPath, path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async readRecords(): Promise<Array<{ path: string; record: MemoryRecord }>> {
    await this.ensureDirectories();
    const entries = await readdir(this.memoriesDir, { withFileTypes: true });
    const records: Array<{ path: string; record: MemoryRecord }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = join(this.memoriesDir, entry.name);
      const source = await readFile(path, 'utf8');
      records.push({ path, record: parseMemoryFile(source, path) });
    }
    return records;
  }

  async list(filters: MemoryFilters = {}): Promise<MemoryRecord[]> {
    const records = (await this.readRecords())
      .map(({ record }) => record)
      .filter((record) => matchesFilters(record, filters))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return filters.limit === undefined ? records : records.slice(0, Math.max(0, filters.limit));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    try {
      const source = await readFile(this.pathFor(id), 'utf8');
      return parseMemoryFile(source, this.pathFor(id));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async create(input: CreateMemoryInput): Promise<MemoryRecord> {
    const record = createMemoryRecord(input);
    await this.ensureDirectories();
    await this.atomicWrite(this.pathFor(record.id), serializeMemory(record));
    return record;
  }

  async update(id: string, patch: UpdateMemoryInput, options: UpdateMemoryOptions = {}): Promise<MemoryRecord> {
    const current = await this.get(id);
    if (current === null) throw new Error(`Memory not found: ${id}`);
    const updated = updateMemoryRecord(current, patch, options);
    await this.atomicWrite(this.pathFor(id), serializeMemory(updated));
    return updated;
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.pathFor(id));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }

  async validateAll(): Promise<ValidationReport> {
    await this.ensureDirectories();
    const entries = await readdir(this.memoriesDir, { withFileTypes: true });
    const report: ValidationReport = { valid: 0, invalid: [] };
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = join(this.memoriesDir, entry.name);
      try {
        const source = await readFile(path, 'utf8');
        const parsed = parseMemoryFile(source, path);
        memoryRecordSchema.parse(parsed);
        report.valid += 1;
      } catch (error) {
        report.invalid.push({
          path,
          issues: [{ path: 'file', message: error instanceof Error ? error.message : String(error) }],
        });
      }
    }
    return report;
  }

  async migrateAll(options: MemoryMigrationOptions = {}): Promise<FileMigrationReport> {
    await this.ensureDirectories();
    const entries = await readdir(this.memoriesDir, { withFileTypes: true });
    const report: FileMigrationReport = { migrated: 0, unchanged: 0, backups: [], invalid: [] };

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = join(this.memoriesDir, entry.name);
      try {
        const source = await readFile(path, 'utf8');
        const result = parseMemoryFileWithMigration(source, path, options);
        if (!result.migrated) {
          report.unchanged += 1;
          continue;
        }

        const backupPath = `${path}.bak.${Date.now()}-${randomUUID()}`;
        await copyFile(path, backupPath);
        await this.atomicWrite(path, serializeMemory(result.record));
        report.backups.push(backupPath);
        report.migrated += 1;
      } catch (error) {
        report.invalid.push({
          path,
          issues: [{ path: 'file', message: error instanceof Error ? error.message : String(error) }],
        });
      }
    }

    return report;
  }
}
