import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createInboxItem,
  parseInboxFile,
  serializeInbox,
  updateInboxItem,
  type CreateInboxItemInput,
  type InboxFilters,
  type InboxItem,
  type InboxStore,
  type ValidationReport,
  type UpdateInboxItemInput,
} from '@reporecall/core';

export type FileInboxStoreOptions = {
  root: string;
  now?: () => string;
};

function isInboxId(id: string): boolean {
  return /^inbox_[A-Za-z0-9_-]+$/u.test(id);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class FileInboxStore implements InboxStore {
  readonly root: string;
  private readonly inboxDir: string;
  private readonly now: () => string;

  constructor(options: FileInboxStoreOptions) {
    this.root = options.root;
    this.inboxDir = join(options.root, 'inbox');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private pathFor(id: string): string {
    if (!isInboxId(id)) throw new Error(`Invalid inbox id: ${id}`);
    return join(this.inboxDir, `${id}.md`);
  }

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.inboxDir, { recursive: true });
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

  private async readItems(): Promise<InboxItem[]> {
    await this.ensureDirectory();
    const entries = await readdir(this.inboxDir, { withFileTypes: true });
    const items: InboxItem[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = join(this.inboxDir, entry.name);
      items.push(parseInboxFile(await readFile(path, 'utf8'), path));
    }
    return items;
  }

  async list(filters: InboxFilters = {}): Promise<InboxItem[]> {
    const items = (await this.readItems())
      .filter((item) => filters.status === undefined || item.status === filters.status)
      .filter(
        (item) =>
          filters.projectId === undefined || item.suggested.project?.id === filters.projectId,
      )
      .sort((left, right) => {
        if (right.updatedAt !== left.updatedAt)
          return right.updatedAt.localeCompare(left.updatedAt);
        return left.id.localeCompare(right.id);
      });
    return filters.limit === undefined ? items : items.slice(0, Math.max(0, filters.limit));
  }

  async get(id: string): Promise<InboxItem | null> {
    const path = this.pathFor(id);
    try {
      return parseInboxFile(await readFile(path, 'utf8'), path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async create(input: CreateInboxItemInput): Promise<InboxItem> {
    const item = createInboxItem(input, { now: this.now() });
    await this.ensureDirectory();
    await this.atomicWrite(this.pathFor(item.id), serializeInbox(item));
    return item;
  }

  async update(id: string, patch: UpdateInboxItemInput): Promise<InboxItem> {
    const current = await this.get(id);
    if (current === null) throw new Error(`Inbox item not found: ${id}`);
    const updated = updateInboxItem(current, patch, { now: this.now() });
    await this.atomicWrite(this.pathFor(id), serializeInbox(updated));
    return updated;
  }

  async remove(id: string): Promise<void> {
    try {
      await unlink(this.pathFor(id));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async validateAll(): Promise<ValidationReport> {
    await this.ensureDirectory();
    const entries = await readdir(this.inboxDir, { withFileTypes: true });
    const report: ValidationReport = { valid: 0, invalid: [] };
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = join(this.inboxDir, entry.name);
      try {
        parseInboxFile(await readFile(path, 'utf8'), path);
        report.valid += 1;
      } catch (error) {
        report.invalid.push({
          path,
          issues: [
            { path: 'file', message: error instanceof Error ? error.message : String(error) },
          ],
        });
      }
    }
    return report;
  }
}
