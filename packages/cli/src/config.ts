import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const PROCESSORS = ['agent-native', 'ollama', 'openrouter', 'openai-compatible', 'disabled'] as const;
export type ProcessorKind = (typeof PROCESSORS)[number];

export const PROCESSOR_MODES = ['conservative', 'balanced', 'automatic'] as const;
export type ProcessorMode = (typeof PROCESSOR_MODES)[number];

export type ConfigSource = {
  path: string;
  layer: 'user' | 'brain' | 'project';
};

export type RepoRecallConfig = {
  brainPath: string;
  projectMemoryDir: string;
  indexPath: string;
  port: number;
  ignoredPaths: string[];
  processor: ProcessorKind;
  processorMode: ProcessorMode;
  sources: ConfigSource[];
};

export type ConfigOverrides = Partial<
  Pick<RepoRecallConfig, 'brainPath' | 'projectMemoryDir' | 'indexPath' | 'port' | 'ignoredPaths' | 'processor' | 'processorMode'>
>;

export type ResolveConfigOptions = {
  cwd?: string;
  homeDir?: string;
  userConfigPath?: string;
  brainPath?: string;
  projectMemoryDir?: string;
  cli?: ConfigOverrides;
};

type RawConfig = {
  brainPath?: string;
  projectMemoryDir?: string;
  indexPath?: string;
  port?: number;
  ignoredPaths?: string[];
  processor?: ProcessorKind;
  processorMode?: ProcessorMode;
};

const DEFAULT_IGNORED_PATHS = ['node_modules', '.git', 'dist', 'coverage'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, key: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${key} in config "${path}"`);
  return value;
}

function optionalNumber(value: unknown, key: string, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`Invalid ${key} in config "${path}"`);
  }
  return value;
}

function optionalStringArray(value: unknown, key: string, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${key} in config "${path}"`);
  }
  const items: unknown[] = value;
  const strings = items.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  if (strings.length !== items.length) throw new Error(`Invalid ${key} in config "${path}"`);
  return strings.map((item) => item.trim());
}

function parseLayer(raw: unknown, path: string): RawConfig {
  if (!isRecord(raw)) throw new Error(`Invalid config "${path}": expected a TOML table`);
  const processor = optionalString(raw.processor, 'processor', path);
  const processorMode = optionalString(raw.processor_mode, 'processor_mode', path);
  if (processor !== undefined && !PROCESSORS.includes(processor as ProcessorKind)) {
    throw new Error(`Invalid processor in config "${path}"`);
  }
  if (processorMode !== undefined && !PROCESSOR_MODES.includes(processorMode as ProcessorMode)) {
    throw new Error(`Invalid processor_mode in config "${path}"`);
  }
  const values: RawConfig = {};
  const brainPath = optionalString(raw.brain_path, 'brain_path', path);
  const projectMemoryDir = optionalString(raw.project_memory_dir, 'project_memory_dir', path);
  const indexPath = optionalString(raw.index_path, 'index_path', path);
  const port = optionalNumber(raw.port, 'port', path);
  const ignoredPaths = optionalStringArray(raw.ignored_paths, 'ignored_paths', path);
  if (brainPath !== undefined) values.brainPath = brainPath;
  if (projectMemoryDir !== undefined) values.projectMemoryDir = projectMemoryDir;
  if (indexPath !== undefined) values.indexPath = indexPath;
  if (port !== undefined) values.port = port;
  if (ignoredPaths !== undefined) values.ignoredPaths = ignoredPaths;
  if (processor !== undefined) values.processor = processor as ProcessorKind;
  if (processorMode !== undefined) values.processorMode = processorMode as ProcessorMode;
  return values;
}

function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir;
  if (value.startsWith('~/')) return join(homeDir, value.slice(2));
  return value;
}

function resolveDeclaredPath(value: string, sourcePath: string | undefined, cwd: string, homeDir: string): string {
  const expanded = expandHome(value, homeDir);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(sourcePath === undefined ? cwd : dirname(sourcePath), expanded);
}

async function readLayer(path: string, layer: ConfigSource['layer']): Promise<{ values: RawConfig; source?: ConfigSource }> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { values: {} };
    throw error;
  }
  return { values: parseLayer(parseToml(source), path), source: { path, layer } };
}

function applyLayer(
  target: ConfigOverrides,
  layer: RawConfig,
  sourcePath: string | undefined,
  cwd: string,
  homeDir: string,
  projectMemorySourcePath: string | null | undefined = sourcePath,
): void {
  if (layer.brainPath !== undefined) target.brainPath = resolveDeclaredPath(layer.brainPath, sourcePath, cwd, homeDir);
  if (layer.projectMemoryDir !== undefined) {
    target.projectMemoryDir = resolveDeclaredPath(layer.projectMemoryDir, projectMemorySourcePath ?? undefined, cwd, homeDir);
  }
  if (layer.indexPath !== undefined) target.indexPath = resolveDeclaredPath(layer.indexPath, sourcePath, cwd, homeDir);
  if (layer.port !== undefined) target.port = layer.port;
  if (layer.ignoredPaths !== undefined) target.ignoredPaths = layer.ignoredPaths;
  if (layer.processor !== undefined) target.processor = layer.processor;
  if (layer.processorMode !== undefined) target.processorMode = layer.processorMode;
}

