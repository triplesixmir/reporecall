import { unwatchFile, watch, watchFile, type FSWatcher, type Stats } from 'node:fs';
import { access, mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import {
  createMemoryInputSchema,
  memoryRelationSchema,
  memoryTagSchema,
  projectRefSchema,
  redactSecrets,
  updateMemoryRecord,
  workspaceRefSchema,
  MEMORY_PRIORITIES,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type CreateMemoryInput,
  type InboxItem,
  type InboxStatus,
  type IndexReport,
  type MemoryFilters,
  type MemoryRecord,
  type MemoryRelation,
  type MemoryScope,
  type MemorySourceRoot,
  type MemoryTag,
  type ProjectRef,
  type RebuildReport,
  type UpdateMemoryInput,
} from '@reporecall/core';
import { SqliteMemoryIndex } from '@reporecall/index';
import { FileInboxStore } from '@reporecall/processors';
import { FileMemoryStore } from '@reporecall/storage';
import { type RepoRecallConfig } from './config.js';
import type { ResolvedProject } from './project.js';

type JsonObject = Record<string, unknown>;
type ApiStatus = 400 | 404 | 409 | 500;

export type ServeRuntime = {
  readonly config: RepoRecallConfig;
  readonly project: ProjectRef;
  readonly stores: {
    global: FileMemoryStore;
    project: FileMemoryStore;
    session: FileMemoryStore;
  };
  readonly inboxStores: {
    global: FileInboxStore;
    project: FileInboxStore;
  };
  readonly index: SqliteMemoryIndex;
  readonly sources: MemorySourceRoot[];
  rebuild(): Promise<RebuildReport>;
  update(paths: string[]): Promise<IndexReport>;
  close(): void;
};

export type ServeOptions = {
  hostname?: string;
  assetsRoot?: string;
  watch?: boolean;
  debounceMs?: number;
};

export type ServeHandle = {
  app: ReturnType<typeof createApiApp>;
  runtime: ServeRuntime;
  port: number;
  close(): Promise<void>;
};

export type DebouncedIndexer = {
  schedule(paths: string[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
};

export type MemoryWatcher = {
  close(): Promise<void>;
};

export type MemoryWatcherOptions = {
  sources: MemorySourceRoot[];
  onPaths(paths: string[]): Promise<void>;
  debounceMs?: number;
  onError?: (error: unknown) => void;
};

class ApiError extends Error {
  readonly status: ApiStatus;

  constructor(status: ApiStatus, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ApiError(400, `Invalid ${field}.`);
  }
  return value as T;
}

function optionalEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  return enumValue(value, allowed, field, allowed[0] as T);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ApiError(400, `${field} must be a boolean.`);
  return value;
}

function optionalConfidence(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ApiError(400, `${field} must be a number between 0 and 1.`);
  }
  return value;
}

function parseTags(value: unknown): MemoryTag[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ApiError(400, 'tags must be an array.');
  const items: unknown[] = value;
  return items.map((item) => {
    const candidate = typeof item === 'string' ? { name: item, origin: 'user' as const } : item;
    const parsed = memoryTagSchema.safeParse(candidate);
    if (!parsed.success) throw new ApiError(400, 'Invalid memory tag.');
    return parsed.data as MemoryTag;
  });
}

function parseRelations(value: unknown): MemoryRelation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ApiError(400, 'relations must be an array.');
  return value.map((item) => {
    const parsed = memoryRelationSchema.safeParse(item);
    if (!parsed.success) throw new ApiError(400, 'Invalid memory relation.');
    return parsed.data as MemoryRelation;
  });
}

function parseProject(body: JsonObject, runtime: ServeRuntime): ProjectRef | undefined {
  if (hasOwn(body, 'project')) {
    const parsed = projectRefSchema.safeParse(body.project);
    if (!parsed.success) throw new ApiError(400, 'Invalid project reference.');
    return parsed.data as ProjectRef;
  }

  const hasFlatProject = ['projectId', 'projectRoot', 'projectName'].some((key) =>
    hasOwn(body, key),
  );
  if (!hasFlatProject) return undefined;
  const id = optionalString(body.projectId, 'projectId') ?? runtime.project.id;
  const root = optionalString(body.projectRoot, 'projectRoot') ?? runtime.project.root;
  const name = optionalString(body.projectName, 'projectName');
  return { id, root, ...(name === undefined ? {} : { name }) };
}

