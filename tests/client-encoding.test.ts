import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoVectorClient } from '../src/client/index.js';
import { executeTool } from '../src/tools/index.js';
import { PACKAGE_VERSION } from '../src/version.js';

const VALID_EXPORT_TOKEN = `v1.${'a'.repeat(64)}.${'b'.repeat(43)}`;

function exportStatusPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    export_id: 'exp_1',
    export_type: 'index',
    target_id: 'idx_1',
    created_at: '2026-07-17T00:00:00Z',
    status: 'completed',
    queue_status: 'succeeded',
    attempts: 1,
    max_attempts: 3,
    available_at: '2026-07-17T00:00:00Z',
    started_at: '2026-07-17T00:00:01Z',
    completed_at: '2026-07-17T00:00:02Z',
    updated_at: '2026-07-17T00:00:02Z',
    download_url: '/api/v2/exports/exp_1/download',
    file_size_bytes: 1024,
    error_message: null,
    last_error: null,
    destination_type: 'download',
    destination_connector_id: null,
    destination_base_path: null,
    destination_subpath: null,
    destination_uri: null,
    gcs_uri: 'gs://private-exports/exports/exp_1.json',
    export_params: {},
    ...overrides,
  };
}

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

  it('mints export bearer URLs through the explicit authenticated endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            export_id: 'exp/1',
            status: 'completed',
            destination_type: 'download',
            destination_connector_id: null,
            download_url:
              `https://example.com/api/v2/exports/exp%2F1/download?token=${VALID_EXPORT_TOKEN}`,
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 3,
    });

    const result = await client.mintExportDownloadUrl('exp/1');

    expect(result.download_url).toContain('?token=');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v2/exports/exp%2F1/download-url');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('sk_test_abc');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });

  it('does not retry export bearer minting after a server failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'metadata_export_token_configuration_invalid',
            message: 'Export download token admission is unavailable',
          },
        }),
        { status: 503 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 3,
    });

    await expect(client.mintExportDownloadUrl('exp_1')).rejects.toMatchObject({
      code: 'metadata_export_token_configuration_invalid',
      statusCode: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed export bearer mint responses', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            export_id: 'exp_1',
            status: 'completed',
            destination_type: 'download',
            destination_connector_id: null,
            download_url: '   ',
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 3,
    });

    await expect(client.mintExportDownloadUrl('exp_1')).rejects.toMatchObject({
      code: 'invalid_export_download_url_response',
      statusCode: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts only the canonical authenticated relative route in export status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(
          exportStatusPayload({
            export_id: 'exp/1',
            download_url: '/api/v2/exports/exp%2F1/download',
          })
        ),
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

    await expect(client.getExportStatus('exp/1')).resolves.toMatchObject({
      export_id: 'exp/1',
      download_url: '/api/v2/exports/exp%2F1/download',
    });
  });

  it.each([
    [
      'processing direct export',
      exportStatusPayload({
        status: 'processing',
        queue_status: 'running',
        completed_at: null,
        download_url: null,
        file_size_bytes: null,
        gcs_uri: null,
      }),
    ],
    [
      'completed connector export',
      exportStatusPayload({
        destination_type: 'connector',
        destination_connector_id: 'conn_1',
        download_url: null,
        destination_uri: 's3://customer-bucket/export.json',
        gcs_uri: 's3://customer-bucket/export.json',
        export_params: {
          destination_connector_id: 'conn_1',
          destination_base_path: 'exports/',
          destination_subpath: 'daily/',
        },
        destination_base_path: 'exports/',
        destination_subpath: 'daily/',
      }),
    ],
  ])('accepts a complete %s status contract', async (_label, payload) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    await expect(client.getExportStatus('exp_1')).resolves.toMatchObject({
      export_id: 'exp_1',
      status: payload.status,
      destination_type: payload.destination_type,
      download_url: null,
    });
  });

  it.each([
    [
      'a bearer URL in status',
      {
        download_url:
          `https://example.com/api/v2/exports/exp_1/download?token=${VALID_EXPORT_TOKEN}`,
      },
    ],
    ['a query on the authenticated route', { download_url: '/api/v2/exports/exp_1/download?x=1' }],
    ['a fragment on the authenticated route', { download_url: '/api/v2/exports/exp_1/download#x' }],
    ['a cross-export route', { download_url: '/api/v2/exports/exp_2/download' }],
    ['a non-durable queue state', { queue_status: 'running' }],
    ['an unknown queue state', { queue_status: 'complete' }],
    ['a status bearer before completion', { status: 'processing' }],
    [
      'a connector-delivered status URL',
      { destination_type: 'connector', destination_connector_id: 'conn_1' },
    ],
    ['a connector id on a direct export', { destination_connector_id: 'conn_1' }],
    [
      'a missing connector id',
      { destination_type: 'connector', destination_connector_id: null, download_url: null },
    ],
    [
      'a mismatched response export id',
      { export_id: 'response-derived-secret-id', download_url: null },
    ],
    ['a malformed timestamp', { updated_at: 'response-derived-secret-timestamp' }],
    ['a negative attempt count', { attempts: -1 }],
    ['a nonintegral file size', { file_size_bytes: 1.5 }],
    ['a direct destination URI', { destination_uri: 'gs://other-bucket/export.json' }],
    ['a missing direct artifact', { gcs_uri: null }],
    ['an unknown export type', { export_type: 'response-derived-secret-type' }],
    ['an empty target id', { target_id: '' }],
    ['a nonobject export_params', { export_params: ['response-derived-secret-param'] }],
    [
      'an internal export_params field',
      { export_params: { billing_account_id: 'response-derived-secret-account' } },
    ],
    [
      'a mismatched connector in export_params',
      {
        destination_type: 'connector',
        destination_connector_id: 'conn_1',
        download_url: null,
        destination_uri: 's3://customer-bucket/export.json',
        gcs_uri: 's3://customer-bucket/export.json',
        export_params: { destination_connector_id: 'conn_2' },
      },
    ],
    [
      'a connector destination URI mismatch',
      {
        destination_type: 'connector',
        destination_connector_id: 'conn_1',
        download_url: null,
        destination_uri: 's3://customer-bucket/one.json',
        gcs_uri: 's3://customer-bucket/two.json',
      },
    ],
  ])('rejects %s without echoing the response', async (_label, overrides) => {
    const secretMarker = 'do-not-echo-status-response';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify(
          exportStatusPayload({
            ...overrides,
            error_message: secretMarker,
          })
        ),
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

    try {
      await client.getExportStatus('exp_1');
      throw new Error('expected status validation to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_export_status_response',
        statusCode: 502,
      });
      expect(String(error)).not.toContain(secretMarker);
      expect(String(error)).not.toContain('response-derived-secret');
      expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it.each([
    ['non-HTTPS URL', `http://example.com/api/v2/exports/exp_1/download?token=${VALID_EXPORT_TOKEN}`],
    ['foreign origin', `https://evil.example/api/v2/exports/exp_1/download?token=${VALID_EXPORT_TOKEN}`],
    ['lookalike origin', `https://example.com.evil.test/api/v2/exports/exp_1/download?token=${VALID_EXPORT_TOKEN}`],
    ['userinfo', `https://user:pass@example.com/api/v2/exports/exp_1/download?token=${VALID_EXPORT_TOKEN}`],
    ['wrong export', `https://example.com/api/v2/exports/exp_2/download?token=${VALID_EXPORT_TOKEN}`],
    ['trailing slash', `https://example.com/api/v2/exports/exp_1/download/?token=${VALID_EXPORT_TOKEN}`],
    ['fragment', `https://example.com/api/v2/exports/exp_1/download?token=${VALID_EXPORT_TOKEN}#fragment`],
    ['extra query', `https://example.com/api/v2/exports/exp_1/download?token=${VALID_EXPORT_TOKEN}&next=x`],
    ['duplicate token', `https://example.com/api/v2/exports/exp_1/download?token=${VALID_EXPORT_TOKEN}&token=${VALID_EXPORT_TOKEN}`],
    ['short token', 'https://example.com/api/v2/exports/exp_1/download?token=short'],
    [
      'an unversioned token',
      `https://example.com/api/v2/exports/exp_1/download?token=${'a'.repeat(64)}`,
    ],
    [
      'the wrong token version',
      `https://example.com/api/v2/exports/exp_1/download?token=v2.${'a'.repeat(64)}.${'b'.repeat(43)}`,
    ],
    [
      'an invalid token character',
      `https://example.com/api/v2/exports/exp_1/download?token=${encodeURIComponent(
        `v1.${'a'.repeat(63)}+.${'b'.repeat(43)}`
      )}`,
    ],
    [
      'oversized token',
      `https://example.com/api/v2/exports/exp_1/download?token=${'a'.repeat(2049)}`,
    ],
  ])('rejects a minted URL with %s', async (_label, downloadUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          export_id: 'exp_1',
          status: 'completed',
          destination_type: 'download',
          destination_connector_id: null,
          download_url: downloadUrl,
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 3,
    });

    await expect(client.mintExportDownloadUrl('exp_1')).rejects.toMatchObject({
      code: 'invalid_export_download_url_response',
      statusCode: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects extra capability response fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          export_id: 'exp_1',
          status: 'completed',
          destination_type: 'download',
          destination_connector_id: null,
          download_url:
            `https://example.com/api/v2/exports/exp_1/download?token=${VALID_EXPORT_TOKEN}`,
          unexpected: 'must-not-cross-the-contract',
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 3,
    });

    await expect(client.mintExportDownloadUrl('exp_1')).rejects.toMatchObject({
      code: 'invalid_export_download_url_response',
      statusCode: 502,
    });
  });

  it.each([
    [
      'successful malformed JSON',
      new Response(
        `{"download_url":"https://example.com/download?token=${VALID_EXPORT_TOKEN}"`,
        { status: 200 }
      ),
      'invalid_json_response',
    ],
    [
      'error malformed JSON',
      new Response(
        `{"error":{"message":"https://example.com/download?token=${VALID_EXPORT_TOKEN}"`,
        { status: 502, statusText: `secret-${VALID_EXPORT_TOKEN}` }
      ),
      'http_502',
    ],
    [
      'noncanonical error JSON',
      new Response(JSON.stringify({ credential: VALID_EXPORT_TOKEN }), { status: 400 }),
      'http_400',
    ],
  ])('keeps %s credential-safe in MCP error output', async (_label, response, code) => {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      timeout: 1000,
      maxRetries: 0,
    });

    const result = await executeTool(
      'get_export_download_url',
      { export_id: 'exp_1' },
      client
    );
    const output = result.content[0]?.text ?? '';
    const payload = JSON.parse(output) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(payload.code).toBe(code);
    expect(output).not.toContain(VALID_EXPORT_TOKEN);
    expect(output).not.toContain('Unexpected');
    expect(output).not.toContain('secret-');
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
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^connector-create-gcs:/);
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
