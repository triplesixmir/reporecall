# Быстрый старт

## 1. Установка

Используйте Node.js `>=22.12.0` и pnpm 11:

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` запускает ESLint, strict TypeScript, Vitest и build всех workspace. `pnpm test:e2e` собирает Web UI, запускает локальный Vite preview и выполняет browser smoke tests.

## 2. Инициализация проекта

Из директории репозитория:

```bash
pnpm exec tsx packages/cli/src/bin.ts init --yes
```

Команда idempotent. Она создаёт `.reporecall/`, config и managed block в `AGENTS.md`, сохраняя текст вне block. Для custom global brain используйте `--brain /absolute/path`. `reporecall brain init --brain /absolute/path` инициализирует только brain.

Инициализация работает и в non-Git directory. Git нужен для синхронизации project Markdown, но не является требованием storage layer.

После установки CLI подключите Codex:

```bash
reporecall codex install --scope user
reporecall doctor
```

После этого Codex получает актуальный context при старте сессии и после
compaction. Transcript не превращается в durable memory молча: для сохранения
используйте явные `remember` или `checkpoint`.

## 3. Создание и поиск memory

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

Результат — `mem_*.md`, durable artifact. Его можно читать и редактировать вручную; после удаления index запустите `rebuild`, а при `serve` watcher обновит index incrementally.

## 4. Workbench

```bash
pnpm build
pnpm exec tsx packages/cli/src/bin.ts serve
```

Откройте `http://127.0.0.1:4317`. UI поддерживает URL filters, CRUD, Inbox review, graph inspection и local health. API по умолчанию loopback-only.

## 5. Явный checkpoint

Session summaries — deliberate writes:

```bash
pnpm exec tsx packages/cli/src/bin.ts checkpoint \
  --content "We chose Markdown as the durable source and SQLite as a rebuildable cache."
```

Создаётся session event в `sessions/`. Lifecycle hook или нестабильный transcript никогда не создают durable summary молча.

## Custom paths

Configuration layers разрешаются в порядке:

```text
CLI flags -> project config -> brain config -> user config -> defaults
```

Полезные flags: `--brain`, `--memory-dir`, `--index`, `--port`, `--ignore`, `--processor`, `--processor-mode`. Перед write запускайте `config`, чтобы увидеть итоговые paths.

## Private brain repository

Для работы на нескольких устройствах отделите public source repository от
private brain repository. На новом Windows-компьютере:

```powershell
$Brain = Join-Path $env:USERPROFILE ".reporecall\brain"
git clone git@github.com:triplesixmir/reporecall-private-memory.git $Brain
reporecall brain init --brain $Brain
cd C:\path\to\your-project
reporecall init --yes --brain $Brain
reporecall rebuild --brain $Brain
reporecall codex install --scope user
```

Переносимыми данными являются Markdown memories. SQLite — local cache: на
каждом устройстве подтяните Markdown и пересоберите index. Codex hooks сами
подтягивают context, но RepoRecall не сохраняет transcript в durable memory
молча.
