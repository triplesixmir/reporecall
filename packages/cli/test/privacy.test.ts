import { describe, expect, test } from 'vitest';
import { redactSecrets, scanSecrets } from '../src/privacy.js';

describe('privacy scanner', () => {
  test('redacts common API keys and bearer tokens while preserving useful text', () => {
    const result = redactSecrets('Use this token: sk-or-v1-1234567890abcdef and Bearer ghp_1234567890abcdef for tests.');

    expect(result.blocked).toBe(false);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    expect(result.redacted).toContain('Use this token:');
    expect(result.redacted).not.toContain('sk-or-v1-1234567890abcdef');
    expect(result.redacted).not.toContain('ghp_1234567890abcdef');
  });

  test('blocks content that is only a secret', () => {
    const result = redactSecrets('sk-proj-1234567890abcdef');

    expect(result.blocked).toBe(true);
    expect(result.redacted).toBe('');
  });

  test('reports private keys and credential paths', () => {
    const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const privateKeyFooter = ['-----END', 'PRIVATE KEY-----'].join(' ');
    const result = scanSecrets(`${privateKeyHeader}\nsecret\n${privateKeyFooter}`, {
      sourcePath: '/tmp/project/.env.production',
    });

    expect(result.findings.map(({ kind }) => kind)).toEqual(expect.arrayContaining(['private-key', 'credential-path']));
  });
});
