import { describe, expect, test } from 'vitest';
import {
  parseProjectFile,
  projectRecordSchema,
  serializeProjectRecord,
  type ProjectRecord,
} from '../src/index.js';

const gitProject: ProjectRecord = {
  schema: 1,
  kind: 'project',
  id: 'proj_git_0123456789abcdef',
  name: 'RepoRecall — локальная память',
  identity: 'git-remote',
  remoteFingerprint: 'sha256:0123456789abcdef',
  createdAt: '2026-08-14T10:00:00.000Z',
  updatedAt: '2026-08-14T10:00:00.000Z',
};

describe('project manifest contract', () => {
  test('round-trips a Git-backed project without machine paths or raw remotes', () => {
    const source = serializeProjectRecord(gitProject);

    expect(source).toContain('kind: project');
    expect(source).toContain('identity: git-remote');
    expect(source).not.toContain('/Users/');
    expect(source).not.toContain('github.com/');
    expect(parseProjectFile(source, 'project.md')).toEqual(gitProject);
  });

  test('accepts local projects without a remote fingerprint', () => {
    const local: ProjectRecord = {
      schema: 1,
      kind: 'project',
      id: 'proj_local_00000000-0000-4000-8000-000000000000',
      name: 'scratch',
      identity: 'local',
      createdAt: gitProject.createdAt,
      updatedAt: gitProject.updatedAt,
    };

    expect(projectRecordSchema.parse(local)).toEqual(local);
    expect(parseProjectFile(serializeProjectRecord(local), 'project.md')).toEqual(local);
  });

  test('rejects future schemas, unknown identities, and incomplete Git metadata', () => {
    expect(() => projectRecordSchema.parse({ ...gitProject, schema: 2 })).toThrow();
    expect(() => projectRecordSchema.parse({ ...gitProject, identity: 'folder-name' })).toThrow();
    expect(() =>
      projectRecordSchema.parse({ ...gitProject, remoteFingerprint: undefined }),
    ).toThrow(/remote fingerprint/i);
  });

  test('reports malformed project Markdown with its path', () => {
    expect(() => parseProjectFile('not a manifest', '/tmp/broken/project.md')).toThrow(
      /project\.md/i,
    );
  });
});
