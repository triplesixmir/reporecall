import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FileInboxStore, ScopedInboxStore } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ScopedInboxStore', () => {
  test('routes suggestions by scope and searches both backing stores', async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), 'reporecall-global-inbox-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'reporecall-project-inbox-'));
    roots.push(globalRoot, projectRoot);

    const globalInbox = new FileInboxStore({ root: globalRoot });
    const projectInbox = new FileInboxStore({ root: projectRoot });
    const inbox = new ScopedInboxStore({ global: globalInbox, project: projectInbox });

    const globalItem = await inbox.create({
      suggested: { content: 'Global preference.', scope: 'global', type: 'preference' },
    });
    const projectItem = await inbox.create({
      suggested: { content: 'Project decision.', scope: 'project', type: 'decision' },
    });

    expect(await globalInbox.get(globalItem.id)).not.toBeNull();
    expect(await projectInbox.get(projectItem.id)).not.toBeNull();
    expect(await inbox.list()).toHaveLength(2);
    await expect(inbox.update(globalItem.id, { status: 'dismissed' })).resolves.toMatchObject({
      status: 'dismissed',
    });
    await inbox.remove(projectItem.id);
    await expect(inbox.list()).resolves.toHaveLength(1);
  });

  test('combines filters, limits, and validation diagnostics', async () => {
    const globalRoot = await mkdtemp(join(tmpdir(), 'reporecall-global-inbox-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'reporecall-project-inbox-'));
    roots.push(globalRoot, projectRoot);

    const globalInbox = new FileInboxStore({ root: globalRoot });
    const projectInbox = new FileInboxStore({ root: projectRoot });
    const inbox = new ScopedInboxStore({ global: globalInbox, project: projectInbox });

    await inbox.create({
      suggested: {
        content: 'Project-specific suggestion.',
        scope: 'project',
        type: 'decision',
        project: { id: 'demo', root: '/tmp/demo' },
      },
    });
    await inbox.create({
      suggested: { content: 'Global suggestion.', scope: 'global', type: 'fact' },
    });

    expect(await inbox.list({ projectId: 'demo' })).toMatchObject([
      { suggested: { content: 'Project-specific suggestion.' } },
    ]);
    expect(await inbox.list({ limit: 1 })).toHaveLength(1);

    const invalidPath = join(projectRoot, 'inbox', 'inbox_broken.md');
    await import('node:fs/promises').then(({ mkdir, writeFile }) =>
      mkdir(join(projectRoot, 'inbox'), { recursive: true }).then(() =>
        writeFile(invalidPath, 'not valid inbox markdown', 'utf8'),
      ),
    );
    const report = await inbox.validateAll();
    expect(report.valid).toBe(2);
    expect(report.invalid).toHaveLength(1);
    expect(report.invalid[0]?.path).toBe(invalidPath);
  });
});
