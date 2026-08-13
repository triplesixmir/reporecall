import {
  type ContextBuilder,
  type ContextBundle,
  type ContextItem,
  type ContextRequest,
  type MemoryIndex,
  type MemoryRecord,
  type SearchResult,
} from '@reporecall/core';

export type DeterministicContextBuilderOptions = {
  now?: string;
};

type ScoredCandidate = {
  result: SearchResult;
  score: number;
  mandatory: boolean;
  excerpt: string;
  estimatedTokens: number;
};

const EXCLUDED_STATUSES = new Set<MemoryRecord['status']>(['archived', 'dismissed', 'superseded']);

function codePointLength(value: string): number {
  return [...value].length;
}

function estimateTokens(value: string): number {
  return Math.ceil(codePointLength(value) / 4);
}

function queryTerms(query: string | undefined): string[] {
  return query?.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

function textRelevance(record: MemoryRecord, query: string | undefined): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const searchable = `${record.content} ${record.tags.map((tag) => tag.name).join(' ')}`.toLocaleLowerCase();
  const matched = terms.filter((term) => searchable.includes(term)).length;
  return matched / terms.length;
}

function scopeMatch(record: MemoryRecord, request: ContextRequest): number {
  if (request.project?.id !== undefined && record.project?.id === request.project.id) return 1;
  if (request.workspace?.id !== undefined && record.workspace?.id === request.workspace.id) return 1;
  if (request.project === undefined && request.workspace === undefined && record.scope === 'global') return 1;
  return 0;
}

function statusScore(status: MemoryRecord['status']): number {
  return status === 'active' ? 1 : status === 'resolved' ? 0.5 : 0;
}

function priorityScore(priority: MemoryRecord['priority']): number {
  return { critical: 1, high: 0.75, normal: 0.5, low: 0.25 }[priority];
}

function recencyScore(updatedAt: string, now: string): number {
  const ageMs = Math.max(0, Date.parse(now) - Date.parse(updatedAt));
  if (!Number.isFinite(ageMs)) return 0;
  const ageDays = ageMs / 86_400_000;
  return 1 / (1 + ageDays);
}

function trimToSentenceBoundary(content: string, maxTokens: number): string {
  const maxCodePoints = Math.max(1, maxTokens * 4);
  if (codePointLength(content) <= maxCodePoints) return content.trim();

  const candidate = [...content].slice(0, maxCodePoints).join('').trimEnd();
  let lastSentenceEnd = -1;
  for (const match of candidate.matchAll(/[.!?。！？](?=\s|$)/gu)) {
    lastSentenceEnd = (match.index ?? 0) + match[0].length;
  }
  if (lastSentenceEnd > 0) return candidate.slice(0, lastSentenceEnd).trim();

  const wordBoundary = candidate.lastIndexOf(' ');
  return (wordBoundary > 0 ? candidate.slice(0, wordBoundary) : candidate).trim();
}

function formatContext(items: ContextItem[]): string {
  return items
    .map(({ record, excerpt }) => `### ${record.id} (${record.type})\n${excerpt}`)
    .join('\n\n');
}

export class DeterministicContextBuilder implements ContextBuilder {
  private readonly index: Pick<MemoryIndex, 'search'>;
  private readonly now: string;

  constructor(index: Pick<MemoryIndex, 'search'>, options: DeterministicContextBuilderOptions = {}) {
    this.index = index;
    this.now = options.now ?? new Date().toISOString();
  }

  async build(request: ContextRequest): Promise<ContextBundle> {
    if (!Number.isFinite(request.tokenBudget) || request.tokenBudget <= 0) {
      throw new Error('Context tokenBudget must be greater than zero');
    }

    const results = await this.index.search({ query: request.query ?? '' });
    const allowedScopes = new Set(request.includeScopes ?? ['global', 'workspace', 'project', 'session']);
    const maxItemTokens = Math.max(1, Math.floor(request.tokenBudget * 0.25));
    const candidates: ScoredCandidate[] = [];

    for (const result of results) {
      const record = result.record;
      if (EXCLUDED_STATUSES.has(record.status) || !allowedScopes.has(record.scope)) continue;
      const currentProject = request.project?.id !== undefined && record.project?.id === request.project.id;
      const currentWorkspace = request.workspace?.id !== undefined && record.workspace?.id === request.workspace.id;
      const mandatory = record.pinned || currentProject || currentWorkspace;
      const score =
        0.3 * (record.pinned ? 1 : 0) +
        0.2 * scopeMatch(record, request) +
        0.15 * statusScore(record.status) +
        0.15 * priorityScore(record.priority) +
        0.1 * textRelevance(record, request.query) +
        0.07 * recencyScore(record.updatedAt, this.now) +
        0.03 * (record.confidence ?? 1);
      const excerpt = trimToSentenceBoundary(record.content, maxItemTokens);
      candidates.push({
        result,
        score,
        mandatory,
        excerpt,
        estimatedTokens: estimateTokens(excerpt),
      });
    }

    candidates.sort((left, right) => {
      if (left.mandatory !== right.mandatory) return left.mandatory ? -1 : 1;
      if (right.score !== left.score) return right.score - left.score;
      if (right.result.record.updatedAt !== left.result.record.updatedAt) {
        return right.result.record.updatedAt.localeCompare(left.result.record.updatedAt);
      }
      return left.result.record.id.localeCompare(right.result.record.id);
    });

    const items: ContextItem[] = [];
    let estimatedTokens = 0;
    for (const candidate of candidates) {
      if (estimatedTokens + candidate.estimatedTokens > request.tokenBudget) continue;
      items.push({
        record: candidate.result.record,
        excerpt: candidate.excerpt,
        score: candidate.score,
        estimatedTokens: candidate.estimatedTokens,
      });
      estimatedTokens += candidate.estimatedTokens;
    }

    return {
      items,
      text: formatContext(items),
      estimatedTokens,
      omittedCount: candidates.length - items.length,
    };
  }
}
