# CLI и конфигурация

## Команды

| Команда      | Назначение                                                     |
| ------------ | -------------------------------------------------------------- |
| `init`       | Создать project memory directories, config и managed guidance. |
| `brain init` | Создать global brain в resolved или custom path.               |
| `status`     | Проверить canonical files и index errors.                      |
| `doctor`     | Проверить Node.js version, storage и index health.             |
| `remember`   | Записать explicit durable memory после redaction.              |
| `process`    | Обработать явно переданную redacted capture.                   |
| `search`     | Искать в SQLite index.                                         |
| `inbox`      | Показать pending processor suggestions.                        |
| `rebuild`    | Пересоздать disposable index из Markdown.                      |
| `config`     | Показать resolved TOML configuration как JSON.                 |
| `checkpoint` | Сохранить явный session event.                                 |
| `serve`      | Запустить API, compiled UI, watcher и local index.             |
| `mcp`        | Запустить stdio MCP server.                                    |
| `codex install`   | Установить Codex MCP и managed lifecycle hooks.            |
| `codex uninstall` | Удалить только настройки RepoRecall в Codex.               |
| `codex-hook` | Обработать `SessionStart`, `PostCompact` или `SessionEnd`.     |

В checkout используйте `pnpm exec tsx packages/cli/src/bin.ts`. После build — `node packages/cli/dist/bin.js`.

## Явный processor workflow

Обработайте явно переданную capture через локальный marker provider:

```bash
reporecall process \
  --processor agent-native \
  --content "Decision: keep Markdown canonical."
```

Для structured input передайте JSON с `content` и optional-полями
`capturedAt`, `sessionId`, `project`, `workspace` и `explicit`:

```bash
reporecall process --processor agent-native --json < capture.json
```

Capture проверяется локально до provider invocation. В `conservative` mode
provider suggestions записываются в Markdown Inbox; `balanced` может сохранить
high-confidence suggestions; `automatic` требует и настройки automatic mode,
и флага `--allow-automatic` для конкретного запуска. Explicit items становятся
durable по своему scope. Raw capture не записывается в `sessions/`, hooks не
вызывают эту команду неявно.

Можно выбрать `ollama`, `openrouter` или `openai-compatible`. Credentials
остаются в environment variables. `--json` возвращает durable records, Inbox,
duplicates, warnings, provider и mode.

## Configuration

Resolved configuration выглядит так:

```toml
brain_path = "~/.reporecall/brain"
project_memory_dir = ".reporecall"
index_path = "index.sqlite"
port = 4317
ignored_paths = ["node_modules", ".git", "dist", "coverage"]
processor = "disabled"
processor_mode = "conservative"
```

Relative paths разрешаются относительно config file, который их объявил. `~` расширяется через configured home. CLI overrides применяются последними. `config` — безопасный способ проверить effective configuration.

## Exit behavior

- `0`: операция завершилась успешно.
- `1`: ошибка команды или validation failure.
- `2`: memory write или processor capture отклонены из-за empty или secret-only content.

`serve` даёт понятную ошибку, если hostname или port недоступны. `codex-hook` fail-open и возвращает `0`, сообщая об ошибке в stderr.

Обычная команда установки Codex — `reporecall codex install --scope user`.
Для установки только в одном репозитории используйте `--scope project`. Если
Codex не находится в `PATH`, передайте `--codex-executable <path>`.

## API development

`createApiApp(runtime)` возвращает Hono app без TCP bind, поэтому routes тестируются через `app.request()`. `startServe(config)` добавляет rebuild, static assets, watcher и loopback HTTP lifecycle.
