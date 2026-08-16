import type {
  InboxFilters,
  InboxItem,
  InboxStore,
  MemoryScope,
  ValidationReport,
  CreateInboxItemInput,
  UpdateInboxItemInput,
} from '@reporecall/core';

export type ScopedInboxStoreOptions = {
  global: InboxStore;
  project: InboxStore;
};

/** Routes global suggestions to the brain Inbox and all other scopes to project Inbox. */
export class ScopedInboxStore implements InboxStore {
  private readonly global: InboxStore;
  private readonly project: InboxStore;

  constructor(options: ScopedInboxStoreOptions) {
    this.global = options.global;
    this.project = options.project;
  }

  private allStores(): InboxStore[] {
    return [...new Set([this.global, this.project])];
  }

  private storeForScope(scope: MemoryScope): InboxStore {
    return scope === 'global' ? this.global : this.project;
  }

  async list(filters: InboxFilters = {}): Promise<InboxItem[]> {
    const items = (await Promise.all(this.allStores().map((store) => store.list(filters)))).flat();
    items.sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
      return left.id.localeCompare(right.id);
    });
    return filters.limit === undefined ? items : items.slice(0, Math.max(0, filters.limit));
  }

  async get(id: string): Promise<InboxItem | null> {
    for (const store of this.allStores()) {
      const item = await store.get(id);
      if (item !== null) return item;
    }
    return null;
  }

  async create(input: CreateInboxItemInput): Promise<InboxItem> {
    return this.storeForScope(input.suggested.scope).create(input);
  }

  async update(id: string, patch: UpdateInboxItemInput): Promise<InboxItem> {
    for (const store of this.allStores()) {
      if ((await store.get(id)) !== null) return store.update(id, patch);
    }
    throw new Error(`Inbox item not found: ${id}`);
  }

  async remove(id: string): Promise<void> {
    for (const store of this.allStores()) {
      if ((await store.get(id)) !== null) {
        await store.remove(id);
        return;
      }
    }
    throw new Error(`Inbox item not found: ${id}`);
  }

  async validateAll(): Promise<ValidationReport> {
    const reports = await Promise.all(this.allStores().map((store) => store.validateAll()));
    return {
      valid: reports.reduce((total, report) => total + report.valid, 0),
      invalid: reports.flatMap((report) => report.invalid),
    };
  }
}