function parseWorkspace(body: JsonObject): MemoryRecord['workspace'] | undefined {
  if (!hasOwn(body, 'workspace')) return undefined;
  const parsed = workspaceRefSchema.safeParse(body.workspace);
  if (!parsed.success) throw new ApiError(400, 'Invalid workspace reference.');
  return parsed.data as MemoryRecord['workspace'];
}

function contentWithRedaction(content: string): { content: string; warnings: string[] } {
  const result = redactSecrets(content);
  if (result.blocked || result.redacted.trim() === '') {
    throw new ApiError(400, 'Refusing to write a memory containing only a secret or credential.');
  }
  return {
    content: result.redacted,
    warnings:
      result.redacted === content ? [] : ['Secrets were redacted before writing the memory.'],
  };
}

function parseCreateInput(
  body: JsonObject,
  runtime: ServeRuntime,
  method: string,
): { input: CreateMemoryInput; warnings: string[] } {
  const redacted = contentWithRedaction(requiredString(body.content, 'content'));
  const scope = enumValue(body.scope, MEMORY_SCOPES, 'scope', 'project');
  const type = enumValue(body.type, MEMORY_TYPES, 'type', 'fact');
  const priority = enumValue(body.priority, MEMORY_PRIORITIES, 'priority', 'normal');
  const status = enumValue(body.status, MEMORY_STATUSES, 'status', 'active');
  const pinned = optionalBoolean(body.pinned, 'pinned') ?? false;
  const tags = parseTags(body.tags) ?? [];
  const confidence = optionalConfidence(body.confidence, 'confidence');
  const project = parseProject(body, runtime) ?? (scope === 'global' ? undefined : runtime.project);
  const workspace = parseWorkspace(body);
  const relations = parseRelations(body.relations) ?? [];
  const candidate = {
    content: redacted.content,
    scope,
    type,
    priority,
    status,
    pinned,
    tags,
    ...(confidence === undefined ? {} : { confidence }),
    ...(project === undefined ? {} : { project }),
    ...(workspace === undefined ? {} : { workspace }),
    relations,
    source: { kind: 'user' as const, method },
  } satisfies CreateMemoryInput;
  const parsed = createMemoryInputSchema.safeParse(candidate);
  if (!parsed.success) throw new ApiError(400, 'Invalid memory payload.');
  return { input: parsed.data as CreateMemoryInput, warnings: redacted.warnings };
}

function parsePatchInput(
  body: JsonObject,
  runtime: ServeRuntime,
): { patch: UpdateMemoryInput; warnings: string[] } {
  const patch: UpdateMemoryInput = {};
  const warnings: string[] = [];

  if (hasOwn(body, 'content')) {
    const redacted = contentWithRedaction(requiredString(body.content, 'content'));
    patch.content = redacted.content;
    warnings.push(...redacted.warnings);
  }
  if (hasOwn(body, 'scope')) {
    const scope = optionalEnumValue(body.scope, MEMORY_SCOPES, 'scope');
    if (scope !== undefined) patch.scope = scope;
  }
  if (hasOwn(body, 'type')) {
    const type = optionalEnumValue(body.type, MEMORY_TYPES, 'type');
    if (type !== undefined) patch.type = type;
  }
  if (hasOwn(body, 'priority')) {
    const priority = optionalEnumValue(body.priority, MEMORY_PRIORITIES, 'priority');
    if (priority !== undefined) patch.priority = priority;
  }
  if (hasOwn(body, 'status')) {
    const status = optionalEnumValue(body.status, MEMORY_STATUSES, 'status');
    if (status !== undefined) patch.status = status;
  }
  if (hasOwn(body, 'pinned')) {
    const pinned = optionalBoolean(body.pinned, 'pinned');
    if (pinned !== undefined) patch.pinned = pinned;
  }
  if (hasOwn(body, 'tags')) {
    const tags = parseTags(body.tags);
    if (tags !== undefined) patch.tags = tags;
  }
  if (hasOwn(body, 'confidence')) {
    const confidence = optionalConfidence(body.confidence, 'confidence');
    if (confidence !== undefined) patch.confidence = confidence;
  }
  if (
    hasOwn(body, 'project') ||
    ['projectId', 'projectRoot', 'projectName'].some((key) => hasOwn(body, key))
  ) {
    const project = parseProject(body, runtime);
    if (project !== undefined) patch.project = project;
  }
  if (hasOwn(body, 'workspace')) {
    const workspace = parseWorkspace(body);
    if (workspace !== undefined) patch.workspace = workspace;
  }
  if (hasOwn(body, 'relations')) {
    const relations = parseRelations(body.relations);
    if (relations !== undefined) patch.relations = relations;
  }
  return { patch, warnings };
}

