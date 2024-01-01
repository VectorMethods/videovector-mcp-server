import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoVectorClient } from '../src/client/index.js';
import { executeTool, getToolDefinitions, getToolRequiredScope } from '../src/tools/index.js';

const exportId = 'export-1';
const size = 4096;
const apiOrigin = 'https://api.example.test';
const args = { source_kind: 'prompt_run', source_id: 'run-1', scope: 'all', export_id: exportId };

function job(overrides: Record<string, unknown> = {}) {
  return {
    export_id: exportId, export_type: 'prompt_run', target_id: 'run-1', status: 'completed',
    queue_status: 'succeeded', attempts: 1, max_attempts: 3,
    created_at: '2026-09-25T00:00:00Z', available_at: null, started_at: null, completed_at: null, updated_at: null,
    download_url: `/api/v2/exports/${exportId}/download`, file_size_bytes: size,
    error_message: null, last_error: null, destination_type: 'download', destination_connector_id: null,
    destination_base_path: null, destination_subpath: null, destination_uri: null,
    gcs_uri: 'gs://private-exports/exports/owner/result.json', export_params: { result_scope: 'all' },
    ...overrides,
  };
}

function grantUrl() {
  return `${apiOrigin}/api/v2/exports/${exportId}/download?token=v1.${'a'.repeat(64)}.${'s'.repeat(43)}`;
}

function mintResponse(url: string | null) {
  return { export_id: exportId, status: 'completed', destination_type: 'download', destination_connector_id: null, download_url: url };
}

function oauthClient() {
  return new VideoVectorClient({
    baseUrl: `${apiOrigin}/api/v2`, maxRetries: 0,
    credential: { kind: 'oauth', accessToken: 'test-only-oauth', issuer: 'https://issuer.example', subject: 'test-subject', resource: apiOrigin },
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('private workflow artifact downloads', () => {
  it('publishes only an app-visible read-scope helper', () => {
    expect(getToolDefinitions('full', false).some(tool => tool.name === 'download_workflow_artifact')).toBe(false);
    const tool = getToolDefinitions('full', false, { includeAppTools: true, advertiseOAuth: true }).find(tool => tool.name === 'download_workflow_artifact')!;
    expect(tool._meta).toMatchObject({ ui: { visibility: ['app'] }, 'openai/visibility': 'private', securitySchemes: [{ type: 'oauth2', scopes: [] }] });
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: false });
    expect(getToolRequiredScope(tool.name)).toBe('read');
    expect(tool.inputSchema.required).toEqual(['source_kind', 'source_id', 'scope', 'export_id']);
  });

  it.each([
    ['prompt_run', 'run-1', 'all', 'full-results.json'],
    ['prompt_run', 'run-1', 'matches', 'matching-results.json'],
    ['search_snapshot', 'snapshot-1', 'search_results', 'search-results.json'],
  ])('privately grants the existing %s %s %s artifact without fetching file contents', async (kind, sourceId, scope, filename) => {
    const url = grantUrl();
    const payload = job({ export_type: kind, target_id: sourceId, export_params: { result_scope: scope === 'matches' ? 'matches' : 'all' } });
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
      init.method === 'POST' ? mintResponse(url) : payload
    ), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await executeTool('download_workflow_artifact', { source_kind: kind, source_id: sourceId, scope, export_id: exportId }, oauthClient(), { authenticationKind: 'oauth' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result._meta?.artifact).toMatchObject({ url, name: filename, mimeType: 'application/json', sizeBytes: size });
    expect(JSON.stringify(result.content)).not.toMatch(/token=|gs:\/\/|test-only-oauth|4096/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([requestUrl, init]) => [new URL(requestUrl).pathname, init.method])).toEqual([
      [`/api/v2/exports/${exportId}`, 'GET'], [`/api/v2/exports/${exportId}/download-url`, 'POST'],
    ]);
    for (const [, init] of fetchMock.mock.calls) expect(init.headers.Authorization).toBe('Bearer test-only-oauth');
  });

  it.each([
    ['different export', { export_id: 'another-export' }],
    ['different source', { target_id: 'another-run' }],
    ['different source kind', { export_type: 'index' }],
    ['different scope', { export_params: { result_scope: 'matches' } }],
    ['pending export', { status: 'pending', download_url: null }],
    ['connector destination', { destination_type: 'connector', download_url: null }],
    ['missing artifact', { download_url: null }],
    ['missing size', { file_size_bytes: null }],
    ['empty artifact', { file_size_bytes: 0 }],
  ])('does not mint for %s', async (_label, overrides) => {
    const backend = { getExportStatus: vi.fn().mockResolvedValue(job(overrides)), mintExportDownloadUrl: vi.fn() } as unknown as VideoVectorClient;
    const result = await executeTool('download_workflow_artifact', args, backend, { authenticationKind: 'oauth' });
    expect(result.isError).toBe(true);
    expect(result._meta).toBeUndefined();
    expect(backend.mintExportDownloadUrl).not.toHaveBeenCalled();
  });

  it.each([
    { ...args, scope: 'search_results' },
    { ...args, source_kind: 'search_snapshot' },
    { ...args, source_kind: 'index' },
    { ...args, url: 'https://untrusted.example' },
  ])('rejects invalid source/scope inputs before any API call', async request => {
    const backend = { getExportStatus: vi.fn(), mintExportDownloadUrl: vi.fn() } as unknown as VideoVectorClient;
    const result = await executeTool('download_workflow_artifact', request, backend);
    expect(result.isError).toBe(true);
    expect(backend.getExportStatus).not.toHaveBeenCalled();
    expect(backend.mintExportDownloadUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['untrusted endpoint', grantUrl().replace(apiOrigin, 'https://untrusted.example')],
    ['unavailable download', null],
  ])('rejects %s grants without reflecting capability material', async (_label, url) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_requestUrl: string, init: RequestInit) => new Response(JSON.stringify(
      init.method === 'POST' ? mintResponse(url) : job()
    ), { status: 200 })));
    const result = await executeTool('download_workflow_artifact', args, oauthClient(), { authenticationKind: 'oauth' });
    expect(result.isError).toBe(true);
    expect(result._meta).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/token=|test-only-oauth/);
  });
});
