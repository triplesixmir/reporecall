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
- Stdio MCP tools: context, search, recent memories, automatic agent capture, durable writes, resolve, checkpoint, explicit processing, and Inbox review.
- Codex adapter for MCP registration, managed `AGENTS.md`, and `SessionStart`, `PostCompact`, and `SessionEnd` hooks.
- Automatic project bootstrap: the first Codex session creates and reuses a stable project identity without a per-project setup command.
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

After this one-time installation, open Codex in any repository. RepoRecall finds
the Git root, creates `.reporecall/project.md` and the local project scope when
needed, and reuses that project identity on later sessions. `reporecall init`
remains useful for explicit setup, a custom brain path, or managed `AGENTS.md`;
it is not required for every new repository.

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
    project.md                  # stable project metadata; safe to commit
    memories/mem_<uuid>.md
    inbox/inbox_<uuid>.md
    sessions/<id>.md
    config.toml
```

Project memory belongs in the project checkout and can be committed. The global brain is user-level and should normally remain on a private filesystem or private remote. Agent-native captures are concise and redacted; no raw transcript is saved, and a durable session summary is created only by an explicit checkpoint.

The project manifest is not a memory and is not indexed as one. For Git-backed
projects its ID is derived from a normalized remote fingerprint; for local-only
folders it is a UUID persisted in `project.md`. The manifest never stores the
raw remote, absolute machine path, credentials, or transcript.

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
reporecall process --content    process an explicit redacted capture
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

The workbench is multi-project. A successful Codex `SessionStart` registers the
current checkout in a small local runtime registry. `serve` then reads the
global brain and the registered projects' `.reporecall` Markdown directories,
so memories from several repositories appear in one local UI. The registry
stores only local discovery metadata and is not a memory source, is not copied
into the public repository, and can be recreated by opening the projects in
Codex again. Project Markdown remains in its own repository; it is never
silently copied into the global brain.

The MCP server is model-agnostic and returns both structured data and a short human-readable summary. MCP writes preserve user-owned tags and run the same redaction rules as the CLI.

The Codex adapter installs the MCP command and managed blocks without overwriting user text or unrelated hooks. `reporecall codex install --scope user` is the supported entry point. `SessionStart` and `PostCompact` inject deterministic context, while the managed instructions ask the agent to call `memory_auto_capture` after meaningful tasks; the user does not need to type a memory command. `SessionEnd` writes only a lifecycle marker. Hook failures are fail-open, and no unstable transcript format is required.

`memory_auto_capture` receives a short redacted task summary and structured
agent-selected candidates. Explicit candidates are written to canonical
Markdown and indexed immediately; provider-generated suggestions still follow
the configured processor mode and conservative mode routes them to Inbox. The
default processor is disabled for privacy, but agent-selected candidates do not
need an external provider. Use `memory_remember` or `reporecall remember` for
direct explicit writes, and use `memory_checkpoint` for a durable session event.

To process a capture explicitly, use `reporecall process --content "..."` or
pipe a JSON capture to `reporecall process --json`. The command sends only
redacted content to the configured provider; conservative mode routes provider
suggestions to Inbox. `--allow-automatic` is required for an automatic-mode
invocation. The capture itself is temporary and is never written as a session
transcript.

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

1. Machine A opens the repository in Codex; the first session creates `.reporecall/project.md` automatically.
2. Machine A runs `remember` or saves a memory in the workbench.
3. Commit `project.md` and the relevant project `.reporecall/memories/*.md` files.
4. Machine B pulls or clones the repository.
5. Machine B runs `reporecall rebuild` to create a local SQLite index, or starts Codex and lets the hook rebuild it.
6. The same context builder retrieves the shared Markdown memory without copying SQLite or machine-specific paths.

Keep private global memories out of public repositories. Use private remotes when project memory contains sensitive context.

For a personal multi-device setup, keep these repositories separate:

| Repository                                   | Visibility | Contents                                       |
| -------------------------------------------- | ---------- | ---------------------------------------------- |
| `triplesixmir/reporecall`                    | public     | source, tests, CI, bilingual documentation     |
| `YOUR_GITHUB_USER/reporecall-private-memory` | private    | your Markdown brain and safe RepoRecall config |

On a fresh Windows machine, clone the private brain first and then initialize
the project that should use it:

```powershell
$Brain = Join-Path $env:USERPROFILE ".reporecall\brain"
git clone git@github.com:YOUR_GITHUB_USER/reporecall-private-memory.git $Brain
reporecall brain init --brain $Brain
cd C:\path\to\your-project
reporecall codex install --scope user
reporecall doctor
```

Start Codex in the project afterward. It creates the project scope
automatically. `reporecall init --yes --brain $Brain` is still available when
you want to create the managed `AGENTS.md` block before the first session.

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
