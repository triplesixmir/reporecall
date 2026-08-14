import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextBuilder, ContextRequest, ProjectRef, WorkspaceRef } from '@reporecall/core';

export const CODEX_HOOK_EVENTS = ['SessionStart', 'PostCompact', 'SessionEnd'] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

export type CodexHookInput = {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  reason?: string;
  source?: string;
  transcript_path?: string | null;
};

export type HookIO = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
};

export type CodexHookRuntime = {
  contextBuilder?: Pick<ContextBuilder, 'build'>;
  projectRoot?: string;
  projectId?: string;
  projectName?: string;
  projectAliases?: string[];
  workspace?: WorkspaceRef;
  tokenBudget?: number;
  runtimeRoot?: string;
  now?: () => string;
};

function isHookEvent(value: string | undefined): value is CodexHookEvent {
  return value !== undefined && (CODEX_HOOK_EVENTS as readonly string[]).includes(value);
}

function project(runtime: CodexHookRuntime): ProjectRef | undefined {
  if (runtime.projectRoot === undefined && runtime.projectId === undefined) return undefined;
  const root = runtime.projectRoot ?? runtime.projectId ?? 'project';
  return {
    id: runtime.projectId ?? root,
    root,
    ...(runtime.projectName === undefined ? {} : { name: runtime.projectName }),
  };
}

function defaultIO(): HookIO {
  return {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  };
}

async function injectContext(event: CodexHookEvent, runtime: CodexHookRuntime, io: HookIO): Promise<void> {
  if (runtime.contextBuilder === undefined) throw new Error('Context builder is not configured');
  const contextProject = project(runtime);
  const request: ContextRequest = {
    tokenBudget: runtime.tokenBudget ?? 2_000,
    ...(contextProject === undefined ? {} : { project: contextProject }),
    ...(runtime.projectAliases === undefined ? {} : { projectAliases: runtime.projectAliases }),
    ...(runtime.workspace === undefined ? {} : { workspace: runtime.workspace }),
  };
  const bundle = await runtime.contextBuilder.build(request);
  if (bundle.text.trim() === '') return;
  io.stdout(
    `${JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: bundle.text,
      },
    })}\n`,
  );
}

async function writeSessionMarker(input: CodexHookInput, runtime: CodexHookRuntime): Promise<void> {
  if (runtime.runtimeRoot === undefined) return;
  const directory = join(runtime.runtimeRoot, 'runtime');
  await mkdir(directory, { recursive: true });
  const marker = {
    schema: 1,
    event: 'session_end',
    sessionId: input.session_id ?? 'unknown',
    reason: input.reason ?? 'other',
    occurredAt: runtime.now?.() ?? new Date().toISOString(),
  };
  await appendFile(join(directory, 'session-events.jsonl'), `${JSON.stringify(marker)}\n`, 'utf8');
}

export async function runCodexHook(input: CodexHookInput, runtime: CodexHookRuntime, providedIO?: HookIO): Promise<number> {
  const io = providedIO ?? defaultIO();
  const event = input.hook_event_name;
  if (!isHookEvent(event)) {
    io.stderr(`RepoRecall hook ignored unknown event: ${event ?? 'missing'}\n`);
    return 0;
  }

  try {
    if (event === 'SessionEnd') {
      await writeSessionMarker(input, runtime);
      return 0;
    }
    await injectContext(event, runtime, io);
  } catch (error) {
    io.stderr(`RepoRecall hook failed open: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return 0;
}
