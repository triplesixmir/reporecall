import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  parseMemoryFile,
  type IndexError,
  type IndexReport,
  type MemoryIndex,
  type MemoryRecord,
  type MemorySourceRoot,
  type RebuildReport,
  type SearchRequest,
  type SearchResult,
  type ValidationReport,
} from '@reporecall/core';

type DatabaseHandle = Database.Database;

export type SqliteMemoryIndexOptions = {
  path: string;
};

type MemoryRow = {
  id: string;
  path: string;
  schema: number;
  scope: MemoryRecord['scope'];
  type: MemoryRecord['type'];
  priority: MemoryRecord['priority'];
  status: MemoryRecord['status'];
  pinned: number;
  created_at: string;
  updated_at: string;
  confidence: number | null;
  project_id: string | null;
  project_root: string | null;
  project_name: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  content: string;
};

type SearchRow = MemoryRow & {
  snippet: string | null;
  rank: number | null;
};

type TagRow = {
  name: string;
  origin: 'user' | 'ai';
  confidence: number | null;
};

type RelationRow = {
  type: MemoryRecord['relations'][number]['type'];
  target_id: string;
  note: string | null;
};

const SCHEMA_SQL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    schema INTEGER NOT NULL,
    scope TEXT NOT NULL,
    type TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL,
    pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    confidence REAL,
    project_id TEXT,
    project_root TEXT,
    project_name TEXT,
    workspace_id TEXT,
    workspace_name TEXT,
    content TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('user', 'ai')),
    confidence REAL,
    PRIMARY KEY (memory_id, name)
  );

  CREATE TABLE IF NOT EXISTS memory_relations (
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY (memory_id, type, target_id)
  );

  CREATE TABLE IF NOT EXISTS indexed_files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    memory_id TEXT,
    indexed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS index_errors (
    path TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS memories_scope_idx ON memories(scope);
  CREATE INDEX IF NOT EXISTS memories_project_idx ON memories(project_id);
  CREATE INDEX IF NOT EXISTS memories_updated_idx ON memories(updated_at DESC);
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED,
    content,
    tags
  );