function projectFromConfig(config: RepoRecallConfig): ProjectRef {
  const projectMemoryDir = resolve(config.projectMemoryDir);
  const projectRoot =
    basename(projectMemoryDir) === '.reporecall' ? dirname(projectMemoryDir) : projectMemoryDir;
  const name = basename(projectRoot) || 'project';
  const id = name.toLocaleLowerCase().replace(/[^a-z0-9_-]+/gu, '-') || 'project';
  return { id, root: projectRoot, name };
}

function projectReference(project: ResolvedProject): ProjectRef {
  return { id: project.id, root: project.root, name: project.name };
}

function storeForScope(runtime: ServeRuntime, scope: MemoryScope): FileMemoryStore {
  if (scope === 'global') return runtime.stores.global;
  if (scope === 'session') return runtime.stores.session;
  return runtime.stores.project;
}

function rootForScope(runtime: ServeRuntime, scope: MemoryScope): string {
  return scope === 'global' ? runtime.config.brainPath : runtime.config.projectMemoryDir;
}

function memoryPath(runtime: ServeRuntime, record: Pick<MemoryRecord, 'id' | 'scope'>): string {
  return join(
    rootForScope(runtime, record.scope),
    record.scope === 'session' ? 'sessions' : 'memories',
    `${record.id}.md`,
  );
}

function memoryStores(runtime: ServeRuntime): FileMemoryStore[] {
  return [...new Set([runtime.stores.global, runtime.stores.project, runtime.stores.session])];
}

async function listMemories(
  runtime: ServeRuntime,
  filters: MemoryFilters = {},
): Promise<MemoryRecord[]> {
  const withoutLimit: MemoryFilters = { ...filters };
  delete withoutLimit.limit;
  const records = (
    await Promise.all(memoryStores(runtime).map((store) => store.list(withoutLimit)))
  ).flat();
  const unique = new Map(records.map((record) => [record.id, record]));
  const sorted = [...unique.values()].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.id.localeCompare(right.id);
  });
  return filters.limit === undefined ? sorted : sorted.slice(0, Math.max(0, filters.limit));
}

async function findMemory(
  runtime: ServeRuntime,
  id: string,
): Promise<{ record: MemoryRecord; store: FileMemoryStore } | null> {
  for (const store of memoryStores(runtime)) {
    const record = await store.get(id);
    if (record !== null) return { record, store };
  }
  return null;
}

function parseLimit(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new ApiError(400, 'limit must be a non-negative integer.');
  return parsed;
}

function filtersFromUrl(url: URL): { filters: MemoryFilters; query?: string } {
  const query = url.searchParams.get('query')?.trim();
  const scopeValue = url.searchParams.get('scope');
  const typeValue = url.searchParams.get('type');
  const priorityValue = url.searchParams.get('priority');
  const statusValue = url.searchParams.get('status');
  const scope =
    scopeValue === null ? undefined : enumValue(scopeValue, MEMORY_SCOPES, 'scope', 'project');
  const type = typeValue === null ? undefined : enumValue(typeValue, MEMORY_TYPES, 'type', 'fact');
  const priority =
    priorityValue === null
      ? undefined
      : enumValue(priorityValue, MEMORY_PRIORITIES, 'priority', 'normal');
  const status =
    statusValue === null ? undefined : enumValue(statusValue, MEMORY_STATUSES, 'status', 'active');
  const projectId = url.searchParams.get('projectId')?.trim() || undefined;
  const workspaceId = url.searchParams.get('workspaceId')?.trim() || undefined;
  const tag = url.searchParams.get('tag')?.trim() || undefined;
  const limit = url.searchParams.has('limit')
    ? parseLimit(url.searchParams.get('limit'), 100)
    : undefined;
  return {
    filters: {
      ...(scope === undefined ? {} : { scope }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(type === undefined ? {} : { type }),
      ...(priority === undefined ? {} : { priority }),
      ...(status === undefined ? {} : { status }),
      ...(tag === undefined ? {} : { tag }),
      ...(limit === undefined ? {} : { limit }),
    },
    ...(query === undefined || query === '' ? {} : { query }),
  };
}

async function readJsonObject(request: Request): Promise<JsonObject> {
  const text = await request.text();
  if (text.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, 'Request body must contain valid JSON.');
  }
  if (!isObject(value)) throw new ApiError(400, 'Request body must be a JSON object.');
  return value;
}

