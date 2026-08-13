import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import {
  INBOX_SCHEMA_VERSION,
  INBOX_STATUSES,
  type CreateInboxItemInput,
  type InboxItem,
  type InboxStatus,
  type MemoryRelation,
  type MemorySource,
  type ProcessorSuggestion,
  type UpdateInboxItemInput,
} from './types.js';
import { createMemoryInputSchema, memorySourceSchema } from './schema.js';

export const processorSuggestionSchema = createMemoryInputSchema
  .extend({ reason: z.string().trim().min(1).optional() })
  .strict();

export const inboxItemSchema = z
  .object({
    schema: z.literal(INBOX_SCHEMA_VERSION),
    id: z
      .string()
      .trim()
      .regex(/^inbox_[A-Za-z0-9_-]+$/u),
    status: z.enum(INBOX_STATUSES),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    suggested: processorSuggestionSchema,
    source: memorySourceSchema.optional(),
    reason: z.string().trim().min(1).optional(),
    duplicateOf: z.string().trim().min(1).optional(),
  })
  .strict();

type FrontmatterSource = {
  kind: MemorySource['kind'];
  agent?: string;
  provider?: string;
  session_id?: string;
  project?: string;
  captured_at?: string;
  method?: string;
};

type FrontmatterRelation = {
  type: MemoryRelation['type'];
  target_id: string;
  note?: string;
};

function sourceToFrontmatter(source: MemorySource): FrontmatterSource {
  return {
    kind: source.kind,
    ...(source.agent === undefined ? {} : { agent: source.agent }),
    ...(source.provider === undefined ? {} : { provider: source.provider }),
    ...(source.sessionId === undefined ? {} : { session_id: source.sessionId }),
    ...(source.project === undefined ? {} : { project: source.project }),
    ...(source.capturedAt === undefined ? {} : { captured_at: source.capturedAt }),
    ...(source.method === undefined ? {} : { method: source.method }),
  };
}

function sourceFromFrontmatter(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    kind: value.kind,
    ...(value.agent === undefined ? {} : { agent: value.agent }),
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.session_id === undefined ? {} : { sessionId: value.session_id }),
    ...(value.project === undefined ? {} : { project: value.project }),
    ...(value.captured_at === undefined ? {} : { capturedAt: value.captured_at }),
    ...(value.method === undefined ? {} : { method: value.method }),
  };
}

function relationToFrontmatter(relation: MemoryRelation): FrontmatterRelation {
  return {
    type: relation.type,
    target_id: relation.targetId,
    ...(relation.note === undefined ? {} : { note: relation.note }),
  };
}

function relationsFromFrontmatter(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const relations: unknown[] = value;
  return relations.map((relation) => {
    if (!isRecord(relation)) return relation;
    return {
      type: relation.type,
      targetId: relation.target_id ?? relation.targetId,
      ...(relation.note === undefined ? {} : { note: relation.note }),
    };
  });
}

function suggestionToFrontmatter(suggestion: ProcessorSuggestion): Record<string, unknown> {
  return {
    scope: suggestion.scope,
    type: suggestion.type,
    ...(suggestion.priority === undefined ? {} : { priority: suggestion.priority }),
    ...(suggestion.status === undefined ? {} : { status: suggestion.status }),
    ...(suggestion.pinned === undefined ? {} : { pinned: suggestion.pinned }),
    ...(suggestion.tags === undefined
      ? {}
      : {
          tags: suggestion.tags.map((tag) => ({
            name: tag.name,
            origin: tag.origin,
            ...(tag.confidence === undefined ? {} : { confidence: tag.confidence }),
          })),
        }),
    ...(suggestion.confidence === undefined ? {} : { confidence: suggestion.confidence }),
    ...(suggestion.project === undefined ? {} : { project: suggestion.project }),
    ...(suggestion.workspace === undefined ? {} : { workspace: suggestion.workspace }),
    ...(suggestion.source === undefined ? {} : { source: sourceToFrontmatter(suggestion.source) }),
    ...(suggestion.relations === undefined
      ? {}
      : { relations: suggestion.relations.map(relationToFrontmatter) }),
    ...(suggestion.reason === undefined ? {} : { reason: suggestion.reason }),
  };
}

