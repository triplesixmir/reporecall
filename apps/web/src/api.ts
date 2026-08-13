import type {
  GraphData,
  InboxItem,
  MemoryInput,
  MemoryList,
  MemoryPatch,
  MemoryRecord,
  Overview,
  ProjectList,
  TagSummary,
  WarningResponse,
} from './types.js';

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const candidate =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? (payload as { error?: { message?: unknown } }).error?.message
        : undefined;
    const message = typeof candidate === 'string' ? candidate : 'Request failed.';
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

function jsonBody(value: unknown): RequestInit {
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

export const api = {
  getOverview: () => request<Overview>('/overview'),
  getHealth: () =>
    request<{ status: string; version: string; indexErrors: Overview['indexErrors'] }>('/health'),
  getMemories: (search: string) => request<MemoryList>(`/memories${search}`),
  getMemory: (id: string) =>
    request<{ memory: MemoryRecord }>(`/memories/${encodeURIComponent(id)}`),
  createMemory: (input: MemoryInput) =>
    request<{ memory: MemoryRecord } & WarningResponse>('/memories', {
      method: 'POST',
      ...jsonBody(input),
    }),
  updateMemory: (id: string, patch: MemoryPatch) =>
    request<{ memory: MemoryRecord } & WarningResponse>(`/memories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...jsonBody(patch),
    }),
  deleteMemory: (id: string) =>
    request<{ deleted: string }>(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getRecent: (limit = 12) =>
    request<{ records: MemoryRecord[]; count: number }>(`/recent?limit=${limit}`),
  getProjects: () => request<ProjectList>('/projects'),
  getTags: () => request<{ tags: TagSummary[]; count: number }>('/tags'),
  getInbox: () => request<{ items: InboxItem[]; count: number }>('/inbox'),
  acceptInbox: (id: string, overrides: MemoryInput) =>
    request<{ item: InboxItem; memory: MemoryRecord } & WarningResponse>(
      `/inbox/${encodeURIComponent(id)}/accept`,
      { method: 'POST', ...jsonBody(overrides) },
    ),
  dismissInbox: (id: string, reason: string) =>
    request<{ item: InboxItem }>(`/inbox/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
      ...jsonBody({ reason }),
    }),
  getGraph: () => request<GraphData>('/graph'),
};
