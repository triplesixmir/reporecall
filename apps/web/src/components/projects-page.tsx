import { useCallback } from 'react';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';
import { Icon } from './icons.js';
import { Card, EmptyState, ErrorState, LoadingState, PageHeader } from './ui.js';

export function ProjectsPage({ refreshKey }: { refreshKey: number }) {
  const loadProjects = useCallback(() => api.getProjects(), []);
  const result = useAsyncData(loadProjects, [refreshKey]);
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Memory boundaries"
        title="Projects"
        description="Project memory stays alongside the repository, so a clone can rebuild its local index without importing machine state."
      />
      {result.loading && result.data === undefined ? (
        <LoadingState label="Loading projects" />
      ) : result.error !== undefined && result.data === undefined ? (
        <ErrorState message={result.error.message} onRetry={result.reload} />
      ) : result.data?.projects.length === 0 ? (
        <EmptyState
          icon="folder"
          title="No projects yet"
          description="Create a project-scoped memory and RepoRecall will keep its identity with the canonical files."
        />
      ) : (
        <section className="project-list" aria-label="Projects">
          {result.data?.projects.map((project) => (
            <Card className="project-row" as="article" key={project.id}>
              <div className="project-icon">
                <Icon name="folder" size={19} />
              </div>
              <div className="project-copy">
                <h2>{project.name ?? project.id}</h2>
                <p className="mono">{project.root}</p>
                <span className="project-id">project id · {project.id}</span>
              </div>
              <Icon name="arrow" size={17} />
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}
