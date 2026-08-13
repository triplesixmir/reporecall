# Privacy model

RepoRecall is local-first, but local does not mean automatically safe. Treat every memory file as potentially sensitive.

## What is persisted

- Durable memories are Markdown files with YAML frontmatter.
- Inbox suggestions are local Markdown files until accepted or dismissed.
- Explicit session checkpoints are Markdown session events.
- Session captures used by processors are redacted and temporary; raw transcripts are not a durable source.
- SQLite contains derived index data and can be deleted.
- An explicit `reporecall process` or `memory_process` call may create Inbox suggestions or durable records, but the supplied capture is never persisted as a transcript.

## Secret scanning

Before a CLI, API, MCP, or processor write, RepoRecall scans for:

- private key blocks and credential-like paths;
- `.env`, credentials, secrets, and `.ssh` paths;
- common API-key prefixes, bearer tokens, and token assignments.

Detected spans are replaced with `[REDACTED <kind>]` and a warning is returned. If nothing useful remains, the write is rejected. The scanner is intentionally conservative and cannot detect every secret format.

## Safe operating practices

1. Review generated memories before committing them.
2. Keep global brain directories private and never publish them by accident.
3. Use private Git remotes for sensitive project memory.
4. Keep provider credentials in environment variables, not TOML or Markdown.
5. Use ignored paths for repositories and folders that should not be watched.
6. Treat processor output as a suggestion in `conservative` mode.
7. Do not put raw transcripts or credentials into checkpoint content.
8. Treat `memory_process` and `reporecall process` as explicit operations; Codex hooks only retrieve context and do not submit captures automatically.

Project `memories/`, accepted Inbox records, and explicit session checkpoints are canonical Markdown and are not ignored automatically. Commit only the records that belong in the repository; use a private remote when they contain sensitive context.

## Hooks and transcripts

Codex lifecycle hooks receive lifecycle input only. `SessionStart` and `PostCompact` build context from canonical files; `SessionEnd` writes a small event marker. RepoRecall does not depend on an unstable transcript path or silently summarize a conversation.
