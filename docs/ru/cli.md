# CLI и конфигурация

## Команды

| Команда      | Назначение                                                     |
| ------------ | -------------------------------------------------------------- |
| `init`       | Создать project memory directories, config и managed guidance. |
| `brain init` | Создать global brain в resolved или custom path.               |
| `status`     | Проверить canonical files и index errors.                      |
| `doctor`     | Проверить Node.js version, storage и index health.             |
| `remember`   | Записать explicit durable memory после redaction.              |
| `search`     | Искать в SQLite index.                                         |
| `inbox`      | Показать pending processor suggestions.                        |
| `rebuild`    | Пересоздать disposable index из Markdown.                      |
| `config`     | Показать resolved TOML configuration как JSON.                 |
| `checkpoint` | Сохранить явный session event.                                 |
| `serve`      | Запустить API, compiled UI, watcher и local index.             |
| `mcp`        | Запустить stdio MCP server.                                    |
| `codex-hook` | Обработать `SessionStart`, `PostCompact` или `SessionEnd`.     |

В checkout используйте `pnpm exec tsx packages/cli/src/bin.ts`. После build — `node packages/cli/dist/bin.js`.

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
- `2`: memory write отклонён из-за empty или secret-only content.

`serve` даёт понятную ошибку, если hostname или port недоступны. `codex-hook` fail-open и возвращает `0`, сообщая об ошибке в stderr.

## API development

`createApiApp(runtime)` возвращает Hono app без TCP bind, поэтому routes тестируются через `app.request()`. `startServe(config)` добавляет rebuild, static assets, watcher и loopback HTTP lifecycle.
