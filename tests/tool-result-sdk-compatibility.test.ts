import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { VideoVectorClient } from '../src/client/index.js';
import { createMcpServer } from '../src/index.js';
import { VideoVectorApiError } from '../src/types/index.js';
import type { McpToolResponse } from '../src/types/mcp.js';
import { readFileSync } from 'node:fs';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getToolDefinitions } from '../src/tools/definitions.js';

const cachedAnalysisSchema = JSON.parse(readFileSync(new URL('./fixtures/analysis-result-schema-6.1.4.json', import.meta.url), 'utf8'));

const completedAnalysis = {
  analysis_id: 'analysis-1', status: 'completed', terminal: true, stage: 'completed',
  message: 'Done', progress: { total: 1, completed: 1 },
  results: { included_videos: 1, final: true }, next_action: { type: 'download_and_answer' },
};
const response = (data: Record<string, unknown>): McpToolResponse => ({
  content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
});
function backend() {
  return {
    mcpTool: vi.fn<VideoVectorClient['mcpTool']>(),
    recordProcessingActivity: vi.fn().mockResolvedValue(undefined),
  };
}

async function withHost(
  api: ReturnType<typeof backend>,
  run: (host: Client) => Promise<void>,
  runtime: Parameters<typeof createMcpServer>[1] = { mode: 'http', authenticationKind: 'api-key' },
  cachedDiscovery = false,
) {
  const server = createMcpServer(api as unknown as VideoVectorClient, runtime);
  if (cachedDiscovery) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolDefinitions().map(tool =>
      tool.name === 'analyze' || tool.name === 'get_analysis' ? { ...tool, outputSchema: cachedAnalysisSchema } : tool) }));
  }
  const host = new Client({ name: 'result-contract-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await host.connect(clientTransport);
    // Discovering tools activates the SDK's published output-schema validation.
    const listed = await host.listTools();
    expect(listed.tools.every(tool => tool.outputSchema !== undefined)).toBe(true);
    await run(host);
  } finally {
    await host.close();
    await server.close();
  }
}