`;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function asNullable(value: string | number | undefined): string | number | null {
  return value === undefined ? null : value;
}

function toFtsQuery(query: string): string {
  const terms = query.normalize('NFKC').match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ');
}

function snippetFor(content: string, query: string): string {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return content.slice(0, 240);
  const terms = normalizedQuery.split(/\s+/u).filter(Boolean);
  const lower = content.toLocaleLowerCase();
  const position = terms
    .map((term) => lower.indexOf(term.toLocaleLowerCase()))
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, position - 80);
  const end = Math.min(content.length, start + 240);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

function toRecord(row: MemoryRow, tags: TagRow[], relations: RelationRow[]): MemoryRecord {
  const project =
    row.project_id === null || row.project_root === null
      ? undefined
      : {
          id: row.project_id,
          root: row.project_root,
          ...(row.project_name === null ? {} : { name: row.project_name }),
        };
  const workspace =
    row.workspace_id === null
      ? undefined
      : {
          id: row.workspace_id,
          ...(row.workspace_name === null ? {} : { name: row.workspace_name }),
        };

  return {
    schema: row.schema as MemoryRecord['schema'],
    id: row.id,
    scope: row.scope,
    type: row.type,
    priority: row.priority,
    status: row.status,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: tags.map((tag) => ({
      name: tag.name,
      origin: tag.origin,
      ...(tag.confidence === null ? {} : { confidence: tag.confidence }),
    })),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    ...(project === undefined ? {} : { project }),
    ...(workspace === undefined ? {} : { workspace }),
    relations: relations.map((relation) => ({
      type: relation.type,
      targetId: relation.target_id,
      ...(relation.note === null ? {} : { note: relation.note }),
    })),
    content: row.content,
  };
}

function recordsPath(root: string, scope: MemorySourceRoot['scope']): string {
  return resolve(root, scope === 'session' ? 'sessions' : 'memories');
}

export class SqliteMemoryIndex implements MemoryIndex {
  readonly path: string;
  private readonly db: DatabaseHandle;

  constructor(options: SqliteMemoryIndexOptions) {
    this.path = options.path;
    if (options.path !== ':memory:') {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new Database(options.path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  getErrors(): Promise<IndexError[]> {
    const rows = this.db
      .prepare('SELECT path, message FROM index_errors ORDER BY path ASC')
      .all() as unknown as IndexError[];
    return Promise.resolve(rows);
  }

  private async listSourceFiles(sources: MemorySourceRoot[]): Promise<string[]> {
    const paths = new Set<string>();
    for (const source of sources) {
      const root = recordsPath(source.root, source.scope);
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) paths.add(resolve(root, entry.name));
      }
    }
    return [...paths].sort();
  }

  private clear(): void {
    this.db.exec(`
      DELETE FROM memory_fts;
      DELETE FROM memory_relations;
      DELETE FROM memory_tags;
      DELETE FROM memories;
      DELETE FROM indexed_files;
      DELETE FROM index_errors;
    `);
  }

  private removePath(path: string): boolean {
    const indexed = this.db.prepare('SELECT memory_id FROM indexed_files WHERE path = ?').get(path) as
      | { memory_id: string | null }
      | undefined;
    const hadError = this.db.prepare('SELECT 1 FROM index_errors WHERE path = ?').get(path) !== undefined;
    if (indexed?.memory_id !== null && indexed?.memory_id !== undefined) {
      this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(indexed.memory_id);
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(indexed.memory_id);
    } else {
      this.db.prepare('DELETE FROM memories WHERE path = ?').run(path);
    }
    this.db.prepare('DELETE FROM indexed_files WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM index_errors WHERE path = ?').run(path);
    return indexed !== undefined || hadError;
  }

  private storeError(path: string, source: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.db.prepare('DELETE FROM memory_fts WHERE memory_id IN (SELECT id FROM memories WHERE path = ?)').run(path);
    this.db.prepare('DELETE FROM memories WHERE path = ?').run(path);
    this.db.prepare('DELETE FROM index_errors WHERE path = ?').run(path);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO index_errors (path, message, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET message = excluded.message, updated_at = excluded.updated_at`,
      )
      .run(path, message, now);
    this.db
      .prepare(
        `INSERT INTO indexed_files (path, content_hash, memory_id, indexed_at) VALUES (?, ?, NULL, ?)
         ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, memory_id = NULL, indexed_at = excluded.indexed_at`,
      )
      .run(path, hashContent(source), now);
  }

  private storeRecord(path: string, source: string, record: MemoryRecord): void {
    this.removePath(path);
    this.db
      .prepare(
        `INSERT INTO memories (
          id, path, schema, scope, type, priority, status, pinned,
          created_at, updated_at, confidence, project_id, project_root,
          project_name, workspace_id, workspace_name, content
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        path,
        record.schema,
        record.scope,
        record.type,
        record.priority,
        record.status,
        record.pinned ? 1 : 0,
        record.createdAt,
        record.updatedAt,
        asNullable(record.confidence),
        asNullable(record.project?.id),
        asNullable(record.project?.root),
        asNullable(record.project?.name),
        asNullable(record.workspace?.id),
        asNullable(record.workspace?.name),
        record.content,
      );

    const insertTag = this.db.prepare(
      'INSERT INTO memory_tags (memory_id, name, origin, confidence) VALUES (?, ?, ?, ?)',
    );
    for (const tag of record.tags) insertTag.run(record.id, tag.name, tag.origin, asNullable(tag.confidence));

    const insertRelation = this.db.prepare(
      'INSERT INTO memory_relations (memory_id, type, target_id, note) VALUES (?, ?, ?, ?)',
    );
    for (const relation of record.relations) {
      insertRelation.run(record.id, relation.type, relation.targetId, asNullable(relation.note));
    }

    const tagText = record.tags.map((tag) => tag.name).join(' ');
    this.db.prepare('INSERT INTO memory_fts (memory_id, content, tags) VALUES (?, ?, ?)').run(record.id, record.content, tagText);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO indexed_files (path, content_hash, memory_id, indexed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, memory_id = excluded.memory_id, indexed_at = excluded.indexed_at`,
      )
      .run(path, hashContent(source), record.id, now);
    this.db.prepare('DELETE FROM index_errors WHERE path = ?').run(path);
  }

  private async indexPath(path: string): Promise<{ indexed: number; invalid: ValidationReport['invalid'] }> {
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return { indexed: 0, invalid: [] };
      throw error;
    }

    try {
      this.storeRecord(path, source, parseMemoryFile(source, path));
      return { indexed: 1, invalid: [] };
    } catch (error) {
      this.storeError(path, source, error);
      return {
        indexed: 0,
        invalid: [{ path, issues: [{ path: 'file', message: error instanceof Error ? error.message : String(error) }] }],
      };
    }
  }

  async rebuild(sources: MemorySourceRoot[]): Promise<RebuildReport> {
    const files = await this.listSourceFiles(sources);
    const previous = this.db.prepare('SELECT path FROM indexed_files').all() as unknown as Array<{ path: string }>;
    const current = new Set(files);
    const deleted = previous.filter(({ path }) => !current.has(path)).length;
    this.clear();

    let indexed = 0;
    const invalid: ValidationReport['invalid'] = [];
    for (const path of files) {
      const result = await this.indexPath(path);
      indexed += result.indexed;
      invalid.push(...result.invalid);
    }
    return { indexed, invalid, deleted };
  }

  async update(paths: string[]): Promise<IndexReport> {
    let indexed = 0;
    let deleted = 0;
    const invalid: ValidationReport['invalid'] = [];
    for (const inputPath of [...new Set(paths)]) {
      const path = resolve(inputPath);
      let exists = true;
      try {
        await readFile(path);
      } catch (error) {
        if (isNotFound(error)) exists = false;
        else throw error;
      }
      if (!exists) {
        if (this.removePath(path)) deleted += 1;
        continue;
      }
      const result = await this.indexPath(path);
      indexed += result.indexed;
      invalid.push(...result.invalid);
    }
    return { indexed, deleted, invalid };
  }

  search(request: SearchRequest): Promise<SearchResult[]> {
    const ftsQuery = toFtsQuery(request.query);
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (request.scope !== undefined) {
      conditions.push('m.scope = ?');
      params.push(request.scope);
    }
    const projectIds = [
      ...(request.projectId === undefined ? [] : [request.projectId]),
      ...(request.projectIds ?? []),
    ].filter((id, index, values) => id !== '' && values.indexOf(id) === index);
    if (projectIds.length === 1) {
      conditions.push('m.project_id = ?');
      params.push(projectIds[0] as string);
    } else if (projectIds.length > 1) {
      conditions.push(`m.project_id IN (${projectIds.map(() => '?').join(', ')})`);
      params.push(...projectIds);
    }
    if (request.workspaceId !== undefined) {
      conditions.push('m.workspace_id = ?');
      params.push(request.workspaceId);
    }
    if (request.type !== undefined) {
      conditions.push('m.type = ?');
      params.push(request.type);
    }
    if (request.priority !== undefined) {
      conditions.push('m.priority = ?');
      params.push(request.priority);
    }
    if (request.status !== undefined) {
      conditions.push('m.status = ?');
      params.push(request.status);
    }
    if (request.tag !== undefined) {
      conditions.push('EXISTS (SELECT 1 FROM memory_tags filter_tag WHERE filter_tag.memory_id = m.id AND filter_tag.name = ?)');
      params.push(request.tag);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = request.limit ?? 1000;
    let rows: SearchRow[];
    if (ftsQuery) {
      const statement = this.db.prepare(`
        SELECT m.*, snippet(memory_fts, 1, '<mark>', '</mark>', '…', 20) AS snippet,
               bm25(memory_fts) AS rank
        FROM memory_fts
        INNER JOIN memories m ON m.id = memory_fts.memory_id
        WHERE memory_fts MATCH ? ${conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : ''}
        ORDER BY rank ASC, m.updated_at DESC, m.id ASC
        LIMIT ?
      `);
      rows = statement.all(ftsQuery, ...params, limit) as unknown as SearchRow[];
    } else {
      const statement = this.db.prepare(`
        SELECT m.*, m.content AS snippet, 0.0 AS rank
        FROM memories m
        ${where}
        ORDER BY m.updated_at DESC, m.id ASC
        LIMIT ?
      `);
      rows = statement.all(...params, limit) as unknown as SearchRow[];
    }

    const results = rows.map((row) => {
      const tags = this.db
        .prepare('SELECT name, origin, confidence FROM memory_tags WHERE memory_id = ? ORDER BY name ASC')
        .all(row.id) as unknown as TagRow[];
      const relations = this.db
        .prepare('SELECT type, target_id, note FROM memory_relations WHERE memory_id = ? ORDER BY type ASC, target_id ASC')
        .all(row.id) as unknown as RelationRow[];
      return {
        record: toRecord(row, tags, relations),
        snippet: row.snippet ?? snippetFor(row.content, request.query),
        score: Math.max(0, -(row.rank ?? 0)),
      };
    });
    return Promise.resolve(results);
  }
}
