import type { z } from 'zod';

export const MEMORY_SCHEMA_VERSION = 1 as const;

export const MEMORY_SCOPES = ['global', 'workspace', 'project', 'session'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_TYPES = [
  'fact',
  'preference',
  'decision',
  'goal',
  'todo',
  'constraint',
  'insight',
  'issue',
  'event',
  'reference',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;
export type MemoryPriority = (typeof MEMORY_PRIORITIES)[number];

export const MEMORY_STATUSES = [
  'active',
  'resolved',
  'archived',
  'superseded',
  'dismissed',
] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const RELATION_TYPES = [
  'related_to',
  'depends_on',
  'contradicts',
  'supersedes',
  'derived_from',
  'implements',
  'blocks',
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const SOURCE_KINDS = ['user', 'agent', 'processor', 'import'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const PROCESSOR_KINDS = [
  'agent-native',
  'ollama',
  'openrouter',
  'openai-compatible',
  'disabled',
] as const;
export type ProcessorKind = (typeof PROCESSOR_KINDS)[number];

export const PROCESSOR_MODES = ['conservative', 'balanced', 'automatic'] as const;
export type ProcessorMode = (typeof PROCESSOR_MODES)[number];

export const INBOX_SCHEMA_VERSION = 1 as const;
export const INBOX_STATUSES = ['pending', 'accepted', 'dismissed'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export type MemoryTag = {
  name: string;
  origin: 'user' | 'ai';
  confidence?: number;
};

export type ProjectRef = {
  id: string;
  root: string;
  name?: string;
};

export type WorkspaceRef = {
  id: string;
  name?: string;
};

export type MemorySource = {
  kind: SourceKind;
  agent?: string;
  provider?: string;
  sessionId?: string;
  project?: string;
  capturedAt?: string;
  method?: string;
};

export type MemoryRelation = {
  type: RelationType;
  targetId: string;
  note?: string;
};

export type MemoryRecord = {
  schema: typeof MEMORY_SCHEMA_VERSION;
  id: string;
  scope: MemoryScope;
  type: MemoryType;
  priority: MemoryPriority;
  status: MemoryStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  tags: MemoryTag[];
  confidence?: number;
  project?: ProjectRef;
  workspace?: WorkspaceRef;
  source?: MemorySource;
  relations: MemoryRelation[];
  content: string;
};

export type CreateMemoryInput = {
  content: string;
  scope: MemoryScope;
  type: MemoryType;
  priority?: MemoryPriority;
  status?: MemoryStatus;
  pinned?: boolean;
  tags?: MemoryTag[];
  confidence?: number;
  project?: ProjectRef;
  workspace?: WorkspaceRef;
  source?: MemorySource;
  relations?: MemoryRelation[];
};

export type UpdateMemoryInput = Partial<
  Pick<
    MemoryRecord,
    | 'content'
    | 'scope'
    | 'type'
    | 'priority'
    | 'status'
    | 'pinned'
    | 'tags'
    | 'confidence'
    | 'project'
    | 'workspace'
    | 'source'
    | 'relations'
  >
>;

export type MemoryMutationActor = 'user' | 'agent' | 'processor' | 'system';

export type UpdateMemoryOptions = {
  actor?: MemoryMutationActor;
};

export type MemoryFile = {
  path: string;
  record: MemoryRecord;
  contentHash: string;
};

export type MemoryFilters = {
  scope?: MemoryScope;
  projectId?: string;
  projectIds?: string[];
  workspaceId?: string;
  type?: MemoryType;
  priority?: MemoryPriority;
  status?: MemoryStatus;
  tag?: string;
  query?: string;
  limit?: number;
};

export type SearchRequest = MemoryFilters & {
  query: string;
};

export type SearchResult = {
  record: MemoryRecord;
  snippet: string;
  score: number;
};

export type IndexError = {
  path: string;
  message: string;
};

export type MemoryIndex = {
  rebuild(sources: MemorySourceRoot[]): Promise<RebuildReport>;
  update(paths: string[]): Promise<IndexReport>;
  search(request: SearchRequest): Promise<SearchResult[]>;
};

export type ContextRequest = {
  project?: ProjectRef;
  projectAliases?: string[];
  workspace?: WorkspaceRef;
  query?: string;
  tokenBudget: number;
  includeScopes?: MemoryScope[];
};

export type ContextItem = {
  record: MemoryRecord;
  excerpt: string;
  score: number;
  estimatedTokens: number;
};

export type ContextBundle = {
  items: ContextItem[];
  text: string;
  estimatedTokens: number;
  omittedCount: number;
};

export type ContextBuilder = {
  build(request: ContextRequest): Promise<ContextBundle>;
};

export type MemorySourceRoot = {
  root: string;
  scope: MemoryScope;
  project?: ProjectRef;
  workspace?: WorkspaceRef;
};

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationReport = {
  valid: number;
  invalid: Array<{ path: string; issues: ValidationIssue[] }>;
};

export type RebuildReport = {
  indexed: number;
  invalid: ValidationReport['invalid'];
  deleted: number;
};

export type IndexReport = {
  indexed: number;
  deleted: number;
  invalid: ValidationReport['invalid'];
};

export type MemoryStore = {
  list(filters?: MemoryFilters): Promise<MemoryRecord[]>;
  get(id: string): Promise<MemoryRecord | null>;
  create(input: CreateMemoryInput): Promise<MemoryRecord>;
  update(
    id: string,
    patch: UpdateMemoryInput,
    options?: UpdateMemoryOptions,
  ): Promise<MemoryRecord>;
  remove(id: string): Promise<void>;
  validateAll(): Promise<ValidationReport>;
};

export type ProcessorSuggestion = CreateMemoryInput & {
  reason?: string;
};

export type RedactedSessionCapture = {
  content: string;
  capturedAt?: string;
  sessionId?: string;
  project?: ProjectRef;
  workspace?: WorkspaceRef;
  source?: MemorySource;
  explicit?: CreateMemoryInput[];
};

export type ProcessorProviderResult = {
  suggestions: ProcessorSuggestion[];
  warnings: string[];
};

export interface ProcessorSuggestionProvider {
  suggest(capture: RedactedSessionCapture): Promise<ProcessorProviderResult>;
}

export type InboxItem = {
  schema: typeof INBOX_SCHEMA_VERSION;
  id: string;
  status: InboxStatus;
  createdAt: string;
  updatedAt: string;
  suggested: ProcessorSuggestion;
  source?: MemorySource;
  reason?: string;
  duplicateOf?: string;
};

export type CreateInboxItemInput = {
  suggested: ProcessorSuggestion;
  source?: MemorySource;
  reason?: string;
  duplicateOf?: string;
  status?: InboxStatus;
};

export type UpdateInboxItemInput = Partial<
  Pick<InboxItem, 'status' | 'suggested' | 'source' | 'reason' | 'duplicateOf'>
>;

export type InboxFilters = {
  status?: InboxStatus;
  projectId?: string;
  limit?: number;
};

export type InboxStore = {
  list(filters?: InboxFilters): Promise<InboxItem[]>;
  get(id: string): Promise<InboxItem | null>;
  create(input: CreateInboxItemInput): Promise<InboxItem>;
  update(id: string, patch: UpdateInboxItemInput): Promise<InboxItem>;
  remove(id: string): Promise<void>;
  validateAll(): Promise<ValidationReport>;
};

export type DuplicateMatch = {
  candidate: ProcessorSuggestion;
  existing: MemoryRecord;
};

export type ProcessorResult = {
  durable: MemoryRecord[];
  inbox: InboxItem[];
  duplicates: DuplicateMatch[];
  warnings: string[];
};

export type ProcessedCaptureResult = ProcessorResult & {
  provider: ProcessorKind;
  mode: ProcessorMode;
};

export interface MemoryProcessor {
  process(capture: RedactedSessionCapture): Promise<ProcessorResult>;
}

export type AdapterTarget = {
  scope: 'user' | 'project';
  projectRoot?: string;
  codexHome?: string;
};

export type InstallationReport = {
  changed: boolean;
  paths: string[];
  warnings: string[];
};

export type AgentAdapter = {
  install(target: AdapterTarget): Promise<InstallationReport>;
  uninstall(target: AdapterTarget): Promise<InstallationReport>;
};

export type MemoryMigrationOptions = {
  now?: string;
};

export type MemoryMigrationResult = {
  record: MemoryRecord;
  migrated: boolean;
  fromSchema: number;
};

export type Schema = z.ZodType<MemoryRecord>;
