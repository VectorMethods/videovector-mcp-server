import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp, type HttpConfig } from '../src/index.js';

const config: HttpConfig = {
  baseUrl: 'https://api.example.test/api/v2', timeout: 30_000, maxRetries: 0,
  mode: 'http', port: 0, host: '127.0.0.1', allowedHosts: [], allowedOrigins: [],
  enableJsonResponse: true, shutdownDrainTimeoutMs: 25_000,
  oauthEnabled: false, oauthMetadataEnabled: false, oauthIssuer: '', oauthJwksUrl: '',
  oauthResource: '', oauthClockSkewSeconds: 60,
};
const apiKey = `sk_live_${'a'.repeat(48)}`;
const analysis = {
  analysis_id: 'analysis-fixture', status: 'processing', stage: 'processing', message: 'One video is ready.',
  scope: { type: 'index', index_id: 'index-fixture' },
  progress: { total: 2, imported: 2, completed: 1, failed: 0, partial: 0, processing: 1 },
  results: { revision: 'revision-fixture', included_videos: 1, final: false, download_url: null,
    expires_in_seconds: null, videos: [{ video_id: 'video-fixture', name: 'Fixture' }] },
  next_action: { type: 'continue_polling', after_seconds: 5 },
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Studio private progress over raw MCP HTTP', () => {
  it('reads import progress through the dedicated no-grant GET adapter', async () => {
    const upstream: URL[] = [];
    const imported = { import_id: 'imp-fixture', status: 'importing', stage: 'importing', scope: { type: 'index', index_id: 'index-fixture' },
      progress: { imported: 1, parts_completed: 1 }, results: { final: false }, files: { items: [{ file_name: 'Fixture.mp4', status: 'importing' }] } };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/workflow/mcp/imports/')) {
        upstream.push(url);
        expect(init?.method).toBe('GET');
        return Response.json(imported);
      }
      return new Response(null, { status: 204 });
    }));
    const { app } = createHttpApp(config);
    const result = await request(app as any).post('/mcp').set('X-API-Key', apiKey).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 'import-read', method: 'tools/call', params: { name: 'read_analysis', arguments: { import_id: 'imp-fixture' } } });
    expect(result.body.result).toEqual({ content: [{ type: 'text', text: 'Import updated in Studio.' }], _meta: { import: imported } });
    expect(upstream.map(url => url.pathname)).toEqual(['/api/v2/workflow/mcp/imports/imp-fixture']);
    expect(upstream[0].search).toBe('');
  });
  it('reads summary and full selected-video pages with no grant or session, while exposing only six model tools', async () => {
    const upstream: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (!url.pathname.includes('/workflow/analyses/')) return new Response(null, { status: 204 });
      upstream.push(url);
      const payload = structuredClone(analysis) as any;
      if (url.searchParams.get('detail') === 'full') {
        payload.results.data = [{ video_id: 'video-fixture', name: 'Fixture', media_type: 'video',
          selection: { status: 'not_applicable' }, segments: [{ segment_id: 'segment-fixture', start_time: 0, end_time: 5, metadata: { scene: 'Ready' } }] }];
        payload.results.pagination = { has_more: false, next_cursor: null };
      }
      return Response.json(payload);
    }));
    const { app } = createHttpApp(config);
    const send = (id: string, method: string, params: Record<string, unknown>) => request(app as any)
      .post('/mcp').set('X-API-Key', apiKey).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id, method, params });

    const listing = await send('list-fixture', 'tools/list', {});
    expect(listing.status).toBe(200);
    expect(listing.body.result.tools.filter((tool: any) => !tool._meta?.ui?.visibility?.includes('app')).map((tool: any) => tool.name))
      .toEqual(['analyze', 'get_analysis', 'search', 'import_media', 'save_prompt', 'browse']);
    expect(listing.body.result.tools.find((tool: any) => tool.name === 'read_analysis')._meta.ui.visibility).toEqual(['app']);
    for (const argumentsValue of [
      { analysis_id: 'analysis-fixture' },
      { analysis_id: 'analysis-fixture', video_id: 'video-fixture', detail: 'full' },
    ]) {
      const response = await send(`read-${argumentsValue.detail ?? 'summary'}`, 'tools/call', { name: 'read_analysis', arguments: argumentsValue });
      expect(response.status).toBe(200);
      expect(response.headers['mcp-session-id']).toBeUndefined();
      expect(response.body.result.isError).not.toBe(true);
      expect(response.body.result.structuredContent).toBeUndefined();
      expect(response.body.result.content).toEqual([{ type: 'text', text: 'Analysis updated in Studio.' }]);
      expect(response.body.result._meta.analysis).toMatchObject(analysis);
      if (argumentsValue.detail === 'full') expect(response.body.result._meta.analysis.results.data[0].segments).toHaveLength(1);
      else expect(response.body.result._meta.analysis.results.data).toBeUndefined();
    }
    expect(upstream).toHaveLength(2);
    expect(upstream.map(url => url.searchParams.get('include_download'))).toEqual(['false', 'false']);
    expect(upstream.map(url => url.searchParams.get('detail'))).toEqual(['summary', 'full']);
    expect(upstream[1]!.searchParams.get('video_id')).toBe('video-fixture');
  });
});
