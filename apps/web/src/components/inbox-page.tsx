import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';
import type { InboxItem, MemoryInput, Priority, Scope } from '../types.js';
import { Icon } from './icons.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  TagList,
} from './ui.js';

export function InboxPage({
  refreshKey,
  onChanged,
  onNotice,
}: {
  refreshKey: number;
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const loadInbox = useCallback(() => api.getInbox(), []);
  const result = useAsyncData(loadInbox, [refreshKey]);
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Human review"
        title="Inbox"
        description="Processor suggestions stay here until you decide whether they deserve a durable place in the brain."
        actions={
          <Badge tone="amber" icon="inbox">
            {result.data?.count ?? 0} pending
          </Badge>
        }
      />
      {result.loading && result.data === undefined ? (
        <LoadingState label="Loading inbox" />
      ) : result.error !== undefined && result.data === undefined ? (
        <ErrorState message={result.error.message} onRetry={result.reload} />
      ) : result.data?.items.length === 0 ? (
        <EmptyState
          icon="check"
          title="Inbox is clear"
          description="That is a good sign. Explicit memories remain canonical; suggestions wait here until reviewed."
        />
      ) : (
        <section className="inbox-list" aria-label="Inbox suggestions">
          {result.data?.items.map((item) => (
            <InboxCard item={item} key={item.id} onChanged={onChanged} onNotice={onNotice} />
          ))}
        </section>
      )}
    </div>
  );
}

function InboxCard({
  item,
  onChanged,
  onNotice,
}: {
  item: InboxItem;
  onChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const [scope, setScope] = useState<Scope>(item.suggested.scope ?? 'project');
  const [priority, setPriority] = useState<Priority>(item.suggested.priority ?? 'normal');
  const [tags, setTags] = useState(item.suggested.tags?.map((tag) => tag.name).join(', ') ?? '');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('Not durable enough yet.');

  const accept = async () => {
    setBusy(true);
    try {
      const input: MemoryInput = {
        content: item.suggested.content,
        scope,
        priority,
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        ...(item.suggested.type === undefined ? {} : { type: item.suggested.type }),
      };
      const response = await api.acceptInbox(item.id, input);
      onChanged();
      onNotice(`Accepted ${response.memory.id} as durable memory.`);
    } catch (error: unknown) {
      onNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    setBusy(true);
    try {
      await api.dismissInbox(item.id, reason);
      onChanged();
      onNotice('Suggestion dismissed.');
    } catch (error: unknown) {
      onNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="inbox-card" as="article">
      <div className="inbox-card-top">
        <div className="inbox-source">
          <span className="source-mark">
            <Icon name="spark" size={15} />
          </span>
          <div>
            <p className="eyebrow">{item.source?.provider ?? 'processor'} suggestion</p>
            <span>{new Date(item.createdAt).toLocaleString()}</span>
          </div>
        </div>
        <Badge tone="amber">pending review</Badge>
      </div>
      <h2>{item.suggested.content}</h2>
      {item.suggested.reason === undefined ? null : (
        <p className="inbox-reason">
          <Icon name="file" size={14} />
          {item.suggested.reason}
        </p>
      )}
      <div className="inbox-controls">
        <label>
          Scope
          <select value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
            <option value="project">project</option>
            <option value="global">global</option>
            <option value="workspace">workspace</option>
            <option value="session">session</option>
          </select>
        </label>
        <label>
          Priority
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as Priority)}
          >
            <option value="normal">normal</option>
            <option value="high">high</option>
            <option value="critical">critical</option>
            <option value="low">low</option>
          </select>
        </label>
        <label className="inbox-tags">
          Tags
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="reviewed, architecture"
          />
        </label>
      </div>
      <div className="inbox-card-bottom">
        <TagList tags={item.suggested.tags ?? []} limit={4} />
        <div className="inbox-actions">
          <input
            className="dismiss-reason"
            aria-label="Dismiss reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button variant="quiet" onClick={() => void dismiss()} disabled={busy}>
            Dismiss
          </Button>
          <Button icon="check" onClick={() => void accept()} disabled={busy}>
            Accept
          </Button>
        </div>
      </div>
    </Card>
  );
}
