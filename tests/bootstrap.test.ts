import { describe, expect, test } from 'vitest';

describe('RepoRecall bootstrap', () => {
  test('runs on a supported Node.js major version', () => {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});
