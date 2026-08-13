import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons.js';
import { Badge } from './ui.js';

export type View = 'overview' | 'memories' | 'projects' | 'recent' | 'inbox' | 'graph' | 'settings';

const navigation: Array<{ view: View; label: string; icon: IconName; note?: string }> = [
  { view: 'overview', label: 'Overview', icon: 'book' },
  { view: 'memories', label: 'Memories', icon: 'stack' },
  { view: 'projects', label: 'Projects', icon: 'folder' },
  { view: 'recent', label: 'Recent', icon: 'commit' },
  { view: 'inbox', label: 'Inbox', icon: 'inbox', note: 'review' },
  { view: 'graph', label: 'Graph', icon: 'graph' },
];

export function Layout({
  view,
  inboxCount,
  onNavigate,
  children,
}: {
  view: View;
  inboxCount: number;
  onNavigate: (view: View) => void;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileNavigate = (nextView: View) => {
    onNavigate(nextView);
    setMobileOpen(false);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Icon name="diamond" size={19} />
          </div>
          <div>
            <span className="brand-name">RepoRecall</span>
            <span className="brand-version">local memory / v0.1</span>
          </div>
        </div>

        <div className="sidebar-rule" />
        <p className="nav-label">Workbench</p>
        <nav aria-label="Primary navigation">
          <ul className="nav-list">
            {navigation.map((item) => (
              <li key={item.view}>
                <button
                  className={`nav-item ${view === item.view ? 'nav-item-active' : ''}`}
                  type="button"
                  onClick={() => onNavigate(item.view)}
                  aria-current={view === item.view ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                  {item.view === 'inbox' && inboxCount > 0 ? (
                    <span className="nav-count">{inboxCount}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-spacer" />
        <button
          className={`nav-item nav-settings ${view === 'settings' ? 'nav-item-active' : ''}`}
          type="button"
          onClick={() => onNavigate('settings')}
          aria-current={view === 'settings' ? 'page' : undefined}
        >
          <Icon name="settings" size={17} />
          <span>Settings</span>
        </button>
        <div className="privacy-note">
          <span className="privacy-dot" />
          <span>
            Stored locally.
            <br />
            Nothing leaves this machine.
          </span>
        </div>
      </aside>

      <div className="main-column">
        <header className="mobile-header">
          <div className="brand-lockup">
            <div className="brand-mark">
              <Icon name="diamond" size={17} />
            </div>
            <span className="brand-name">RepoRecall</span>
          </div>
          <div className="mobile-header-actions">
            <Badge tone="green">local</Badge>
            <button
              className="mobile-menu-button"
              type="button"
              aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen((current) => !current)}
            >
              <Icon name={mobileOpen ? 'close' : 'menu'} size={19} />
            </button>
          </div>
        </header>
        {mobileOpen ? (
          <div className="mobile-nav-layer">
            <button
              className="mobile-nav-scrim"
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
            />
            <nav className="mobile-nav-panel" aria-label="Mobile navigation">
              <p className="nav-label">Workbench</p>
              {navigation.map((item) => (
                <button
                  className={`nav-item ${view === item.view ? 'nav-item-active' : ''}`}
                  type="button"
                  key={item.view}
                  onClick={() => mobileNavigate(item.view)}
                  aria-current={view === item.view ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                  {item.view === 'inbox' && inboxCount > 0 ? (
                    <span className="nav-count">{inboxCount}</span>
                  ) : null}
                </button>
              ))}
              <button
                className={`nav-item ${view === 'settings' ? 'nav-item-active' : ''}`}
                type="button"
                onClick={() => mobileNavigate('settings')}
                aria-current={view === 'settings' ? 'page' : undefined}
              >
                <Icon name="settings" size={17} />
                <span>Settings</span>
              </button>
            </nav>
          </div>
        ) : null}
        <main className="main-content">{children}</main>
        <footer className="app-footer">
          <span>Markdown is the source of truth</span>
          <span className="footer-separator">/</span>
          <span>SQLite is rebuildable</span>
          <span className="footer-separator">/</span>
          <span>Designed for agent context</span>
        </footer>
      </div>
    </div>
  );
}
