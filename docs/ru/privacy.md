# Модель приватности

RepoRecall local-first, но local не означает автоматически safe. Считайте каждый memory file потенциально sensitive.

## Что сохраняется

- Durable memories — Markdown files с YAML frontmatter.
- Inbox suggestions — local Markdown до accept или dismiss.
- Explicit session checkpoints — Markdown session events.
- Agent-native automatic captures — короткие redacted summaries и structured candidates; durable candidates хранятся как canonical Markdown.
- Session captures для processors redacted и временные; raw transcript не является durable source.
- SQLite содержит derived index и может быть удалён.
- Явный вызов `reporecall process` или `memory_process` может создать Inbox suggestions или durable records, но переданная capture не сохраняется как transcript.

## Secret scanning

Перед CLI, API, MCP и processor write RepoRecall ищет:

- private key blocks и credential-like paths;
- `.env`, credentials, secrets и `.ssh` paths;
- common API-key prefixes, bearer tokens и token assignments.

Найденные spans заменяются на `[REDACTED <kind>]`, возвращается warning. Если полезного контента не осталось, write отклоняется. Scanner консервативен и не обнаружит любой возможный secret format.

## Практики безопасности

1. Проверяйте generated memories перед commit.
2. Держите global brain private и не публикуйте его случайно.
3. Используйте private Git remotes для sensitive project memory.
4. Храните provider credentials в environment, не в TOML или Markdown.
5. Настраивайте ignored paths для директорий, которые нельзя watch/import.
6. Оставляйте processor output в Inbox в `conservative` mode.
7. Не помещайте raw transcripts и credentials в checkpoint content.
8. Считайте `memory_process` и `reporecall process` явными lower-level processor operations; managed Codex agent-native path использует `memory_auto_capture` для коротких structured candidates и никогда не отправляет raw transcript.

Project `memories/`, accepted Inbox records и explicit session checkpoints — canonical Markdown и автоматически не игнорируются. Commit-ьте только records, предназначенные для repository; для sensitive context используйте private remote.

## Hooks и transcripts

Codex lifecycle hooks получают lifecycle input для recall и lifecycle markers. `SessionStart` и `PostCompact` строят context из canonical files, `SessionEnd` пишет небольшой event marker. Agent-native capture передаёт только короткий summary и structured candidates через MCP; RepoRecall не зависит от нестабильного transcript path и не делает silent summary.
