import {
  PROCESSOR_KINDS,
  redactSecrets,
  processorSuggestionSchema,
  type ProcessorKind,
  type ProcessorProviderResult,
  type ProcessorSuggestion,
  type ProcessorSuggestionProvider,
  type RedactedSessionCapture,
} from '@reporecall/core';
import { z } from 'zod';

export type ProcessorHttpRequest = {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
};

export type ProcessorHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type ProcessorHttpClient = (request: ProcessorHttpRequest) => Promise<ProcessorHttpResponse>;

export type ProcessorProviderOptions = {
  endpoint?: string;
  model?: string;
  env?: Record<string, string | undefined>;
  httpClient?: ProcessorHttpClient;
  timeoutMs?: number;
};

const DEFAULT_OLLAMA_ENDPOINT = 'http://127.0.0.1:11434/api/chat';
const DEFAULT_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENAI_COMPATIBLE_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'local-model';
const DEFAULT_TIMEOUT_MS = 30_000;

const rawSuggestionSchema = z
  .object({
    content: z.string().trim().min(1),
    scope: z.enum(['global', 'workspace', 'project', 'session']).optional(),
    type: z
      .enum([
        'fact',
        'preference',
        'decision',
        'goal',
        'todo',
        'constraint',
        'insight',
        'issue',
        'event',
        'reference',
      ])
      .optional(),
    priority: z.enum(['critical', 'high', 'normal', 'low']).optional(),
    status: z.enum(['active', 'resolved', 'archived', 'superseded', 'dismissed']).optional(),
    pinned: z.boolean().optional(),
    tags: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            origin: z.enum(['user', 'ai']).optional(),
            confidence: z.number().min(0).max(1).optional(),
          })
          .strict(),
      )
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
    project: z
      .object({
        id: z.string().trim().min(1),
        root: z.string().trim().min(1),
        name: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    workspace: z
      .object({ id: z.string().trim().min(1), name: z.string().trim().min(1).optional() })
      .strict()
      .optional(),
    relations: z
      .array(
        z
          .object({
            type: z.enum([
              'related_to',
              'depends_on',
              'contradicts',
              'supersedes',
              'derived_from',
              'implements',
              'blocks',
            ]),
            targetId: z.string().trim().min(1),
            note: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

const providerPayloadSchema = z.object({ suggestions: z.array(rawSuggestionSchema) }).strict();

const SYSTEM_PROMPT = [
  'Extract only durable project knowledge from the supplied redacted session capture.',
  'Return JSON only with the shape {"suggestions":[{"content":"...","type":"fact|preference|decision|goal|todo|constraint|insight|issue|event|reference","confidence":0.0,"tags":[{"name":"...","confidence":0.0}],"relations":[{"type":"related_to","targetId":"..."],"reason":"..."}]}].',
  'Do not include secrets, credentials, raw transcripts, or machine-specific paths.',
  'Never claim a tag is user-owned; processor tags are always treated as AI suggestions.',
].join(' ');

function environment(options: ProcessorProviderOptions): Record<string, string | undefined> {
  return options.env ?? process.env;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function chatCompletionsEndpoint(value: string): string {
  const trimmed = value.replace(/\/+$/u, '');
  return /\/chat\/completions$/u.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

function safeCapture(capture: RedactedSessionCapture): {
  capture?: RedactedSessionCapture;
  warning?: string;
} {
  const result = redactSecrets(capture.content);
  if (result.blocked || result.redacted.trim() === '') {
    return { warning: 'Processor refused a capture containing only a secret or credential.' };
  }
  return {
    capture:
      result.redacted === capture.content ? capture : { ...capture, content: result.redacted },
  };
}

function contextDefaults(capture: RedactedSessionCapture): {
  scope: ProcessorSuggestion['scope'];
  project?: ProcessorSuggestion['project'];
  workspace?: ProcessorSuggestion['workspace'];
} {
  return {
    scope: capture.project === undefined ? 'global' : 'project',
    ...(capture.project === undefined ? {} : { project: capture.project }),
    ...(capture.workspace === undefined ? {} : { workspace: capture.workspace }),
  };
}

function normalizeSuggestion(
  suggestion: z.infer<typeof rawSuggestionSchema>,
  capture: RedactedSessionCapture,
): ProcessorSuggestion {
  const defaults = contextDefaults(capture);
  const scope = suggestion.scope ?? defaults.scope;
  const project = suggestion.project ?? (scope === 'global' ? undefined : defaults.project);
  const workspace = suggestion.workspace ?? defaults.workspace;
  const tags = suggestion.tags?.map((tag) => ({
    name: tag.name,
    origin: 'ai' as const,
    ...(tag.confidence === undefined ? {} : { confidence: tag.confidence }),
  }));
  const candidate = {
    content: suggestion.content,
    scope,
    type: suggestion.type ?? 'fact',
    ...(suggestion.priority === undefined ? {} : { priority: suggestion.priority }),
    ...(suggestion.status === undefined ? {} : { status: suggestion.status }),
    ...(suggestion.pinned === undefined ? {} : { pinned: suggestion.pinned }),
    ...(tags === undefined ? {} : { tags }),
    ...(suggestion.confidence === undefined ? {} : { confidence: suggestion.confidence }),
    ...(project === undefined ? {} : { project }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(suggestion.relations === undefined ? {} : { relations: suggestion.relations }),
    ...(suggestion.reason === undefined ? {} : { reason: suggestion.reason }),
  };
  return processorSuggestionSchema.parse(candidate) as ProcessorSuggestion;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
    throw new Error('Provider response did not contain a JSON object');
  }
}

function nestedMessageContent(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const message = record.message;
  if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
  }
  const choices: unknown = record.choices;
  if (Array.isArray(choices)) {
    const first: unknown = choices[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      const nestedMessage = (first as Record<string, unknown>).message;
      if (
        typeof nestedMessage === 'object' &&
        nestedMessage !== null &&
        !Array.isArray(nestedMessage)
      ) {
        const content = (nestedMessage as Record<string, unknown>).content;
        if (typeof content === 'string') return content;
      }
    }
  }
  return undefined;
}

function parseProviderSuggestions(
  body: string,
  capture: RedactedSessionCapture,
  provider: ProcessorKind,
): ProcessorProviderResult {
  try {
    const parsedBody = JSON.parse(body) as unknown;
    const nested = nestedMessageContent(parsedBody);
    const payload = nested === undefined ? parsedBody : parseJson(nested);
    const parsed = providerPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        suggestions: [],
        warnings: [`${provider} returned an invalid suggestion contract.`],
      };
    }
    return {
      suggestions: parsed.data.suggestions.map((suggestion) =>
        normalizeSuggestion(suggestion, capture),
      ),
      warnings: [],
    };
  } catch (error) {
    return {
      suggestions: [],
      warnings: [
        `${provider} response could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function agentNativeProvider(): ProcessorSuggestionProvider {
  return {
    suggest(capture) {
      const safe = safeCapture(capture);
      if (safe.capture === undefined) {
        return Promise.resolve({
          suggestions: [],
          warnings: [safe.warning ?? 'Capture was rejected.'],
        });
      }
      const suggestions: ProcessorSuggestion[] = [];
      const marker =
        /^\s*(?:repo\s*recall\s+)?(remember|decision|preference|todo|constraint|goal|insight|issue|fact)\s*:\s*(.+?)\s*$/gimu;
      for (const match of safe.capture.content.matchAll(marker)) {
        const markerType = match[1]?.toLocaleLowerCase();
        const content = match[2]?.trim();
        if (content === undefined || content === '') continue;
        const defaults = contextDefaults(safe.capture);
        const type = markerType === 'remember' ? 'fact' : markerType;
        if (type === undefined) continue;
        suggestions.push({
          content,
          scope: defaults.scope,
          type: type as ProcessorSuggestion['type'],
          confidence: 1,
          tags: [{ name: 'agent-native', origin: 'ai', confidence: 1 }],
          ...(defaults.project === undefined ? {} : { project: defaults.project }),
          ...(defaults.workspace === undefined ? {} : { workspace: defaults.workspace }),
          reason: 'Extracted from an explicit agent-native marker.',
        });
      }
      return Promise.resolve({ suggestions, warnings: [] });
    },
  };
}

function externalProvider(
  kind: Exclude<ProcessorKind, 'agent-native' | 'disabled'>,
  options: ProcessorProviderOptions,
): ProcessorSuggestionProvider {
  return {
    async suggest(capture) {
      const safe = safeCapture(capture);
      if (safe.capture === undefined)
        return { suggestions: [], warnings: [safe.warning ?? 'Capture was rejected.'] };
      const env = environment(options);
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const model =
        nonEmpty(options.model) ??
        (kind === 'ollama'
          ? (nonEmpty(env.REPORECALL_OLLAMA_MODEL) ??
            nonEmpty(env.OLLAMA_MODEL) ??
            DEFAULT_OLLAMA_MODEL)
          : kind === 'openrouter'
            ? (nonEmpty(env.REPORECALL_OPENROUTER_MODEL) ??
              nonEmpty(env.OPENROUTER_MODEL) ??
              DEFAULT_OPENROUTER_MODEL)
            : (nonEmpty(env.REPORECALL_OPENAI_COMPATIBLE_MODEL) ??
              nonEmpty(env.OPENAI_MODEL) ??
              DEFAULT_OPENAI_COMPATIBLE_MODEL));
      const configuredEndpoint =
        options.endpoint ??
        (kind === 'ollama'
          ? (nonEmpty(env.REPORECALL_OLLAMA_URL) ?? DEFAULT_OLLAMA_ENDPOINT)
          : kind === 'openrouter'
            ? (nonEmpty(env.OPENROUTER_BASE_URL) ?? DEFAULT_OPENROUTER_ENDPOINT)
            : (nonEmpty(env.REPORECALL_OPENAI_COMPATIBLE_URL) ??
              nonEmpty(env.OPENAI_BASE_URL) ??
              DEFAULT_OPENAI_COMPATIBLE_ENDPOINT));
      const endpoint =
        kind === 'ollama' ? configuredEndpoint : chatCompletionsEndpoint(configuredEndpoint);
      const apiKey =
        kind === 'ollama'
          ? undefined
          : kind === 'openrouter'
            ? nonEmpty(env.OPENROUTER_API_KEY)
            : (nonEmpty(env.REPORECALL_OPENAI_COMPATIBLE_API_KEY) ?? nonEmpty(env.OPENAI_API_KEY));
      if (kind !== 'ollama' && apiKey === undefined) {
        const name =
          kind === 'openrouter'
            ? 'OPENROUTER_API_KEY'
            : 'REPORECALL_OPENAI_COMPATIBLE_API_KEY or OPENAI_API_KEY';
        return { suggestions: [], warnings: [`${kind} requires ${name} in the environment.`] };
      }
      const client = options.httpClient ?? createFetchHttpClient();
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      };
      const body =
        kind === 'ollama'
          ? {
              model,
              stream: false,
              format: 'json',
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: safe.capture.content },
              ],
            }
          : {
              model,
              temperature: 0,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: safe.capture.content },
              ],
            };
      try {
        const response = await client({
          url: endpoint,
          method: 'POST',
          headers,
          body,
          timeoutMs,
        });
        if (response.status < 200 || response.status >= 300) {
          return {
            suggestions: [],
            warnings: [`${kind} request failed with HTTP ${response.status}.`],
          };
        }
        return parseProviderSuggestions(response.body, safe.capture, kind);
      } catch (error) {
        return {
          suggestions: [],
          warnings: [
            `${kind} request failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      }
    },
  };
}

export function createFetchHttpClient(
  fetchImpl: typeof fetch = globalThis.fetch,
): ProcessorHttpClient {
  return async (request) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function createProcessorProvider(
  kind: ProcessorKind,
  options: ProcessorProviderOptions = {},
): ProcessorSuggestionProvider {
  if (!PROCESSOR_KINDS.includes(kind)) throw new Error(`Unsupported processor provider: ${kind}`);
  if (kind === 'disabled')
    return { suggest: () => Promise.resolve({ suggestions: [], warnings: [] }) };
  if (kind === 'agent-native') return agentNativeProvider();
  return externalProvider(kind, options);
}
