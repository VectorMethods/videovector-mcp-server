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
  it('initializes, lists the eight-file contract, submits a batch and reads its status', async () => {
    const analysis = { analysis_id: 'batch', status: 'completed', stage: 'completed', message: 'Done', scope: { type: 'playground' }, progress: { total: 8, imported: 8, completed: 8, failed: 0 }, results: { revision: 'r1', included_videos: 8, final: true, download_url: null, expires_in_seconds: null }, next_action: { type: 'download_and_answer' } };
    const files = Array.from({ length: 8 }, (_, index) => ({ file_id: `host-${index}`, download_url: `https://files.example/${index}` }));
    const calls: { path: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, init });
      if (path.endsWith('/auth/validate')) return new Response(null, { status: 204 });
      if (path.endsWith('/auth/processing-activity')) return new Response('{"accepted":true}', { status: 200 });
      if (path.endsWith('/workflow/mcp/analyze')) return new Response(JSON.stringify(response({ ...analysis, status: 'processing', stage: 'importing', next_action: { type: 'continue_polling', after_seconds: 15 } })), { status: 202 });
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
    const listed = await send('list', 'tools/list', {});
    const find = listed.body.result.tools.find((tool: any) => tool.name === 'analyze');
    expect(find.inputSchema.properties.files.maxItems).toBe(8);
    const submitted = await send('analyze', 'tools/call', { name: 'analyze', arguments: { instruction: 'Find cars', files, wait_seconds: 0, idempotency_key: 'same-command' } });
    expect(submitted.body.result.isError).not.toBe(true);
    expect(submitted.body.result.structuredContent).toMatchObject({ analysis_id: 'batch', status: 'processing' });
    const create = calls.find(call => call.path.endsWith('/workflow/mcp/analyze'))!;
    expect(JSON.parse(create.init!.body as string)).toEqual({ instruction: 'Find cars', files, wait_seconds: 0, idempotency_key:'same-command' });
    expect(create.init!.headers).toMatchObject({ 'Idempotency-Key': 'same-command' });
    const status = await send('status', 'tools/call', { name: 'get_analysis', arguments: { analysis_id: 'batch', wait_seconds: 0 } });
    expect(status.body.result.isError).not.toBe(true);
    expect(status.body.result.structuredContent).toMatchObject({ analysis_id: 'batch', status: 'completed' });
    expect(calls.filter(call => call.path.endsWith('/workflow/mcp/analyze'))).toHaveLength(1);
  });
});
