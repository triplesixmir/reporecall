import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';
import { GraphPage } from './components/graph-page.js';
import { InboxPage } from './components/inbox-page.js';
import { Icon } from './components/icons.js';
import { Layout, type View } from './components/layout.js';
import { MemoriesPage } from './components/memories-page.js';
import { OverviewPage } from './components/overview-page.js';
import { ProjectsPage } from './components/projects-page.js';
import { RecentPage } from './components/recent-page.js';
import { SettingsPage } from './components/settings-page.js';
import { useAsyncData } from './hooks.js';
import { ErrorState, LoadingState } from './components/ui.js';

const views: View[] = ['overview', 'memories', 'projects', 'recent', 'inbox', 'graph', 'settings'];

function viewFromUrl(url: URL): View {
  const value = url.searchParams.get('view');
  return value !== null && views.includes(value as View) ? (value as View) : 'overview';
}

export function App() {
  const [locationKey, setLocationKey] = useState(() => window.location.href);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const location = useMemo(() => new URL(locationKey), [locationKey]);
  const view = viewFromUrl(location);
  const loadOverview = useCallback(() => api.getOverview(), []);
  const overview = useAsyncData(loadOverview, [refreshKey]);

  useEffect(() => {
    const onPopState = () => setLocationKey(window.location.href);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = window.setTimeout(() => setNotice(undefined), 4_500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const navigate = useCallback(
    (nextView: View, updates: Record<string, string | undefined> = {}) => {
      const next = new URL(window.location.href);
      next.searchParams.set('view', nextView);
      if (nextView !== 'memories') {
        next.searchParams.delete('memory');
        next.searchParams.delete('new');
      }
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === '') next.searchParams.delete(key);
        else next.searchParams.set(key, value);
      }
      window.history.pushState({}, '', next);
      setLocationKey(next.href);
    },
    [],
  );

  const replaceUrl = useCallback((updates: Record<string, string | undefined>) => {
    const next = new URL(window.location.href);
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === '') next.searchParams.delete(key);
      else next.searchParams.set(key, value);
    }
    window.history.replaceState({}, '', next);
    setLocationKey(next.href);
  }, []);

  const changed = useCallback(() => setRefreshKey((current) => current + 1), []);
  const onNotice = useCallback((message: string) => setNotice(message), []);
  const content = (() => {
    if (view === 'overview')
      return (
        <OverviewPage
          onNavigate={(next) => navigate(next)}
          onNewMemory={() => navigate('memories', { new: '1' })}
          refreshKey={refreshKey}
        />
      );
    if (view === 'memories')
      return (
        <MemoriesPage
          location={location}
          onUrlChange={replaceUrl}
          refreshKey={refreshKey}
          onChanged={changed}
          onNotice={onNotice}
        />
      );
    if (view === 'projects') return <ProjectsPage refreshKey={refreshKey} />;
    if (view === 'recent')
      return (
        <RecentPage refreshKey={refreshKey} onOpen={(id) => navigate('memories', { memory: id })} />
      );
    if (view === 'inbox')
      return <InboxPage refreshKey={refreshKey} onChanged={changed} onNotice={onNotice} />;
    if (view === 'graph')
      return (
        <GraphPage refreshKey={refreshKey} onOpen={(id) => navigate('memories', { memory: id })} />
      );
    return <SettingsPage refreshKey={refreshKey} />;
  })();

  return (
    <Layout
      view={view}
      inboxCount={overview.data?.inboxCount ?? 0}
      onNavigate={(next) => navigate(next)}
    >
      {overview.loading && overview.data === undefined && view === 'overview' ? (
        <LoadingState label="Loading RepoRecall" />
      ) : overview.error !== undefined && overview.data === undefined && view === 'overview' ? (
        <ErrorState message={overview.error.message} onRetry={overview.reload} />
      ) : (
        <>
          {content}
          {notice === undefined ? null : (
            <div className="global-notice" role="status">
              <Icon name="check" size={15} />
              {notice}
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => setNotice(undefined)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}
        </>
      )}
    </Layout>
  );
}
