import { useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';
import type { MemoryInput, MemoryRecord, MemoryStatus, MemoryType, Scope } from '../types.js';
import { Icon } from './icons.js';
import { MemoryEditor } from './memory-editor.js';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  formatDate,
  LoadingState,
  MemoryBadges,
  PageHeader,
  TagList,
} from './ui.js';

const typeOptions: Array<MemoryType | ''> = [
  '',
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
];
const scopeOptions: Array<Scope | ''> = ['', 'project', 'global', 'workspace', 'session'];
const statusOptions: Array<MemoryStatus | ''> = [
  '',
  'active',
  'resolved',
  'archived',
  'superseded',
  'dismissed',
];

export function MemoriesPage({
  location,
  onUrlChange,
  refreshKey,
  onChanged,
  onNotice,
}: {
  location: URL;
  onUrlChange: (updates: Record<string, string | undefined>) => void;
  refreshKey: number;
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    const keys = ['q', 'type', 'scope', 'status', 'tag'];
    for (const key of keys) {
      const value = location.searchParams.get(key);
      if (value !== null && value !== '') params.set(key === 'q' ? 'query' : key, value);
    }
    return params.toString() === '' ? '' : `?${params.toString()}`;
  }, [location]);
  const loadMemories = useCallback(() => api.getMemories(queryString), [queryString]);
  const result = useAsyncData(loadMemories, [refreshKey]);
  const selectedId = location.searchParams.get('memory');
  const createOpen = location.searchParams.get('new') === '1';
  const loadSelected = useCallback(
    () =>
      selectedId === null
        ? Promise.resolve<{ memory: MemoryRecord } | undefined>(undefined)
        : api.getMemory(selectedId),
    [selectedId],
  );
  const selected = useAsyncData(loadSelected, [refreshKey]);
  const memories = result.data?.memories ?? [];
  const selectedRecord =
    selected.data?.memory ?? memories.find((memory) => memory.id === selectedId);
  const isEditorOpen = createOpen || selectedId !== null;

  const updateFilter = (key: string, value: string) =>
    onUrlChange({ [key]: value === '' ? undefined : value, memory: undefined, new: undefined });
  const openMemory = (id: string) => onUrlChange({ memory: id, new: undefined });
  const openNew = () => onUrlChange({ new: '1', memory: undefined });
  const closeEditor = () => onUrlChange({ memory: undefined, new: undefined });

  const saveMemory = async (input: MemoryInput): Promise<string[]> => {
    if (selectedRecord === undefined) {
      const response = await api.createMemory(input);
      onChanged();
      onNotice(`Saved ${response.memory.id} to canonical Markdown.`);
      return response.warnings ?? [];
    }
    const response = await api.updateMemory(selectedRecord.id, input);
    onChanged();
    onNotice(`Updated ${response.memory.id}.`);
    return response.warnings ?? [];
  };

  const deleteMemory = async () => {
    if (selectedRecord === undefined) return;
    await api.deleteMemory(selectedRecord.id);
    onChanged();
    onNotice('Memory removed from the canonical store.');
  };

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Canonical Markdown"
        title="Memories"
        description="Search the durable context your agents can actually retrieve. Every result can be opened, edited, or removed as a normal file."
        actions={
          <Button icon="plus" onClick={openNew}>
            New memory
          </Button>
        }
      />
      <Card className="filter-card">
        <div className="filter-search">
          <Icon name="search" size={18} />
          <label className="sr-only" htmlFor="memory-search">
            Search memories
          </label>
          <input
            id="memory-search"
            type="search"
            value={location.searchParams.get('q') ?? ''}
            onChange={(event) => updateFilter('q', event.target.value)}
            placeholder="Search content and tags…"
          />
        </div>
        <div className="filter-fields">
          <FilterSelect
            label="Type"
            value={location.searchParams.get('type') ?? ''}
            options={typeOptions}
            onChange={(value) => updateFilter('type', value)}
          />
          <FilterSelect
            label="Scope"
            value={location.searchParams.get('scope') ?? ''}
            options={scopeOptions}
            onChange={(value) => updateFilter('scope', value)}
          />
          <FilterSelect
            label="Status"
            value={location.searchParams.get('status') ?? ''}
            options={statusOptions}
            onChange={(value) => updateFilter('status', value)}
          />
          <div className="filter-tag">
            <label htmlFor="memory-tag">Tag</label>
            <input
              id="memory-tag"
              value={location.searchParams.get('tag') ?? ''}
              onChange={(event) => updateFilter('tag', event.target.value)}
              placeholder="any tag"
            />
          </div>
        </div>
      </Card>
      {result.loading && result.data === undefined ? (
        <LoadingState label="Loading memories" />
      ) : result.error !== undefined && result.data === undefined ? (
        <ErrorState message={result.error.message} onRetry={result.reload} />
      ) : memories.length === 0 ? (
        <EmptyState
          icon="stack"
          title="No memories match"
          description="Try a broader search, or create a memory that gives your next agent a head start."
          action={
            <Button icon="plus" onClick={openNew}>
              Create memory
            </Button>
          }
        />
      ) : (
        <section className="memory-list" aria-label="Memories">
          <div className="list-summary">
            <span>
              {result.data?.count ?? memories.length}{' '}
              {result.data?.count === 1 ? 'memory' : 'memories'}
            </span>
            <span>Filters are reflected in the URL</span>
          </div>
          {memories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} onOpen={() => openMemory(memory.id)} />
          ))}
        </section>
      )}
      <MemoryEditor
        {...(selectedRecord === undefined ? {} : { record: selectedRecord })}
        open={isEditorOpen}
        onClose={closeEditor}
        onSave={saveMemory}
        {...(selectedRecord === undefined ? {} : { onDelete: deleteMemory })}
      />
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const allLabel = label === 'Status' ? 'All statuses' : `All ${label.toLowerCase()}s`;
  return (
    <div className="filter-select">
      <label htmlFor={`filter-${label.toLowerCase()}`}>{label}</label>
      <select
        id={`filter-${label.toLowerCase()}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option value={option} key={option}>
            {option === '' ? allLabel : option}
          </option>
        ))}
      </select>
    </div>
  );
}

function MemoryCard({ memory, onOpen }: { memory: MemoryRecord; onOpen: () => void }) {
  return (
    <article className="memory-card">
      <button type="button" className="memory-card-open" onClick={onOpen}>
        <div className="memory-card-heading">
          <MemoryBadges
            type={memory.type}
            scope={memory.scope}
            priority={memory.priority}
            status={memory.status}
          />
          <span className="memory-date">{formatDate(memory.updatedAt)}</span>
        </div>
        <h2>{memory.content}</h2>
        <div className="memory-card-footer">
          <span className="memory-project">
            <Icon name={memory.scope === 'global' ? 'diamond' : 'folder'} size={13} />
            {memory.project?.name ?? memory.project?.id ?? 'Global brain'}
          </span>
          <TagList tags={memory.tags} limit={4} />
          <span className="memory-open-label">
            Open <Icon name="arrow" size={13} />
          </span>
        </div>
      </button>
    </article>
  );
}
