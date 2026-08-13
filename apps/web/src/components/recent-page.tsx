import { useCallback } from 'react';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';
import type { MemoryRecord } from '../types.js';
import { Icon } from './icons.js';
import {
  EmptyState,
  ErrorState,
  formatDate,
  formatRelative,
  LoadingState,
  MemoryBadges,
  PageHeader,
  TagList,
} from './ui.js';

export function RecentPage({
  refreshKey,
  onOpen,
}: {
  refreshKey: number;
  onOpen: (id: string) => void;
}) {
  const loadRecent = useCallback(() => api.getRecent(50), []);
  const result = useAsyncData(loadRecent, [refreshKey]);
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Timeline"
        title="Recent"
        description="The latest changes across global, project, and session scopes. Use this view to spot what just became part of the working context."
      />
      {result.loading && result.data === undefined ? (
        <LoadingState label="Loading recent memories" />
      ) : result.error !== undefined && result.data === undefined ? (
        <ErrorState message={result.error.message} onRetry={result.reload} />
      ) : result.data?.records.length === 0 ? (
        <EmptyState
          icon="commit"
          title="No activity yet"
          description="Your recent durable memories will appear here as soon as you save one."
        />
      ) : (
        <div className="timeline" aria-label="Recent memories">
          {result.data?.records.map((record) => (
            <TimelineRow key={record.id} record={record} onOpen={() => onOpen(record.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TimelineRow({ record, onOpen }: { record: MemoryRecord; onOpen: () => void }) {
  return (
    <article className="timeline-row">
      <div className="timeline-rail">
        <span className="timeline-dot" />
      </div>
      <div className="timeline-content">
        <div className="timeline-top">
          <MemoryBadges
            type={record.type}
            scope={record.scope}
            priority={record.priority}
            status={record.status}
          />
          <time dateTime={record.updatedAt}>{formatRelative(record.updatedAt)}</time>
        </div>
        <button type="button" className="timeline-title" onClick={onOpen}>
          {record.content}
          <Icon name="arrow" size={14} />
        </button>
        <div className="timeline-meta">
          <span>
            <Icon name="folder" size={13} />
            {record.project?.name ?? record.project?.id ?? 'Global brain'}
          </span>
          <TagList tags={record.tags} limit={3} />
          <span>{formatDate(record.updatedAt)}</span>
        </div>
      </div>
    </article>
  );
}
