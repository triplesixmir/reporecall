import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  MEMORY_PRIORITIES,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  createMemoryInputSchema,
  memoryTagSchema,
  memorySourceSchema,
  redactSecrets,
  redactedSessionCaptureSchema,
  type ProcessedCaptureResult,
  type RedactedSessionCapture,
  type ContextBuilder,
  type ContextRequest,
  type CreateMemoryInput,
  type InboxItem as CoreInboxItem,
  type MemoryFilters,
  type MemoryIndex,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
  type MemoryTag,
  type UpdateMemoryInput,
} from '@reporecall/core';

export const REPORECALL_MCP_INSTRUCTIONS = [
  'RepoRecall is a local-first memory layer. Canonical Markdown files with YAML frontmatter are the durable source of truth; SQLite is only a disposable local index.',
  'Use memory_remember and memory_update for explicit durable writes. memory_checkpoint is the only tool that creates a durable session event; session hooks never summarize transcripts automatically.',
  'memory_process accepts only an explicitly supplied redacted capture. It never reads or stores raw transcripts; automatic persistence requires an explicit allowAutomatic request and conservative mode sends processor suggestions to Inbox.',
  'Never write secrets, credentials, private keys, or raw transcripts. User-owned tags are preserved when an agent updates a memory.',
].join(' ');

export type InboxItem = CoreInboxItem;

export type MemoryWriteOperation = 'create' | 'update' | 'resolve' | 'checkpoint';

export type MemoryMcpRuntime = {
  store: MemoryStore;
  stores?: Partial<Record<MemoryScope, MemoryStore>>;
  index: Pick<MemoryIndex, 'search'>;
  contextBuilder: ContextBuilder;
  afterWrite?: (record: MemoryRecord, operation: MemoryWriteOperation) => Promise<void>;
  listInbox?: (limit: number) => Promise<InboxItem[]>;
  processCapture?: (
    capture: RedactedSessionCapture,
    options: { allowAutomatic: boolean },
  ) => Promise<ProcessedCaptureResult>;
};

type ProjectArguments = {
  projectId?: string | undefined;
  projectRoot?: string | undefined;
  projectName?: string | undefined;
};

type InputTag = {
  name: string;
  origin: 'user' | 'ai';
  confidence?: number | undefined;
};

const projectFields = {
  projectId: z.string().min(1).optional(),
  projectRoot: z.string().min(1).optional(),
  projectName: z.string().min(1).optional(),
};

const searchInputSchema = {
  query: z.string().default(''),
  scope: z.enum(MEMORY_SCOPES).optional(),
  projectId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  priority: z.enum(MEMORY_PRIORITIES).optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  tag: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1000).default(20),
};

const contextInputSchema = {
  query: z.string().optional(),
  tokenBudget: z.number().int().min(1).max(100_000).default(2_000),
  ...projectFields,
  workspaceId: z.string().min(1).optional(),
  workspaceName: z.string().min(1).optional(),
};

const rememberInputSchema = {
  content: z.string().min(1),
  scope: z.enum(MEMORY_SCOPES).default('project'),
  type: z.enum(MEMORY_TYPES).default('fact'),
  priority: z.enum(MEMORY_PRIORITIES).default('normal'),
  status: z.enum(MEMORY_STATUSES).default('active'),
  pinned: z.boolean().default(false),
  tags: z.array(memoryTagSchema).default([]),
  confidence: z.number().min(0).max(1).optional(),
  ...projectFields,
};

