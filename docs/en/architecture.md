# Architecture

RepoRecall is organized around one durable boundary:

```text
Markdown + YAML frontmatter  ->  canonical source of truth
             |
             v
SQLite + FTS5                ->  disposable local index/cache
             |
             v
CLI / local API / MCP / Codex hooks / Web UI
```

## Packages

```text
packages/
  core/          schema, types, serialization, privacy, migrations
  storage/       atomic canonical Markdown stores
  index/         SQLite FTS5 index and incremental updates
  context/       deterministic token-budget context builder
  integrations/  Codex adapter and lifecycle hooks
  processors/    Inbox, duplicate detection, optional providers
  mcp/           model-agnostic stdio MCP server
  cli/           commands, local API, serve runtime, watcher, publishable bundle

apps/web/        React 19 + Vite local workbench
tests/e2e/       browser smoke flows
```

The packages intentionally communicate through plain TypeScript contracts. No package treats an LLM response, transcript format, or SQLite row as durable truth.

The CLI release artifact bundles the internal workspace packages and keeps third-party runtime dependencies in `dependencies`. This makes the npm tarball installable without publishing the internal packages separately.

## Memory contract

`MemoryRecord` is schema version 1. It contains scope, type, priority, lifecycle status, pinning, timestamps, tags, optional project/workspace references, source metadata, relations, confidence, and Markdown content. Zod validates both inputs and parsed files. Unknown or malformed fields produce diagnostics instead of silently rewriting a file.

User tags and AI tags carry different origins. A processor update may add AI tags but cannot remove or replace a user-owned tag with an AI-owned version.

## Canonical paths

Global and project roots contain separate directories for durable memories, Inbox suggestions, sessions, and configuration:

```text
<root>/memories/mem_<id>.md
<root>/inbox/inbox_<id>.md
<root>/sessions/<id>.md
<root>/.reporecall/config.toml       # global root
<project>/.reporecall/config.toml    # project root
```

Writes use a temporary file and rename. A scope update relocates the record between `memories/` and `sessions/` only after the new file has been written. Explicit migrations create a backup before replacing a legacy file.

Project canonical Markdown is intentionally trackable in Git. The generated SQLite file, cache, and runtime markers are ignored; private project memories still require review and a private remote.

## Index lifecycle

`SqliteMemoryIndex.rebuild()` enumerates configured canonical roots, clears derived tables, parses every Markdown record, and recreates FTS5, metadata, tags, relations, file hashes, and error rows. `update(paths)` handles manual edits, atomic rename events, and deletions. Index errors remain inspectable and never modify the source file.

The `serve` watcher observes canonical directories and known files. A debounce collects related changes before an incremental index update. The watcher is best-effort; `rebuild` remains the recovery operation after a deleted or stale SQLite file.

## Context selection

The context builder excludes `archived`, `dismissed`, and `superseded` records unless a caller explicitly changes the filter. It adds required pinned/project-current records first, then ranks remaining records using:

```text
0.30 pinned
0.20 scope match
0.15 unresolved/current status
0.15 priority
0.10 text relevance
0.07 recency
0.03 confidence
```

Tokens are estimated as `ceil(codePointLength / 4)`. One item cannot consume more than 25% of the requested budget and is shortened at a sentence boundary when needed. Ties use `updatedAt`, then stable `id`.

## Integrations

The MCP server consumes stores, an index, and a context builder supplied by the CLI runtime. It returns structured tool data plus a short summary. The Codex adapter calls the official `codex mcp add/remove` command, merges a managed `AGENTS.md` block, and preserves unrelated `hooks.json` handlers.

`SessionStart` and `PostCompact` call the context builder. `SessionEnd` writes a lifecycle marker only. No hook reads or stores a raw transcript and all hook failures are fail-open.

## Privacy boundary

Secret scanning is performed before CLI, API, MCP, or processor writes. Redaction is visible to the user and secret-only content is rejected. This is defense in depth, not a promise of perfect detection; private global brains and sensitive project memories should use private storage and remotes.
