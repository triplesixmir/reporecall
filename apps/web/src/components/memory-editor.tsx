import { useEffect, useRef, useState } from 'react';
import type {
  MemoryInput,
  MemoryRecord,
  MemoryStatus,
  MemoryType,
  Priority,
  Scope,
} from '../types.js';
import { Icon } from './icons.js';
import { Button } from './ui.js';

const scopes: Scope[] = ['project', 'global', 'workspace', 'session'];
const types: MemoryType[] = [
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
const priorities: Priority[] = ['normal', 'high', 'critical', 'low'];
const statuses: MemoryStatus[] = ['active', 'resolved', 'archived', 'superseded', 'dismissed'];

type Draft = {
  content: string;
  scope: Scope;
  type: MemoryType;
  priority: Priority;
  status: MemoryStatus;
  pinned: boolean;
  tags: string;
};

function draftFrom(record?: MemoryRecord): Draft {
  return {
    content: record?.content ?? '',
    scope: record?.scope ?? 'project',
    type: record?.type ?? 'fact',
    priority: record?.priority ?? 'normal',
    status: record?.status ?? 'active',
    pinned: record?.pinned ?? false,
    tags: record?.tags.map((tag) => tag.name).join(', ') ?? '',
  };
}

export function MemoryEditor({
  record,
  open,
  onClose,
  onSave,
  onDelete,
}: {
  record?: MemoryRecord;
  open: boolean;
  onClose: () => void;
  onSave: (input: MemoryInput) => Promise<string[]>;
  onDelete?: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(record));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(record));
    setError(undefined);
    setWarnings([]);
    window.setTimeout(() => contentRef.current?.focus(), 0);
  }, [open, record]);

  if (!open) return null;

  const setField = <K extends keyof Draft>(field: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.content.trim() === '') {
      setError('Write a memory before saving.');
      contentRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const returnedWarnings = await onSave({
        content: draft.content.trim(),
        scope: draft.scope,
        type: draft.type,
        priority: draft.priority,
        status: draft.status,
        pinned: draft.pinned,
        tags: draft.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      setWarnings(returnedWarnings);
      if (returnedWarnings.length === 0) onClose();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (onDelete === undefined || !window.confirm('Delete this canonical memory?')) return;
    setSaving(true);
    try {
      await onDelete();
      onClose();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor-layer" role="presentation">
      <button className="editor-scrim" type="button" aria-label="Close editor" onClick={onClose} />
      <aside
        className="editor-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
      >
        <div className="editor-header">
          <div>
            <p className="eyebrow">
              {record === undefined ? 'New durable memory' : 'Edit canonical file'}
            </p>
            <h2 id="editor-title">
              {record === undefined ? 'What should persist?' : 'Shape this memory'}
            </h2>
          </div>
          <button className="icon-button" type="button" aria-label="Close editor" onClick={onClose}>
            <Icon name="close" size={19} />
          </button>
        </div>
        <form className="editor-form" onSubmit={(event) => void submit(event)}>
          <div className="field field-content">
            <label htmlFor="memory-content">Memory content</label>
            <textarea
              id="memory-content"
              ref={contentRef}
              value={draft.content}
              onChange={(event) => setField('content', event.target.value)}
              placeholder="A decision, constraint, preference, or fact worth carrying forward…"
              rows={7}
            />
            <span className="field-hint">Markdown is stored as the durable source of truth.</span>
          </div>
          <div className="form-grid">
            <FieldSelect
              id="memory-type"
              label="Type"
              value={draft.type}
              options={types}
              onChange={(value) => setField('type', value as MemoryType)}
            />
            <FieldSelect
              id="memory-scope"
              label="Scope"
              value={draft.scope}
              options={scopes}
              onChange={(value) => setField('scope', value as Scope)}
            />
            <FieldSelect
              id="memory-priority"
              label="Priority"
              value={draft.priority}
              options={priorities}
              onChange={(value) => setField('priority', value as Priority)}
            />
            <FieldSelect
              id="memory-status"
              label="Status"
              value={draft.status}
              options={statuses}
              onChange={(value) => setField('status', value as MemoryStatus)}
            />
          </div>
          <div className="field">
            <label htmlFor="memory-tags">Tags</label>
            <input
              id="memory-tags"
              value={draft.tags}
              onChange={(event) => setField('tags', event.target.value)}
              placeholder="architecture, privacy"
            />
            <span className="field-hint">
              Comma-separated. User tags cannot be removed by an AI processor.
            </span>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={draft.pinned}
              onChange={(event) => setField('pinned', event.target.checked)}
            />
            <span>
              <strong>Pin in context</strong>
              <small>Bring this memory to the top when context is built.</small>
            </span>
          </label>
          {record === undefined ? (
            <div className="editor-callout">
              <Icon name="spark" size={16} />
              <span>Secrets are scanned and redacted before a file is written.</span>
            </div>
          ) : (
            <div className="editor-record-meta">
              <span>{record.id}</span>
              <span>updated {new Date(record.updatedAt).toLocaleString()}</span>
            </div>
          )}
          {warnings.length > 0 ? (
            <div className="inline-warning" role="status">
              <Icon name="warning" size={16} />
              <div>
                {warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            </div>
          ) : null}
          {error === undefined ? null : (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="editor-actions">
            <Button type="submit" icon="check" disabled={saving}>
              {saving ? 'Saving…' : 'Save memory'}
            </Button>
            <Button variant="quiet" onClick={onClose}>
              Cancel
            </Button>
            {onDelete === undefined ? null : (
              <Button
                variant="danger"
                icon="trash"
                onClick={() => void remove()}
                ariaLabel="Delete memory"
              >
                Delete
              </Button>
            )}
          </div>
        </form>
      </aside>
    </div>
  );
}

function FieldSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option value={option} key={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
