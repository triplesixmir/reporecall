# CLI and configuration

## Commands

| Command      | Purpose                                                          |
| ------------ | ---------------------------------------------------------------- |
| `init`       | Create project memory directories, config, and managed guidance. |
| `brain init` | Create a global brain at the resolved or custom path.            |
| `status`     | Validate canonical files and report index errors.                |
| `doctor`     | Check Node.js version and storage/index health.                  |
| `remember`   | Write an explicit durable memory after redaction.                |
| `process`    | Process an explicitly supplied redacted capture.                |
| `search`     | Search the SQLite index.                                         |
| `inbox`      | Print pending processor suggestions.                             |
| `rebuild`    | Recreate the disposable index from Markdown.                     |
| `config`     | Print resolved TOML configuration as JSON.                       |
| `checkpoint` | Persist an explicit session event.                               |
| `serve`      | Start API, compiled UI, watcher, and local index.                |
| `mcp`        | Run the stdio MCP server.                                        |
| `codex install`   | Install the Codex MCP server and managed lifecycle hooks.   |
| `codex uninstall` | Remove only RepoRecall-managed Codex settings.             |
| `codex-hook` | Handle a `SessionStart`, `PostCompact`, or `SessionEnd` event.   |

The source checkout can run commands with `pnpm exec tsx packages/cli/src/bin.ts`. A built checkout can use `node packages/cli/dist/bin.js`.

## Explicit processor workflow

Process a deliberately supplied capture with the local marker provider:

```bash
reporecall process \
  --processor agent-native \
  --content "Decision: keep Markdown canonical."
```

For structured input, pipe a JSON object containing `content` and optional
`capturedAt`, `sessionId`, `project`, `workspace`, and `explicit` fields:

```bash
reporecall process --processor agent-native --json < capture.json
```

The capture is scanned locally before provider invocation. In `conservative`
mode provider suggestions are written to the Markdown Inbox; `balanced` may
persist high-confidence suggestions; `automatic` requires both configured
automatic mode and the per-invocation `--allow-automatic` flag. Explicit items
in the capture are durable according to their declared scope. The raw capture
is not written to `sessions/` and hooks do not call this command implicitly.

Use `--processor ollama`, `--processor openrouter`, or
`--processor openai-compatible` for the existing HTTP providers. Credentials
remain environment variables. `--json` returns durable records, Inbox items,
duplicates, warnings, provider, and mode.

## Configuration

The resolved configuration contains:

```toml
brain_path = "~/.reporecall/brain"
project_memory_dir = ".reporecall"
index_path = "index.sqlite"
port = 4317
ignored_paths = ["node_modules", ".git", "dist", "coverage"]
processor = "disabled"
processor_mode = "conservative"
```

Paths are resolved relative to the file that declares them. `~` expands against the configured home directory. CLI overrides are applied last. The `config` command is the safest way to confirm the effective configuration.

## Exit behavior

- `0`: operation completed successfully.
- `1`: command or validation failure.
- `2`: a requested memory write or processor capture was refused because content was empty or secret-only.

`serve` reports a friendly bind error when the port or hostname is unavailable. `codex-hook` is fail-open and returns `0` after reporting hook failures to stderr.

Use `reporecall codex install --scope user` for the normal Codex setup. Pass
`--scope project` for repository-local installation or
`--codex-executable <path>` when Codex is not on `PATH`.

## API development

`createApiApp(runtime)` exposes the Hono app without opening a TCP socket, which makes route contracts testable with `app.request()`. `startServe(config)` adds rebuild, optional static assets, watcher, and loopback HTTP lifecycle.
