# Release verification

Run the following from a clean checkout before publishing:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
pnpm --dir packages/cli pack --pack-destination /tmp/reporecall-release
```

The repository root is intentionally private. The publishable CLI artifact is `packages/cli`; its build bundles internal workspace packages and leaves only third-party runtime dependencies in the tarball. Do not publish the private root accidentally.

Install the tarball in a fresh directory to verify the user-facing path:

```bash
mkdir /tmp/reporecall-clean
cd /tmp/reporecall-clean
npm install /tmp/reporecall-release/reporecall-0.1.0.tgz
npx --no-install reporecall init --yes
```

## Local checks

- Verify the Web UI production bundle exists in `apps/web/dist`.
- Start `serve` on an isolated brain path and check `/api/health` over loopback.
- Create a memory, edit its Markdown file, delete the SQLite file, and run `rebuild`.
- Run `doctor` and inspect `status` for malformed files or index errors.
- Exercise MCP with a disposable `CODEX_HOME`; never use a real user directory in tests.
- Simulate two clones: commit only project Markdown, clone to a second directory, rebuild there, and search for the same memory.
- Confirm the second clone's context builder retrieves the same record after rebuilding its local SQLite index.

## Public-history checklist

Before a public repository or release:

- no credentials, private keys, bearer tokens, or provider secrets;
- no machine-specific paths or personal memory files;
- no generated SQLite, runtime markers, browser artifacts, or build output;
- English and Russian documentation describe the implemented behavior and limitations;
- CI runs install, lint, typecheck, unit tests, E2E, and build on Ubuntu, macOS, and Windows.
