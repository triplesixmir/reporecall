# Contributing to RepoRecall

Thank you for helping improve RepoRecall. Contributions should keep the project local-first, file-first, privacy-conscious, and useful without a hosted service.

## Before you start

- Node.js `>=22.12`.
- pnpm `11.19.0` (the repository pins this through `packageManager`).
- A temporary test brain, never a real personal brain or real `CODEX_HOME`.

Do not include private memories, credentials, machine-specific absolute paths, generated SQLite files, or `.playwright-cli` artifacts in a change.

## Development setup

```text
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
```

`pnpm check` runs lint, strict type-checking, the unit/integration suite, and all workspace builds. The browser suite builds the web app and runs it against a local preview server.

## Architecture rules

- Markdown files with YAML frontmatter are the only durable source of truth.
- SQLite is a disposable index/cache. A feature must remain correct after the database is deleted and rebuilt.
- Keep public contracts in the smallest appropriate package. Avoid importing CLI or web code into core packages.
- Preserve atomic writes and actionable diagnostics for malformed memory files.
- Treat session captures as redacted, temporary input. Never persist a raw transcript.
- Keep user-owned tags and text intact; AI-originated suggestions must remain distinguishable.
- New integrations should fail open where possible and must not silently create durable memories.

## Making a change

1. Read the relevant package and its tests before changing an interface.
2. Add a focused failing test for behavior that is new or broken.
3. Implement the smallest change that makes the test pass.
4. Run the focused test, then `pnpm check` and `pnpm test:e2e` when the change affects the CLI, API, or UI.
5. Update English and Russian documentation for user-visible behavior.
6. Inspect `git diff --check` and confirm that no secrets or local paths are present.

For new vertical slices, keep the package boundary explicit, add a handoff note in the commit description when useful, and document any deliberate limitation rather than hiding it behind a fallback.

## Commit and pull request guidance

Use a conventional commit subject, for example:

```text
feat(index): support project-aware ranking
```

Pull requests should include:

- a concise explanation of the user-visible result;
- tests and verification commands that were run;
- migration, privacy, or compatibility notes when applicable;
- screenshots or a short recording for meaningful UI changes;
- confirmation that the change does not require a hosted service.

Please keep unrelated refactors out of feature changes. Maintainers may ask for a smaller patch when behavior and cleanup are difficult to review together.

## Reporting security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md), and remove credentials from any local reproduction before sharing it.