async function pendingInbox(runtime: ServeRuntime): Promise<InboxItem[]> {
  const items = (
    await Promise.all(
      Object.values(runtime.inboxStores).map((store) => store.list({ status: 'pending' })),
    )
  ).flat();
  return items.sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.id.localeCompare(right.id);
  });
}

async function allInbox(
  runtime: ServeRuntime,
  status: InboxStatus | 'all',
  limit?: number,
): Promise<InboxItem[]> {
  const items = (
    await Promise.all(
      Object.values(runtime.inboxStores).map((store) =>
        status === 'all' ? store.list() : store.list({ status }),
      ),
    )
  ).flat();
  const sorted = items.sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.id.localeCompare(right.id);
  });
  return limit === undefined ? sorted : sorted.slice(0, Math.max(0, limit));
}

async function findInbox(
  runtime: ServeRuntime,
  id: string,
): Promise<{ item: InboxItem; store: FileInboxStore } | null> {
  for (const store of Object.values(runtime.inboxStores)) {
    const item = await store.get(id);
    if (item !== null) return { item, store };
  }
  return null;
}

function statusFromInboxUrl(url: URL): InboxStatus | 'all' {
  const value = url.searchParams.get('status') ?? 'pending';
  if (value === 'all') return value;
  if (value !== 'pending' && value !== 'accepted' && value !== 'dismissed') {
    throw new ApiError(400, 'Invalid inbox status.');
  }
  return value;
}

function notFound(message: string): never {
  throw new ApiError(404, message);
}

export function createServeRuntime(
  config: RepoRecallConfig,
  resolvedProject?: ResolvedProject,
): ServeRuntime {
  const project = resolvedProject === undefined ? projectFromConfig(config) : projectReference(resolvedProject);
  const stores = {
    global: new FileMemoryStore({ root: config.brainPath, scope: 'global' }),
    project: new FileMemoryStore({ root: config.projectMemoryDir, scope: 'project' }),
    session: new FileMemoryStore({ root: config.projectMemoryDir, scope: 'session' }),
  };
  const inboxStores = {
    global: new FileInboxStore({ root: config.brainPath }),
    project: new FileInboxStore({ root: config.projectMemoryDir }),
  };
  const index = new SqliteMemoryIndex({ path: config.indexPath });
  const sources: MemorySourceRoot[] = [
    { root: config.brainPath, scope: 'global' },
    { root: config.projectMemoryDir, scope: 'project', project },
    { root: config.projectMemoryDir, scope: 'session', project },
  ];
  return {
    config,
    project,
    stores,
    inboxStores,
    index,
    sources,
    rebuild: () => index.rebuild(sources),
    update: (paths) => index.update(paths),
    close: () => index.close(),
  };
}

