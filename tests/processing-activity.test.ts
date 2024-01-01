import request from 'supertest';
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
    await apiClient().recordProcessingActivity({ reason: 'authentication' }, EVENT_ID);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${config.baseUrl}/auth/processing-activity`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-API-Key': API_KEY });
    expect(init.headers).not.toHaveProperty('Idempotency-Key');
    expect(JSON.parse(init.body as string)).toEqual({
      event_id: EVENT_ID, surface: 'mcp', reason: 'authentication',
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
    await expect(apiClient().recordProcessingActivity({ reason: 'authentication' })).resolves.toBeUndefined();
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
    const work = apiClient(timeout).recordProcessingActivity({ reason: 'authentication' });
    await vi.advanceTimersByTimeAsync(Math.min(timeout, 3_000));
    await expect(work).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('foreground MCP triggers', () => {
  it('warms only initialize, not discovery, initialized notifications or validation cache refresh', async () => {
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
      '/api/v2/auth/validate', '/api/v2/auth/processing-activity', '/api/v2/auth/validate',
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

  it('does not allocate a request after draining starts during the bounded readiness call', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => (
      url.endsWith('/auth/validate') ? new Response(null, { status: 204 })
        : new Promise<Response>(resolve => { finish = resolve; })
    )));
    const context = createHttpApp(config);
    const response = send(context.app, initialize).then(value => value);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    context.startDraining();
    finish(activityResponse());
    expect((await response).status).toBe(503);
    expect(context.activeRequests.size).toBe(0);
  });

  it.each(['import_media', 'analyze'] as const)(
    'signals a deliberate %s tool invocation once, before tool execution',
    async operation => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(null, { status: 204 })));
      const activity = vi.spyOn(VideoVectorClient.prototype, 'recordProcessingActivity').mockResolvedValue();
      const { app } = createHttpApp(config);
      await send(app, { jsonrpc: '2.0', id: operation, method: 'tools/call', params: { name: operation, arguments: {} } });
      expect(activity).toHaveBeenCalledExactlyOnceWith({ reason: 'processing_intent', operation });
    }
  );

  it.each(['get_analysis', 'browse', 'search', 'save_prompt'])(
    'does not add readiness to %s',
    async name => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(null, { status: 204 })));
      const activity = vi.spyOn(VideoVectorClient.prototype, 'recordProcessingActivity').mockResolvedValue();
      const { app } = createHttpApp(config);
      await send(app, { jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: {} } });
      expect(activity).not.toHaveBeenCalled();
    }
  );

  it('does not wake processing for import progress reads',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>new Response(null,{status:204})));
    const activity=vi.spyOn(VideoVectorClient.prototype,'recordProcessingActivity').mockResolvedValue();
    const {app}=createHttpApp(config);
    await send(app,{jsonrpc:'2.0',id:'import-progress',method:'tools/call',params:{name:'import_media',arguments:{import_id:'import-1',wait_seconds:0}}});
    expect(activity).not.toHaveBeenCalled();
  });

  it('stdio begins one readiness request on protocol initialization, never construction', async () => {
    const activity = vi.spyOn(VideoVectorClient.prototype, 'recordProcessingActivity').mockResolvedValue();
    const server = createMcpServer(apiClient(), { mode: 'stdio', authenticationKind: 'api-key' });
    expect(activity).not.toHaveBeenCalled();
    server.oninitialized?.();
    server.oninitialized?.();
    expect(activity).toHaveBeenCalledExactlyOnceWith({ reason: 'authentication' });
    await server.close();
  });
});
