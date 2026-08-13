import { useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAsyncData } from '../hooks.js';
import { Icon } from './icons.js';
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHeader } from './ui.js';

export function GraphPage({
  refreshKey,
  onOpen,
}: {
  refreshKey: number;
  onOpen: (id: string) => void;
}) {
  const loadGraph = useCallback(() => api.getGraph(), []);
  const result = useAsyncData(loadGraph, [refreshKey]);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selected = result.data?.nodes.find((node) => node.id === selectedId);
  const selectedEdges = useMemo(
    () =>
      result.data?.edges.filter(
        (edge) => edge.source === selectedId || edge.target === selectedId,
      ) ?? [],
    [result.data, selectedId],
  );
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Indexed relations"
        title="Graph"
        description="A lightweight view of the relations already stored in canonical memories. The graph is a projection, never a second source of truth."
        actions={
          <Badge tone="blue" icon="graph">
            {result.data?.nodes.length ?? 0} nodes
          </Badge>
        }
      />
      {result.loading && result.data === undefined ? (
        <LoadingState label="Loading memory graph" />
      ) : result.error !== undefined && result.data === undefined ? (
        <ErrorState message={result.error.message} onRetry={result.reload} />
      ) : result.data?.nodes.length === 0 ? (
        <EmptyState
          icon="graph"
          title="No relations indexed"
          description="Add a relation to a memory and it will appear here after the local index refreshes."
        />
      ) : (
        <div className="graph-layout">
          <Card className="graph-board">
            <div className="graph-board-header">
              <span className="eyebrow">Relation map</span>
              <span>{result.data?.edges.length ?? 0} edges</span>
            </div>
            <div className="graph-node-grid">
              {result.data?.nodes.map((node, index) => (
                <button
                  type="button"
                  className={`graph-node graph-node-${index % 4} ${node.id === selectedId ? 'graph-node-selected' : ''}`}
                  key={node.id}
                  onClick={() => setSelectedId(node.id)}
                >
                  <span className="graph-node-dot" />
                  <strong>{node.label}</strong>
                  <small>
                    {node.type} · {node.scope}
                  </small>
                </button>
              ))}
            </div>
          </Card>
          <Card className="graph-inspector">
            {selected === undefined ? (
              <div className="graph-inspector-empty">
                <Icon name="diamond" size={21} />
                <h2>Inspect a node</h2>
                <p>
                  Select a memory to see the edges that connect it, then open the canonical record
                  for editing.
                </p>
              </div>
            ) : (
              <div className="graph-inspector-content">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Selected memory</p>
                    <h2>{selected.label}</h2>
                  </div>
                  <Badge tone="dark">{selected.type}</Badge>
                </div>
                <div className="graph-detail">
                  <span>scope</span>
                  <strong>{selected.scope}</strong>
                  <span>status</span>
                  <strong>{selected.status}</strong>
                  <span>relations</span>
                  <strong>{selectedEdges.length}</strong>
                </div>
                <ul className="edge-list">
                  {selectedEdges.length === 0 ? (
                    <li className="edge-empty">No relation edges on this memory.</li>
                  ) : (
                    selectedEdges.map((edge) => (
                      <li key={`${edge.source}-${edge.target}-${edge.type}`}>
                        <Icon name="arrow" size={13} />
                        <span>{edge.type}</span>
                        <button
                          type="button"
                          onClick={() =>
                            onOpen(edge.source === selected.id ? edge.target : edge.source)
                          }
                        >
                          {edge.source === selected.id ? edge.target : edge.source}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
                <button
                  className="text-link graph-open"
                  type="button"
                  onClick={() => onOpen(selected.id)}
                >
                  Open memory <Icon name="arrow" size={14} />
                </button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
