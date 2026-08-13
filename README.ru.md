# RepoRecall

> Постоянная память для AI-агентов, хранящаяся там, где её контролируете вы.

[![CI](https://github.com/triplesixmir/reporecall/actions/workflows/ci.yml/badge.svg)](https://github.com/triplesixmir/reporecall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

RepoRecall — локальный, независимый от модели слой памяти для coding agents. Durable-записи хранятся в читаемых Markdown-файлах с YAML frontmatter, быстрый локальный индекс — в удаляемом SQLite, а единый контракт доступен через CLI, локальный API, MCP и Codex hooks.

Главная граница системы проста: Markdown — единственный source of truth. SQLite можно удалить и полностью восстановить в любой момент.

## Что входит в v0.1

- Global brain, project, workspace и явный session scope.
- Версионируемая схема, валидация и atomic Markdown writes.
- SQLite FTS5, фильтры по metadata, tags, relations и диагностика индекса.
- Детерминированная сборка контекста с приоритетом pinned/project-current и token budget.
- Безопасные CLI-команды для init, remember, search, Inbox, checkpoint, rebuild, doctor и serve.
- Loopback Hono API и React/Vite workbench.
- Stdio MCP tools для context, search, recent, durable writes, resolve, checkpoint, explicit processing и Inbox.
- Codex adapter для MCP, managed `AGENTS.md` и hooks `SessionStart`, `PostCompact`, `SessionEnd`.
- Опциональные processors: `agent-native`, Ollama, OpenRouter и OpenAI-compatible HTTP providers.
- Secret scanner и redaction до записи в durable storage.

## Быстрый старт

Требования: Node.js `>=22.12.0` и pnpm 11.

```bash
git clone https://github.com/triplesixmir/reporecall.git reporecall
cd reporecall
pnpm install --frozen-lockfile
pnpm check
pnpm exec tsx packages/cli/src/bin.ts init --yes
pnpm exec tsx packages/cli/src/bin.ts remember --type decision --content "Canonical Markdown is the source of truth."
pnpm exec tsx packages/cli/src/bin.ts serve
```

Откройте `http://127.0.0.1:4317`. Команда `serve` по умолчанию слушает только loopback и отдаёт собранный workbench, если существует `apps/web/dist`. Для production bundle сначала выполните `pnpm build`.

После сборки CLI можно запускать так:

```bash
pnpm build
node packages/cli/dist/bin.js doctor
node packages/cli/dist/bin.js status
```

Установить интеграцию с Codex для текущего пользователя (MCP, managed
instructions и lifecycle hooks):

```bash
reporecall codex install --scope user
reporecall doctor
```

`--scope project` ограничивает интеграцию одним репозиторием. Если executable
Codex не находится в `PATH`, укажите его через
`--codex-executable /path/to/codex`.

## File-first storage

Canonical layout остаётся inspectable и Git-friendly:

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

Project memory живёт рядом с checkout и может коммититься. Global brain обычно остаётся на private filesystem или private remote. Session captures redacted и временные: raw transcript не сохраняется, а durable summary появляется только после явного checkpoint.

## Scope и context

| Scope       | Durable location                 | Типичное назначение                            |
| ----------- | -------------------------------- | ---------------------------------------------- |
| `global`    | global brain                     | личные conventions и cross-project preferences |
| `workspace` | настроенный project root         | общий local workspace context                  |
| `project`   | `<project>/.reporecall/memories` | решения и ограничения репозитория              |
| `session`   | `<project>/.reporecall/sessions` | явные checkpoints и lifecycle events           |

Context builder работает детерминированно. `archived`, `dismissed` и `superseded` по умолчанию исключаются. Сначала рассматриваются pinned и project-current записи, затем остальные ранжируются по scope, status, priority, relevance, recency, confidence и стабильным tie-breaker до заполнения token budget.

## CLI

```text
reporecall init                 инициализировать project memory и managed guidance
reporecall brain init           инициализировать custom global brain
reporecall status               проверить files и health индекса
reporecall doctor               проверить runtime и storage
reporecall remember <text>      создать явную durable memory
reporecall process --content    обработать явный redacted capture
reporecall search <query>       искать в локальном SQLite index
reporecall inbox                показать processor suggestions
reporecall rebuild              пересобрать SQLite из Markdown
reporecall config               показать resolved configuration
reporecall checkpoint <summary> сохранить явный session checkpoint
reporecall serve                запустить loopback API, UI и watcher
reporecall mcp                  запустить stdio MCP server
reporecall codex install       установить Codex MCP и managed hooks
reporecall codex uninstall     удалить только настройки RepoRecall в Codex
reporecall codex-hook <event>   обработать Codex lifecycle hook
```

Пути и поведение настраиваются через CLI flags и TOML. Приоритет: CLI, project, brain, user, platform defaults. Global brain по умолчанию — `~/.reporecall/brain`, порт API — `4317`.

## API, MCP и Codex

`reporecall serve` поднимает локальный API для workbench: memory CRUD, recent, projects, tags, Inbox actions, relation graph, overview и health. По умолчанию API loopback-only.

MCP server model-agnostic и возвращает structured data вместе с коротким human-readable summary. MCP writes сохраняют user-owned tags и используют те же redaction rules, что CLI.

Codex adapter устанавливает MCP command и managed blocks, не перезаписывая пользовательский текст и unrelated hooks. Поддерживаемая точка входа — `reporecall codex install --scope user`; `SessionStart` и `PostCompact` инжектируют детерминированный context. `SessionEnd` пишет только lifecycle marker. При ошибке hook работает fail-open и не зависит от нестабильного transcript format.

Это automatic retrieval контекста, а не тихое создание памяти. Agent явно пишет
durable record через `memory_remember` или `reporecall remember`; durable summary
сессии появляется только после явного checkpoint. По умолчанию processor отключён
ради privacy. Если нужны suggestions, processor включается отдельно и пишет их
в Inbox.

Явную capture можно обработать через `reporecall process --content "..."` или
передать JSON в stdin с флагом `--json`. Provider получает только redacted
content; в `conservative` mode suggestions попадают в Inbox. Для конкретного
запуска `automatic` нужен явный `--allow-automatic`. Сама capture временная и
никогда не сохраняется как session transcript.

## Privacy и processors

RepoRecall проверяет private keys, credential paths, API-key prefixes, bearer tokens и типичные token assignments. Секреты заменяются видимым redaction marker с предупреждением. Запись, состоящая только из secret material, отклоняется. Это safety layer, а не гарантия: generated memories нужно проверять перед commit.

Processors опциональны. Режим `conservative` — default: explicit durable records сохраняются, processor suggestions попадают в Inbox. `balanced` и `automatic` включаются осознанно; automatic persistence не является default. Credentials providers читаются из environment и не попадают в Markdown.

## Web workbench

Локальный React workbench содержит:

- Overview с memory, project, active-context и Inbox metrics.
- Memories с URL-синхронизированными search/filter, CRUD editor, tags, status, priority, scope, pinning и secret warnings.
- Projects, Recent, Inbox review, relation Graph и Settings.
- Semantic controls, явные loading/empty/error states, keyboard-accessible focus editor и responsive layout для 320, 768, 1024 и 1440px.

Graph — projection indexed relations, а не отдельное хранилище.

## Git и cross-device workflow

1. Machine A создаёт memory через `remember` или workbench.
2. Commit-ит project `.reporecall/memories/*.md`.
3. Machine B делает pull или clone.
4. Machine B запускает `reporecall rebuild`.
5. Тот же context builder получает memory из Markdown без копирования SQLite и machine-specific paths.

Private global memories не должны попадать в public repositories. Для sensitive project memory используйте private remotes.

Для личной работы на нескольких устройствах держите два репозитория
раздельно:

| Репозиторий | Visibility | Содержимое |
| ----------- | ---------- | ---------- |
| `triplesixmir/reporecall` | public | source, tests, CI, bilingual documentation |
| `YOUR_GITHUB_USER/reporecall-private-memory` | private | ваш Markdown brain и safe RepoRecall config |

На новом Windows-компьютере сначала клонируйте private brain, затем подключите
его к проекту:

```powershell
$Brain = Join-Path $env:USERPROFILE ".reporecall\brain"
git clone git@github.com:YOUR_GITHUB_USER/reporecall-private-memory.git $Brain
reporecall brain init --brain $Brain
cd C:\path\to\your-project
reporecall init --yes --brain $Brain
reporecall rebuild --brain $Brain
reporecall codex install --scope user
reporecall doctor
```

Public source checkout устанавливается отдельно через Node.js и pnpm. Перед
работой на втором устройстве подтяните private brain, а перед push проверьте
изменения Markdown. SQLite нельзя копировать или коммитить.

## Ограничения и roadmap

В v0.1 нет cloud backend, accounts, billing, telemetry, embeddings, vector DB, mobile app и team collaboration. Claude Code и другие harnesses могут использовать generic MCP contract, но Codex — первый adapter с автоматизированной lifecycle installation.

Дальше: более сильные import/export tools, richer relation editing, больше adapters и дополнительные accessibility/cross-platform checks.

## Документация

- [Architecture (EN)](docs/en/architecture.md) · [Архитектура (RU)](docs/ru/architecture.md)
- [Getting started](docs/en/getting-started.md) · [Быстрый старт](docs/ru/getting-started.md)
- [CLI and configuration](docs/en/cli.md) · [CLI и конфигурация](docs/ru/cli.md)
- [Privacy](docs/en/privacy.md) · [Приватность](docs/ru/privacy.md)
- [Integrations](docs/en/integrations.md) · [Интеграции](docs/ru/integrations.md)
- [Release verification](docs/en/release.md) · [Проверка релиза](docs/ru/release.md)

## Разработка

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
```

Перед изменениями прочитайте [CONTRIBUTING.md](CONTRIBUTING.md). RepoRecall распространяется по [MIT License](LICENSE).
