import {
  createProcessorProvider,
  type ProcessorProviderOptions,
  type ProcessorHttpClient,
} from './providers.js';
import {
  PROCESSOR_MODES,
  redactSecrets,
  type CreateMemoryInput,
  type DuplicateMatch,
  type InboxItem,
  type InboxStore,
  type MemoryProcessor,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStore,
  type ProcessorKind,
  type ProcessorMode,
  type ProcessorProviderResult,
  type ProcessorSuggestion,
  type ProcessorSuggestionProvider,
  type ProcessorResult,
  type RedactedSessionCapture,
} from '@reporecall/core';

export type MemoryProcessorOptions = {
  store: MemoryStore;
  inbox: InboxStore;
  stores?: Partial<Record<MemoryScope, MemoryStore>>;
  provider?: ProcessorSuggestionProvider;
  providerKind?: ProcessorKind;
  providerOptions?: ProcessorProviderOptions;
  mode?: ProcessorMode;
  allowAutomatic?: boolean;
  balancedConfidence?: number;
};

type Candidate = {
  suggestion: ProcessorSuggestion;
  input: CreateMemoryInput;
  explicit: boolean;
};

function suggestionFromInput(input: CreateMemoryInput, reason?: string): ProcessorSuggestion {
  return {
    ...input,
    ...(reason === undefined ? {} : { reason }),
  };
}

function sourceFor(
  kind: 'explicit' | 'processor',
  capture: RedactedSessionCapture,
  providerKind: string,
  existing: CreateMemoryInput['source'],
): CreateMemoryInput['source'] {
  if (kind === 'explicit' && existing !== undefined) return existing;
  if (kind === 'explicit' && capture.source !== undefined) return capture.source;
  return {
    kind: kind === 'explicit' ? 'agent' : 'processor',
    ...(kind === 'processor' ? { provider: providerKind } : {}),
    ...(capture.sessionId === undefined ? {} : { sessionId: capture.sessionId }),
    ...(capture.capturedAt === undefined ? {} : { capturedAt: capture.capturedAt }),
    method: kind === 'explicit' ? 'explicit-capture' : 'consolidation',
  };
}