function suggestionFromFrontmatter(value: unknown, content: string): unknown {
  if (!isRecord(value)) return value;
  const source = sourceFromFrontmatter(value.source);
  const relations = relationsFromFrontmatter(value.relations);
  return {
    content,
    scope: value.scope,
    type: value.type,
    ...(value.priority === undefined ? {} : { priority: value.priority }),
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.pinned === undefined ? {} : { pinned: value.pinned }),
    ...(value.tags === undefined ? {} : { tags: value.tags }),
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    ...(value.project === undefined ? {} : { project: value.project }),
    ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
    ...(source === undefined ? {} : { source }),
    ...(relations === undefined ? {} : { relations }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeId(): string {
  return `inbox_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export function createInboxItem(
  input: CreateInboxItemInput,
  options: { id?: string; now?: string } = {},
): InboxItem {
  const now = options.now ?? new Date().toISOString();
  const item = {
    schema: INBOX_SCHEMA_VERSION,
    id: options.id ?? makeId(),
    status: input.status ?? ('pending' satisfies InboxStatus),
    createdAt: now,
    updatedAt: now,
    suggested: processorSuggestionSchema.parse(input.suggested) as ProcessorSuggestion,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.duplicateOf === undefined ? {} : { duplicateOf: input.duplicateOf }),
  } satisfies InboxItem;
  return inboxItemSchema.parse(item) as InboxItem;
}

export function updateInboxItem(
  item: InboxItem,
  patch: UpdateInboxItemInput,
  options: { now?: string } = {},
): InboxItem {
  const next = {
    ...item,
    ...patch,
    updatedAt: options.now ?? new Date().toISOString(),
  };
  return inboxItemSchema.parse(next) as InboxItem;
}

export function serializeInbox(item: InboxItem): string {
  const validated = inboxItemSchema.parse(item) as InboxItem;
  const frontmatter = stringify({
    schema: validated.schema,
    id: validated.id,
    status: validated.status,
    created_at: validated.createdAt,
    updated_at: validated.updatedAt,
    suggested: suggestionToFrontmatter(validated.suggested),
    ...(validated.source === undefined ? {} : { source: sourceToFrontmatter(validated.source) }),
    ...(validated.reason === undefined ? {} : { reason: validated.reason }),
    ...(validated.duplicateOf === undefined ? {} : { duplicate_of: validated.duplicateOf }),
  }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${validated.suggested.content.trim()}\n`;
}

export function parseInboxFile(source: string, filePath = '<inbox>'): InboxItem {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u);
  if (!match) throw new Error(`Invalid inbox file "${filePath}": missing YAML frontmatter`);

  try {
    const yamlSource = match[1];
    const markdownContent = match[2];
    if (yamlSource === undefined || markdownContent === undefined) {
      throw new Error('frontmatter delimiters are incomplete');
    }
    const raw: unknown = parse(yamlSource) as unknown;
    if (!isRecord(raw)) throw new Error('YAML frontmatter must be an object');
    const content = markdownContent.trim();
    const source = sourceFromFrontmatter(raw.source);
    const candidate = {
      schema: raw.schema,
      id: raw.id,
      status: raw.status,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      suggested: suggestionFromFrontmatter(raw.suggested, content),
      ...(source === undefined ? {} : { source }),
      ...(raw.reason === undefined ? {} : { reason: raw.reason }),
      ...(raw.duplicate_of === undefined ? {} : { duplicateOf: raw.duplicate_of }),
    };
    return inboxItemSchema.parse(candidate) as InboxItem;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown validation error';
    throw new Error(`Invalid inbox file "${filePath}": ${detail}`, { cause: error });
  }
}
