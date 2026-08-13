import { z } from 'zod';
import {
  MEMORY_PRIORITIES,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  RELATION_TYPES,
  SOURCE_KINDS,
  type CreateMemoryInput,
  type MemoryMigrationOptions,
  type MemoryMigrationResult,
  type MemoryTag,
  type MemoryRecord,
  type UpdateMemoryOptions,
} from './types.js';

const nonEmptyString = z.string().trim().min(1);
const isoDate = z.iso.datetime({ offset: true });
const confidence = z.number().min(0).max(1);

export const memoryTagSchema = z
  .object({
    name: nonEmptyString,
    origin: z.enum(['user', 'ai']),
    confidence: confidence.optional(),
  })
  .strict()
  .superRefine((tag, context) => {
    if (tag.origin === 'user' && tag.confidence !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: 'User tags must not carry AI confidence metadata',
      });
    }
  });

export const projectRefSchema = z
  .object({ id: nonEmptyString, root: nonEmptyString, name: nonEmptyString.optional() })
  .strict();

export const workspaceRefSchema = z
  .object({ id: nonEmptyString, name: nonEmptyString.optional() })
  .strict();

export const memorySourceSchema = z
  .object({
    kind: z.enum(SOURCE_KINDS),
    agent: nonEmptyString.optional(),
    provider: nonEmptyString.optional(),
    sessionId: nonEmptyString.optional(),
    project: nonEmptyString.optional(),
    capturedAt: isoDate.optional(),
    method: nonEmptyString.optional(),
  })
  .strict();

export const memoryRelationSchema = z
  .object({
    type: z.enum(RELATION_TYPES),
    targetId: nonEmptyString,
    note: z.string().trim().min(1).optional(),
  })
  .strict();

export const memoryRecordSchema = z
  .object({
    schema: z.literal(MEMORY_SCHEMA_VERSION),
    id: nonEmptyString,
    scope: z.enum(MEMORY_SCOPES),
    type: z.enum(MEMORY_TYPES),
    priority: z.enum(MEMORY_PRIORITIES),
    status: z.enum(MEMORY_STATUSES),
    pinned: z.boolean(),
    createdAt: isoDate,
    updatedAt: isoDate,
    tags: z.array(memoryTagSchema),
    confidence: confidence.optional(),
    project: projectRefSchema.optional(),
    workspace: workspaceRefSchema.optional(),
    source: memorySourceSchema.optional(),
    relations: z.array(memoryRelationSchema),
    content: z.string().trim().min(1),
  })
  .strict()
  .superRefine((record, context) => {
    const names = new Set<string>();
    for (const [index, tag] of record.tags.entries()) {
      const normalized = tag.name.toLocaleLowerCase();
      if (names.has(normalized)) {
        context.addIssue({
          code: 'custom',
          path: ['tags', index, 'name'],
          message: 'Tags must be unique within a memory',
        });
      }
      names.add(normalized);
    }

  });

export type MemoryRecordInput = z.input<typeof memoryRecordSchema>;

function makeId(): string {
  return `mem_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function normalizeTag(tag: MemoryTag): MemoryTag {
  const normalized = { name: tag.name.trim(), origin: tag.origin } as MemoryTag;
  return tag.confidence === undefined ? normalized : { ...normalized, confidence: tag.confidence };
}

function normalizeTags(tags: MemoryTag[] = []): MemoryTag[] {
  const byName = new Map<string, MemoryTag>();
  for (const tag of tags) {
    const normalizedTag = normalizeTag(tag);
    const name = normalizedTag.name;
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    const previous = byName.get(key);
    if (!previous || (previous.origin === 'ai' && normalizedTag.origin === 'user')) {
      byName.set(key, normalizedTag);
    }
  }
  return [...byName.values()];
}

export function createMemoryRecord(
  input: CreateMemoryInput,
  options: { id?: string; now?: string } = {},
): MemoryRecord {
  const now = options.now ?? new Date().toISOString();
  const record = {
    schema: MEMORY_SCHEMA_VERSION,
    id: options.id ?? makeId(),
    scope: input.scope,
    type: input.type,
    priority: input.priority ?? 'normal',
    status: input.status ?? 'active',
    pinned: input.pinned ?? false,
    createdAt: now,
    updatedAt: now,
    tags: normalizeTags(input.tags),
    confidence: input.confidence ?? 1,
    relations: input.relations ?? [],
    content: input.content.trim(),
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    ...(input.source === undefined ? {} : { source: input.source }),
  } satisfies MemoryRecord;
  return memoryRecordSchema.parse(record) as MemoryRecord;
}

export function updateMemoryRecord(
  record: MemoryRecord,
  patch: Partial<MemoryRecord>,
  options: UpdateMemoryOptions = {},
): MemoryRecord {
  const actor = options.actor ?? 'system';
  const tags =
    patch.tags === undefined || actor === 'user'
      ? patch.tags === undefined
        ? record.tags
        : normalizeTags(patch.tags)
      : normalizeTags([...record.tags, ...patch.tags]);
  const next = {
    ...record,
    ...patch,
    tags,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  };
  return memoryRecordSchema.parse(next) as MemoryRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Converts the original schema-0 object shape into the current schema.
 * Schema 1 is deliberately validated without defaults so malformed current
 * files cannot be made valid by a migration pass.
 */
export function migrateMemoryRecord(
  input: unknown,
  options: MemoryMigrationOptions = {},
): MemoryMigrationResult {
  if (!isRecord(input)) throw new Error('Memory record must be an object');

  const schema = schemaNumber(input.schema);
  if (schema === MEMORY_SCHEMA_VERSION) {
    return {
      record: memoryRecordSchema.parse(input) as MemoryRecord,
      migrated: false,
      fromSchema: schema,
    };
  }

  if (schema === undefined) throw new Error('Memory record schema is required');
  if (schema > MEMORY_SCHEMA_VERSION) {
    throw new Error(`Memory schema ${schema} is newer than supported schema ${MEMORY_SCHEMA_VERSION}`);
  }
  if (schema < 0) throw new Error(`Unsupported memory schema: ${schema}`);

  const now = options.now ?? new Date().toISOString();
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? createdAt;
  const migratedInput = {
    ...input,
    schema: MEMORY_SCHEMA_VERSION,
    scope: input.scope ?? 'project',
    type: input.type ?? 'fact',
    priority: input.priority ?? 'normal',
    status: input.status ?? 'active',
    pinned: input.pinned ?? false,
    createdAt,
    updatedAt,
    tags: input.tags ?? [],
    relations: input.relations ?? [],
  };

  return {
    record: memoryRecordSchema.parse(migratedInput) as MemoryRecord,
    migrated: true,
    fromSchema: schema,
  };
}
