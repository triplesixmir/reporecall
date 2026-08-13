import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AdapterTarget, AgentAdapter, InstallationReport } from '@reporecall/core';
import {
  removeManagedAgents,
  removeManagedHooks,
  updateManagedAgents,
  updateManagedHooks,
  type ManagedFileUpdate,
} from './managed.js';

export type CodexCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

export type CodexCommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type CodexCommandRunner = (
  executable: string,
  args: string[],
  options: CodexCommandOptions,
) => Promise<CodexCommandResult>;

export type CodexAdapterOptions = {
  codexExecutable?: string;
  codexHome?: string;
  projectRoot?: string;
  serverName?: string;
  serverCommand?: string;
  serverArgs?: string[];
  hookExecutable?: string;
  commandRunner?: CodexCommandRunner;
};

type TargetPaths = {
  projectRoot: string;
  configRoot: string;
  configPath: string;
  agentsPath: string;
  hooksPath: string;
};

function runCommand(executable: string, args: string[], options: CodexCommandOptions): Promise<CodexCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolvePromise({ status: status ?? 1, stdout, stderr }));
  });
}

function updatesChanged(updates: ManagedFileUpdate[]): boolean {
  return updates.some((update) => update.changed);
}

export class CodexAdapter implements AgentAdapter {
  private readonly options: Required<Pick<CodexAdapterOptions, 'codexExecutable' | 'serverName' | 'serverCommand' | 'hookExecutable'>> & CodexAdapterOptions;

  constructor(options: CodexAdapterOptions = {}) {
    this.options = {
      codexExecutable: 'codex',
      serverName: 'reporecall',
      serverCommand: 'reporecall',
      hookExecutable: 'reporecall',
      ...options,
    };
  }

  private paths(target: AdapterTarget): TargetPaths {
    const projectRoot = resolve(target.projectRoot ?? this.options.projectRoot ?? process.cwd());
    const userCodexHome = resolve(target.codexHome ?? this.options.codexHome ?? join(homedir(), '.codex'));
    const configRoot = target.scope === 'user' ? userCodexHome : join(projectRoot, '.codex');
    return {
      projectRoot,
      configRoot,
      configPath: join(configRoot, 'config.toml'),
      agentsPath: target.scope === 'user' ? join(configRoot, 'AGENTS.md') : join(projectRoot, 'AGENTS.md'),
      hooksPath: join(configRoot, 'hooks.json'),
    };
  }

  private async codexCommand(target: AdapterTarget, action: 'add' | 'remove'): Promise<CodexCommandResult> {
    const paths = this.paths(target);
    if (action === 'add') await mkdir(paths.configRoot, { recursive: true });
    const args = action === 'add'
      ? ['mcp', 'add', this.options.serverName, '--', this.options.serverCommand, ...(this.options.serverArgs ?? ['mcp'])]
      : ['mcp', 'remove', this.options.serverName];
    const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: paths.configRoot };
    return (this.options.commandRunner ?? runCommand)(this.options.codexExecutable, args, {
      cwd: paths.projectRoot,
      env: environment,
    });
  }

  private report(paths: TargetPaths, updates: ManagedFileUpdate[], warnings: string[], commandChanged: boolean): InstallationReport {
    return {
      changed: commandChanged || updatesChanged(updates),
      paths: [...new Set([paths.configPath, ...updates.map((update) => update.path)])],
      warnings,
    };
  }

  async install(target: AdapterTarget): Promise<InstallationReport> {
    const paths = this.paths(target);
    const command = await this.codexCommand(target, 'add');
    if (command.status !== 0) {
      throw new Error(`codex mcp add failed (${command.status}): ${(command.stderr || command.stdout).trim()}`);
    }
    const updates = [
      await updateManagedAgents(paths.agentsPath),
      await updateManagedHooks(paths.hooksPath, this.options.hookExecutable),
    ];
    return this.report(paths, updates, [], command.status === 0);
  }

  async uninstall(target: AdapterTarget): Promise<InstallationReport> {
    const paths = this.paths(target);
    const warnings: string[] = [];
    try {
      const command = await this.codexCommand(target, 'remove');
      if (command.status !== 0) warnings.push(`codex mcp remove exited with ${command.status}: ${(command.stderr || command.stdout).trim()}`);
    } catch (error) {
      warnings.push(`codex mcp remove was unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const updates = [
      await removeManagedAgents(paths.agentsPath),
      await removeManagedHooks(paths.hooksPath, this.options.hookExecutable),
    ];
    return this.report(paths, updates, warnings, false);
  }
}