describe('tool results consumed by the official MCP SDK', () => {
  it.each(['analyze', 'get_analysis'] as const)('delivers %s saved prompt identity through the cached 6.1.4 output schema', async name => {
    const api = backend();
    const data = { ...completedAnalysis, scope: { type: 'playground', prompt_id: 'saved-prompt-1' } };
    api.mcpTool.mockResolvedValue(response(data));
    await withHost(api, async host => {
      const args = name === 'analyze'
        ? { instruction: 'Summarize the lecture', source: { video_ids: ['video-1'] }, wait_seconds: 0 }
        : { analysis_id: 'analysis-1', wait_seconds: 0 };
      const result = await host.callTool({ name, arguments: args });
      expect(result.structuredContent).toEqual(data);
      expect(result.isError).not.toBe(true);
      expect(api.mcpTool).toHaveBeenCalledTimes(1);
    }, undefined, true);
  });

  it('delivers the saved prompt in a recoverable admission observation to a cached-schema host', async () => {
    const api = backend();
    api.mcpTool.mockResolvedValueOnce(response({ ...completedAnalysis, status: 'processing', terminal: false,
      scope: { type: 'playground', prompt_id: 'saved-prompt-1' },
      next_action: { type: 'continue_polling', after_seconds: 15 } }))
      .mockResolvedValueOnce({ ...response({ analysis_id: 'analysis-1', code: 'observation_unavailable',
        message: 'Continue reading this analysis.', next_action: { type: 'continue_polling', after_seconds: 15 } }), isError: true });
    await withHost(api, async host => {
      const result = await host.callTool({ name: 'analyze', arguments: {
        instruction: 'Summarize the lecture', source: { video_ids: ['video-1'] },
      } });
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty('structuredContent');
      expect(JSON.parse(result.content[0].text)).toMatchObject({ analysis_id: 'analysis-1',
        scope: { prompt_id: 'saved-prompt-1' }, code: 'observation_unavailable' });
      expect(api.mcpTool.mock.calls.map(call => call[0])).toEqual(['analyze', 'get_analysis']);
    }, undefined, true);
  });

  it('delivers analysis navigation to hosts with the cached 6.1.4 output schema', async () => {
    const api = backend();
    const data = { ...completedAnalysis,
      files: [{ video_id: 'video-1', links: { open_in_app: 'https://app.vectormethods.com/playground?analysis=analysis-1&video=video-1' } }],
      next_action: { type: 'download_and_answer', links: { open_in_app: 'https://app.vectormethods.com/playground?analysis=analysis-1' } },
    };
    api.mcpTool.mockResolvedValue(response(data));
    await withHost(api, async host => {
      const result = await host.callTool({ name: 'get_analysis', arguments: { analysis_id: 'analysis-1', wait_seconds: 0 } });
      expect(result.structuredContent).toEqual(data);
      expect(result.isError).not.toBe(true);
    }, undefined, true);
  });
  it.each([undefined, false])('preserves successful structured results when isError is %s', async isError => {
    const api = backend();
    const expected = { ...response(completedAnalysis), isError, _meta: { trace: 'success' } };
    api.mcpTool.mockResolvedValue(expected);
    await withHost(api, async host => {
      const result = await host.callTool({ name: 'get_analysis', arguments: { analysis_id: 'analysis-1', wait_seconds: 0 } });
      expect(result.content).toEqual(expected.content);
      expect(result.structuredContent).toEqual(completedAnalysis);
      expect(result.isError).toBe(isError);
      expect(result._meta).toEqual(expected._meta);
    });
  });

  it.each([
    {
      name: 'get_analysis', arguments: { analysis_id: 'analysis-1', cursor: 'page-2', detail: 'full', wait_seconds: 0 },
      data: { analysis_id: 'analysis-1', cursor: 'page-2', code: 'observation_unavailable',
        message: 'This observation is unavailable; execution may still be active.',
        next_action: { type: 'continue_polling', tool: 'get_analysis', after_seconds: 15 } },
    },
    {
      name: 'browse', arguments: { resource: 'analyses' },
      data: { error: true, code: 'authorization_denied', message: 'Access is unavailable.',
        next_action: { type: 'request_input' } },
    },
  ])('delivers a facade $name error without validating it as a successful result', async testCase => {
    const api = backend();
    const expected = { ...response(testCase.data), isError: true, _meta: { trace: 'facade-error' } };
    api.mcpTool.mockResolvedValue(expected);
    await withHost(api, async host => {
      const result = await host.callTool({ name: testCase.name, arguments: testCase.arguments });
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty('structuredContent');
      expect(result.content).toEqual(expected.content);
      expect(result._meta).toEqual(expected._meta);
    });
  });

  it('keeps the same analysis and cursor in a transient HTTP failure', async () => {
    const api = backend();
    api.mcpTool.mockRejectedValue(new VideoVectorApiError('private backend detail', 'database_unavailable', 503));
    await withHost(api, async host => {
      const args = { analysis_id: 'analysis-1', cursor: 'page-2', detail: 'full', wait_seconds: 0 };
      const result = await host.callTool({ name: 'get_analysis', arguments: args });
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty('structuredContent');
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        analysis_id: args.analysis_id, cursor: args.cursor,
        next_action: { type: 'continue_polling', tool: 'get_analysis', after_seconds: 15 },
      });
      expect(JSON.stringify(result)).not.toContain('private backend detail');
      expect(api.mcpTool).toHaveBeenCalledExactlyOnceWith('get_analysis', args, expect.any(Object));
    });
  });

  it('delivers an uncertain submission receipt with its original idempotency key', async () => {
    const api = backend();
    api.mcpTool.mockRejectedValue(new VideoVectorApiError('private connection detail', 'network_error', 0));
    await withHost(api, async host => {
      const result = await host.callTool({ name: 'analyze', arguments: {
        instruction: 'Summarize this lecture', source: { video_ids: ['video-1'] },
        idempotency_key: 'original-submission', wait_seconds: 0,
      } });
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty('structuredContent');
      const receipt = JSON.parse(result.content[0].text);
      expect(receipt).toMatchObject({ code: 'analyze_submission_unconfirmed', next_action: {
        type: 'retry_same_submission', tool: 'analyze', idempotency_key: 'original-submission', after_seconds: 15,
      } });
      expect(receipt).not.toHaveProperty('analysis_id');
      expect(api.mcpTool).toHaveBeenCalledOnce();
    });
  });

  it('preserves facade metadata and the OAuth reconnect challenge on an error', async () => {
    const api = backend();
    const expected = { ...response({ error: true, message: 'Reconnect your account.', next_action: { type: 'request_input' } }),
      isError: true, oauthAuthenticationFailure: true, _meta: { trace: 'auth-error' } };
    api.mcpTool.mockResolvedValue(expected);
    const metadataUrl = 'https://mcp.example/.well-known/oauth-protected-resource';
    await withHost(api, async host => {
      const result = await host.callTool({ name: 'get_analysis', arguments: { analysis_id: 'analysis-1', wait_seconds: 0 } });
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty('structuredContent');
      expect(result.content).toEqual(expected.content);
      expect(result._meta).toMatchObject({ trace: 'auth-error', 'mcp/www_authenticate': expect.stringContaining(metadataUrl) });
    }, { mode: 'http', authenticationKind: 'oauth', oauthResourceMetadataUrl: metadataUrl });
  });

  it('still rejects a malformed successful result against its published schema', async () => {
    const api = backend();
    api.mcpTool.mockResolvedValue(response({ analysis_id: 'analysis-1' }));
    await withHost(api, async host => {
      await expect(host.callTool({ name: 'get_analysis', arguments: { analysis_id: 'analysis-1', wait_seconds: 0 } }))
        .rejects.toThrow('Structured content does not match');
    });
  });
});
