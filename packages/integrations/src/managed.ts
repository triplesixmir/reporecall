import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const REPORECALL_BEGIN_MARKER = '<!-- BEGIN REPORECALL MANAGED BLOCK -->';
export const REPORECALL_END_MARKER = '<!-- END REPORECALL MANAGED BLOCK -->';

export const REPORECALL_MANAGED_BLOCK = `${REPORECALL_BEGIN_MARKER}
## RepoRecall memory

Canonical memory files are Markdown with YAML frontmatter and are the durable source of truth. SQLite is only a rebuildable local index. Do not store secrets, credentials, private keys, or raw transcripts in memory files.

Use RepoRecall MCP tools or the local CLI for memory operations. Durable session summaries are created only after an explicit checkpoint.
${REPORECALL_END_MARKER}`;

const HOOK_EVENTS = ['SessionStart', 'PostCompact', 'SessionEnd'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

type JsonObject = { [key: string]: unknown };
type HookGroup = JsonObject & { hooks?: unknown };

export type ManagedFileUpdate = {
  changed: boolean;
  path: string;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function mergeAgents(existing: string): { content: string; changed: boolean } {
  const begin = existing.indexOf(REPORECALL_BEGIN_MARKER);
  const end = existing.indexOf(REPORECALL_END_MARKER);
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
    throw new Error('AGENTS.md contains an incomplete RepoRecall managed block');
  }
  if (begin !== -1 && end !== -1) {
    const endExclusive = end + REPORECALL_END_MARKER.length;
    const content = `${existing.slice(0, begin)}${REPORECALL_MANAGED_BLOCK}${existing.slice(endExclusive)}`;
    return { content, changed: content !== existing };
  }
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  return {
    content: `${existing}${separator}\n${REPORECALL_MANAGED_BLOCK}\n`,
    changed: true,
  };
}

export async function updateManagedAgents(path: string): Promise<ManagedFileUpdate> {
  const existing = (await readOptional(path)) ?? '';
  const merged = mergeAgents(existing);
  if (merged.changed) await atomicWrite(path, merged.content);
  return { changed: merged.changed, path };
}

export async function removeManagedAgents(path: string): Promise<ManagedFileUpdate> {
  const existing = await readOptional(path);
  if (existing === undefined) return { changed: false, path };
  const begin = existing.indexOf(REPORECALL_BEGIN_MARKER);
  const end = existing.indexOf(REPORECALL_END_MARKER);
  if (begin === -1 && end === -1) return { changed: false, path };
  if ((begin === -1) !== (end === -1) || end < begin) {
    throw new Error('AGENTS.md contains an incomplete RepoRecall managed block');
  }
  const before = existing.slice(0, begin).replace(/\n{3,}$/u, '\n\n');
  const after = existing.slice(end + REPORECALL_END_MARKER.length).replace(/^\n{3,}/u, '\n\n');
  const content = `${before}${after}`.replace(/^\n+$/u, '');
  await atomicWrite(path, content.length === 0 ? '' : `${content}\n`);
  return { changed: true, path };
}

export function managedHookCommand(event: HookEvent, executable = 'reporecall'): string {
  return `${executable} codex-hook ${event} --managed-by reporecall`;
}

function managedGroup(event: HookEvent, executable: string): HookGroup {
  const matcher = event === 'SessionStart' ? 'startup|resume|clear|compact' : event === 'PostCompact' ? 'manual|auto' : 'other';
  const command = managedHookCommand(event, executable);
  return {
    matcher,
    hooks: [
      {
        type: 'command',
        command,
        timeout: event === 'SessionEnd' ? 3 : 10,
        ...(event === 'SessionStart' || event === 'PostCompact' ? { additionalContextLimit: 5_000 } : {}),
      },
    ],
  };
}

function isManagedHandler(value: unknown, event: HookEvent, executable: string): boolean {
  if (!isRecord(value)) return false;
  return value.type === 'command' && value.command === managedHookCommand(event, executable);
}

function withoutManagedHandlers(value: unknown, event: HookEvent, executable: string): HookGroup | null {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return isRecord(value) ? value : null;
  const original = value.hooks;
  const hooks = original.filter((handler) => !isManagedHandler(handler, event, executable));
  if (hooks.length === original.length) return value;
  if (hooks.length === 0) return null;
  return { ...value, hooks };
}

function updateHooksDocument(source: string | undefined, executable: string, install: boolean): string {
  let document: JsonObject = {};
  if (source !== undefined && source.trim() !== '') {
    const parsed: unknown = JSON.parse(source);
    if (!isRecord(parsed)) throw new Error('Codex hooks.json must contain a JSON object');
    document = parsed;
  }
  const currentHooks = document.hooks;
  if (currentHooks !== undefined && !isRecord(currentHooks)) {
    throw new Error('Codex hooks.json field "hooks" must be an object');
  }
  const hooks: JsonObject = isRecord(currentHooks) ? { ...currentHooks } : {};

  for (const event of HOOK_EVENTS) {
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`Codex hooks.json event "${event}" must be an array`);
    }
    const preserved = (current ?? [])
      .map((group) => withoutManagedHandlers(group, event, executable))
      .filter((group): group is HookGroup => group !== null);
    hooks[event] = install ? [...preserved, managedGroup(event, executable)] : preserved;
    if (!install && preserved.length === 0) delete hooks[event];
  }

  if (Object.keys(hooks).length === 0) {
    delete document.hooks;
  } else {
    document.hooks = hooks;
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export async function updateManagedHooks(path: string, executable = 'reporecall'): Promise<ManagedFileUpdate> {
  const source = await readOptional(path);
  const next = updateHooksDocument(source, executable, true);
  const changed = source !== next;
  if (changed) await atomicWrite(path, next);
  return { changed, path };
}

export async function removeManagedHooks(path: string, executable = 'reporecall'): Promise<ManagedFileUpdate> {
  const source = await readOptional(path);
  if (source === undefined) return { changed: false, path };
  const next = updateHooksDocument(source, executable, false);
  const changed = source !== next;
  if (changed) await atomicWrite(path, next);
  return { changed, path };
}
