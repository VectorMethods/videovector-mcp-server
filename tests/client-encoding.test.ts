import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoVectorClient } from '../src/client/index.js';
import { PACKAGE_VERSION } from '../src/version.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VideoVectorClient request encoding', () => {
  it('encodes export index requests as JSON bodies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ export_id: 'exp_1', status: 'processing' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.exportIndexMetadata('idx_1', {
      prompt_run_ids: ['run_1', 'run_2'],
      destination_connector_id: 'conn_1',
      destination_subpath: 'daily/',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/api/v2/exports/index/idx_1');
    expect(parsed.searchParams.toString()).toBe('');
    expect(JSON.parse(String(init.body))).toEqual({
      prompt_run_ids: ['run_1', 'run_2'],
      destination_connector_id: 'conn_1',
      destination_subpath: 'daily/',
    });
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('sk_test_abc');
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(
      `videovector-mcp/${PACKAGE_VERSION}`
    );
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^export-index-create:/);
  });

  it('omits empty export bodies so idempotency matches the bare HTTP route', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ export_id: 'exp_1', status: 'processing' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.exportPromptRun('run_1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/api/v2/exports/prompt-run/run_1');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^export-prompt-run-create:/);
  });

  it('filters undefined and empty export optionals before deciding whether to send a body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ export_id: 'exp_1', status: 'processing' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.exportIndexMetadata('idx_1', {
      prompt_run_ids: [],
      destination_connector_id: undefined,
      destination_subpath: '',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('encodes webhook delivery status and limit query params', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.listWebhookDeliveries('wh_1', { status: 'processing', limit: 25 });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/api/v2/webhooks/wh_1/deliveries');
    expect(parsed.searchParams.get('status')).toBe('processing');
    expect(parsed.searchParams.get('limit')).toBe('25');
  });

  it('encodes GCS connector import_mode in multipart form data', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ connector_id: 'conn_1', import_mode: 'new_only' }), {
          status: 200,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.createGCSConnector(
      {
        name: 'Archive',
        bucket: 'bucket-a',
        gcp_project_id: 'proj_1',
        credentials_json: {
          type: 'service_account',
          project_id: 'proj_1',
        },
        scopes: ['import', 'export'],
        export_base_path: 'exports/',
        import_mode: 'new_only',
      },
      'gcs-key-1'
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    const formData = init.body as FormData;

    expect(parsed.pathname).toBe('/api/v2/connectors/gcs');
    expect(formData.get('name')).toBe('Archive');
    expect(formData.get('import_mode')).toBe('new_only');
    expect(formData.getAll('scopes')).toEqual(['import', 'export']);
    expect(formData.get('export_base_path')).toBe('exports/');
    expect(formData.get('credentials_file')).toBeInstanceOf(Blob);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('gcs-key-1');
  });

  it('omits empty export_base_path from JSON connector creation bodies', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ connector_id: 'conn_1', import_mode: 'all' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.createS3Connector({
      name: 'Archive',
      bucket: 'bucket-a',
      region: 'us-east-1',
      aws_access_key_id: 'key',
      aws_secret_access_key: 'secret',
      import_mode: 'all',
      export_base_path: '',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'Archive',
      bucket: 'bucket-a',
      region: 'us-east-1',
      aws_access_key_id: 'key',
      aws_secret_access_key: 'secret',
      import_mode: 'all',
    });
  });

  it('adds idempotency headers to prompt execution and segment retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ run_id: 'run_1', status: 'pending' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.executePrompt({
      prompt_id: 'prompt_1',
      target: { type: 'index', index_id: 'idx_1' },
    });

    const executeHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(executeHeaders['Idempotency-Key']).toMatch(/^prompt-run-execute:/);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ retry_id: 'retry_1', status: 'pending' }), { status: 200 })
    );

    await client.retryPromptRunSegment('run_1', 'vid_1', 'seg_1');
    const retryHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(retryHeaders['Idempotency-Key']).toMatch(/^prompt-run-segment-retry:/);
  });

  it('preserves explicit idempotency keys for write operations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ run_id: 'run_1', status: 'pending' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.executePrompt(
      {
        prompt_id: 'prompt_1',
        target: { type: 'index', index_id: 'idx_1' },
      },
      'exec-key-1'
    );

    const executeHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(executeHeaders['Idempotency-Key']).toBe('exec-key-1');

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ prompt_id: 'prompt_1', name: 'Prompt Updated' }), { status: 200 })
    );

    await client.updatePrompt('prompt_1', { name: 'Prompt Updated' }, 'prompt-update-1');
    const updateHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(updateHeaders['Idempotency-Key']).toBe('prompt-update-1');
  });

  it('adds idempotency headers to prompt-run cancellation, import-job cancellation and webhook writes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ run_id: 'run_1', status: 'cancelled' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.cancelPromptRun('run_1');
    const cancelHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(cancelHeaders['Idempotency-Key']).toMatch(/^prompt-run-cancel:/);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ job_id: 'job_1', status: 'cancelled' }), { status: 200 })
    );

    await client.cancelImportJob('job_1');
    const importCancelHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(importCancelHeaders['Idempotency-Key']).toMatch(/^import-job-cancel:/);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ webhook_id: 'wh_1', name: 'Updated' }), { status: 200 })
    );
    await client.updateWebhook('wh_1', { name: 'Updated' }, 'webhook-update-1');
    const updateHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>;
    expect(updateHeaders['Idempotency-Key']).toBe('webhook-update-1');

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, status_code: 200, error: null }), { status: 200 })
    );
    await client.testWebhook('wh_1');
    const testHeaders = fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string>;
    expect(testHeaders['Idempotency-Key']).toMatch(/^webhook-test:/);
  });

  it('does not retry multipart connector creation after a transport failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 3,
    });

    await expect(
      client.createGCSConnector({
        name: 'Archive',
        bucket: 'bucket-a',
        gcp_project_id: 'proj_1',
        credentials_json: { type: 'service_account', project_id: 'proj_1' },
      })
    ).rejects.toMatchObject({ code: 'network_error' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry multipart connector creation after a retryable server response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail: 'temporary outage' }), { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 3,
    });

    await expect(
      client.createGCSConnector({
        name: 'Archive',
        bucket: 'bucket-a',
        gcp_project_id: 'proj_1',
        credentials_json: { type: 'service_account', project_id: 'proj_1' },
      })
    ).rejects.toMatchObject({ code: 'http_503', statusCode: 503 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry cost-bearing POST requests after a retryable server response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'temporary outage' }), {
        status: 503,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 3,
    });

    await expect(
      client.searchVideos('idx_1', { query: 'find the moment' })
    ).rejects.toMatchObject({ code: 'http_503', statusCode: 503 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a cost-bearing POST after an ambiguous network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 3,
    });

    await expect(
      client.searchVideos('idx_1', { query: 'find the moment' })
    ).rejects.toMatchObject({ code: 'network_error' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries idempotent writes with the same stable idempotency key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: 'temporary outage' }), {
          status: 503,
          headers: { 'Retry-After': '0' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ index_id: 'idx_1', name: 'Archive' }), {
          status: 200,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 1,
    });

    await expect(client.createIndex({ name: 'Archive' }, 'index-create-1')).resolves.toMatchObject({
      index_id: 'idx_1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(firstHeaders['Idempotency-Key']).toBe('index-create-1');
    expect(secondHeaders['Idempotency-Key']).toBe('index-create-1');
  });

  it('applies client-side limit when listing prompt runs for a video', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify([
            { run_id: 'run_1' },
            { run_id: 'run_2' },
            { run_id: 'run_3' },
          ]),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    const runs = await client.listPromptRuns({ videoId: 'vid_1', limit: 2 });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/api/v2/videos/vid_1/prompt-runs');
    expect(parsed.searchParams.get('limit')).toBe('2');
    expect(Array.isArray(runs)).toBe(true);
    expect((runs as Array<{ run_id: string }>).map((run) => run.run_id)).toEqual([
      'run_1',
      'run_2',
      'run_3',
    ]);
  });

  it('omits limit for unbounded video-scoped prompt-run requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ run_id: 'run_1' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.listPromptRuns({ videoId: 'vid_1' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/api/v2/videos/vid_1/prompt-runs');
    expect(parsed.searchParams.toString()).toBe('');
  });

  it('defaults user-scoped prompt-run listings to the backend 200-run limit', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ run_id: 'run_1' }]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await client.listPromptRuns();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);

    expect(parsed.pathname).toBe('/api/v2/prompt-runs');
    expect(parsed.searchParams.get('limit')).toBe('200');
  });
});
