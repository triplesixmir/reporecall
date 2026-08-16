# Integrations

## MCP

Run the local stdio server:

```bash
reporecall mcp
```

The server exposes `memory_get_context`, `memory_search`, `memory_get_recent`, `memory_auto_capture`, `memory_remember`, `memory_update`, `memory_resolve`, `memory_checkpoint`, `memory_process`, and `memory_review_inbox`. Every response contains structured content and a concise summary.

MCP writes use the same canonical stores and secret redaction as the CLI. Agents can add AI tags, but user-owned tags are preserved. A durable session event requires the explicit `memory_checkpoint` tool.

`memory_auto_capture` is the normal Codex agent-native path. After meaningful
work, the managed instructions ask the agent to send a concise redacted summary
and a `memories` array of structured candidates. Explicit candidates become
durable Markdown records and are indexed immediately; provider suggestions
still follow the configured processor mode. Trivial turns should not call the
tool.

`memory_process` remains the lower-level processor workflow for an explicitly
supplied redacted capture and returns durable records, Inbox suggestions,
duplicates, warnings, provider, and mode. Neither tool reads or stores
transcript files. A durable session event still requires the explicit
`memory_checkpoint` tool.

## Codex

The adapter supports user-level or project-level installation through the official Codex MCP command and managed configuration files. Installation is designed to be idempotent:

```bash
reporecall codex install --scope user
# or, for one repository only:
reporecall codex install --scope project
```

- `codex mcp add` registers the local stdio server;
- a managed `AGENTS.md` block explains source-of-truth, privacy, automatic capture, and recall semantics;
- managed `hooks.json` entries inject context at `SessionStart` and `PostCompact` and write a lifecycle marker at `SessionEnd`;
- unrelated user text and hook handlers remain intact.

To remove the integration, run `reporecall codex uninstall --scope user` (or
`--scope project`). Only RepoRecall-managed entries are removed.

The hook executable is fail-open. If the index or context builder is unavailable, the session continues and the hook reports a diagnostic instead of blocking the agent.

After the one-time installation, project setup is automatic. On `SessionStart`
or `PostCompact`, RepoRecall finds the Git root, creates the project manifest
and canonical scope directories if needed, rebuilds the disposable index, and
injects context using the stable project ID. A Git remote keeps the ID stable
across clones; local-only projects persist a UUID in `project.md`. No raw
remote, machine path, or transcript is written to that manifest.

`SessionStart` and `PostCompact` are the automatic recall path. The agent-native
capture path does not parse or persist the Codex transcript, so it remains
model-actionable without depending on an unstable transcript format.

## Processors

Processor kinds are `disabled`, `agent-native`, `ollama`, `openrouter`, and `openai-compatible`. HTTP providers use one typed request/response contract and environment-variable credentials. Modes are:

- `conservative`: explicit records durable; provider suggestions go to Inbox;
- `balanced`: high-confidence suggestions may become durable;
- `automatic`: opt-in persistence, never the default.

The CLI equivalent is `reporecall process --content "..."` or
`reporecall process --json < capture.json`. Both entry points use the same
redaction, duplicate, and Inbox rules.

Duplicate detection uses normalized content, type, and project identity before processor-assisted relation work is considered.

## Generic adapters

Other harnesses can consume the MCP contract or implement the `AgentAdapter` and `ContextBuilder` interfaces. The v0.1 repository does not claim automatic transcript capture for non-Codex harnesses.
