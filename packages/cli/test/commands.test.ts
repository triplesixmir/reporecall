import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FileInboxStore } from '@reporecall/processors';
import { FileMemoryStore } from '@reporecall/storage';
import { runCli, type CliIO } from '../src/index.js';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reporecall-cli-'));
  roots.push(root);
  return root;
}

function io(cwd: string, output: string[], errors: string[]): CliIO {
  return {
    cwd,
    homeDir: join(cwd, 'home'),
    stdout: (value) => output.push(value),
    stderr: (value) => errors.push(value),
  };
}

function stdin(value: string): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      yield value;
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RepoRecall CLI', () => {
  test('initializes, remembers, rebuilds, and searches a custom local brain', async () => {
    const root = await fixture();
    const project = join(root, 'project');
    const brain = join(root, 'brain');
    const output: string[] = [];
    const errors: string[] = [];
    const context = io(project, output, errors);

    await expect(runCli(['init', '--brain', brain], context)).resolves.toBe(0);
    await expect(
      runCli(['remember', 'Keep this local project decision.', '--brain', brain], context),
    ).resolves.toBe(0);
    await expect(runCli(['rebuild', '--brain', brain], context)).resolves.toBe(0);
    await expect(
      runCli(['search', 'local project decision', '--brain', brain], context),
    ).resolves.toBe(0);

    expect(output.join('\n')).toContain('Keep this local project decision.');
    await expect(readdir(join(project, '.reporecall', 'memories'))).resolves.toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('refuses to persist a secret-only memory', async () => {
    const root = await fixture();
    const project = join(root, 'project');
    const brain = join(root, 'brain');
    const output: string[] = [];
    const errors: string[] = [];
    const context = io(project, output, errors);

    await runCli(['init', '--brain', brain], context);
    await expect(
      runCli(['remember', 'sk-proj-1234567890abcdef', '--brain', brain], context),
    ).resolves.toBe(2);
    await expect(readdir(join(project, '.reporecall', 'memories'))).resolves.toEqual([]);
    expect(errors.join('\n')).toMatch(/secret|credential/i);
  });

  test('lists structured pending Inbox suggestions from canonical files', async () => {
    const root = await fixture();
    const project = join(root, 'project');
    const brain = join(root, 'brain');
    const output: string[] = [];
    const errors: string[] = [];
    const context = io(project, output, errors);

    await runCli(['init', '--brain', brain], context);
    const inbox = new FileInboxStore({ root: join(project, '.reporecall') });
    await inbox.create({
      suggested: {
        content: 'Review this processor suggestion.',
        scope: 'project',
        type: 'decision',
      },
      reason: 'Needs a human decision.',
    });

    await expect(runCli(['inbox', '--brain', brain], context)).resolves.toBe(0);

    const listed = JSON.parse(output.at(-1) ?? '[]') as Array<{ suggested: { content: string } }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]?.suggested.content).toBe('Review this processor suggestion.');
    expect(errors).toEqual([]);
  });

  test('processes an agent-native capture into the project Inbox in conservative mode', async () => {
    const root = await fixture();
    const project = join(root, 'project');
    const brain = join(root, 'brain');
    const output: string[] = [];
    const errors: string[] = [];
    const context = io(project, output, errors);

    await runCli(['init', '--brain', brain], context);
    await expect(
      runCli(
        [
          'process',
          '--processor',
          'agent-native',
          '--content',
          'Decision: keep Markdown canonical.',
          '--brain',
          brain,
        ],
        context,
      ),
    ).resolves.toBe(0);

    const pending = await new FileInboxStore({ root: join(project, '.reporecall') }).list({
      status: 'pending',
    });
    expect(pending).toMatchObject([
      { suggested: { content: 'keep Markdown canonical.', scope: 'project' } },
    ]);
    expect(await readdir(join(project, '.reporecall', 'memories'))).toEqual([]);
    expect(output.join('\n')).toMatch(/1 Inbox/i);
    expect(errors).toEqual([]);
  });

  test('persists balanced agent-native suggestions and makes them searchable', async () => {
    const root = await fixture();
    const project = join(root, 'project');
    const brain = join(root, 'brain');
    const output: string[] = [];
    const errors: string[] = [];
    const context = io(project, output, errors);

    await runCli(['init', '--brain', brain], context);
    await expect(
      runCli(
        [
          'process',
          '--processor',
          'agent-native',
          '--processor-mode',
          'balanced',
          '--content',
          'Decision: use deterministic ranking.',
          '--brain',
          brain,
        ],
        context,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(['search', 'deterministic ranking', '--brain', brain], context),
    ).resolves.toBe(0);

    expect(output.join('\n')).toContain('use deterministic ranking.');
    expect(errors).toEqual([]);
  });

  test('requires explicit opt-in for automatic persistence', async () => {
    const root = await fixture();
    const project = join(root, 'project');
    const brain = join(root, 'brain');
    const output: string[] = [];
    const errors: string[] = [];
    const context = io(project, output, errors);

    await runCli(['init', '--brain', brain], context);
    await expect(
      runCli(
        [
          'process',
          '--processor',
          'agent-native',
          '--processor-mode',
          'automatic',
          '--content',
          'Decision: do not persist without approval.',
          '--brain',
          brain,
        ],
        context,
      ),
    ).resolves.toBe(1);
    await expect(
      runCli(
        [
          'process',
          '--processor',
          'agent-native',
          '--processor-mode',
          'automatic',
          '--allow-automatic',
          '--content',
          'Decision: persist after explicit approval.',
          '--brain',
          brain,
        ],
        context,
      ),
    ).resolves.toBe(0);

    await expect(
      new FileMemoryStore({ root: join(project, '.reporecall'), scope: 'project' }).list(),
    ).resolves.toMatchObject([{ content: 'persist after explicit approval.' }]);
    expect(errors.join('\n')).toMatch(/automatic.*allow/i);
  });

  test('accepts JSON stdin without writing the raw capture as a session file', async () => {
    const root = await fixture();
    const project = join(root, 'project');
    const brain = join(root, 'brain');
    const output: string[] = [];
    const errors: string[] = [];
    const context = { ...io(project, output, errors), stdin: stdin(JSON.stringify({
      content: 'Decision: use stdin captures.',
      sessionId: 'session-json',
    })) };

    await runCli(['init', '--brain', brain], context);
    await expect(
      runCli(['process', '--processor', 'agent-native', '--brain', brain], context),
    ).resolves.toBe(0);

    expect(await readdir(join(project, '.reporecall', 'sessions'))).toEqual([]);
    const pending = await new FileInboxStore({ root: join(project, '.reporecall') }).list({
      status: 'pending',
    });
    expect(pending).toMatchObject([{ suggested: { content: 'use stdin captures.' } }]);
    expect(errors).toEqual([]);
  });

  test('rejects a secret-only capture before creating processor output', async () => {
    const root = await fixture();
    const project = join(root, 'project');
    const brain = join(root, 'brain');
    const output: string[] = [];
    const errors: string[] = [];
    const context = io(project, output, errors);

    await runCli(['init', '--brain', brain], context);
    await expect(
      runCli(
        [
          'process',
          '--processor',
          'agent-native',
          '--content',
          'sk-proj-1234567890abcdef',
          '--brain',
          brain,
        ],
        context,
      ),
    ).resolves.toBe(2);

    expect(await new FileInboxStore({ root: join(project, '.reporecall') }).list()).toEqual([]);
    expect(errors.join('\n')).toMatch(/secret|credential/i);
    expect(errors.join('\n')).not.toContain('sk-proj-1234567890abcdef');
  });
});
