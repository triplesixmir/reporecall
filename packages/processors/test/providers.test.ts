import { describe, expect, test } from 'vitest';
import type { RedactedSessionCapture } from '@reporecall/core';
import { createProcessorProvider, type ProcessorHttpRequest } from '../src/index.js';

const capture: RedactedSessionCapture = {
  sessionId: 'session-1',
  capturedAt: '2026-08-13T12:00:00.000Z',
  project: { id: 'demo', root: '/tmp/demo', name: 'Demo' },
  content: 'The team chose canonical Markdown and a rebuildable SQLite index.',
};

describe('processor providers', () => {
  test('disabled provider performs no processing', async () => {
    const provider = createProcessorProvider('disabled');

    await expect(provider.suggest(capture)).resolves.toEqual({ suggestions: [], warnings: [] });
  });

  test('agent-native provider extracts explicit marker lines deterministically', async () => {
    const provider = createProcessorProvider('agent-native');

    const result = await provider.suggest({
      ...capture,
      content: [
        'Unrelated conversation.',
        'remember: Keep the canonical files human-readable.',
        'decision: SQLite is a disposable cache.',
        'todo: Add a rebuild command.',
      ].join('\n'),
    });

    expect(result.warnings).toEqual([]);
    expect(result.suggestions).toMatchObject([
      { content: 'Keep the canonical files human-readable.', type: 'fact', confidence: 1 },
      { content: 'SQLite is a disposable cache.', type: 'decision', confidence: 1 },
      { content: 'Add a rebuild command.', type: 'todo', confidence: 1 },
    ]);
  });

  test('OpenAI-compatible provider uses one typed request and environment credentials', async () => {
    let request: ProcessorHttpRequest | undefined;
    const provider = createProcessorProvider('openai-compatible', {
      env: {
        REPORECALL_OPENAI_COMPATIBLE_API_KEY: 'test-key-not-a-secret',
        REPORECALL_OPENAI_COMPATIBLE_MODEL: 'test-model',
      },
      endpoint: 'http://127.0.0.1:9999/v1/chat/completions',
      httpClient: (nextRequest) => {
        request = nextRequest;
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    suggestions: [
                      {
                        content: 'Keep the durable source in Markdown.',
                        type: 'decision',
                        confidence: 0.88,
                        tags: [{ name: 'storage', origin: 'user' }],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        });
      },
    });

    const result = await provider.suggest(capture);

    expect(request).toMatchObject({
      url: 'http://127.0.0.1:9999/v1/chat/completions',
      method: 'POST',
      headers: { authorization: 'Bearer test-key-not-a-secret' },
    });
    expect(JSON.stringify(request?.body)).not.toContain('test-key-not-a-secret');
    expect(result.warnings).toEqual([]);
    expect(result.suggestions[0]).toMatchObject({
      content: 'Keep the durable source in Markdown.',
      scope: 'project',
      type: 'decision',
      project: capture.project,
      tags: [{ name: 'storage', origin: 'ai' }],
    });
  });

  test('OpenAI-compatible base URLs receive the chat completions suffix', async () => {
    let request: ProcessorHttpRequest | undefined;
    const provider = createProcessorProvider('openai-compatible', {
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_MODEL: 'test-model',
        OPENAI_BASE_URL: 'http://127.0.0.1:9999/v1',
      },
      httpClient: (nextRequest) => {
        request = nextRequest;
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify({ suggestions: [] }),
        });
      },
    });

    await provider.suggest(capture);

    expect(request?.url).toBe('http://127.0.0.1:9999/v1/chat/completions');
  });

  test('external provider reports missing credentials and malformed responses without throwing', async () => {
    let calls = 0;
    const provider = createProcessorProvider('openrouter', {
      env: {},
      httpClient: () => {
        calls += 1;
        return Promise.resolve({ status: 200, headers: {}, body: '{}' });
      },
    });

    const result = await provider.suggest(capture);

    expect(calls).toBe(0);
    expect(result.suggestions).toEqual([]);
    expect(result.warnings[0]).toMatch(/OPENROUTER_API_KEY/i);
  });
});
