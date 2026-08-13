import { readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { input } from '@inquirer/prompts';
import {
  MEMORY_PRIORITIES,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  type MemoryScope,
  type MemoryType,
} from '@reporecall/core';
import { SqliteMemoryIndex } from '@reporecall/index';
import { FileMemoryStore } from '@reporecall/storage';
import { initializeBrain, initializeProject } from './init.js';
import {
  PROCESSOR_MODES,
  PROCESSORS,
  resolveConfig,
  type ConfigOverrides,
  type RepoRecallConfig,
} from './config.js';
import { redactSecrets } from './privacy.js';

export type CliIO = {
  cwd?: string;
  homeDir?: string;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

type CommandContext = Required<Pick<CliIO, 'cwd' | 'homeDir' | 'stdout' | 'stderr'>>;

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
  const processorMode = parseEnum(stringFlag(flags, 'processor-mode'), PROCESSOR_MODES, 'processor-mode');
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

async function getConfig(context: CommandContext, flags: ParsedArgs['flags']): Promise<RepoRecallConfig> {
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

function projectRef(cwd: string) {
  const name = basename(cwd) || 'project';
  return { id: name.toLocaleLowerCase().replace(/[^a-z0-9_-]+/gu, '-'), root: cwd, name };
}

function rootsFor(config: RepoRecallConfig) {
  return [
    { root: config.brainPath, scope: 'global' as const },
    { root: config.projectMemoryDir, scope: 'project' as const, project: projectRef(config.projectMemoryDir) },
  ];
}

function storeFor(config: RepoRecallConfig, scope: MemoryScope): { store: FileMemoryStore; root: string } {
  const root = scope === 'global' ? config.brainPath : config.projectMemoryDir;
  return { root, store: new FileMemoryStore({ root, scope }) };
}

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw new Error(`Invalid --${name}: ${value}`);
  return value as T;
}

function printJson(context: CommandContext, value: unknown): void {
  context.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

async function rememberCommand(
  context: CommandContext,
  config: RepoRecallConfig,
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

  const scope = forced?.scope ?? parseEnum(stringFlag(flags, 'scope'), MEMORY_SCOPES, 'scope') ?? 'project';
  const type = forced?.type ?? parseEnum(stringFlag(flags, 'type'), MEMORY_TYPES, 'type') ?? 'fact';
  const priority = parseEnum(stringFlag(flags, 'priority'), MEMORY_PRIORITIES, 'priority') ?? 'normal';
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
    ...(scope === 'global' ? {} : { project: projectRef(context.cwd) }),
    source: { kind: 'user', method: forced === undefined ? 'cli' : 'checkpoint' },
  });
  const index = new SqliteMemoryIndex({ path: config.indexPath });
  await index.update([join(root, 'memories', `${record.id}.md`)]);
  index.close();
  context.stdout(`Remembered ${record.id}\n${record.content}\n`);
  return 0;
}

async function initCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const config = await getConfig(context, flags);
  const brainFlag = stringFlag(flags, 'brain');
  let brainPath = config.brainPath;
  let brainConfigPath = brainFlag === undefined ? undefined : config.brainPath;
  if (brainFlag === undefined && !booleanFlag(flags, 'yes') && process.env.CI !== 'true' && process.stdin.isTTY) {
    const answer = await input({ message: 'Global brain path', default: config.brainPath });
    brainPath = resolve(answer);
    brainConfigPath = brainPath;
  }
  if (brainConfigPath === undefined && brainPath === resolve(join(context.homeDir, '.reporecall', 'brain'))) {
    brainConfigPath = '~/.reporecall/brain';
  }
  const report = await initializeProject({
    cwd: context.cwd,
    brainPath,
    ...(brainConfigPath === undefined ? {} : { brainConfigPath }),
    projectMemoryDir: config.projectMemoryDir,
  });
  printJson(context, report);
  return 0;
}

async function rebuildCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const config = await getConfig(context, flags);
  const index = new SqliteMemoryIndex({ path: config.indexPath });
  const report = await index.rebuild(rootsFor(config));
  index.close();
  printJson(context, report);
  return report.invalid.length === 0 ? 0 : 1;
}

async function searchCommand(context: CommandContext, flags: ParsedArgs['flags'], query: string): Promise<number> {
  const config = await getConfig(context, flags);
  const index = new SqliteMemoryIndex({ path: config.indexPath });
  const results = await index.search({ query });
  index.close();
  for (const result of results) context.stdout(`${result.record.id} [${result.record.type}] ${result.record.content}\n`);
  if (results.length === 0) context.stdout('No memories found.\n');
  return 0;
}

async function statusCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const config = await getConfig(context, flags);
  const project = new FileMemoryStore({ root: config.projectMemoryDir, scope: 'project' });
  const brain = new FileMemoryStore({ root: config.brainPath, scope: 'global' });
  const [projectValidation, brainValidation] = await Promise.all([project.validateAll(), brain.validateAll()]);
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
  return projectValidation.invalid.length + brainValidation.invalid.length + errors.length === 0 ? 0 : 1;
}

async function inboxCommand(context: CommandContext, flags: ParsedArgs['flags']): Promise<number> {
  const config = await getConfig(context, flags);
  const roots = [join(config.projectMemoryDir, 'inbox'), join(config.brainPath, 'inbox')];
  const files: string[] = [];
  for (const root of roots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      files.push(...entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => join(root, entry.name)));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  printJson(context, files.sort());
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

export async function runCli(argv: string[], io: CliIO = {}): Promise<number> {
  const context: CommandContext = {
    cwd: resolve(io.cwd ?? process.cwd()),
    homeDir: resolve(io.homeDir ?? process.env.HOME ?? process.cwd()),
    stdout: io.stdout ?? ((message) => process.stdout.write(message)),
    stderr: io.stderr ?? ((message) => process.stderr.write(message)),
  };
  const { positionals, flags } = parseArgs(argv);
  const command = positionals[0];
  try {
    if (command === undefined || command === 'help' || booleanFlag(flags, 'help')) {
      context.stdout('RepoRecall commands: init, brain init, status, doctor, remember, search, inbox, rebuild, config, checkpoint\n');
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
      return rememberCommand(context, await getConfig(context, flags), flags, content);
    }
    if (command === 'checkpoint') {
      const content = stringFlag(flags, 'content') ?? positionals.slice(1).join(' ');
      if (content.trim() === '') throw new Error('checkpoint requires an explicit summary');
      return rememberCommand(context, await getConfig(context, flags), flags, content, { scope: 'session', type: 'event' });
    }
    if (command === 'search') {
      const query = positionals.slice(1).join(' ');
      if (query.trim() === '') throw new Error('search requires a query');
      return searchCommand(context, flags, query);
    }
    if (command === 'rebuild') return rebuildCommand(context, flags);
    if (command === 'status') return statusCommand(context, flags);
    if (command === 'doctor') return doctorCommand(context, flags);
    if (command === 'inbox') return inboxCommand(context, flags);
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
