import { useCallback } from 'react';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';
import type { MemoryRecord, Overview } from '../types.js';
import { Icon } from './icons.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  formatRelative,
  LoadingState,
  MemoryBadges,
  PageHeader,
  TagList,
} from './ui.js';

export function OverviewPage({
  onNavigate,
  onNewMemory,
  refreshKey,
}: {
  onNavigate: (view: 'memories' | 'inbox') => void;
  onNewMemory: () => void;
  refreshKey: number;
}) {
  const loadOverview = useCallback(() => api.getOverview(), []);
  const loadRecent = useCallback(() => api.getRecent(5), []);
  const overview = useAsyncData<Overview>(loadOverview, [refreshKey]);
  const recent = useAsyncData<{ records: MemoryRecord[]; count: number }>(loadRecent, [refreshKey]);

  if (overview.loading && overview.data === undefined)
    return <LoadingState label="Loading overview" />;
  if (overview.error !== undefined && overview.data === undefined)
    return <ErrorState message={overview.error.message} onRetry={overview.reload} />;
  const metrics = overview.data;
  if (metrics === undefined) return null;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Local memory workbench"
        title="Keep the important parts."
        description="A calm, inspectable memory layer for the decisions, constraints, and context your agents should carry forward."
        actions={
          <Button icon="plus" onClick={onNewMemory}>
            New memory
          </Button>
        }
      />

      <section className="welcome-panel" aria-labelledby="welcome-title">
        <div className="welcome-copy">
          <Badge tone="green" icon="spark">
            Your local brain is ready
          </Badge>
          <h2 id="welcome-title">Context that stays close to the work.</h2>
          <p>
            RepoRecall keeps canonical Markdown files readable in Git while a disposable local index
            makes them fast to search.
          </p>
          <div className="welcome-actions">
            <Button variant="secondary" icon="inbox" onClick={() => onNavigate('inbox')}>
              Review inbox{metrics.inboxCount > 0 ? ` · ${metrics.inboxCount}` : ''}
            </Button>
            <span className="muted-note">
              <span className="signal-dot" /> index healthy
            </span>
          </div>
        </div>
        <div className="welcome-diagram" aria-hidden="true">
          <div className="diagram-card diagram-card-top">
            <Icon name="file" size={15} />
            <span>Markdown</span>
            <small>source of truth</small>
          </div>
          <div className="diagram-line diagram-line-one" />
          <div className="diagram-card diagram-card-middle">
            <Icon name="diamond" size={15} />
            <span>RepoRecall</span>
            <small>context layer</small>
          </div>
          <div className="diagram-line diagram-line-two" />
          <div className="diagram-card diagram-card-bottom">
            <Icon name="spark" size={15} />
            <span>Agent</span>
            <small>better continuity</small>
          </div>
        </div>
      </section>

      <section className="metric-grid" aria-label="Memory overview">
        <Metric
          label="Total memories"
          value={metrics.memoryCount}
          detail="across local scopes"
          icon="stack"
        />
        <Metric
          label="Active context"
          value={metrics.activeCount}
          detail="available to agents"
          icon="spark"
          tone="green"
        />
        <Metric
          label="Projects"
          value={metrics.projectCount}
          detail="with durable memory"
          icon="folder"
        />
        <Metric
          label="Needs review"
          value={metrics.inboxCount}
          detail={metrics.inboxCount === 0 ? 'inbox is clear' : 'suggestions waiting'}
          icon="inbox"
          tone={metrics.inboxCount > 0 ? 'amber' : 'green'}
        />
      </section>

      <div className="content-grid overview-grid">
        <Card className="recent-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Fresh context</p>
              <h2>Recent memories</h2>
            </div>
            <button className="text-link" type="button" onClick={() => onNavigate('memories')}>
              View all <Icon name="arrow" size={14} />
            </button>
          </div>
          {recent.loading && recent.data === undefined ? (
            <LoadingState />
          ) : recent.error !== undefined ? (
            <ErrorState message={recent.error.message} onRetry={recent.reload} />
          ) : recent.data?.records.length === 0 ? (
            <EmptyState
              icon="stack"
              title="A blank page, for now"
              description="Create the first durable memory when a decision is worth carrying forward."
            />
          ) : (
            <RecentMemoryList records={recent.data?.records ?? []} />
          )}
        </Card>
        <Card className="principles-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Operating principles</p>
              <h2>Small by design</h2>
            </div>
            <Icon name="diamond" size={20} />
          </div>
          <ul className="principle-list">
            <li>
              <span className="principle-index">01</span>
              <div>
                <strong>Files first</strong>
                <p>Every durable memory is a Markdown file you can read, review, and commit.</p>
              </div>
            </li>
            <li>
              <span className="principle-index">02</span>
              <div>
                <strong>Local by default</strong>
                <p>No accounts, telemetry, or cloud backend required to keep context useful.</p>
              </div>
            </li>
            <li>
              <span className="principle-index">03</span>
              <div>
                <strong>Explicit checkpoints</strong>
                <p>
                  Session summaries become durable only when you or an agent chooses to save them.
                </p>
              </div>
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  detail: string;
  icon: 'stack' | 'spark' | 'folder' | 'inbox';
  tone?: 'neutral' | 'green' | 'amber';
}) {
  return (
    <Card className="metric-card">
      <div className={`metric-icon metric-icon-${tone}`}>
        <Icon name={icon} size={17} />
      </div>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </Card>
  );
}

function RecentMemoryList({ records }: { records: MemoryRecord[] }) {
  return (
    <div className="recent-list">
      {records.map((record) => (
        <article className="recent-row" key={record.id}>
          <div className="recent-marker" />
          <div className="recent-body">
            <div className="recent-row-top">
              <MemoryBadges
                type={record.type}
                scope={record.scope}
                priority={record.priority}
                status={record.status}
              />
              <time dateTime={record.updatedAt}>{formatRelative(record.updatedAt)}</time>
            </div>
            <h3>{record.content}</h3>
            <div className="recent-row-bottom">
              <span>{record.project?.name ?? record.project?.id ?? 'Global brain'}</span>
              <TagList tags={record.tags} limit={2} />
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
