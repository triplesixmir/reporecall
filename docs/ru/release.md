# Проверка релиза

Перед публикацией из clean checkout выполните:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
pnpm audit:public -- --working-tree
pnpm --dir packages/cli pack --pack-destination /tmp/reporecall-release
```

Root workspace намеренно private. Publishable CLI artifact находится в `packages/cli`; его build включает internal workspace packages и оставляет в tarball только third-party runtime dependencies. Нельзя случайно публиковать private root.

Установите tarball в свежую directory для проверки пользовательского пути:

```bash
mkdir /tmp/reporecall-clean
cd /tmp/reporecall-clean
npm install /tmp/reporecall-release/reporecall-0.1.0.tgz
npx --no-install reporecall init --yes
```

## Локальные проверки

- Убедитесь, что production bundle находится в `apps/web/dist`.
- Запустите `serve` на isolated brain path и проверьте `/api/health` через loopback.
- Создайте memory, отредактируйте Markdown, удалите SQLite и выполните `rebuild`.
- Запустите `doctor` и проверьте `status` на malformed files/index errors.
- Тестируйте MCP с disposable `CODEX_HOME`, никогда не используя настоящий user directory.
- Симулируйте два clone: commit только project Markdown, clone во вторую directory, rebuild и найдите ту же memory.
- Проверьте, что context builder во втором clone получает ту же запись после rebuild локального SQLite index.

## Checklist public history

Перед public repository или release проверьте:

- нет credentials, private keys, bearer tokens и provider secrets;
- нет machine-specific paths и private memory files;
- нет generated SQLite, runtime markers, browser artifacts и build output;
- `pnpm audit:public -- --working-tree` не находит sensitive paths или values;
- English и Russian docs описывают реализованное и limitations;
- CI выполняет install, lint, typecheck, unit tests, E2E и build на Ubuntu, macOS и Windows.
