import { parse, stringify } from 'yaml';
import { memoryRecordSchema, migrateMemoryRecord } from './schema.js';
import type {
  MemoryMigrationOptions,
  MemoryMigrationResult,
  MemoryRecord,
  MemoryRelation,
  MemorySource,
  MemoryTag,
} from './types.js';

type Frontmatter = {
  schema: number;
  id: string;
  scope: MemoryRecord['scope'];
  type: MemoryRecord['type'];
  priority: MemoryRecord['priority'];
  status: MemoryRecord['status'];
  pinned: boolean;
  created_at: string;
  updated_at: string;
  tags: Array<{ name: string; origin: MemoryTag['origin']; confidence?: number }>;
  confidence?: number;
  project?: { id: string; root: string; name?: string };
  workspace?: { id: string; name?: string };
  source?: {
    kind: MemorySource['kind'];
    agent?: string;
    provider?: string;
    session_id?: string;
    project?: string;
    captured_at?: string;
    method?: string;
  };
  relations: Array<{ type: MemoryRelation['type']; target_id: string; note?: string }>;
};

function toFrontmatter(record: MemoryRecord): Frontmatter {
  return {
    schema: record.schema,
    id: record.id,
    scope: record.scope,
    type: record.type,
    priority: record.priority,
    status: record.status,
    pinned: record.pinned,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    tags: record.tags.map((tag) => ({
      name: tag.name,
      origin: tag.origin,
      ...(tag.confidence === undefined ? {} : { confidence: tag.confidence }),
    })),
    ...(record.confidence === undefined ? {} : { confidence: record.confidence }),
    ...(record.project === undefined ? {} : { project: record.project }),
    ...(record.workspace === undefined ? {} : { workspace: record.workspace }),
    ...(record.source === undefined
      ? {}
      : {
          source: {
            kind: record.source.kind,
            ...(record.source.agent === undefined ? {} : { agent: record.source.agent }),
            ...(record.source.provider === undefined ? {} : { provider: record.source.provider }),
            ...(record.source.sessionId === undefined ? {} : { session_id: record.source.sessionId }),
            ...(record.source.project === undefined ? {} : { project: record.source.project }),
            ...(record.source.capturedAt === undefined ? {} : { captured_at: record.source.capturedAt }),
            ...(record.source.method === undefined ? {} : { method: record.source.method }),
          },
        }),
    relations: record.relations.map((relation) => ({
      type: relation.type,
      target_id: relation.targetId,
      ...(relation.note === undefined ? {} : { note: relation.note }),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fromFrontmatter(
  frontmatter: unknown,
  content: string,
  options: MemoryMigrationOptions = {},
): MemoryMigrationResult {
  if (!isRecord(frontmatter)) throw new Error('YAML frontmatter must be an object');

  const candidate: Record<string, unknown> = {
    schema: frontmatter.schema,
    id: frontmatter.id,
    scope: frontmatter.scope,
    type: frontmatter.type,
    priority: frontmatter.priority,
    status: frontmatter.status,
    pinned: frontmatter.pinned,
    createdAt: frontmatter.created_at,
    updatedAt: frontmatter.updated_at,
    tags: frontmatter.tags,
    confidence: frontmatter.confidence,
    project: frontmatter.project,
    workspace: frontmatter.workspace,
    relations: frontmatter.relations,
    content,
  };

  if (isRecord(frontmatter.source)) {
    candidate.source = {
      kind: frontmatter.source.kind,
      agent: frontmatter.source.agent,
      provider: frontmatter.source.provider,
      sessionId: frontmatter.source.session_id,
      project: frontmatter.source.project,
      capturedAt: frontmatter.source.captured_at,
      method: frontmatter.source.method,
    };
  } else if (frontmatter.source !== undefined) {
    candidate.source = frontmatter.source;
  }

  if (Array.isArray(frontmatter.relations)) {
    const relations: unknown[] = frontmatter.relations;
    candidate.relations = relations.map((relation) => {
      if (!isRecord(relation)) return relation;
      return {
        type: relation.type,
        targetId: relation.target_id ?? relation.targetId,
        ...(relation.note === undefined ? {} : { note: relation.note }),
      };
    });
  }

  return migrateMemoryRecord(candidate, options);
}

export function serializeMemory(record: MemoryRecord): string {
  const validated = memoryRecordSchema.parse(record) as MemoryRecord;
  const frontmatter = stringify(toFrontmatter(validated)).trimEnd();
  return `---\n${frontmatter}\n---\n\n${record.content.trim()}\n`;
}

export function parseMemoryFile(source: string, filePath = '<memory>'): MemoryRecord {
  return parseMemoryFileWithMigration(source, filePath).record;
}

export function parseMemoryFileWithMigration(
  source: string,
  filePath = '<memory>',
  options: MemoryMigrationOptions = {},
): MemoryMigrationResult {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid memory file "${filePath}": missing YAML frontmatter`);
  }

  try {
    const yamlSource = match[1];
    const markdownContent = match[2];
    if (yamlSource === undefined || markdownContent === undefined) {
      throw new Error('frontmatter delimiters are incomplete');
    }
    const raw: unknown = parse(yamlSource) as unknown;
    return fromFrontmatter(raw, markdownContent.trim(), options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown validation error';
    throw new Error(`Invalid memory file "${filePath}": ${detail}`, { cause: error });
  }
}
