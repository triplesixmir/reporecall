import { basename, join, resolve } from 'node:path';
import { input } from '@inquirer/prompts';
import {
  MEMORY_PRIORITIES,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  redactedSessionCaptureSchema,
  type MemoryScope,
  type MemoryType,
  type ProjectRef,
  type RedactedSessionCapture,
} from '@reporecall/core';
import { DeterministicContextBuilder } from '@reporecall/context';
import { SqliteMemoryIndex } from '@reporecall/index';
import { CodexAdapter, runCodexHook, type CodexHookInput } from '@reporecall/integrations';
import { runMcpStdio, type InboxItem, type MemoryMcpRuntime } from '@reporecall/mcp';
import { FileInboxStore } from '@reporecall/processors';
import { FileMemoryStore, FileProjectRegistry } from '@reporecall/storage';
import { initializeBrain, initializeProject } from './init.js';
import { createProcessingRuntime } from './processing.js';
import {
  PROCESSOR_MODES,
  PROCESSORS,
  resolveConfig,
  type ConfigOverrides,
  type RepoRecallConfig,
} from './config.js';
import { redactSecrets } from './privacy.js';
import { discoverProject, ensureProject, type ResolvedProject } from './project.js';
import { startServe } from './server.js';

export type CliIO = {
  cwd?: string;
  homeDir?: string;
  stdin?: AsyncIterable<string | Uint8Array>;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

type CommandContext = Required<Pick<CliIO, 'cwd' | 'homeDir' | 'stdout' | 'stderr'>> & {
  stdin: AsyncIterable<string | Uint8Array>;
};

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const equalIndex = argument.indexOf('=');
    if (equalIndex > 2) {
      flags[argument.slice(2, equalIndex)] = argument.slice(equalIndex + 1);
      continue;
    }
    const key = argument.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

function stringFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function booleanFlag(flags: ParsedArgs['flags'], name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}

function numberFlag(flags: ParsedArgs['flags'], name: string): number | undefined {
  const value = stringFlag(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function configOverrides(flags: ParsedArgs['flags']): ConfigOverrides {
  const port = numberFlag(flags, 'port');
  const indexPath = stringFlag(flags, 'index');
  const processor = parseEnum(stringFlag(flags, 'processor'), PROCESSORS, 'processor');
  const processorMode = parseEnum(
    stringFlag(flags, 'processor-mode'),
    PROCESSOR_MODES,
    'processor-mode',
  );
  const ignoredPaths = stringFlag(flags, 'ignore')
    ?.split(',')
    .map((path) => path.trim())
    .filter(Boolean);
  return {
    ...(indexPath === undefined ? {} : { indexPath }),
    ...(port === undefined ? {} : { port }),
    ...(processor === undefined ? {} : { processor }),
    ...(processorMode === undefined ? {} : { processorMode }),
    ...(ignoredPaths === undefined ? {} : { ignoredPaths }),
  };
}

async function getConfig(
  context: CommandContext,
  flags: ParsedArgs['flags'],
): Promise<RepoRecallConfig> {
  const brainPath = stringFlag(flags, 'brain');
  const projectMemoryDir = stringFlag(flags, 'memory-dir');
  return resolveConfig({
    cwd: context.cwd,
    homeDir: context.homeDir,
    userConfigPath: join(context.homeDir, '.config', 'reporecall', 'config.toml'),
    ...(brainPath === undefined ? {} : { brainPath }),
    ...(projectMemoryDir === undefined ? {} : { projectMemoryDir }),
    cli: configOverrides(flags),
  });
}

type ProjectContextMode = 'ensure' | 'read-only';

async function getProjectContext(
  context: CommandContext,
  flags: ParsedArgs['flags'],
  mode: ProjectContextMode = 'ensure',
): Promise<{ config: RepoRecallConfig; project: ResolvedProject }> {
  const discovered = await discoverProject(context.cwd);
  const rootContext: CommandContext = { ...context, cwd: discovered.root };
  const initialConfig = await getConfig(rootContext, flags);
  let project = mode === 'ensure'
    ? await ensureProject(discovered.root, initialConfig.projectMemoryDir)
    : await discoverProject(discovered.root);
  let config = await getConfig(rootContext, flags);

  if (mode === 'ensure' && resolve(config.projectMemoryDir) !== project.memoryDir) {
    project = await ensureProject(discovered.root, config.projectMemoryDir);
    config = await getConfig(rootContext, flags);
  }

  if (project.manifestExists) {
    try {
      await new FileProjectRegistry({ brainPath: config.brainPath }).upsert({
        schema: project.schema,
        kind: project.kind,
        id: project.id,
        name: project.name,
        identity: project.identity,
        ...(project.remoteFingerprint === undefined
          ? {}
          : { remoteFingerprint: project.remoteFingerprint }),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        root: project.root,
        memoryDir: config.projectMemoryDir,
        manifestPath: project.manifestPath,
      });
    } catch (error) {
      context.stderr(
        `RepoRecall project registry warning: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  return {
    config,
    project: { ...project, memoryDir: config.projectMemoryDir },
  };
}

function projectRef(cwd: string) {
  const name = basename(cwd) || 'project';
  return { id: name.toLocaleLowerCase().replace(/[^a-z0-9_-]+/gu, '-'), root: cwd, name };
}

function projectReference(project: ResolvedProject): ProjectRef {
  return { id: project.id, root: project.root, name: project.name };
}

function rootsFor(config: RepoRecallConfig, project: ResolvedProject) {
  const projectRef = { id: project.id, root: project.root, name: project.name };
  return [
    { root: config.brainPath, scope: 'global' as const },
    { root: config.projectMemoryDir, scope: 'project' as const, project: projectRef },
    { root: config.projectMemoryDir, scope: 'session' as const, project: projectRef },
  ];
}

function memoryPath(root: string, id: string, scope: MemoryScope): string {
  return join(root, scope === 'session' ? 'sessions' : 'memories', `${id}.md`);
}

async function inboxItems(config: RepoRecallConfig, limit: number): Promise<InboxItem[]> {
  const items = (
    await Promise.all(
      [config.projectMemoryDir, config.brainPath].map((root) =>
        new FileInboxStore({ root }).list({ status: 'pending' }),
      ),
    )
  ).flat();
  return items
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
      return left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}

export function createMcpRuntime(config: RepoRecallConfig, project: ResolvedProject): {
  runtime: MemoryMcpRuntime;
  index: SqliteMemoryIndex;
  project: ResolvedProject;
  close: () => void;
} {
  const processing = createProcessingRuntime(config);
  const { global: globalStore, project: projectStore, session: sessionStore } = processing.stores;
  const index = processing.index;
  const contextBuilder = new DeterministicContextBuilder(index);
  const runtime: MemoryMcpRuntime = {
    store: projectStore,
    stores: { global: globalStore, project: projectStore, session: sessionStore },
    index,
    contextBuilder,
    project: { id: project.id, root: project.root, name: project.name },
    projectAliases: project.legacyIds,
    afterWrite: async (record) => {
      const root = record.scope === 'global' ? config.brainPath : config.projectMemoryDir;
      await index.update([memoryPath(root, record.id, record.scope)]);
    },
    listInbox: (limit) => processing.inbox.list({ status: 'pending', limit }),
    processCapture: (capture, options) => processing.processCapture(capture, options),
  };
  return { runtime, index, project, close: () => processing.close() };
}

function storeFor(
  config: RepoRecallConfig,
  scope: MemoryScope,
): { store: FileMemoryStore; root: string } {
  const root = scope === 'global' ? config.brainPath : config.projectMemoryDir;
  return { root, store: new FileMemoryStore({ root, scope }) };
}

function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new Error(`Invalid --${name}: ${value}`);
  return value as T;
}

function printJson(context: CommandContext, value: unknown): void {
  context.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

async function readStdin(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
  }
  return chunks.join('');
}

function projectFromFlags(
  cwd: string,
  flags: ParsedArgs['flags'],
  resolvedProject?: ResolvedProject,
): ProjectRef {
  const defaultProject = resolvedProject === undefined ? projectRef(cwd) : projectReference(resolvedProject);
  const root = stringFlag(flags, 'project-root') ?? defaultProject.root;
  const resolvedRoot = resolve(root);
  return {
    id: stringFlag(flags, 'project-id') ?? projectRef(resolvedRoot).id,
    root: resolvedRoot,
    name: stringFlag(flags, 'project-name') ?? basename(resolvedRoot),
  };
}

function workspaceFromFlags(flags: ParsedArgs['flags']): RedactedSessionCapture['workspace'] {
  const id = stringFlag(flags, 'workspace-id');
  const name = stringFlag(flags, 'workspace-name');
  if (id === undefined && name === undefined) return undefined;
  return { id: id ?? name ?? 'workspace', ...(name === undefined ? {} : { name }) };
}

function captureWithFlags(
  context: CommandContext,
  flags: ParsedArgs['flags'],
  capture: RedactedSessionCapture,
  resolvedProject?: ResolvedProject,
): RedactedSessionCapture {
  const hasProjectOverride = ['project-id', 'project-root', 'project-name'].some(
    (name) => stringFlag(flags, name) !== undefined,
  );
  const project = hasProjectOverride
    ? projectFromFlags(context.cwd, flags, resolvedProject)
    : (capture.project ?? projectFromFlags(context.cwd, flags, resolvedProject));
  const workspace = workspaceFromFlags(flags) ?? capture.workspace;
  const sessionId = stringFlag(flags, 'session-id') ?? capture.sessionId;
  const capturedAt = stringFlag(flags, 'captured-at') ?? capture.capturedAt;
  return {
    ...capture,
    project,
    ...(workspace === undefined ? {} : { workspace }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(capturedAt === undefined ? {} : { capturedAt }),
  };
}

async function processCaptureInput(
  context: CommandContext,
  flags: ParsedArgs['flags'],
  resolvedProject?: ResolvedProject,
): Promise<RedactedSessionCapture> {
  const content = stringFlag(flags, 'content');
  if (content !== undefined) {
    return redactedSessionCaptureSchema.parse(
      captureWithFlags(context, flags, { content }, resolvedProject),
    ) as RedactedSessionCapture;
  }

  const source = await readStdin(context.stdin);
  if (source.trim() === '') throw new Error('process requires --content or JSON on stdin');
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new Error('process stdin must contain a valid JSON object');
  }
  const capture = redactedSessionCaptureSchema.parse(parsed) as RedactedSessionCapture;
  return redactedSessionCaptureSchema.parse(
    captureWithFlags(context, flags, capture, resolvedProject),
  ) as RedactedSessionCapture;
}

async function processCommand(
  context: CommandContext,
  flags: ParsedArgs['flags'],
): Promise<number> {
  const { config, project } = await getProjectContext(context, flags);
  const capture = await processCaptureInput(context, flags, project);
  const scanned = redactSecrets(capture.content);
  if (scanned.blocked || scanned.redacted.trim() === '') {
    context.stderr('Refusing to process a capture containing only a secret or credential.\n');
    return 2;
  }
  const wasRedacted = scanned.redacted !== capture.content;
  const safeCapture = wasRedacted ? { ...capture, content: scanned.redacted } : capture;
  const runtime = createProcessingRuntime(config);
  try {
    const result = await runtime.processCapture(safeCapture, {
      allowAutomatic: booleanFlag(flags, 'allow-automatic'),
    });
    const output = wasRedacted
      ? {
          ...result,
          warnings: ['Capture secrets were redacted before processing.', ...result.warnings],
        }
      : result;
    if (booleanFlag(flags, 'json')) {
      printJson(context, output);
    } else {
      context.stdout(
        `Processed with ${output.provider} (${output.mode}): ${output.durable.length} durable, ${output.inbox.length} Inbox, ${output.duplicates.length} duplicates.\n`,
      );
      for (const warning of output.warnings) context.stderr(`Warning: ${warning}\n`);
    }
    return 0;
  } finally {
    runtime.close();
  }
}

async function rememberCommand(
  context: CommandContext,
  config: RepoRecallConfig,
  project: ResolvedProject,
  flags: ParsedArgs['flags'],
  contentInput: string,
  forced?: { scope: MemoryScope; type: MemoryType },
): Promise<number> {
  const scanned = redactSecrets(contentInput);
  if (scanned.findings.length > 0 && !scanned.blocked && scanned.redacted !== contentInput) {
    context.stderr('Warning: secrets were redacted before writing the memory.\n');
  }
  if (scanned.blocked || scanned.redacted.trim() === '') {
    context.stderr('Refusing to write a memory containing only a secret or credential.\n');
    return 2;
  }

  const scope =
    forced?.scope ?? parseEnum(stringFlag(flags, 'scope'), MEMORY_SCOPES, 'scope') ?? 'project';
  const type = forced?.type ?? parseEnum(stringFlag(flags, 'type'), MEMORY_TYPES, 'type') ?? 'fact';
  const priority =
    parseEnum(stringFlag(flags, 'priority'), MEMORY_PRIORITIES, 'priority') ?? 'normal';
  const status = parseEnum(stringFlag(flags, 'status'), MEMORY_STATUSES, 'status') ?? 'active';
  const tags = (stringFlag(flags, 'tag') ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((name) => ({ name, origin: 'user' as const }));
  const { store, root } = storeFor(config, scope);
  const record = await store.create({
    content: scanned.redacted,
    scope,
    type,
    priority,
    status,
    pinned: booleanFlag(flags, 'pin'),
    tags,
    ...(scope === 'global' ? {} : { project: projectReference(project) }),
    source: { kind: 'user', method: forced === undefined ? 'cli' : 'checkpoint' },
  });
  const index = new SqliteMemoryIndex({ path: config.indexPath });
  await index.update([memoryPath(root, record.id, record.scope)]);
  index.close();
  context.stdout(`Remembered ${record.id}\n${record.content}\n`);
  return 0;
}

async function initCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const discovered = await discoverProject(context.cwd);
  const projectContext: CommandContext = { ...context, cwd: discovered.root };
  const config = await getConfig(projectContext, flags);
  const brainFlag = stringFlag(flags, 'brain');
  let brainPath = config.brainPath;
  let brainConfigPath = brainFlag === undefined ? undefined : config.brainPath;
  if (
    brainFlag === undefined &&
    !booleanFlag(flags, 'yes') &&
    process.env.CI !== 'true' &&
    process.stdin.isTTY
  ) {
    const answer = await input({ message: 'Global brain path', default: config.brainPath });
    brainPath = resolve(answer);
    brainConfigPath = brainPath;
  }
  if (
    brainConfigPath === undefined &&
    brainPath === resolve(join(context.homeDir, '.reporecall', 'brain'))
  ) {
    brainConfigPath = '~/.reporecall/brain';
  }
  const report = await initializeProject({
    cwd: discovered.root,
    brainPath,
    ...(brainConfigPath === undefined ? {} : { brainConfigPath }),
    projectMemoryDir: config.projectMemoryDir,
  });
  printJson(context, report);
  return 0;
}

async function rebuildCommand(
  context: CommandContext,
  flags: ParsedArgs['flags'],
): Promise<number> {
  const { config, project } = await getProjectContext(context, flags);
  const index = new SqliteMemoryIndex({ path: config.indexPath });
  const report = await index.rebuild(rootsFor(config, project));
  index.close();
  printJson(context, report);
  return report.invalid.length === 0 ? 0 : 1;
}

async function searchCommand(
  context: CommandContext,
  flags: ParsedArgs['flags'],
  query: string,
): Promise<number> {
  const { config } = await getProjectContext(context, flags);
  const index = new SqliteMemoryIndex({ path: config.indexPath });
  const results = await index.search({ query });
  index.close();
  for (const result of results)
    context.stdout(`${result.record.id} [${result.record.type}] ${result.record.content}\n`);
  if (results.length === 0) context.stdout('No memories found.\n');
  return 0;
}

async function statusCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const { config } = await getProjectContext(context, flags);
  const project = new FileMemoryStore({ root: config.projectMemoryDir, scope: 'project' });
  const brain = new FileMemoryStore({ root: config.brainPath, scope: 'global' });
  const [projectValidation, brainValidation] = await Promise.all([
    project.validateAll(),
    brain.validateAll(),
  ]);
  const index = new SqliteMemoryIndex({ path: config.indexPath });
  const indexed = await index.search({ query: '' });
  const errors = await index.getErrors();
  index.close();
  printJson(context, {
    config,
    project: { valid: projectValidation.valid, invalid: projectValidation.invalid.length },
    brain: { valid: brainValidation.valid, invalid: brainValidation.invalid.length },
    indexed: indexed.length,
    indexErrors: errors,
  });
  return projectValidation.invalid.length + brainValidation.invalid.length + errors.length === 0
    ? 0
    : 1;
}

async function inboxCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const { config } = await getProjectContext(context, flags);
  printJson(context, await inboxItems(config, 1_000));
  return 0;
}

async function doctorCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    context.stderr(`RepoRecall requires Node.js >=22.12.0; found ${process.versions.node}.\n`);
    return 1;
  }
  return statusCommand(context, flags);
}

async function mcpCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const { config, project } = await getProjectContext(context, flags);
  const configured = createMcpRuntime(config, project);
  try {
    await configured.index.rebuild(rootsFor(config, project));
    await runMcpStdio(configured.runtime);
    return 0;
  } catch (error) {
    configured.close();
    throw error;
  }
}

async function serveCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const { config, project } = await getProjectContext(context, flags);
  const assetsRoot = stringFlag(flags, 'assets');
  const handle = await startServe(config, project, {
    ...(assetsRoot === undefined ? {} : { assetsRoot }),
    watch: !booleanFlag(flags, 'no-watch'),
  });
  context.stdout(`RepoRecall listening on http://127.0.0.1:${handle.port}\n`);

  return new Promise<number>((resolvePromise) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void handle
        .close()
        .then(() => resolvePromise(0))
        .catch((error: unknown) => {
          context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
          resolvePromise(1);
        });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function codexAdapterCommand(
  context: CommandContext,
  flags: ParsedArgs['flags'],
  action: 'install' | 'uninstall',
): Promise<number> {
  const scope = parseEnum(stringFlag(flags, 'scope'), ['user', 'project'] as const, 'scope') ?? 'user';
  const codexExecutable =
    stringFlag(flags, 'codex-executable') ?? process.env.REPORECALL_CODEX_EXECUTABLE ?? 'codex';
  const serverCommand = stringFlag(flags, 'server-command') ?? 'reporecall';
  const hookExecutable = stringFlag(flags, 'hook-executable') ?? 'reporecall';
  const codexHome = stringFlag(flags, 'codex-home');
  const adapter = new CodexAdapter({ codexExecutable, serverCommand, hookExecutable });
  const target = {
    scope,
    projectRoot: context.cwd,
    ...(codexHome === undefined ? {} : { codexHome }),
  } as const;
  const report = action === 'install' ? await adapter.install(target) : await adapter.uninstall(target);
  printJson(context, report);
  return 0;
}

async function codexHookCommand(
  context: CommandContext,
  flags: ParsedArgs['flags'],
  event: string | undefined,
): Promise<number> {
  try {
    const source = await readStdin(context.stdin);
    let hookInput: CodexHookInput = event === undefined ? {} : { hook_event_name: event };
    if (source.trim() !== '') {
      const parsed: unknown = JSON.parse(source);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('Codex hook input must be a JSON object');
      const parsedInput = parsed as CodexHookInput;
      hookInput = { ...parsedInput, ...(event === undefined ? {} : { hook_event_name: event }) };
    }
    const hookCwd =
      typeof hookInput.cwd === 'string' && hookInput.cwd.trim() !== ''
        ? resolve(hookInput.cwd)
        : context.cwd;
    const hookContext: CommandContext = { ...context, cwd: hookCwd };
    const mode: ProjectContextMode = hookInput.hook_event_name === 'SessionEnd'
      ? 'read-only'
      : 'ensure';
    const { config, project } = await getProjectContext(hookContext, flags, mode);
    if (hookInput.hook_event_name === 'SessionEnd') {
      return await runCodexHook(
        hookInput,
        {
          projectRoot: project.root,
          projectId: project.id,
          projectName: project.name,
          projectAliases: project.legacyIds,
          ...(project.manifestExists ? { runtimeRoot: config.projectMemoryDir } : {}),
        },
        { stdout: context.stdout, stderr: context.stderr },
      );
    }

    const index = new SqliteMemoryIndex({ path: config.indexPath });
    try {
      await index.rebuild(rootsFor(config, project));
      return await runCodexHook(
        hookInput,
        {
          contextBuilder: new DeterministicContextBuilder(index),
          projectRoot: project.root,
          projectId: project.id,
          projectName: project.name,
          projectAliases: project.legacyIds,
          runtimeRoot: config.projectMemoryDir,
          tokenBudget: numberFlag(flags, 'token-budget') ?? 2_000,
        },
        { stdout: context.stdout, stderr: context.stderr },
      );
    } finally {
      index.close();
    }
  } catch (error) {
    context.stderr(
      `RepoRecall hook failed open: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 0;
  }
}

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const context: CommandContext = {
    cwd: resolve(io.cwd ?? process.cwd()),
    homeDir: resolve(io.homeDir ?? process.env.HOME ?? process.cwd()),
    stdin: io.stdin ?? (process.stdin as AsyncIterable<string | Uint8Array>),
    stdout: io.stdout ?? ((message) => process.stdout.write(message)),
    stderr: io.stderr ?? ((message) => process.stderr.write(message)),
  };
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0];
  try {
    if (command === undefined || command === 'help' || booleanFlag(flags, 'help')) {
      context.stdout(
        'RepoRecall commands: init, brain init, status, doctor, remember, process, search, inbox, rebuild, config, checkpoint, serve, mcp, codex install, codex uninstall, codex-hook\n',
      );
      return 0;
    }
    if (command === 'init') return initCommand(context, flags);
    if (command === 'brain' && positionals[1] === 'init') {
      const config = await getConfig(context, flags);
      printJson(context, await initializeBrain({ brainPath: config.brainPath }));
      return 0;
    }
    if (command === 'remember') {
      const content = stringFlag(flags, 'content') ?? positionals.slice(1).join(' ');
      if (content.trim() === '') throw new Error('remember requires memory content');
      const projectContext = await getProjectContext(context, flags);
      return rememberCommand(context, projectContext.config, projectContext.project, flags, content);
    }
    if (command === 'checkpoint') {
      const content = stringFlag(flags, 'content') ?? positionals.slice(1).join(' ');
      if (content.trim() === '') throw new Error('checkpoint requires an explicit summary');
      const projectContext = await getProjectContext(context, flags);
      return rememberCommand(context, projectContext.config, projectContext.project, flags, content, {
        scope: 'session',
        type: 'event',
      });
    }
    if (command === 'process') return await processCommand(context, flags);
    if (command === 'search') {
      const query = positionals.slice(1).join(' ');
      if (query.trim() === '') throw new Error('search requires a query');
      return searchCommand(context, flags, query);
    }
    if (command === 'rebuild') return rebuildCommand(context, flags);
    if (command === 'status') return statusCommand(context, flags);
    if (command === 'doctor') return doctorCommand(context, flags);
    if (command === 'inbox') return inboxCommand(context, flags);
    if (command === 'serve') return serveCommand(context, flags);
    if (command === 'mcp') return mcpCommand(context, flags);
    if (command === 'codex' && (positionals[1] === 'install' || positionals[1] === 'uninstall')) {
      return codexAdapterCommand(context, flags, positionals[1]);
    }
    if (command === 'codex-hook') return codexHookCommand(context, flags, positionals[1]);
    if (command === 'config') printJson(context, await getConfig(context, flags));
    else throw new Error(`Unknown command: ${command}`);
    return 0;
  } catch (error) {
    context.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export * from './config.js';
export * from './init.js';
export * from './privacy.js';
export * from './server.js';
