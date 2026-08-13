# RepoRecall

> Persistent memory for AI agents, stored where you control it.

[![CI](https://github.com/triplesixmir/reporecall/actions/workflows/ci.yml/badge.svg)](https://github.com/triplesixmir/reporecall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

RepoRecall is a local-first, model-agnostic memory layer for coding agents. It keeps durable memories as readable Markdown files with YAML frontmatter, stores the fast search index in disposable SQLite, and exposes the same contract through a CLI, local API, MCP, and Codex hooks.

The important boundary is simple: Markdown is the source of truth. SQLite can be deleted and rebuilt at any time.

## What v0.1 includes

- Global brain plus project, workspace, and explicit session scopes.
- Versioned schema validation and atomic Markdown writes.
- SQLite FTS5 search with metadata filters, tags, relations, and index diagnostics.
- Deterministic context selection with pinned/project-current boosts and token budgets.
- Safe CLI commands for initialization, remembering, searching, Inbox review, checkpoints, rebuilds, diagnostics, and serving.
- Local loopback Hono API and React/Vite workbench.
- Stdio MCP tools: context, search, recent memories, durable writes, resolve, checkpoint, and Inbox review.
- Codex adapter for MCP registration, managed `AGENTS.md`, and `SessionStart`, `PostCompact`, and `SessionEnd` hooks.
- Optional processors (`agent-native`, Ollama, OpenRouter, and OpenAI-compatible HTTP providers) with conservative mode as the default.
- Secret scanning and redaction before content becomes durable.

## Quick start

Requirements: Node.js `>=22.12.0` and pnpm 11.

```bash
git clone https://github.com/triplesixmir/reporecall.git reporecall
cd reporecall
pnpm install --frozen-lockfile
pnpm check
pnpm exec tsx packages/cli/src/bin.ts init --yes
pnpm exec tsx packages/cli/src/bin.ts remember --type decision --content "Canonical Markdown is the source of truth."
pnpm exec tsx packages/cli/src/bin.ts serve
```

Open `http://127.0.0.1:4317`. `serve` binds to loopback by default and serves the compiled workbench when `apps/web/dist` exists. Use `pnpm build` first for a production asset bundle.

For an installed CLI after building:

```bash
pnpm build
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js status
```

Install the Codex integration for the current user (MCP registration, managed
instructions, and lifecycle hooks):

```bash
reporecall codex install --scope user
reporecall doctor
```

Use `--scope project` to keep the integration inside one repository. If the
Codex executable is not on `PATH`, pass its path with
`--codex-executable /path/to/codex`.

## File-first storage

The canonical layout is intentionally inspectable:

```text
~/.reporecall/brain/
  memories/mem_<uuid>.md
  inbox/inbox_<uuid>.md
  sessions/<id>.md
  .reporecall/config.toml

your-project/
  .reporecall/
    memories/mem_<uuid>.md
    inbox/inbox_<uuid>.md
    sessions/<id>.md
    config.toml
```

Project memory belongs in the project checkout and can be committed. The global brain is user-level and should normally remain on a private filesystem or private remote. Session captures are redacted and temporary; no raw transcript is saved, and a durable session summary is created only by an explicit checkpoint.

## Scopes and context

| Scope       | Durable location                 | Typical use                                        |
| ----------- | -------------------------------- | -------------------------------------------------- |
| `global`    | global brain                     | personal conventions and cross-project preferences |
| `workspace` | configured project memory root   | shared local workspace context                     |
| `project`   | `<project>/.reporecall/memories` | repository decisions and constraints               |
| `session`   | `<project>/.reporecall/sessions` | explicit checkpoints and lifecycle events          |

Context building is deterministic. Archived, dismissed, and superseded records are excluded by default. Pinned and project-current records are considered first; remaining records are ranked by scope, status, priority, relevance, recency, confidence, and stable tie-breakers until the token budget is full.

## CLI

```text
reporecall init                 initialize project memory and managed guidance
reporecall brain init           initialize a custom global brain
reporecall status               validate files and report index health
reporecall doctor               check runtime and storage health
reporecall remember <text>      create an explicit durable memory
reporecall search <query>       search the local SQLite index
reporecall inbox                list pending processor suggestions
reporecall rebuild              rebuild SQLite from canonical Markdown
reporecall config               print resolved configuration
reporecall checkpoint <summary> persist an explicit session checkpoint
reporecall serve                run the loopback API, UI, and watcher
reporecall mcp                  run the stdio MCP server
reporecall codex install       install the Codex MCP server and managed hooks
reporecall codex uninstall     remove only RepoRecall-managed Codex settings
reporecall codex-hook <event>   handle a Codex lifecycle hook
```

Paths and behavior can be changed with CLI flags or TOML configuration. Precedence is CLI, project, brain, user, then platform defaults. The default brain is `~/.reporecall/brain` and the default API port is `4317`.

## API, MCP, and Codex

`reporecall serve` provides a local API for the workbench: memory CRUD, recent records, projects, tags, Inbox actions, relation graph, overview, and health. The API is intentionally loopback-only unless a caller explicitly supplies another hostname through the server API.

The MCP server is model-agnostic and returns both structured data and a short human-readable summary. MCP writes preserve user-owned tags and run the same redaction rules as the CLI.

The Codex adapter installs the MCP command and managed blocks without overwriting user text or unrelated hooks. `reporecall codex install --scope user` is the supported entry point; `SessionStart` and `PostCompact` inject deterministic context. `SessionEnd` writes only a lifecycle marker. Hook failures are fail-open, and no unstable transcript format is required.

This is automatic context retrieval, not silent memory creation. An agent can
write a durable record explicitly with `memory_remember` or `reporecall
remember`; a durable session summary requires an explicit checkpoint. The
default processor is disabled for privacy. Enable a processor deliberately if
you want suggestions in Inbox.

## Privacy and processors

RepoRecall scans for private keys, credential paths, API-key prefixes, bearer tokens, and common token assignments. Detected secrets are replaced with a visible redaction marker and a warning. A write made only of secret material is rejected. Detection is a safety layer, not a guarantee: review memories before committing them.

Processors are optional. `conservative` mode is the default: explicit durable records are written, while processor suggestions go to Inbox. `balanced` and `automatic` require deliberate configuration; automatic persistence is opt-in. Provider credentials are read from environment variables and never stored in memory files.

## Web workbench

The local React workbench includes:

- Overview with memory, project, active-context, and Inbox metrics.
- Memories with URL-synchronized search and filters, CRUD editor, tags, status, priority, scope, pinning, and secret warnings.
- Projects, Recent, Inbox review, relation Graph, and Settings screens.
- Semantic controls, visible loading/empty/error states, keyboard-accessible editor focus, and responsive layouts for 320, 768, 1024, and 1440px.

The graph is a projection of indexed relations. It is not another storage system.

## Git and cross-device workflow

1. Machine A runs `remember` or saves a memory in the workbench.
2. Commit the relevant project `.reporecall/memories/*.md` files.
3. Machine B pulls or clones the repository.
4. Machine B runs `reporecall rebuild` to create a local SQLite index.
5. The same context builder retrieves the shared Markdown memory without copying SQLite or machine-specific paths.

Keep private global memories out of public repositories. Use private remotes when project memory contains sensitive context.

For a personal multi-device setup, keep these repositories separate:

| Repository | Visibility | Contents |
| ---------- | ---------- | -------- |
| `triplesixmir/reporecall` | public | source, tests, CI, bilingual documentation |
| `triplesixmir/reporecall-private-memory` | private | your Markdown brain and safe RepoRecall config |

On a fresh Windows machine, clone the private brain first and then initialize
the project that should use it:

```powershell
$Brain = Join-Path $env:USERPROFILE ".reporecall\brain"
git clone git@github.com:triplesixmir/reporecall-private-memory.git $Brain
reporecall brain init --brain $Brain
cd C:\path\to\your-project
reporecall init --yes --brain $Brain
reporecall rebuild --brain $Brain
reporecall codex install --scope user
reporecall doctor
```

The public source checkout is installed separately with Node.js and pnpm. Pull
the private brain before using a second machine, and push only after reviewing
the Markdown changes. Do not copy or commit SQLite files.

## Limitations and roadmap

v0.1 intentionally has no cloud backend, accounts, billing, telemetry, embeddings, vector database, mobile app, or team collaboration. Claude Code and other harnesses can use the generic MCP contract, but Codex is the first adapter with automated lifecycle installation.

Next areas are stronger import/export tooling, richer relation editing, broader adapter coverage, and additional accessibility and cross-platform verification.

## Documentation

- [Architecture (EN)](docs/en/architecture.md) · [Архитектура (RU)](docs/ru/architecture.md)
- [Getting started](docs/en/getting-started.md) · [Быстрый старт](docs/ru/getting-started.md)
- [CLI and configuration](docs/en/cli.md) · [CLI и конфигурация](docs/ru/cli.md)
- [Privacy](docs/en/privacy.md) · [Приватность](docs/ru/privacy.md)
- [Integrations](docs/en/integrations.md) · [Интеграции](docs/ru/integrations.md)
- [Release verification](docs/en/release.md) · [Проверка релиза](docs/ru/release.md)

## Development

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. RepoRecall is released under the [MIT License](LICENSE).
