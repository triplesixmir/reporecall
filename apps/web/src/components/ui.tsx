import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons.js';

export function Card({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'article' | 'div';
}) {
  return <Tag className={`card ${className}`}>{children}</Tag>;
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'primary',
  icon,
  className = '',
  disabled = false,
  ariaLabel,
}: {
  children?: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  icon?: IconName;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      className={`button button-${variant} ${className}`}
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {icon === undefined ? null : <Icon name={icon} size={16} />}
      {children === undefined ? null : <span>{children}</span>}
    </button>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  icon,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'dark';
  icon?: IconName;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {icon === undefined ? null : <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description === undefined ? null : <p className="page-description">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function LoadingState({ label = 'Loading local memory' }: { label?: string }) {
  return (
    <div className="loading-state" aria-busy="true" aria-live="polite">
      <span className="loading-line loading-line-wide" />
      <span className="loading-line" />
      <span className="loading-line loading-line-short" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-panel state-error" role="alert">
      <Icon name="warning" size={24} />
      <div>
        <h2>Could not reach the local brain</h2>
        <p>{message}</p>
        {onRetry === undefined ? null : (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-panel state-empty" role="status">
      <div className="empty-icon">
        <Icon name={icon} size={25} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function TagList({
  tags,
  limit,
}: {
  tags: Array<{ name: string; origin?: string }>;
  limit?: number;
}) {
  const visible = limit === undefined ? tags : tags.slice(0, limit);
  return (
    <span className="tag-list">
      {visible.map((tag) => (
        <span
          className={`tag tag-${tag.origin ?? 'user'}`}
          key={`${tag.name}-${tag.origin ?? 'user'}`}
        >
          {tag.name}
        </span>
      ))}
      {limit !== undefined && tags.length > visible.length ? (
        <span className="tag tag-more">+{tags.length - visible.length}</span>
      ) : null}
    </span>
  );
}

export function MemoryBadges({
  type,
  scope,
  priority,
  status,
}: {
  type: string;
  scope: string;
  priority: string;
  status: string;
}) {
  return (
    <span className="memory-badges">
      <Badge tone="dark">{type}</Badge>
      <Badge tone={scope === 'global' ? 'blue' : 'neutral'}>{scope}</Badge>
      {priority === 'critical' || priority === 'high' ? (
        <Badge tone="amber">{priority}</Badge>
      ) : null}
      {status !== 'active' ? (
        <Badge tone={status === 'resolved' ? 'green' : 'neutral'}>{status}</Badge>
      ) : null}
    </span>
  );
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

export function formatRelative(value: string): string {
  const difference = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(difference / 60_000));
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
