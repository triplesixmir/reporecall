# Интеграции

## MCP

Запуск локального stdio server:

```bash
reporecall mcp
```

Доступны `memory_get_context`, `memory_search`, `memory_get_recent`, `memory_remember`, `memory_update`, `memory_resolve`, `memory_checkpoint`, `memory_process` и `memory_review_inbox`. Каждый ответ содержит structured content и короткое summary.

MCP writes используют те же canonical stores и secret redaction, что CLI. Agent может добавить AI tags, но user-owned tags сохраняются. Durable session event требует явного `memory_checkpoint`.

`memory_process` принимает только явно переданную redacted capture и возвращает
durable records, Inbox suggestions, duplicates, warnings, provider и mode. Он не
читает transcript files. `allowAutomatic` по умолчанию `false`; включайте его
только для конкретного осознанно разрешённого вызова.

## Codex

Adapter поддерживает user-level и project-level installation через официальный Codex MCP command и managed config files. Installation idempotent:

```bash
reporecall codex install --scope user
# или только для одного репозитория:
reporecall codex install --scope project
```

- `codex mcp add` регистрирует local stdio server;
- managed `AGENTS.md` block объясняет source-of-truth и privacy semantics;
- managed `hooks.json` inject-ит context на `SessionStart` и `PostCompact`, lifecycle marker — на `SessionEnd`;
- unrelated user text и hook handlers сохраняются.

Для удаления интеграции используйте `reporecall codex uninstall --scope user`
(или `--scope project`). Удаляются только managed entries RepoRecall.

Hook fail-open. Если index или context builder недоступен, session продолжается, а hook пишет diagnostic, не блокируя agent.

## Processors

Processor kinds: `disabled`, `agent-native`, `ollama`, `openrouter`, `openai-compatible`. HTTP providers используют единый typed contract и environment credentials. Modes:

- `conservative`: explicit records durable, provider suggestions в Inbox;
- `balanced`: high-confidence suggestions могут стать durable;
- `automatic`: opt-in persistence, никогда не default.

CLI-эквивалент — `reporecall process --content "..."` или
`reporecall process --json < capture.json`. Оба entry point используют одинаковые
redaction, duplicate и Inbox rules.

Duplicate detection использует normalized content, type и project identity до processor-assisted relations.

## Generic adapters

Другие harnesses могут использовать MCP contract или реализовать `AgentAdapter` и `ContextBuilder`. В v0.1 нет заявления об automatic transcript capture для non-Codex harnesses.
