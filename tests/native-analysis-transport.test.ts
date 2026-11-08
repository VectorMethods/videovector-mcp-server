import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp, type HttpConfig } from '../src/index.js';

const config: HttpConfig = {
  mode: 'http', baseUrl: 'https://backend.example/api/v2', timeout: 1000, maxRetries: 0,
  port: 0, host: '127.0.0.1', allowedHosts: [], allowedOrigins: [],
  enableJsonResponse: true, shutdownDrainTimeoutMs: 100,
  oauthEnabled: false, oauthMetadataEnabled: false, oauthIssuer: '', oauthJwksUrl: '',
  oauthResource: '', oauthClockSkewSeconds: 60,
};
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const response=(data:object)=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
describe('native analysis protocol', () => {
  it('forwards a supported 10 MiB image search through the HTTP transport intact', async () => {
    const imageData = Buffer.alloc(10 * 1024 * 1024, 0x7a).toString('base64');
    const arguments_ = { image_data: imageData, scope: { index_id: 'images' } };
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/auth/validate')) return new Response(null, { status: 204 });
      if (path.endsWith('/auth/processing-activity')) return new Response('{"accepted":true}');
      if (path.endsWith('/workflow/mcp/search')) {
        bodies.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify(response({ search_id: 'image-search', matches: [] })));
      }
      throw new Error(`Unexpected backend path: ${path}`);
    }));
    const { app, activeRequests } = createHttpApp(config);
    const result = await request(app).post('/mcp')
      .set('X-API-Key', `sk_live_${'a'.repeat(48)}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 'image', method: 'tools/call', params: { name: 'search', arguments: arguments_ } });
    expect(result.status).toBe(200);
    expect(result.body.result.isError).not.toBe(true);
    expect(bodies).toEqual([expect.objectContaining(arguments_)]);
    expect(activeRequests.size).toBe(0);
  });

  it('keeps HTTP-200 facade observation errors on the same read until processing completes', async () => {
    const reads: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/auth/validate')) return new Response(null, { status: 204 });
      if (path.endsWith('/auth/processing-activity')) return new Response('{"accepted":true}');
      if (path.endsWith('/workflow/mcp/get_analysis')) {
        reads.push(JSON.parse(init!.body as string));
        const payload = reads.length === 1
          ? { ...response({ analysis_id: 'active-analysis', cursor: 'page-1', code: 'observation_unavailable',
            message: 'This observation is temporarily unavailable; it does not establish that execution stopped.',
            next_action: { type: 'continue_polling', tool: 'get_analysis', after_seconds: 15 } }), isError: true }
          : response({ analysis_id: 'active-analysis', status: 'completed', terminal: true, stage: 'completed',
            message: 'Done', scope: { type: 'videos' }, progress: { total: 1, completed: 1 },
            results: { included_videos: 1, final: true }, next_action: { type: 'download_and_answer' } });
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      throw new Error(`Unexpected backend path: ${path}`);
    }));
    const { app } = createHttpApp(config);
    const args = { analysis_id: 'active-analysis', cursor: 'page-1', detail: 'full', wait_seconds: 0 };
    const send = (id: number) => request(app).post('/mcp')
      .set('X-API-Key', `sk_live_${'a'.repeat(48)}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_analysis', arguments: args } });
    const unavailable = await send(1);
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.result.isError).toBe(true);
    expect(unavailable.body.result).not.toHaveProperty('structuredContent');
    const error = JSON.parse(unavailable.body.result.content[0].text);
    expect(error).toMatchObject({ analysis_id: 'active-analysis', cursor: 'page-1', next_action: { type: 'continue_polling' } });
    expect(error).not.toHaveProperty('status');
    expect(error).not.toHaveProperty('terminal');
    const complete = await send(2);
    expect(complete.body.result.isError).not.toBe(true);
    expect(complete.body.result.structuredContent).toMatchObject({ analysis_id: 'active-analysis', terminal: true });
    expect(reads).toEqual([args, args]);
  });

  it('rejects oversized MCP bodies before authentication or backend work', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { app } = createHttpApp(config);
    const result = await request(app).post('/mcp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ image_data: 'a'.repeat(16 * 1024 * 1024) }));
    expect(result.status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('validates the native host allowlist before parsing an invalid body', async () => {
    const { app } = createHttpApp({ ...config, allowedHosts: ['allowed.example'] });
    const result = await request(app).post('/mcp')
      .set('Host', 'untrusted.example')
      .set('Content-Type', 'application/json')
      .send('invalid JSON');
    expect(result.status).toBe(403);
  });

  it('initializes, lists the eight-file contract, submits a batch and reads its status', async () => {
    const analysis = { analysis_id: 'batch', status: 'completed', terminal: true, stage: 'completed', message: 'Done', scope: { type: 'playground' }, progress: { total: 8, imported: 8, completed: 8, failed: 0 }, results: { included_videos: 8, final: true, download_url: null, expires_in_seconds: null }, next_action: { type: 'download_and_answer' } };
    const files = Array.from({ length: 8 }, (_, index) => ({ file_id: `host-${index}`, download_url: `https://files.example/${index}` }));
    const calls: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, init });
      if (path.endsWith('/auth/validate')) return new Response(null, { status: 204 });
      if (path.endsWith('/auth/processing-activity')) return new Response('{"accepted":true}', { status: 200 });
      if (path.endsWith('/workflow/mcp/analyze')) return new Response(JSON.stringify(response({ ...analysis, status: 'processing', terminal: false, stage: 'importing', results: { ...analysis.results, included_videos: 0, final: false }, next_action: { type: 'continue_polling', after_seconds: 15 } })), { status: 202 });
      if (path.endsWith('/workflow/mcp/get_analysis')) return new Response(JSON.stringify(response(analysis)), { status: 200 });
      throw new Error(`Unexpected backend path: ${path}`);
    }));
    const { app } = createHttpApp(config);
    const send = (id: string, method: string, params: object) => request(app as never).post('/mcp')
      .set('X-API-Key', `sk_live_${'a'.repeat(48)}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id, method, params });
    const initialized = await send('init', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'local-native-test', version: '1' } });
    expect(initialized.status).toBe(200);
    expect(initialized.body.result.serverInfo.name).toBe('videovector');
    expect(initialized.body.result.instructions).toContain('segment and whole-media fields together');
    expect(initialized.body.result.instructions).toContain('Never resubmit an active analysis');
    expect(initialized.body.result.instructions).toContain('explicit user intent to retry');
    expect(initialized.body.result.instructions).toContain('An observation error does not prove execution stopped');
    const listed = await send('list', 'tools/list', {});
    const find = listed.body.result.tools.find((tool: any) => tool.name === 'analyze');
    expect(find.inputSchema.properties.files.maxItems).toBe(8);
    for (const media of ['video', 'audio']) {
      expect(find.inputSchema.properties.execution.properties[`${media}_segmentation_type`]).toBeUndefined();
      expect(find.inputSchema.properties.execution.properties[`${media}_segment_duration`]).toBeUndefined();
      const incomplete = await send(`invalid-${media}`, 'tools/call', { name: 'analyze', arguments: {
        instruction: 'Find cars', files, execution: { [`${media}_segmentation_type`]: 'fixed' },
      } });
      expect(incomplete.body.result.isError).toBe(true);
    }
    expect(calls.some(call => call.path.endsWith('/workflow/mcp/analyze'))).toBe(false);
    expect(find.outputSchema.required).toContain('terminal');
    const submitted = await send('analyze', 'tools/call', { name: 'analyze', arguments: { instruction: 'Find cars', files, wait_seconds: 0, idempotency_key: 'same-command' } });
    expect(submitted.body.result.isError).not.toBe(true);
    expect(submitted.body.result.structuredContent).toMatchObject({ analysis_id: 'batch', status: 'processing', terminal: false });
    const create = calls.find(call => call.path.endsWith('/workflow/mcp/analyze'))!;
    expect(JSON.parse(create.init!.body as string)).toEqual({ instruction: 'Find cars', files, wait_seconds: 0, idempotency_key:'same-command' });
    expect(create.init!.headers).toMatchObject({ 'Idempotency-Key': 'same-command' });
    const status = await send('status', 'tools/call', { name: 'get_analysis', arguments: { analysis_id: 'batch', wait_seconds: 0 } });
    expect(status.body.result.isError).not.toBe(true);
    expect(status.body.result.structuredContent).toMatchObject({ analysis_id: 'batch', status: 'completed', terminal: true });
    expect(calls.filter(call => call.path.endsWith('/workflow/mcp/analyze'))).toHaveLength(1);
  });
});
