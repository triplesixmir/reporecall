# Getting started

## 1. Install

Use Node.js `>=22.12.0` and pnpm 11:

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs ESLint, strict TypeScript, Vitest, and all workspace builds. `pnpm test:e2e` builds the web app, starts a local Vite preview, and runs browser smoke tests.

## 2. Initialize a project

From a repository directory:

```bash
pnpm exec tsx packages/cli/src/bin.ts init --yes
```

This is idempotent. It creates `.reporecall/`, writes configuration, and adds a managed block to `AGENTS.md` while preserving text outside that block. Use `--brain /absolute/path` for a custom global brain. `reporecall brain init --brain /absolute/path` initializes only that brain.

For a non-Git directory, initialization still works. Git is useful for syncing project Markdown, but is not required by the storage layer.

After installing the CLI, connect Codex:

```bash
reporecall codex install --scope user
reporecall doctor
```

This makes Codex retrieve current context at session start and after compaction.
It does not silently turn a transcript into durable memory; use an explicit
`remember` or `checkpoint` write when something should persist.

## 3. Create and find memory

```bash
pnpm exec tsx packages/cli/src/bin.ts remember \
  --type decision \
  --priority high \
  --tag architecture,local-first \
  --content "Markdown remains the source of truth."

pnpm exec tsx packages/cli/src/bin.ts rebuild
pnpm exec tsx packages/cli/src/bin.ts search Markdown
pnpm exec tsx packages/cli/src/bin.ts status
```

The resulting `mem_*.md` file is the durable artifact. You can review or edit it directly; run `rebuild` after deleting the index or use `serve` to let the watcher update it incrementally.

## 4. Start the workbench

```bash
pnpm build
pnpm exec tsx packages/cli/src/bin.ts serve
```

Open `http://127.0.0.1:4317`. The interface supports URL-synchronized memory filters, CRUD, Inbox review, graph inspection, and local health information. The API is loopback-only by default.

## 5. Make an explicit checkpoint

Session summaries are deliberate writes:

```bash
pnpm exec tsx packages/cli/src/bin.ts checkpoint \
  --content "We chose Markdown as the durable source and SQLite as a rebuildable cache."
```

This creates a session event in `sessions/`. A lifecycle hook or an unstable transcript never creates a durable summary silently.

## Custom paths

Configuration layers are resolved in this order:

```text
CLI flags -> project config -> brain config -> user config -> defaults
```

Useful flags include `--brain`, `--memory-dir`, `--index`, `--port`, `--ignore`, `--processor`, and `--processor-mode`. Run `config` to inspect the final resolved paths before writing data.

## Private brain repository

For cross-device use, keep the public source repository separate from a private
brain repository. On a fresh Windows device:

```powershell
$Brain = Join-Path $env:USERPROFILE ".reporecall\brain"
git clone git@github.com:YOUR_GITHUB_USER/reporecall-private-memory.git $Brain
reporecall brain init --brain $Brain
cd C:\path\to\your-project
reporecall init --yes --brain $Brain
reporecall rebuild --brain $Brain
reporecall codex install --scope user
```

The Markdown memories are the portable data. The SQLite index is local cache:
pull the Markdown, then rebuild the index on each device. RepoRecall retrieves
context automatically through the Codex hooks, but it does not silently save a
transcript as durable memory.
