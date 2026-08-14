# Архитектура

RepoRecall построен вокруг одной durable-границы:

```text
Markdown + YAML frontmatter  ->  canonical source of truth
             |
             v
SQLite + FTS5                ->  disposable local index/cache
             |
             v
CLI / local API / MCP / Codex hooks / Web UI
```

## Пакеты

```text
packages/
  core/          схема, типы, serialization, privacy, migrations
  storage/       atomic canonical Markdown stores
  index/         SQLite FTS5 и incremental updates
  context/       deterministic context builder с token budget
  integrations/  Codex adapter и lifecycle hooks
  processors/    Inbox, duplicate detection, optional providers
  mcp/           model-agnostic stdio MCP server
  cli/           commands, local API, serve runtime, watcher, publishable bundle

apps/web/        React 19 + Vite local workbench
tests/e2e/       browser smoke flows
```

Пакеты общаются через plain TypeScript contracts. Ни один пакет не считает ответ LLM, transcript format или SQLite row durable truth.

Release artifact CLI включает внутренние workspace-пакеты в bundle и оставляет third-party runtime dependencies в `dependencies`. Поэтому npm tarball устанавливается без отдельной публикации внутренних пакетов.

## Memory contract

`MemoryRecord` — schema version 1: scope, type, priority, lifecycle status, pinning, timestamps, tags, project/workspace refs, source metadata, relations, confidence и Markdown content. Zod проверяет inputs и parsed files. Неизвестные или malformed fields дают diagnostics и не переписывают файл молча.

User tags и AI tags имеют разные origins. Processor может добавить AI tag, но не может заменить или удалить user-owned tag.

## Canonical paths

Global и project roots содержат отдельные directories для memories, Inbox, sessions и config:

```text
<root>/memories/mem_<id>.md
<root>/inbox/inbox_<id>.md
<root>/sessions/<id>.md
<root>/.reporecall/config.toml       # global root
<project>/.reporecall/config.toml    # project root
```

Write выполняется через temporary file и rename. Scope update перемещает запись между `memories/` и `sessions/` только после успешной записи нового файла. Явная migration создаёт backup перед заменой legacy file.

Project canonical Markdown намеренно можно track в Git. Generated SQLite, cache и runtime markers игнорируются; private project memories всё равно нужно проверять и отправлять в private remote.

## Automatic project bootstrap

Перед project-aware работой CLI находит Git top-level directory. Если
`<project-root>/.reporecall/project.md` отсутствует, он атомарно создаётся на
`SessionStart`, `PostCompact`, `mcp`, `serve` и project-aware CLI commands.
Manifest отделён от memory files и не индексируется как memory.

Для репозитория с remote project ID имеет вид `proj_git_<sha256>` и получается
из normalized host/path fingerprint. SSH и HTTPS формы одного remote дают один
ID. Без remote RepoRecall один раз создаёт `proj_local_<uuid>` и сохраняет его
в manifest. Raw remote, absolute root, credentials и transcripts туда не
попадают. Старые basename-based memory IDs остаются discoverable через runtime
aliases, поэтому старые Markdown не нужно переписывать.

`SessionEnd` не bootstrap-ит новый project: lifecycle marker пишется только если
manifest уже существует. Остальные hook failures работают fail-open.

## Жизненный цикл индекса

`SqliteMemoryIndex.rebuild()` перечисляет настроенные canonical roots, очищает derived tables, парсит Markdown и заново создаёт FTS5, metadata, tags, relations, file hashes и error rows. `update(paths)` обрабатывает ручные edits, atomic rename events и deletions. Index errors видимы и не меняют source files.

Watcher команды `serve` наблюдает canonical directories и известные files. Debounce объединяет связанные изменения перед incremental update. Если SQLite удалён или устарел, recovery operation — `rebuild`.

## Context selection

Context builder по умолчанию исключает `archived`, `dismissed` и `superseded`. Сначала добавляются обязательные pinned/project-current записи, затем остальные ранжируются:

```text
0.30 pinned
0.20 scope match
0.15 unresolved/current status
0.15 priority
0.10 text relevance
0.07 recency
0.03 confidence
```

Token estimate: `ceil(codePointLength / 4)`. Один item не занимает больше 25% бюджета и при необходимости обрезается по границе предложения. Tie-breakers: `updatedAt`, затем стабильный `id`.

## Интеграции

MCP получает stores, index и context builder от CLI runtime. Он возвращает structured tool data и короткое summary. Codex adapter вызывает официальный `codex mcp add/remove`, добавляет managed `AGENTS.md` block и сохраняет unrelated handlers в `hooks.json`.

`SessionStart` и `PostCompact` вызывают context builder. `SessionEnd` пишет только lifecycle marker. Hook не сохраняет raw transcript и работает fail-open.

## Privacy boundary

Перед writes из CLI, API, MCP и processors выполняется secret scan. Redaction видим пользователю, secret-only content отклоняется. Это defense-in-depth, а не гарантия идеального detection; private brain и sensitive project memory нужно хранить в private storage/remotes.