const updateInputSchema = {
  id: z.string().min(1),
  content: z.string().min(1).optional(),
  scope: z.enum(MEMORY_SCOPES).optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  priority: z.enum(MEMORY_PRIORITIES).optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  pinned: z.boolean().optional(),
  tags: z.array(memoryTagSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
  ...projectFields,
};

const resolveInputSchema = {
  id: z.string().min(1),
  status: z.enum(['active', 'resolved', 'archived', 'dismissed']).default('resolved'),
};

const recentInputSchema = {
  limit: z.number().int().min(1).max(1000).default(20),
};

const checkpointInputSchema = {
  content: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  ...projectFields,
};

const inboxInputSchema = {
  limit: z.number().int().min(1).max(1000).default(50),
};

const processInputSchema = {
  content: z.string().min(1),
  capturedAt: z.iso.datetime({ offset: true }).optional(),
  sessionId: z.string().min(1).optional(),
  source: memorySourceSchema.optional(),
  explicit: z.array(createMemoryInputSchema).optional(),
  ...projectFields,
  workspaceId: z.string().min(1).optional(),
  workspaceName: z.string().min(1).optional(),
  allowAutomatic: z.boolean().default(false),
};

function success<T extends Record<string, unknown>>(data: T, summary: string): CallToolResult {
  return {
    structuredContent: data,
    content: [{ type: 'text', text: summary }],
  };
}

function projectRef(arguments_: ProjectArguments): CreateMemoryInput['project'] {
  if (arguments_.projectId === undefined && arguments_.projectRoot === undefined) return undefined;
  const root = arguments_.projectRoot ?? arguments_.projectId ?? 'project';
  const id = arguments_.projectId ?? root;
  return {
    id,
    root,
    ...(arguments_.projectName === undefined ? {} : { name: arguments_.projectName }),
  };
}

function agentTags(tags: InputTag[] | undefined): MemoryTag[] | undefined {
  if (tags === undefined) return undefined;
  return tags.map((tag) => ({
    name: tag.name,
    origin: 'ai' as const,
    ...(tag.confidence === undefined ? {} : { confidence: tag.confidence }),
  }));
}

function redactContent(content: string): string {
  const result = redactSecrets(content);
  if (result.blocked || result.redacted.trim() === '') {
    throw new Error('Refusing to write a memory containing only a secret or credential.');
  }
  return result.redacted;
}

function stores(runtime: MemoryMcpRuntime): MemoryStore[] {
  return [...new Set([runtime.store, ...Object.values(runtime.stores ?? {})])];
}

function storeForScope(runtime: MemoryMcpRuntime, scope: MemoryScope): MemoryStore {
  return runtime.stores?.[scope] ?? runtime.store;
}

async function findMemory(
  runtime: MemoryMcpRuntime,
  id: string,
): Promise<{ record: MemoryRecord; store: MemoryStore } | null> {
  for (const store of stores(runtime)) {
    const record = await store.get(id);
    if (record !== null) return { record, store };
  }
  return null;
}

async function listAll(
  runtime: MemoryMcpRuntime,
  filters: MemoryFilters = {},
): Promise<MemoryRecord[]> {
  const records = (await Promise.all(stores(runtime).map((store) => store.list(filters)))).flat();
  const unique = new Map(records.map((record) => [record.id, record]));
  return [...unique.values()].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.id.localeCompare(right.id);
  });
}

function contextProject(arguments_: ProjectArguments): ContextRequest['project'] {
  return projectRef(arguments_);
}

function captureWorkspace(arguments_: {
  workspaceId?: string | undefined;
  workspaceName?: string | undefined;
}): RedactedSessionCapture['workspace'] {
  if (arguments_.workspaceId === undefined && arguments_.workspaceName === undefined)
    return undefined;
  return {
    id: arguments_.workspaceId ?? arguments_.workspaceName ?? 'workspace',
    ...(arguments_.workspaceName === undefined ? {} : { name: arguments_.workspaceName }),
  };
}

async function writeRecord(
  runtime: MemoryMcpRuntime,
  input: CreateMemoryInput,
  operation: MemoryWriteOperation,
): Promise<MemoryRecord> {
  const record = await storeForScope(runtime, input.scope).create(input);
  await runtime.afterWrite?.(record, operation);
  return record;
}

async function updateRecord(
  runtime: MemoryMcpRuntime,
  id: string,
  patch: UpdateMemoryInput,
  operation: MemoryWriteOperation,
): Promise<MemoryRecord> {
  const found = await findMemory(runtime, id);
  if (found === null) throw new Error(`Memory not found: ${id}`);
  const record = await found.store.update(id, patch, { actor: 'agent' });
  await runtime.afterWrite?.(record, operation);
  return record;
}