function normalizeCandidate(
  suggestion: ProcessorSuggestion,
  capture: RedactedSessionCapture,
  kind: 'explicit' | 'processor',
  providerKind: string,
  warnings: string[],
): Candidate | null {
  const scanned = redactSecrets(suggestion.content);
  if (scanned.blocked || scanned.redacted.trim() === '') {
    warnings.push('Processor skipped a suggestion containing only a secret or credential.');
    return null;
  }
  const scope = suggestion.scope;
  const project = suggestion.project ?? (scope === 'global' ? undefined : capture.project);
  const workspace = suggestion.workspace ?? capture.workspace;
  const tags =
    kind === 'explicit'
      ? suggestion.tags
      : suggestion.tags?.map((tag) => ({
          name: tag.name,
          origin: 'ai' as const,
          ...(tag.confidence === undefined ? {} : { confidence: tag.confidence }),
        }));
  const source = sourceFor(kind, capture, providerKind, suggestion.source);
  const input = {
    content: scanned.redacted,
    scope,
    type: suggestion.type,
    ...(suggestion.priority === undefined ? {} : { priority: suggestion.priority }),
    ...(suggestion.status === undefined ? {} : { status: suggestion.status }),
    ...(suggestion.pinned === undefined ? {} : { pinned: suggestion.pinned }),
    ...(tags === undefined ? {} : { tags }),
    ...(suggestion.confidence === undefined ? {} : { confidence: suggestion.confidence }),
    ...(project === undefined ? {} : { project }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(source === undefined ? {} : { source }),
    ...(suggestion.relations === undefined ? {} : { relations: suggestion.relations }),
  } satisfies CreateMemoryInput;
  return {
    input,
    suggestion: suggestionFromInput(input, suggestion.reason),
    explicit: kind === 'explicit',
  };
}

export function normalizeMemoryContent(content: string): string {
  return content
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\p{P}+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function memoryDuplicateKey(
  record: Pick<CreateMemoryInput, 'content' | 'type' | 'project'>,
): string {
  return [record.type, record.project?.id ?? '', normalizeMemoryContent(record.content)].join('|');
}

function duplicateOf(
  candidate: CreateMemoryInput,
  existing: MemoryRecord[],
): MemoryRecord | undefined {
  const key = memoryDuplicateKey(candidate);
  return existing.find((record) => memoryDuplicateKey(record) === key);
}

function storeForScope(options: MemoryProcessorOptions, scope: MemoryScope): MemoryStore {
  return options.stores?.[scope] ?? options.store;
}

async function listExisting(options: MemoryProcessorOptions): Promise<MemoryRecord[]> {
  const stores = [...new Set([options.store, ...Object.values(options.stores ?? {})])];
  const records = (await Promise.all(stores.map((store) => store.list()))).flat();
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function providerName(options: MemoryProcessorOptions): string {
  return options.providerKind ?? 'custom';
}

export class ConsolidatingMemoryProcessor implements MemoryProcessor {
  private readonly options: Required<Pick<MemoryProcessorOptions, 'mode' | 'balancedConfidence'>> &
    MemoryProcessorOptions;
  private readonly provider: ProcessorSuggestionProvider;

  constructor(options: MemoryProcessorOptions) {
    const mode = options.mode ?? 'conservative';
    if (!PROCESSOR_MODES.includes(mode)) throw new Error(`Unsupported processor mode: ${mode}`);
    if (mode === 'automatic' && options.allowAutomatic !== true) {
      throw new Error('Automatic processing requires explicit allowAutomatic: true.');
    }
    this.options = {
      ...options,
      mode,
      balancedConfidence: options.balancedConfidence ?? 0.9,
    };
    this.provider =
      options.provider ??
      createProcessorProvider(options.providerKind ?? 'disabled', options.providerOptions);
  }

  async process(capture: RedactedSessionCapture): Promise<ProcessorResult> {
    const warnings: string[] = [];
    const durable: MemoryRecord[] = [];
    const inbox: InboxItem[] = [];
    const duplicates: DuplicateMatch[] = [];
    const captureScan = redactSecrets(capture.content);
    if (captureScan.blocked || captureScan.redacted.trim() === '') {
      return {
        durable,
        inbox,
        duplicates,
        warnings: ['Processor refused a session capture containing only a secret or credential.'],
      };
    }
    if (captureScan.redacted !== capture.content) {
      warnings.push('Processor redacted one or more secrets before provider processing.');
    }
    const safeCapture =
      captureScan.redacted === capture.content
        ? capture
        : { ...capture, content: captureScan.redacted };
    const providerResult: ProcessorProviderResult = await this.provider.suggest(safeCapture);
    warnings.push(...providerResult.warnings);
    const existing = await listExisting(this.options);
    const providerKind = providerName(this.options);

    const explicitCandidates = (safeCapture.explicit ?? [])
      .map((suggestion) =>
        normalizeCandidate(suggestion, safeCapture, 'explicit', providerKind, warnings),
      )
      .filter((candidate): candidate is Candidate => candidate !== null);
    const providerCandidates = providerResult.suggestions
      .map((suggestion) =>
        normalizeCandidate(suggestion, safeCapture, 'processor', providerKind, warnings),
      )
      .filter((candidate): candidate is Candidate => candidate !== null);
    const candidates = [...explicitCandidates, ...providerCandidates];
    const seenKeys = new Set(existing.map((record) => memoryDuplicateKey(record)));

    for (const candidate of candidates) {
      const match = duplicateOf(candidate.input, existing);
      if (match !== undefined) {
        duplicates.push({ candidate: candidate.suggestion, existing: match });
        if (!candidate.explicit) {
          const item = await this.options.inbox.create({
            suggested: candidate.suggestion,
            ...(candidate.input.source === undefined ? {} : { source: candidate.input.source }),
            reason: candidate.suggestion.reason ?? 'A duplicate suggestion needs review.',
            duplicateOf: match.id,
          });
          inbox.push(item);
        }
        continue;
      }
      const key = memoryDuplicateKey(candidate.input);
      if (seenKeys.has(key)) {
        warnings.push(`Processor skipped a duplicate suggestion for ${candidate.input.type}.`);
        continue;
      }

      const shouldPersist =
        candidate.explicit ||
        this.options.mode === 'automatic' ||
        (this.options.mode === 'balanced' &&
          (candidate.input.confidence ?? 0) >= this.options.balancedConfidence);
      if (shouldPersist) {
        const record = await storeForScope(this.options, candidate.input.scope).create(
          candidate.input,
        );
        durable.push(record);
        existing.push(record);
        seenKeys.add(memoryDuplicateKey(record));
        continue;
      }

      const item = await this.options.inbox.create({
        suggested: candidate.suggestion,
        ...(candidate.input.source === undefined ? {} : { source: candidate.input.source }),
        reason:
          candidate.suggestion.reason ??
          'Processor suggestion requires review before becoming durable.',
      });
      inbox.push(item);
      seenKeys.add(key);
    }

    return { durable, inbox, duplicates, warnings };
  }
}

export function createMemoryProcessor(options: MemoryProcessorOptions): MemoryProcessor {
  return new ConsolidatingMemoryProcessor(options);
}

export type { ProcessorHttpClient };
