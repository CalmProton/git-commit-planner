import { describe, expect, test } from 'bun:test';
import {
  extractOpenCodeText,
  OpenCodeClient,
  parseModelReference
} from '../src/openCode';
import type { ExtensionSettings } from '../src/settings';

describe('OpenCode helpers', () => {
  test('parses provider/model references with optional variants', () => {
    expect(parseModelReference('openrouter/anthropic/claude-sonnet#high')).toEqual({
      providerID: 'openrouter',
      modelID: 'anthropic/claude-sonnet',
      variant: 'high'
    });
    expect(parseModelReference('openai/gpt-5')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5'
    });
    expect(parseModelReference('')).toBeUndefined();
  });

  test('rejects model values without a provider and model', () => {
    expect(() => parseModelReference('gpt-5')).toThrow('provider/model');
    expect(() => parseModelReference('openai/')).toThrow('provider/model');
  });

  test('extracts structured and text responses', () => {
    expect(extractOpenCodeText({
      info: { structured: { commitMessage: 'feat: add support' } },
      parts: []
    })).toBe('{"commitMessage":"feat: add support"}');

    expect(extractOpenCodeText({
      parts: [
        { type: 'reasoning', text: 'hidden reasoning' },
        { type: 'text', text: '{"commitMessage":"fix: repair output"}' }
      ]
    })).toBe('{"commitMessage":"fix: repair output"}');
  });

  test('discovers providers and retries without unsupported structured output', async () => {
    const messageBodies: Array<Record<string, unknown>> = [];
    let deleted = false;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/global/health') {
          return Response.json({ healthy: true });
        }
        if (url.pathname === '/provider') {
          return Response.json({
            all: [{
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-5': {
                  name: 'GPT-5',
                  variants: { high: {} }
                }
              }
            }],
            connected: ['openai'],
            default: { openai: 'gpt-5' }
          });
        }
        if (url.pathname === '/experimental/tool/ids') {
          return Response.json(['bash', 'customTool', 'StructuredOutput']);
        }
        if (url.pathname === '/session' && request.method === 'POST') {
          return Response.json({ id: 'session-1' });
        }
        if (url.pathname === '/session/session-1/message' && request.method === 'POST') {
          const body = await request.json() as Record<string, unknown>;
          messageBodies.push(body);
          if ('format' in body) {
            return Response.json({ error: 'Unknown key format' }, { status: 400 });
          }
          return Response.json({
            info: { structured: { commitMessage: 'feat: use OpenCode' } },
            parts: []
          });
        }
        if (url.pathname === '/session/session-1' && request.method === 'DELETE') {
          deleted = true;
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      }
    });

    try {
      const client = new OpenCodeClient('opencode', server.url.href);
      const models = await client.listModels('C:/repo');
      expect(models.map(model => model.reference)).toEqual(['openai/gpt-5']);

      const result = await client.generate(
        [
          { role: 'system', content: 'Return JSON.' },
          { role: 'user', content: 'Describe the change.' }
        ],
        'C:/repo',
        {
          opencode: {
            command: 'opencode',
            serverUrl: server.url.href,
            model: 'openai/gpt-5#high',
            variant: ''
          }
        } as ExtensionSettings,
        { type: 'object', properties: { commitMessage: { type: 'string' } } }
      );

      expect(result.text).toBe('{"commitMessage":"feat: use OpenCode"}');
      expect(result.timings.phases.map(timing => timing.phase)).toEqual([
        'server readiness',
        'session startup',
        'tool policy',
        'model turn',
        'session cleanup'
      ]);
      expect(messageBodies).toHaveLength(2);
      expect(messageBodies[0]).toHaveProperty('format');
      expect(messageBodies[1]).not.toHaveProperty('format');
      expect(messageBodies[1]).toMatchObject({
        model: { providerID: 'openai', modelID: 'gpt-5' },
        variant: 'high',
        tools: { bash: false, customTool: false }
      });
      expect(deleted).toBe(true);
      client.dispose();
    } finally {
      server.stop();
    }
  });

  test('retries without structured output when thinking mode rejects tool choice', async () => {
    const messageBodies: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/global/health') {
          return Response.json({ healthy: true });
        }
        if (url.pathname === '/session' && request.method === 'POST') {
          return Response.json({ id: 'session-1' });
        }
        if (url.pathname === '/session/session-1/message' && request.method === 'POST') {
          const body = await request.json() as Record<string, unknown>;
          messageBodies.push(body);
          if ('format' in body) {
            return Response.json({
              info: {
                error: {
                  name: 'APIError',
                  data: { message: 'Error from provider: Thinking mode does not support this tool_choice' }
                }
              },
              parts: []
            });
          }
          return Response.json({
            parts: [{ type: 'text', text: '{"commits":[]}' }]
          });
        }
        if (url.pathname === '/session/session-1' && request.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      }
    });

    try {
      const client = new OpenCodeClient('opencode', server.url.href);
      const result = await client.generate(
        [
          { role: 'system', content: 'Return JSON.' },
          { role: 'user', content: 'Describe the change.' }
        ],
        'C:/repo',
        {
          opencode: {
            command: 'opencode',
            serverUrl: server.url.href,
            model: 'opencode-go/deepseek-v4-flash',
            variant: 'high'
          }
        } as ExtensionSettings,
        { type: 'object', properties: { commits: { type: 'array' } } }
      );

      expect(result.text).toBe('{"commits":[]}');
      expect(messageBodies).toHaveLength(2);
      expect(messageBodies[0]).toHaveProperty('format');
      expect(messageBodies[1]).not.toHaveProperty('format');
      expect(messageBodies[1]).toMatchObject({
        model: { providerID: 'opencode-go', modelID: 'deepseek-v4-flash' },
        variant: 'high'
      });
      client.dispose();
    } finally {
      server.stop();
    }
  });
});
