import { join } from 'node:path';
import type {
  MemoryScope,
  MemorySourceRoot,
  ProcessedCaptureResult,
  RedactedSessionCapture,
} from '@reporecall/core';
import { SqliteMemoryIndex } from '@reporecall/index';
import {
  FileInboxStore,
  ScopedInboxStore,
  createMemoryProcessingService,
  type ProcessCaptureOptions,
} from '@reporecall/processors';
import { FileMemoryStore } from '@reporecall/storage';
import type { RepoRecallConfig } from './config.js';

export type CliProcessingRuntime = {
  stores: {
    global: FileMemoryStore;
    project: FileMemoryStore;
    session: FileMemoryStore;
  };
  inbox: ScopedInboxStore;
  index: SqliteMemoryIndex;
  processCapture(
    capture: RedactedSessionCapture,
    options?: ProcessCaptureOptions,
  ): Promise<ProcessedCaptureResult>;
  close(): void;
};

function memoryPath(root: string, id: string, scope: MemoryScope): string {
  return join(root, scope === 'session' ? 'sessions' : 'memories', `${id}.md`);
}

function memoryRoot(config: RepoRecallConfig, scope: MemoryScope): string {
  return scope === 'global' ? config.brainPath : config.projectMemoryDir;
}

export function createProcessingRuntime(config: RepoRecallConfig): CliProcessingRuntime {
  const stores = {
    global: new FileMemoryStore({ root: config.brainPath, scope: 'global' }),
    project: new FileMemoryStore({ root: config.projectMemoryDir, scope: 'project' }),
    session: new FileMemoryStore({ root: config.projectMemoryDir, scope: 'session' }),
  };
  const inbox = new ScopedInboxStore({
    global: new FileInboxStore({ root: config.brainPath }),
    project: new FileInboxStore({ root: config.projectMemoryDir }),
  });
  const index = new SqliteMemoryIndex({ path: config.indexPath });
  const service = createMemoryProcessingService({
    store: stores.project,
    stores: {
      global: stores.global,
      workspace: stores.project,
      project: stores.project,
      session: stores.session,
    },
    inbox,
    providerKind: config.processor,
    mode: config.processorMode,
    afterDurable: async (record) => {
      await index.update([memoryPath(memoryRoot(config, record.scope), record.id, record.scope)]);
    },
  });

  return {
    stores,
    inbox,
    index,
    processCapture: (capture, options) => service.process(capture, options),
    close: () => index.close(),
  };
}

export function processingSources(config: RepoRecallConfig): MemorySourceRoot[] {
  return [
    { root: config.brainPath, scope: 'global' },
    { root: config.projectMemoryDir, scope: 'project' },
    { root: config.projectMemoryDir, scope: 'session' },
  ];
}