function defaultUserConfigPath(homeDir: string): string {
  return process.env.XDG_CONFIG_HOME === undefined
    ? join(homeDir, '.config', 'reporecall', 'config.toml')
    : join(process.env.XDG_CONFIG_HOME, 'reporecall', 'config.toml');
}

export async function resolveConfig(options: ResolveConfigOptions = {}): Promise<RepoRecallConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeDir = resolve(options.homeDir ?? homedir());
  const userConfigPath = options.userConfigPath ?? defaultUserConfigPath(homeDir);
  const user = await readLayer(userConfigPath, 'user');
  const configuredProjectMemoryDir = options.projectMemoryDir ?? user.values.projectMemoryDir;
  const initialProjectMemoryDir = configuredProjectMemoryDir === undefined
    ? join(cwd, '.reporecall')
    : resolveDeclaredPath(
        configuredProjectMemoryDir,
        options.projectMemoryDir === undefined ? user.source?.path : undefined,
        cwd,
        homeDir,
      );
  const configuredBrainPath = options.brainPath ?? user.values.brainPath;
  const brainPath = configuredBrainPath === undefined
    ? join(homeDir, '.reporecall', 'brain')
    : resolveDeclaredPath(configuredBrainPath, options.brainPath === undefined ? user.source?.path : undefined, cwd, homeDir);
  const brain = await readLayer(join(brainPath, '.reporecall', 'config.toml'), 'brain');
  const brainProjectMemoryDir = brain.values.projectMemoryDir === undefined
    ? initialProjectMemoryDir
    : resolveDeclaredPath(brain.values.projectMemoryDir, join(brainPath, '.reporecall', 'config.toml'), cwd, homeDir);
  const project = await readLayer(join(brainProjectMemoryDir, 'config.toml'), 'project');
  const merged: ConfigOverrides = {};
  applyLayer(merged, user.values, user.source?.path, cwd, homeDir);
  applyLayer(merged, brain.values, join(brainPath, '.reporecall', 'config.toml'), cwd, homeDir);
  applyLayer(merged, project.values, join(brainProjectMemoryDir, 'config.toml'), cwd, homeDir, null);
  applyLayer(merged, options.cli ?? {}, undefined, cwd, homeDir);
  if (options.brainPath !== undefined) merged.brainPath = resolveDeclaredPath(options.brainPath, undefined, cwd, homeDir);
  if (options.projectMemoryDir !== undefined) {
    merged.projectMemoryDir = resolveDeclaredPath(options.projectMemoryDir, undefined, cwd, homeDir);
  }

  const finalProjectMemoryDir = merged.projectMemoryDir ?? brainProjectMemoryDir;
  const finalBrainPath = merged.brainPath ?? brainPath;
  return {
    brainPath: finalBrainPath,
    projectMemoryDir: finalProjectMemoryDir,
    indexPath: merged.indexPath ?? join(finalProjectMemoryDir, 'index.sqlite'),
    port: merged.port ?? 4_317,
    ignoredPaths: merged.ignoredPaths ?? DEFAULT_IGNORED_PATHS,
    processor: merged.processor ?? 'disabled',
    processorMode: merged.processorMode ?? 'conservative',
    sources: [user.source, brain.source, project.source].filter((source): source is ConfigSource => source !== undefined),
  };
}

export function stringifyConfig(values: Partial<RepoRecallConfig>): string {
  const output: Record<string, unknown> = {};
  if (values.brainPath !== undefined) output.brain_path = values.brainPath;
  if (values.projectMemoryDir !== undefined) output.project_memory_dir = values.projectMemoryDir;
  if (values.indexPath !== undefined) output.index_path = values.indexPath;
  if (values.port !== undefined) output.port = values.port;
  if (values.ignoredPaths !== undefined) output.ignored_paths = values.ignoredPaths;
  if (values.processor !== undefined) output.processor = values.processor;
  if (values.processorMode !== undefined) output.processor_mode = values.processorMode;
  if (Object.keys(output).length === 0) {
    output.brain_path = '~/.reporecall/brain';
    output.project_memory_dir = '.reporecall';
    output.index_path = 'index.sqlite';
    output.port = 4_317;
    output.ignored_paths = DEFAULT_IGNORED_PATHS;
    output.processor = 'disabled';
    output.processor_mode = 'conservative';
  }
  return stringifyToml(output as Parameters<typeof stringifyToml>[0]);
}
