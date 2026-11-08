import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOL_NAMES, type ToolName } from '../src/tools/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoVectorClient } from '../src/client/index.js';
import { createHttpApp, createMcpServer, type HttpConfig } from '../src/index.js';

const API_KEY = `sk_live_${'a'.repeat(48)}`;
const EVENT_ID = 'a5808a61-2bf1-44ba-875e-c664890db384';
const config: HttpConfig = {
  mode: 'http', baseUrl: 'https://api.example.com/api/v2', timeout: 30_000, maxRetries: 0,
  port: 0, host: '127.0.0.1', allowedHosts: [], allowedOrigins: [],
  enableJsonResponse: true, shutdownDrainTimeoutMs: 100,
  oauthEnabled: false, oauthMetadataEnabled: false, oauthIssuer: '', oauthJwksUrl: '',
  oauthResource: '', oauthClockSkewSeconds: 60,
};
const initialize = {
  jsonrpc: '2.0', id: 'initialize', method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};
function activityResponse(): Response {
  return new Response(JSON.stringify({ accepted: true, wake_status: 'accepted' }), { status: 200 });
}
function apiClient(timeout = 30_000): VideoVectorClient {
  return new VideoVectorClient({ apiKey: API_KEY, baseUrl: config.baseUrl, timeout, maxRetries: 3 });
}
function send(app: ReturnType<typeof createHttpApp>['app'], body: object) {
  return request(app as never).post('/mcp').set('X-API-Key', API_KEY)
    .set('Accept', 'application/json, text/event-stream').send(body);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('explicit processing activity transport', () => {
  it('sends the existing credential and stable event to the canonical control route', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => activityResponse());
    vi.stubGlobal('fetch', fetchSpy);
    await apiClient().recordProcessingActivity({ reason: 'processing_intent', operation: 'analyze' }, EVENT_ID);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${config.baseUrl}/auth/processing-activity`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-API-Key': API_KEY });
    expect(init.headers).not.toHaveProperty('Idempotency-Key');
    expect(JSON.parse(init.body as string)).toEqual({
      event_id: EVENT_ID, surface: 'mcp', reason: 'processing_intent', operation: 'analyze',
    });
  });

  it('preserves OAuth bearer authentication without adding an API key', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => activityResponse());
    vi.stubGlobal('fetch', fetchSpy);
    const client = new VideoVectorClient({
      baseUrl: config.baseUrl,
      credential: { kind: 'oauth', accessToken: 'verified-token', issuer: 'issuer', subject: 'user', resource: 'resource' },
    });
    await client.recordProcessingActivity({ reason: 'processing_intent', operation: 'analyze' }, EVENT_ID);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer verified-token' });
    expect(init.headers).not.toHaveProperty('X-API-Key');
    expect(JSON.parse(init.body as string)).toMatchObject({ operation: 'analyze', reason: 'processing_intent' });
  });

  it.each([401, 429, 503])('keeps readiness HTTP%s advisory and never retries', async status => {
    const fetchSpy = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({ detail: 'private backend details' }), { status }
    ));
    vi.stubGlobal('fetch', fetchSpy);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(apiClient().recordProcessingActivity({ reason: 'processing_intent', operation: 'analyze' })).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[videovector-mcp] Processing readiness unavailable; continuing.');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
  });

  it.each([30_000, 100])('bounds the signal by the smaller of three seconds and client timeout%s', async timeout => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const work = apiClient(timeout).recordProcessingActivity({ reason: 'processing_intent', operation: 'analyze' });
    await vi.advanceTimersByTimeAsync(Math.min(timeout, 3_000));
    await expect(work).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('foreground MCP triggers', () => {
  it('keeps initialization, discovery, notifications and validation cache refresh passive', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => (
      url.endsWith('/auth/validate') ? new Response(null, { status: 204 }) : activityResponse()
    ));
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(config);
    expect((await send(app, initialize)).status).toBe(200);
    now += 61_000; // Forces genuine read-only revalidation, not another session.
    expect((await send(app, { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} })).status).toBe(200);
    await send(app, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(fetchSpy.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v2/auth/validate', '/api/v2/auth/validate',
    ]);
  });

  it('never signals rejected authentication', async () => {
    const fetchSpy = vi.fn().mockImplementation(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(config);
    expect((await send(app, initialize)).status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe(`${config.baseUrl}/auth/validate`);
  });

  it('does not allocate a request after draining starts during authentication', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
    const context = createHttpApp(config);
    const response = send(context.app, initialize).then(value => value);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    context.startDraining();
    finish(new Response(null, { status: 204 }));
    expect((await response).status).toBe(503);
    expect(context.activeRequests.size).toBe(0);
  });

  const toolArguments: Record<ToolName, Record<string, unknown>> = {
    analyze: { instruction: 'Summarize', source: { video_ids: ['video-1'] }, wait_seconds: 0 },
    import_media: { files: [{ file_id: 'file-1', download_url: 'https://media.example/video.mp4' }], wait_seconds: 0 },
    get_analysis: { analysis_id: 'analysis-1', wait_seconds: 0 },
    search: { query: 'decisions', scope: { playground: true } },
    browse: { resource: 'indexes' },
  };

  it.each(Object.values(TOOL_NAMES))('signals %s once before executing the tool', async operation => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    let finish!: () => void;
    const activity = vi.spyOn(VideoVectorClient.prototype, 'recordProcessingActivity')
      .mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const execute = vi.spyOn(VideoVectorClient.prototype, 'mcpTool').mockResolvedValue({
      content: [], structuredContent: { analysis_id: 'analysis-1', import_id: 'import-1' },
    });
    const { app } = createHttpApp(config);
    const response = send(app, { jsonrpc: '2.0', id: operation, method: 'tools/call',
      params: { name: operation, arguments: toolArguments[operation] } }).then(value => value);
    await vi.waitFor(() => expect(activity).toHaveBeenCalledExactlyOnceWith({ reason: 'processing_intent', operation }));
    expect(execute).not.toHaveBeenCalled();
    finish();
    expect((await response).body.result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toBe(operation);
  });

  it('signals import progress tool calls, but not their underlying API reads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const activity = vi.spyOn(VideoVectorClient.prototype, 'recordProcessingActivity').mockResolvedValue();
    const execute = vi.spyOn(VideoVectorClient.prototype, 'mcpTool').mockResolvedValue({ content: [] });
    const { app } = createHttpApp(config);
    await send(app, { jsonrpc: '2.0', id: 'import-progress', method: 'tools/call',
      params: { name: 'import_media', arguments: { import_id: 'import-1', wait_seconds: 0 } } });
    expect(activity).toHaveBeenCalledExactlyOnceWith({ reason: 'processing_intent', operation: 'import_media' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'save_prompt'])('does not warm retired or unknown %s or unauthenticated tool calls', async name => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    const activity = vi.spyOn(VideoVectorClient.prototype, 'recordProcessingActivity').mockResolvedValue();
    const { app } = createHttpApp(config);
    const unknown = await send(app, { jsonrpc: '2.0', id: 'unknown', method: 'tools/call', params: { name } });
    expect(unknown.body.result.isError).toBe(true);
    const unauthenticated = await request(app).post('/mcp').set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 'unauthenticated', method: 'tools/call', params: { name: 'browse', arguments: toolArguments.browse } });
    expect(unauthenticated.status).toBe(401);
    expect(activity).not.toHaveBeenCalled();
  });

  it('stdio stays passive through initialization and discovery, then warms on each tool call', async () => {
    const activity = vi.spyOn(VideoVectorClient.prototype, 'recordProcessingActivity').mockResolvedValue();
    vi.spyOn(VideoVectorClient.prototype, 'mcpTool').mockResolvedValue({ content: [], isError: true });
    const server = createMcpServer(apiClient(), { mode: 'stdio', authenticationKind: 'api-key' });
    const host = new Client({ name: 'test-host', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await host.connect(clientTransport);
      await host.listTools();
      expect(activity).not.toHaveBeenCalled();
      await host.callTool({ name: 'browse', arguments: toolArguments.browse });
      await host.callTool({ name: 'analyze', arguments: toolArguments.analyze });
      expect(activity.mock.calls.map(([value]) => value)).toEqual([
        { reason: 'processing_intent', operation: 'browse' },
        { reason: 'processing_intent', operation: 'analyze' },
      ]);
    } finally {
      await host.close();
      await server.close();
    }
  });
});