export function createApiApp(runtime: ServeRuntime): Hono {
  const app = new Hono();

  app.get('/api/health', async (context: Context) =>
    context.json({
      status: 'ok',
      version: '0.1.0',
      indexErrors: await runtime.index.getErrors(),
    }),
  );

  app.get('/api/overview', async (context: Context) => {
    const records = await listMemories(runtime);
    const projects = new Set(
      [runtime.project.id, ...records.map((record) => record.project?.id).filter(Boolean)],
    );
    const tags = new Set(records.flatMap((record) => record.tags.map((tag) => tag.name)));
    const activeCount = records.filter((record) => record.status === 'active').length;
    const inbox = await pendingInbox(runtime);
    return context.json({
      memoryCount: records.length,
      activeCount,
      projectCount: projects.size,
      tagCount: tags.size,
      inboxCount: inbox.length,
      indexErrors: await runtime.index.getErrors(),
    });
  });

  app.get('/api/memories', async (context: Context) => {
    const { filters, query } = filtersFromUrl(new URL(context.req.url));
    if (query !== undefined) {
      const results = await runtime.index.search({ query, ...filters });
      return context.json({
        memories: results.map((result) => result.record),
        results,
        count: results.length,
      });
    }
    const memories = await listMemories(runtime, filters);
    return context.json({ memories, count: memories.length });
  });

  app.get('/api/memories/:id', async (context: Context) => {
    const found = await findMemory(runtime, requiredString(context.req.param('id'), 'id'));
    if (found === null) notFound('Memory not found.');
    return context.json({ memory: found.record });
  });

  app.post('/api/memories', async (context: Context) => {
    const { input, warnings } = parseCreateInput(
      await readJsonObject(context.req.raw),
      runtime,
      'api',
    );
    const record = await storeForScope(runtime, input.scope).create(input);
    await runtime.update([memoryPath(runtime, record)]);
    return context.json({ memory: record, warnings }, 201);
  });

  app.patch('/api/memories/:id', async (context: Context) => {
    const found = await findMemory(runtime, requiredString(context.req.param('id'), 'id'));
    if (found === null) notFound('Memory not found.');
    const { patch, warnings } = parsePatchInput(await readJsonObject(context.req.raw), runtime);
    const updated = updateMemoryRecord(found.record, patch, { actor: 'user' });
    const targetStore = storeForScope(runtime, updated.scope);
    const oldPath = memoryPath(runtime, found.record);
    const newPath = memoryPath(runtime, updated);
    await targetStore.writeRecord(updated);
    if (oldPath !== newPath) await found.store.remove(found.record.id);
    await runtime.update([...new Set([oldPath, newPath])]);
    return context.json({ memory: updated, warnings });
  });

  app.delete('/api/memories/:id', async (context: Context) => {
    const found = await findMemory(runtime, requiredString(context.req.param('id'), 'id'));
    if (found === null) notFound('Memory not found.');
    const path = memoryPath(runtime, found.record);
    await found.store.remove(found.record.id);
    await runtime.update([path]);
    return context.json({ deleted: found.record.id });
  });

  app.get('/api/recent', async (context: Context) => {
    const limit = parseLimit(new URL(context.req.url).searchParams.get('limit'), 20);
    const records = await listMemories(runtime, { limit });
    return context.json({ records, count: records.length });
  });

  app.get('/api/projects', async (context: Context) => {
    const records = await listMemories(runtime);
    const inbox = await pendingInbox(runtime);
    const projects = new Map<string, ProjectRef>();
    for (const record of records) {
      if (record.project !== undefined) projects.set(record.project.id, record.project);
    }
    projects.set(runtime.project.id, runtime.project);
    const values = [...projects.values()]
      .map((project) => {
        const projectRecords = records.filter((record) => record.project?.id === project.id);
        return {
          ...project,
          memoryCount: projectRecords.length,
          activeCount: projectRecords.filter((record) => record.status === 'active').length,
          inboxCount: inbox.filter((item) => item.suggested.project?.id === project.id).length,
          current: project.id === runtime.project.id,
          ready: true,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    return context.json({ projects: values, count: values.length });
  });

  app.get('/api/tags', async (context: Context) => {
    const records = await listMemories(runtime);
    const tags = new Map<
      string,
      { name: string; count: number; userCount: number; aiCount: number }
    >();
    for (const record of records) {
      for (const tag of record.tags) {
        const current = tags.get(tag.name) ?? {
          name: tag.name,
          count: 0,
          userCount: 0,
          aiCount: 0,
        };
        current.count += 1;
        if (tag.origin === 'user') current.userCount += 1;
        else current.aiCount += 1;
        tags.set(tag.name, current);
      }
    }
    const values = [...tags.values()].sort((left, right) => left.name.localeCompare(right.name));
    return context.json({ tags: values, count: values.length });
  });

  app.get('/api/inbox', async (context: Context) => {
    const url = new URL(context.req.url);
    const status = statusFromInboxUrl(url);
    const limit = url.searchParams.has('limit')
      ? parseLimit(url.searchParams.get('limit'), 100)
      : undefined;
    const items = await allInbox(runtime, status, limit);
    return context.json({ items, count: items.length });
  });

  app.post('/api/inbox/:id/accept', async (context: Context) => {
    const found = await findInbox(runtime, requiredString(context.req.param('id'), 'id'));
    if (found === null) notFound('Inbox item not found.');
    if (found.item.status !== 'pending')
      throw new ApiError(409, 'Inbox item is no longer pending.');
    const body = await readJsonObject(context.req.raw);
    const payload: JsonObject = { ...found.item.suggested, ...body };
    if (body.scope === 'global' && !hasOwn(body, 'project')) delete payload.project;
    const { input, warnings } = parseCreateInput(payload, runtime, 'inbox-accept');
    const record = await storeForScope(runtime, input.scope).create(input);
    const item = await found.store.update(found.item.id, { status: 'accepted' });
    await runtime.update([memoryPath(runtime, record)]);
    return context.json({ item, memory: record, warnings }, 201);
  });

  app.post('/api/inbox/:id/dismiss', async (context: Context) => {
    const found = await findInbox(runtime, requiredString(context.req.param('id'), 'id'));
    if (found === null) notFound('Inbox item not found.');
    if (found.item.status !== 'pending')
      throw new ApiError(409, 'Inbox item is no longer pending.');
    const body = await readJsonObject(context.req.raw);
    const reason = optionalString(body.reason, 'reason');
    const item = await found.store.update(found.item.id, {
      status: 'dismissed',
      ...(reason === undefined ? {} : { reason }),
    });
    return context.json({ item });
  });

  app.get('/api/graph', async (context: Context) => {
    const { filters, query } = filtersFromUrl(new URL(context.req.url));
    const records =
      query === undefined
        ? await listMemories(runtime, filters)
        : (await runtime.index.search({ query, ...filters })).map((result) => result.record);
    const nodes = records.map((record) => ({
      id: record.id,
      label: record.content.slice(0, 120),
      type: record.type,
      scope: record.scope,
      status: record.status,
    }));
    const edges = records.flatMap((record) =>
      record.relations.map((relation) => ({
        source: record.id,
        target: relation.targetId,
        type: relation.type,
        ...(relation.note === undefined ? {} : { note: relation.note }),
      })),
    );
    return context.json({ nodes, edges });
  });

  app.notFound((context: Context) => context.json({ error: { message: 'Not found.' } }, 404));
  app.onError((error: Error, context: Context) => {
    if (error instanceof ApiError)
      return context.json({ error: { message: error.message } }, error.status);
    return context.json(
      { error: { message: error instanceof Error ? error.message : String(error) } },
      500,
    );
  });
  return app;
}

export function createDebouncedIndexer(
  onUpdate: (paths: string[]) => Promise<void>,
  delayMs = 150,
  onError: (error: unknown) => void = () => undefined,
): DebouncedIndexer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const pending = new Set<string>();
  let inFlight: Promise<void> | undefined;

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (inFlight !== undefined) await inFlight;
    if (pending.size === 0) return;
    const paths = [...pending].sort();
    pending.clear();
    inFlight = (async () => {
      try {
        await onUpdate(paths);
      } catch (error) {
        onError(error);
      } finally {
        inFlight = undefined;
      }
    })();
    await inFlight;
    if (pending.size > 0) await flush();
  };

  return {
    schedule(paths) {
      if (closed) return;
      for (const path of paths) pending.add(path);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(
        () => {
          void flush();
        },
        Math.max(0, delayMs),
      );
    },
    flush,
    async close() {
      closed = true;
      await flush();
    },
  };
}

export async function createMemoryWatcher(options: MemoryWatcherOptions): Promise<MemoryWatcher> {
  const onError = options.onError ?? (() => undefined);
  const debounced = createDebouncedIndexer(
    async (paths) => options.onPaths(paths),
    options.debounceMs,
    onError,
  );
  const directories = new Set(
    options.sources.map((source) =>
      resolve(source.root, source.scope === 'session' ? 'sessions' : 'memories'),
    ),
  );
  const watchers: FSWatcher[] = [];
  const knownPaths = new Map<string, Set<string>>();
  const syncChains = new Map<string, Promise<void>>();
  const fileListeners = new Map<string, (current: Stats, previous: Stats) => void>();

  const watchFilePath = (path: string): void => {
    if (fileListeners.has(path)) return;
    const listener = (current: Stats, previous: Stats) => {
      if (
        current.mtimeMs !== previous.mtimeMs ||
        current.size !== previous.size ||
        current.ino !== previous.ino
      ) {
        debounced.schedule([path]);
      }
    };
    fileListeners.set(path, listener);
    watchFile(path, { persistent: false, interval: 25 }, listener);
  };

  const syncDirectory = async (directory: string): Promise<void> => {
    const previousSync = syncChains.get(directory) ?? Promise.resolve();
    const nextSync = previousSync
      .catch(() => undefined)
      .then(async () => {
        const previous = knownPaths.get(directory) ?? new Set<string>();
        const current = new Set<string>();
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && entry.name.endsWith('.md'))
            current.add(join(directory, entry.name));
        }
        knownPaths.set(directory, current);
        for (const path of current) watchFilePath(path);
        debounced.schedule([...previous, ...current]);
      });
    syncChains.set(directory, nextSync);
    await nextSync;
  };

  try {
    for (const directory of directories) {
      await mkdir(directory, { recursive: true });
      await syncDirectory(directory);
      const watcher = watch(directory, { persistent: false }, (_event, filename) => {
        const name = filename?.toString();
        if (name?.endsWith('.md')) debounced.schedule([join(directory, name)]);
        void syncDirectory(directory).catch(onError);
      });
      watcher.on('error', onError);
      watchers.push(watcher);
    }
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    await debounced.close();
    throw error;
  }
  return {
    async close() {
      for (const watcher of watchers) watcher.close();
      for (const [path, listener] of fileListeners) unwatchFile(path, listener);
      fileListeners.clear();
      await debounced.close();
    },
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function closeServer(server: ServerType): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

export function startServe(
  config: RepoRecallConfig,
  options?: ServeOptions,
): Promise<ServeHandle>;
export function startServe(
  config: RepoRecallConfig,
  project: ResolvedProject,
  options?: ServeOptions,
): Promise<ServeHandle>;
export async function startServe(
  config: RepoRecallConfig,
  projectOrOptions: ResolvedProject | ServeOptions = {},
  providedOptions: ServeOptions = {},
): Promise<ServeHandle> {
  const resolvedProject = 'manifestPath' in projectOrOptions ? projectOrOptions : undefined;
  const options: ServeOptions = resolvedProject === undefined
    ? projectOrOptions as ServeOptions
    : providedOptions;
  const runtime = createServeRuntime(config, resolvedProject);
  let watcher: MemoryWatcher | undefined;
  let server: ServerType | undefined;
  try {
    await runtime.rebuild();
    const app = createApiApp(runtime);
    const assetsRoot = resolve(options.assetsRoot ?? join(process.cwd(), 'apps', 'web', 'dist'));
    if (await fileExists(join(assetsRoot, 'index.html'))) {
      app.use('/*', serveStatic({ root: assetsRoot, index: 'index.html' }));
    }
    if (options.watch !== false) {
      watcher = await createMemoryWatcher({
        sources: runtime.sources,
        ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
        onPaths: async (paths) => {
          await runtime.update(paths);
        },
      });
    }

    const hostname = options.hostname ?? '127.0.0.1';
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const onError = (error: Error) => {
        server?.off('error', onError);
        rejectPort(
          new Error(
            `Unable to start RepoRecall server on ${hostname}:${config.port}: ${error.message}`,
            { cause: error },
          ),
        );
      };
      server = serve({ fetch: app.fetch, hostname, port: config.port }, (info) => {
        server?.off('error', onError);
        resolvePort(info.port);
      });
      server.once('error', onError);
    });

    return {
      app,
      runtime,
      port,
      async close() {
        await watcher?.close();
        await closeServer(server as ServerType);
        runtime.close();
      },
    };
  } catch (error) {
    await watcher?.close().catch(() => undefined);
    if (server !== undefined) await closeServer(server).catch(() => undefined);
    runtime.close();
    throw error;
  }
}
