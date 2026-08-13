import { test, expect, type Page, type Request } from '@playwright/test';

const memory = {
  schema: 1 as const,
  id: 'mem_e2e_decision',
  scope: 'project' as const,
  type: 'decision' as const,
  priority: 'high' as const,
  status: 'active' as const,
  pinned: false,
  createdAt: '2026-01-01T12:00:00.000Z',
  updatedAt: '2026-01-01T12:00:00.000Z',
  tags: [{ name: 'e2e', origin: 'user' as const }],
  confidence: 1,
  project: { id: 'demo', root: '/tmp/demo', name: 'Demo' },
  relations: [],
  content: 'Canonical Markdown remains the source of truth.',
};

const inboxItem = {
  schema: 1 as const,
  id: 'inbox_e2e_suggestion',
  status: 'pending' as const,
  createdAt: '2026-01-01T12:00:00.000Z',
  updatedAt: '2026-01-01T12:00:00.000Z',
  suggested: {
    content: 'Keep session summaries explicit and user-approved.',
    scope: 'project' as const,
    type: 'constraint' as const,
    priority: 'normal' as const,
    tags: [{ name: 'privacy', origin: 'ai' as const, confidence: 0.9 }],
  },
  source: { kind: 'processor', provider: 'agent-native' },
  reason: 'Needs a human decision before becoming durable.',
};

function contentFromRequest(request: Request): string {
  try {
    const value: unknown = JSON.parse(request.postData() ?? '{}') as unknown;
    if (typeof value === 'object' && value !== null && 'content' in value) {
      const content = (value as { content?: unknown }).content;
      if (typeof content === 'string') return content;
    }
  } catch {
    return memory.content;
  }
  return memory.content;
}

async function mockApi(page: Page) {
  let pendingInbox = true;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/overview')
      return json({
        memoryCount: 1,
        activeCount: 1,
        projectCount: 1,
        tagCount: 1,
        inboxCount: pendingInbox ? 1 : 0,
        indexErrors: [],
      });
    if (path === '/api/health') return json({ status: 'ok', version: '0.1.0', indexErrors: [] });
    if (path === '/api/memories' && request.method() === 'GET')
      return json({ memories: [memory], count: 1 });
    if (path === '/api/memories' && request.method() === 'POST')
      return json(
        {
          memory: {
            ...memory,
            id: 'mem_e2e_created',
            content: contentFromRequest(request),
          },
          warnings: [],
        },
        201,
      );
    if (path === `/api/memories/${memory.id}` && request.method() === 'GET')
      return json({ memory });
    if (path === '/api/recent') return json({ records: [memory], count: 1 });
    if (path === '/api/projects') return json({ projects: [memory.project], count: 1 });
    if (path === '/api/tags')
      return json({ tags: [{ name: 'e2e', count: 1, userCount: 1, aiCount: 0 }], count: 1 });
    if (path === '/api/graph')
      return json({
        nodes: [
          {
            id: memory.id,
            label: memory.content,
            type: memory.type,
            scope: memory.scope,
            status: memory.status,
          },
        ],
        edges: [],
      });
    if (path === '/api/inbox' && request.method() === 'GET')
      return json({ items: pendingInbox ? [inboxItem] : [], count: pendingInbox ? 1 : 0 });
    if (path === `/api/inbox/${inboxItem.id}/accept`) {
      pendingInbox = false;
      return json(
        {
          item: { ...inboxItem, status: 'accepted' },
          memory: { ...memory, id: 'mem_e2e_accepted', content: inboxItem.suggested.content },
          warnings: [],
        },
        201,
      );
    }
    if (path === `/api/inbox/${inboxItem.id}/dismiss`) {
      pendingInbox = false;
      return json({ item: { ...inboxItem, status: 'dismissed' } });
    }
    if (path.startsWith('/api/memories/') && request.method() === 'PATCH')
      return json({ memory, warnings: [] });
    return json({ error: { message: `Unhandled mock route ${request.method()} ${path}` } }, 500);
  });
}

test.describe('RepoRecall Web UI', () => {
  test('navigates, searches, opens the editor, and creates a memory', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Keep the important parts.' })).toBeVisible();
    await page.getByRole('button', { name: 'Memories' }).click();
    await expect(page).toHaveURL(/view=memories/);
    await page.getByRole('searchbox', { name: 'Search memories' }).fill('canonical');
    await expect(page).toHaveURL(/q=canonical/);
    await page.getByRole('button', { name: 'New memory' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Memory content' })
      .fill('A new durable decision created from the workbench.');
    await page.getByRole('button', { name: 'Save memory' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByText('Saved mem_e2e_created')).toBeVisible();
  });

  test('reviews an Inbox suggestion and exposes the graph/settings screens', async ({ page }) => {
    await mockApi(page);
    await page.goto('/?view=inbox');
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    await expect(page.getByRole('heading', { name: inboxItem.suggested.content })).toBeVisible();
    await page.getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByText('Accepted mem_e2e_accepted')).toBeVisible();
    await expect(page.getByText('Inbox is clear')).toBeVisible();
    await page.getByRole('button', { name: 'Graph' }).click();
    await expect(page.getByRole('heading', { name: 'Graph' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Connected and loopback-only')).toBeVisible();
  });

  test('keeps navigation reachable at the 320px breakpoint', async ({ page }) => {
    await mockApi(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('navigation', { name: 'Mobile navigation' })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Mobile navigation' })
      .getByRole('button', { name: 'Memories' })
      .click();
    await expect(page).toHaveURL(/view=memories/);
    await expect(page.getByRole('heading', { name: 'Memories' })).toBeVisible();
  });
});