export function createMemoryMcpServer(runtime: MemoryMcpRuntime): McpServer {
  const server = new McpServer(
    { name: 'reporecall', version: '0.1.0' },
    { instructions: REPORECALL_MCP_INSTRUCTIONS },
  );

  server.registerTool(
    'memory_search',
    {
      title: 'Search memories',
      description: 'Search the rebuildable local index with optional metadata filters.',
      inputSchema: searchInputSchema,
    },
    async (arguments_) => {
      const results = await runtime.index.search({
        query: arguments_.query,
        ...(arguments_.scope === undefined ? {} : { scope: arguments_.scope }),
        ...(arguments_.projectId === undefined ? {} : { projectId: arguments_.projectId }),
        ...(arguments_.workspaceId === undefined ? {} : { workspaceId: arguments_.workspaceId }),
        ...(arguments_.type === undefined ? {} : { type: arguments_.type }),
        ...(arguments_.priority === undefined ? {} : { priority: arguments_.priority }),
        ...(arguments_.status === undefined ? {} : { status: arguments_.status }),
        ...(arguments_.tag === undefined ? {} : { tag: arguments_.tag }),
        limit: arguments_.limit,
      });
      return success(
        { results, count: results.length },
        `Found ${results.length} memor${results.length === 1 ? 'y' : 'ies'}.`,
      );
    },
  );

  server.registerTool(
    'memory_get_context',
    {
      title: 'Build agent context',
      description: 'Build deterministic project-aware context within a token budget.',
      inputSchema: contextInputSchema,
    },
    async (arguments_) => {
      const currentProject = contextProject(arguments_);
      const bundle = await runtime.contextBuilder.build({
        ...(arguments_.query === undefined ? {} : { query: arguments_.query }),
        tokenBudget: arguments_.tokenBudget,
        ...(currentProject === undefined ? {} : { project: currentProject }),
        ...(arguments_.workspaceId === undefined
          ? {}
          : {
              workspace: {
                id: arguments_.workspaceId,
                ...(arguments_.workspaceName === undefined
                  ? {}
                  : { name: arguments_.workspaceName }),
              },
            }),
      });
      return success(
        { bundle },
        `Built context with ${bundle.items.length} memor${bundle.items.length === 1 ? 'y' : 'ies'}.`,
      );
    },
  );

  server.registerTool(
    'memory_get_recent',
    {
      title: 'Get recent memories',
      description: 'Return the latest canonical memories across configured local scopes.',
      inputSchema: recentInputSchema,
    },
    async (arguments_) => {
      const records = (await listAll(runtime)).slice(0, arguments_.limit);
      return success(
        { records, count: records.length },
        `Returned ${records.length} recent memor${records.length === 1 ? 'y' : 'ies'}.`,
      );
    },
  );

  server.registerTool(
    'memory_process',
    {
      title: 'Process an explicit capture',
      description:
        'Process an explicitly supplied redacted capture; this never reads or stores a raw transcript.',
      inputSchema: processInputSchema,
    },
    async (arguments_) => {
      if (runtime.processCapture === undefined) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'Memory processing is unavailable in this runtime.',
            },
          ],
        };
      }
      const project = projectRef(arguments_);
      const workspace = captureWorkspace(arguments_);
      const capture = redactedSessionCaptureSchema.parse({
        content: arguments_.content,
        ...(arguments_.capturedAt === undefined ? {} : { capturedAt: arguments_.capturedAt }),
        ...(arguments_.sessionId === undefined ? {} : { sessionId: arguments_.sessionId }),
        ...(arguments_.source === undefined ? {} : { source: arguments_.source }),
        ...(arguments_.explicit === undefined ? {} : { explicit: arguments_.explicit }),
        ...(project === undefined ? {} : { project }),
        ...(workspace === undefined ? {} : { workspace }),
      }) as RedactedSessionCapture;
      const result = await runtime.processCapture(capture, {
        allowAutomatic: arguments_.allowAutomatic,
      });
      return success(
        result,
        `Processed with ${result.provider} (${result.mode}): ${result.durable.length} durable, ${result.inbox.length} Inbox, ${result.duplicates.length} duplicates.`,
      );
    },
  );

  server.registerTool(
    'memory_remember',
    {
      title: 'Remember a fact',
      description: 'Create an explicit durable Markdown memory after local secret redaction.',
      inputSchema: rememberInputSchema,
    },
    async (arguments_) => {
      const content = redactContent(arguments_.content);
      const project = arguments_.scope === 'global' ? undefined : projectRef(arguments_);
      const tags = agentTags(arguments_.tags);
      const record = await writeRecord(
        runtime,
        {
          content,
          scope: arguments_.scope,
          type: arguments_.type,
          priority: arguments_.priority,
          status: arguments_.status,
          pinned: arguments_.pinned,
          ...(tags === undefined ? {} : { tags }),
          ...(arguments_.confidence === undefined ? {} : { confidence: arguments_.confidence }),
          ...(project === undefined ? {} : { project }),
          source: { kind: 'agent', agent: 'mcp', method: 'memory_remember' },
        },
        'create',
      );
      return success({ record }, `Remembered ${record.id}.`);
    },
  );

  server.registerTool(
    'memory_update',
    {
      title: 'Update a memory',
      description: 'Update a canonical memory while preserving user-owned tags.',
      inputSchema: updateInputSchema,
    },
    async (arguments_) => {
      const project = projectRef(arguments_);
      const patch: UpdateMemoryInput = {
        ...(arguments_.content === undefined ? {} : { content: redactContent(arguments_.content) }),
        ...(arguments_.scope === undefined ? {} : { scope: arguments_.scope }),
        ...(arguments_.type === undefined ? {} : { type: arguments_.type }),
        ...(arguments_.priority === undefined ? {} : { priority: arguments_.priority }),
        ...(arguments_.status === undefined ? {} : { status: arguments_.status }),
        ...(arguments_.pinned === undefined ? {} : { pinned: arguments_.pinned }),
        ...(arguments_.tags === undefined ? {} : { tags: agentTags(arguments_.tags) ?? [] }),
        ...(arguments_.confidence === undefined ? {} : { confidence: arguments_.confidence }),
        ...(project === undefined ? {} : { project }),
      };
      const record = await updateRecord(runtime, arguments_.id, patch, 'update');
      return success({ record }, `Updated ${record.id}.`);
    },
  );

  server.registerTool(
    'memory_resolve',
    {
      title: 'Resolve a memory',
      description:
        'Mark a memory as resolved or another explicit non-destructive lifecycle status.',
      inputSchema: resolveInputSchema,
    },
    async (arguments_) => {
      const record = await updateRecord(
        runtime,
        arguments_.id,
        { status: arguments_.status },
        'resolve',
      );
      return success({ record }, `Marked ${record.id} as ${record.status}.`);
    },
  );

  server.registerTool(
    'memory_checkpoint',
    {
      title: 'Create an explicit checkpoint',
      description:
        'Persist an explicit session checkpoint; this never reads or stores a transcript.',
      inputSchema: checkpointInputSchema,
    },
    async (arguments_) => {
      const project = projectRef(arguments_);
      const record = await writeRecord(
        runtime,
        {
          content: redactContent(arguments_.content),
          scope: 'session',
          type: 'event',
          priority: 'normal',
          status: 'active',
          pinned: false,
          tags: [],
          ...(project === undefined ? {} : { project }),
          source: {
            kind: 'user',
            method: 'checkpoint',
            ...(arguments_.sessionId === undefined ? {} : { sessionId: arguments_.sessionId }),
          },
        },
        'checkpoint',
      );
      return success({ record }, `Checkpointed ${record.id}.`);
    },
  );

  server.registerTool(
    'memory_review_inbox',
    {
      title: 'Review the inbox',
      description: 'List processor or agent suggestions without making them durable automatically.',
      inputSchema: inboxInputSchema,
    },
    async (arguments_) => {
      const items = (await runtime.listInbox?.(arguments_.limit)) ?? [];
      return success(
        { items, count: items.length },
        `Inbox contains ${items.length} item${items.length === 1 ? '' : 's'}.`,
      );
    },
  );

  return server;
}

export async function runMcpStdio(runtime: MemoryMcpRuntime): Promise<void> {
  const server = createMemoryMcpServer(runtime);
  await server.connect(new StdioServerTransport());
}
