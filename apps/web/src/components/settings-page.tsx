import { useCallback } from 'react';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';
import { Icon } from './icons.js';
import { Badge, Card, ErrorState, LoadingState, PageHeader } from './ui.js';

export function SettingsPage({ refreshKey }: { refreshKey: number }) {
  const loadHealth = useCallback(() => api.getHealth(), []);
  const health = useAsyncData(loadHealth, [refreshKey]);
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Local configuration"
        title="Settings"
        description="RepoRecall is intentionally small: inspect the files, choose the scope, and let the local index do the fast work."
      />
      <div className="settings-grid">
        {health.loading && health.data === undefined ? (
          <LoadingState label="Checking local server" />
        ) : health.error !== undefined && health.data === undefined ? (
          <ErrorState message={health.error.message} onRetry={health.reload} />
        ) : (
          <Card className="settings-status">
            <div className="settings-status-top">
              <div className="status-emblem">
                <Icon name="diamond" size={22} />
              </div>
              <div>
                <p className="eyebrow">Local API</p>
                <h2>Connected and loopback-only</h2>
              </div>
              <Badge tone="green">healthy</Badge>
            </div>
            <dl className="settings-list">
              <div>
                <dt>Version</dt>
                <dd>{health.data?.version}</dd>
              </div>
              <div>
                <dt>Storage</dt>
                <dd>Markdown + YAML frontmatter</dd>
              </div>
              <div>
                <dt>Index</dt>
                <dd>Disposable SQLite / FTS5</dd>
              </div>
              <div>
                <dt>Privacy</dt>
                <dd>Redaction before writes</dd>
              </div>
            </dl>
          </Card>
        )}
        <Card className="settings-notes">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Operating model</p>
              <h2>Three filesystems, one truth</h2>
            </div>
            <Icon name="file" size={19} />
          </div>
          <div className="settings-note">
            <span>01</span>
            <div>
              <strong>Canonical memories</strong>
              <p>
                <code>mem_*.md</code> files are the thing you commit, review, and move between
                machines.
              </p>
            </div>
          </div>
          <div className="settings-note">
            <span>02</span>
            <div>
              <strong>Local index</strong>
              <p>
                SQLite can be deleted at any time. Rebuild restores search and graph data from
                Markdown.
              </p>
            </div>
          </div>
          <div className="settings-note">
            <span>03</span>
            <div>
              <strong>Explicit checkpoints</strong>
              <p>
                Session captures remain redacted and temporary until a user chooses to checkpoint.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
