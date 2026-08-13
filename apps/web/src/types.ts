export type Scope = 'global' | 'workspace' | 'project' | 'session';
export type MemoryType =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'goal'
  | 'todo'
  | 'constraint'
  | 'insight'
  | 'issue'
  | 'event'
  | 'reference';
export type Priority = 'critical' | 'high' | 'normal' | 'low';
export type MemoryStatus = 'active' | 'resolved' | 'archived' | 'superseded' | 'dismissed';
export type TagOrigin = 'user' | 'ai';

export type MemoryTag = {
  name: string;
  origin: TagOrigin;
  confidence?: number;
};

export type ProjectRef = {
  id: string;
  root: string;
  name?: string;
};

export type WorkspaceRef = {
  id: string;
  name?: string;
};

export type MemoryRelation = {
  type: string;
  targetId: string;
  note?: string;
};

export type MemoryRecord = {
  schema: 1;
  id: string;
  scope: Scope;
  type: MemoryType;
  priority: Priority;
  status: MemoryStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  tags: MemoryTag[];
  confidence?: number;
  project?: ProjectRef;
  workspace?: WorkspaceRef;
  source?: {
    kind: string;
    method?: string;
    provider?: string;
  };
  relations: MemoryRelation[];
  content: string;
};

export type MemoryInput = {
  content: string;
  scope?: Scope;
  type?: MemoryType;
  priority?: Priority;
  status?: MemoryStatus;
  pinned?: boolean;
  tags?: string[];
};

export type MemoryPatch = Partial<MemoryInput>;

export type SearchResult = {
  record: MemoryRecord;
  snippet: string;
  score: number;
};

export type InboxItem = {
  schema: 1;
  id: string;
  status: 'pending' | 'accepted' | 'dismissed';
  createdAt: string;
  updatedAt: string;
  suggested: Omit<MemoryInput, 'tags'> & {
    tags?: MemoryTag[];
    project?: ProjectRef;
    reason?: string;
  };
  source?: { kind: string; provider?: string };
  reason?: string;
  duplicateOf?: string;
};

export type Overview = {
  memoryCount: number;
  activeCount: number;
  projectCount: number;
  tagCount: number;
  inboxCount: number;
  indexErrors: Array<{ path: string; message: string }>;
};

export type ProjectList = {
  projects: ProjectRef[];
  count: number;
};

export type TagSummary = {
  name: string;
  count: number;
  userCount: number;
  aiCount: number;
};

export type MemoryList = {
  memories: MemoryRecord[];
  count: number;
  results?: SearchResult[];
};

export type GraphData = {
  nodes: Array<{
    id: string;
    label: string;
    type: MemoryType;
    scope: Scope;
    status: MemoryStatus;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
    note?: string;
  }>;
};

export type WarningResponse = {
  warnings?: string[];
};
