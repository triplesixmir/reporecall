# Integrations

## MCP

Run the local stdio server:

```bash
reporecall mcp
```

The server exposes `memory_get_context`, `memory_search`, `memory_get_recent`, `memory_remember`, `memory_update`, `memory_resolve`, `memory_checkpoint`, and `memory_review_inbox`. Every response contains structured content and a concise summary.

MCP writes use the same canonical stores and secret redaction as the CLI. Agents can add AI tags, but user-owned tags are preserved. A durable session event requires the explicit `memory_checkpoint` tool.

## Codex

The adapter supports user-level or project-level installation through the official Codex MCP command and managed configuration files. Installation is designed to be idempotent:

```bash
reporecall codex install --scope user
# or, for one repository only:
reporecall codex install --scope project
```

- `codex mcp add` registers the local stdio server;
- a managed `AGENTS.md` block explains source-of-truth and privacy semantics;
- managed `hooks.json` entries inject context at `SessionStart` and `PostCompact` and write a lifecycle marker at `SessionEnd`;
- unrelated user text and hook handlers remain intact.

To remove the integration, run `reporecall codex uninstall --scope user` (or
`--scope project`). Only RepoRecall-managed entries are removed.

The hook executable is fail-open. If the index or context builder is unavailable, the session continues and the hook reports a diagnostic instead of blocking the agent.

## Processors

Processor kinds are `disabled`, `agent-native`, `ollama`, `openrouter`, and `openai-compatible`. HTTP providers use one typed request/response contract and environment-variable credentials. Modes are:

- `conservative`: explicit records durable; provider suggestions go to Inbox;
- `balanced`: high-confidence suggestions may become durable;
- `automatic`: opt-in persistence, never the default.

Duplicate detection uses normalized content, type, and project identity before processor-assisted relation work is considered.

## Generic adapters

Other harnesses can consume the MCP contract or implement the `AgentAdapter` and `ContextBuilder` interfaces. The v0.1 repository does not claim automatic transcript capture for non-Codex harnesses.
