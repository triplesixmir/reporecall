import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CodexAdapter, runCodexHook, type CodexHookRuntime, type HookIO } from '../src/index.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; codexHome: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-codex-'));
  roots.push(root);
  const codexHome = join(root, 'codex home');
  const project = join(root, 'project');
  return { root, codexHome, project };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function commands(
  hooks: Record<string, Array<{ hooks: Array<{ command?: string }> }>> | undefined,
): string[] {
  return Object.values(hooks ?? {}).flatMap((groups) =>
    groups.flatMap((group) => group.hooks.map((hook) => hook.command ?? '')),
  );
}

type HookOutput = {
  hookSpecificOutput?: {
    hookEventName?: unknown;
    additionalContext?: unknown;
  };
};

function parseHookOutput(value: string): HookOutput {
  return JSON.parse(value) as HookOutput;
}

describe('Codex adapter', () => {
  test('installs idempotent MCP registration, managed instructions, and hooks', async () => {
    const { codexHome, project } = await fixture();
    const calls: Array<{
      executable: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }> = [];
    const adapter = new CodexAdapter({
      codexHome,
      projectRoot: project,
      commandRunner: (executable, args, options) => {
        calls.push({ executable, args, cwd: options.cwd, env: options.env });
        return Promise.resolve({ status: 0, stdout: '', stderr: '' });
      },
    });

    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'AGENTS.md'), '# Existing instructions\n', 'utf8');
    await writeFile(
      join(codexHome, 'hooks.json'),
      JSON.stringify({
        description: 'User hooks stay intact.',
        hooks: {
          SessionStart: [
            { matcher: '*', hooks: [{ type: 'command', command: 'reporecall custom-user-hook' }] },
          ],
        },
      }),
      'utf8',
    );
    await adapter.install({ scope: 'user' });
    await adapter.install({ scope: 'user' });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      executable: 'codex',
      args: ['mcp', 'add', 'reporecall', '--', 'reporecall', 'mcp'],
      cwd: project,
      env: { CODEX_HOME: codexHome },
    });
    const agents = await readFile(join(codexHome, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# Existing instructions');
    expect(agents.match(/BEGIN REPORECALL MANAGED BLOCK/g)).toHaveLength(1);
    expect(agents).toContain('memory_auto_capture');
    expect(agents).toContain('meaningful task');
    expect(agents).toContain('project scope');
    expect(agents).toContain('PostCompact');

    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
    };
    const installedCommands = commands(hooks.hooks);
    expect(
      installedCommands.filter((command) => command.includes('--managed-by reporecall')),
    ).toHaveLength(3);
    expect(installedCommands).toContain('reporecall custom-user-hook');

    const removal = await adapter.uninstall({ scope: 'user' });
    expect(removal.changed).toBe(true);
    const remainingHooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command?: string }> }>>;
    };
    expect(commands(remainingHooks.hooks)).toEqual(['reporecall custom-user-hook']);
    expect(await readFile(join(codexHome, 'AGENTS.md'), 'utf8')).not.toContain(
      'BEGIN REPORECALL MANAGED BLOCK',
    );
    expect(calls[2]).toMatchObject({
      args: ['mcp', 'remove', 'reporecall'],
      env: { CODEX_HOME: codexHome },
    });
  });

  test('preserves a user hook group and supports project-scoped installation', async () => {
    const { codexHome, project } = await fixture();
    const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
    const adapter = new CodexAdapter({
      codexHome,
      projectRoot: project,
      commandRunner: (_executable, args, options) => {
        calls.push({ args, cwd: options.cwd, env: options.env });
        return Promise.resolve({ status: 0, stdout: '', stderr: '' });
      },
    });

    await adapter.install({ scope: 'project', projectRoot: project });
    expect(calls[0]).toMatchObject({
      args: ['mcp', 'add', 'reporecall', '--', 'reporecall', 'mcp'],
      cwd: project,
      env: { CODEX_HOME: join(project, '.codex') },
    });
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toContain('Canonical memory files');
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toContain('memory_auto_capture');
    expect(await readFile(join(project, '.codex', 'hooks.json'), 'utf8')).toContain('SessionStart');
  });
});

describe('Codex lifecycle hooks', () => {
  test('injects deterministic context on SessionStart and PostCompact', async () => {
    const { root, project } = await fixture();
    const output: string[] = [];
    const errors: string[] = [];
    const io: HookIO = {
      stdout: (value) => output.push(value),
      stderr: (value) => errors.push(value),
    };
    const requests: Array<{ tokenBudget: number; project?: { id: string; root: string } }> = [];
    const runtime: CodexHookRuntime = {
      projectRoot: project,
      runtimeRoot: root,
      tokenBudget: 300,
      contextBuilder: {
        build: (request) => {
          requests.push(request);
          return Promise.resolve({
            items: [],
            text: '### mem_demo (decision)\nKeep project conventions.',
            estimatedTokens: 8,
            omittedCount: 0,
          });
        },
      },
    };

    await expect(
      runCodexHook(
        {
          hook_event_name: 'SessionStart',
          session_id: 'session-1',
          cwd: project,
          transcript_path: '/secret/transcript.jsonl',
        },
        runtime,
        io,
      ),
    ).resolves.toBe(0);
    await expect(
      runCodexHook(
        {
          hook_event_name: 'PostCompact',
          session_id: 'session-1',
          cwd: project,
          transcript_path: '/secret/transcript.jsonl',
        },
        runtime,
        io,
      ),
    ).resolves.toBe(0);

    const sessionStart = parseHookOutput(output[0] ?? '');
    const postCompact = parseHookOutput(output[1] ?? '');
    expect(sessionStart.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(sessionStart.hookSpecificOutput?.additionalContext).toContain(
      'Keep project conventions',
    );
    expect(postCompact.hookSpecificOutput?.hookEventName).toBe('PostCompact');
    expect(postCompact.hookSpecificOutput?.additionalContext).toContain('Keep project conventions');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ tokenBudget: 300, project: { root: project } });
    expect(errors).toEqual([]);
  });

  test('writes only a local lifecycle marker on SessionEnd and fails open', async () => {
    const { root, project } = await fixture();
    const output: string[] = [];
    const errors: string[] = [];
    const io: HookIO = {
      stdout: (value) => output.push(value),
      stderr: (value) => errors.push(value),
    };
    const runtime: CodexHookRuntime = { projectRoot: project, runtimeRoot: root };

    await expect(
      runCodexHook(
        {
          hook_event_name: 'SessionEnd',
          session_id: 'session-2',
          cwd: project,
          reason: 'other',
          transcript_path: '/private/raw-transcript-with-secret-sk-proj-1234567890abcdef',
        },
        runtime,
        io,
      ),
    ).resolves.toBe(0);
    const marker = await readFile(join(root, 'runtime', 'session-events.jsonl'), 'utf8');
    expect(marker).toContain('session-2');
    expect(marker).not.toContain('transcript');
    expect(marker).not.toContain('sk-proj');
    expect(output).toEqual([]);

    const failing: CodexHookRuntime = {
      ...runtime,
      contextBuilder: { build: () => Promise.reject(new Error('index unavailable')) },
    };
    await expect(
      runCodexHook(
        { hook_event_name: 'SessionStart', session_id: 'session-3', cwd: project },
        failing,
        io,
      ),
    ).resolves.toBe(0);
    expect(errors.join(' ')).toMatch(/index unavailable/i);
  });
});
