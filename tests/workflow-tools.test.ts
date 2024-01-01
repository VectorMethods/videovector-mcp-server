import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoVectorClient } from '../src/client/index.js';
import {
  authorizeUploadFile,
  executeTool,
  getToolAvailability,
  getToolDefinitions,
  getToolRequiredScope,
} from '../src/tools/index.js';

function parseContent(result: Awaited<ReturnType<typeof executeTool>>): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('simplified workflow tool surface', () => {
  it('encodes JSON workflow calls on canonical paths with durable identities', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      maxRetries: 0,
    });

    await client.workflowDefinePrompt({ instruction: 'Find logos', save: true });
    await client.workflowProcessMedia({ prompt_id: 'prompt_1' }, 'process-1');
    await client.workflowSearchMedia({ query: 'red car', limit: 10 }, 'search-1');
    await client.workflowSearchPage('cursor/value');

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v2/workflow/define',
      '/api/v2/workflow/process',
      '/api/v2/workflow/search',
      '/api/v2/workflow/search/page',
    ]);
    expect((calls[0]?.[1].headers as Record<string, string>)['Idempotency-Key']).toMatch(
      /^workflow-define:/
    );
    expect((calls[1]?.[1].headers as Record<string, string>)['Idempotency-Key']).toBe('process-1');
    expect((calls[2]?.[1].headers as Record<string, string>)['Idempotency-Key']).toBe('search-1');
    expect((calls[3]?.[1].headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
    expect(new URL(calls[3]?.[0] ?? '').searchParams.get('cursor')).toBe('cursor/value');
  });

  it('retries workflow response-loss failures with one stable idempotency key', async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => {
            throw new TypeError('terminated');
          },
        } as Response;
      }
      if (attempt === 2) {
        return new Response('', { status: 200 });
      }
      if (attempt === 3) {
        return new Response('{malformed', { status: 200 });
      }
      if (attempt === 4) {
        return {
          ok: true,
          status: 200,
          text: () => new Promise<string>((_resolve, reject) => {
            const abort = () => {
              const error = new Error('aborted while reading the response');
              error.name = 'AbortError';
              reject(error);
            };
            if (init.signal?.aborted) {
              abort();
            } else {
              init.signal?.addEventListener('abort', abort, { once: true });
            }
          }),
        } as Response;
      }
      return new Response(
        JSON.stringify({ prompt_id: 'prompt_1', saved: true }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      maxRetries: 4,
      timeout: 5,
    });
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);

    await expect(
      client.workflowDefinePrompt({ instruction: 'Find logos', save: true })
    ).resolves.toMatchObject({ prompt_id: 'prompt_1' });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const keys = fetchMock.mock.calls.map(
      ([, init]) => (init.headers as Record<string, string>)['Idempotency-Key']
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^workflow-define:/);
  });

  it('keeps full as the compatibility profile and exposes four focused simple tools', () => {
    const fullNames = getToolDefinitions('full', true).map((tool) => tool.name);
    const simpleNames = getToolDefinitions('simple', true).map((tool) => tool.name);
    const hostedSimpleNames = getToolDefinitions('simple', false).map((tool) => tool.name);

    expect(fullNames).toHaveLength(52);
    expect(fullNames).toContain('search_videos');
    expect(simpleNames).toEqual([
      'upload_media',
      'define_prompt',
      'process_media',
      'search_media',
    ]);
    expect(hostedSimpleNames).toEqual([
      'define_prompt',
      'process_media',
      'search_media',
    ]);
    expect(getToolAvailability('upload_media')).toEqual({
      profiles: ['simple', 'full'],
      transports: ['stdio'],
    });
    expect(getToolAvailability('define_prompt')).toEqual({
      profiles: ['simple', 'full'],
      transports: ['stdio', 'streamable-http'],
    });
    expect(getToolRequiredScope('upload_media')).toBe('write');
    expect(getToolRequiredScope('define_prompt')).toBe('write');
    expect(getToolRequiredScope('process_media')).toBe('write');
    expect(getToolRequiredScope('search_media')).toBe('search');
    expect(getToolDefinitions('simple', true).find(
      (tool) => tool.name === 'search_media'
    )?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
  });

  it('maps minimal prompt definition and preserves explicit retry identity', async () => {
    const client = {
      workflowDefinePrompt: vi.fn().mockResolvedValue({
        prompt_id: 'prompt_1',
        saved: true,
      }),
    } as unknown as VideoVectorClient;

    const response = await executeTool(
      'define_prompt',
      {
        instruction: 'Find logos and sentiment',
        idempotency_key: 'define-1',
      },
      client
    );

    expect((client as any).workflowDefinePrompt).toHaveBeenCalledWith(
      { instruction: 'Find logos and sentiment', save: true },
      'define-1'
    );
    expect(response.structuredContent).toMatchObject({ prompt_id: 'prompt_1' });
  });

  it('rejects unknown arguments for every standalone workflow tool', async () => {
    const client = {
      workflowUploadMedia: vi.fn(),
      workflowDefinePrompt: vi.fn(),
      workflowProcessMedia: vi.fn(),
      workflowSearchMedia: vi.fn(),
    } as unknown as VideoVectorClient;
    const cases: Array<{
      tool: string;
      args: Record<string, unknown>;
      unknown: string;
    }> = [
      {
        tool: 'upload_media',
        args: { file_path: '/tmp/example.mp4', tilte: 'Example' },
        unknown: 'tilte',
      },
      {
        tool: 'define_prompt',
        args: { instruction: 'Find logos', saved: true },
        unknown: 'saved',
      },
      {
        tool: 'process_media',
        args: { prompt_id: 'prompt_1', advanced_transcripton: true },
        unknown: 'advanced_transcripton',
      },
      {
        tool: 'search_media',
        args: { query: 'red car', video_id: 'video_1' },
        unknown: 'video_id',
      },
    ];

    for (const testCase of cases) {
      const response = await executeTool(
        testCase.tool,
        testCase.args,
        client,
        { transportMode: 'stdio', uploadRoots: ['/tmp'] }
      );
      expect(response.isError).toBe(true);
      expect(String(parseContent(response).message)).toContain('unknown argument');
      expect(String(parseContent(response).message)).toContain(testCase.unknown);
    }

    expect((client as any).workflowUploadMedia).not.toHaveBeenCalled();
    expect((client as any).workflowDefinePrompt).not.toHaveBeenCalled();
    expect((client as any).workflowProcessMedia).not.toHaveBeenCalled();
    expect((client as any).workflowSearchMedia).not.toHaveBeenCalled();
  });

  it('preserves backend and saved prompt defaults when processing settings are omitted', async () => {
    const client = {
      workflowProcessMedia: vi.fn().mockResolvedValue({ run_id: 'run_1' }),
    } as unknown as VideoVectorClient;

    await executeTool(
      'process_media',
      {
        prompt_id: 'prompt_1',
        video_ids: [' video_1 ', 'video_1', 'video_2'],
      },
      client
    );

    expect((client as any).workflowProcessMedia).toHaveBeenCalledWith(
      {
        prompt_id: 'prompt_1',
        video_ids: ['video_1', 'video_2'],
      },
      undefined
    );
  });

  it('leaves omitted fixed duration to the backend default', async () => {
    const client = {
      workflowProcessMedia: vi.fn().mockResolvedValue({ run_id: 'run_2' }),
    } as unknown as VideoVectorClient;

    await executeTool(
      'process_media',
      {
        prompt_instruction: 'Describe the scene',
        segmentation_mode: 'fixed',
        advanced_transcription: true,
        create_image_embeddings: true,
      },
      client
    );

    expect((client as any).workflowProcessMedia).toHaveBeenCalledWith(
      {
        prompt_instruction: 'Describe the scene',
        segmentation_mode: 'fixed',
        advanced_transcription: true,
        create_image_embeddings: true,
      },
      undefined
    );
  });

  it.each(['content_aware', 'fixed'] as const)('forwards explicit %s settings and false toggles', async (mode) => {
    const client = {
      workflowProcessMedia: vi.fn().mockResolvedValue({ run_id: 'run_3' }),
    } as unknown as VideoVectorClient;
    const options = {
      prompt_id: 'prompt_1',
      segmentation_mode: mode,
      ...(mode === 'fixed' ? { fixed_segment_duration_seconds: 15 } : {}),
      advanced_transcription: false,
      create_image_embeddings: false,
    };

    const response = await executeTool('process_media', options, client);

    expect(response.isError).toBeUndefined();
    expect((client as any).workflowProcessMedia).toHaveBeenCalledWith(options, undefined);
  });

  it('rejects retired smart segmentation before making a paid submission', async () => {
    const client = { workflowProcessMedia: vi.fn() } as unknown as VideoVectorClient;
    const response = await executeTool('process_media', {
      prompt_id: 'prompt_1', segmentation_mode: 'smart',
    }, client);

    expect(response.isError).toBe(true);
    expect(String(parseContent(response).message)).toContain('content_aware, fixed');
    expect((client as any).workflowProcessMedia).not.toHaveBeenCalled();
  });

  it('advertises only canonical segmentation without injecting optional execution defaults', () => {
    for (const name of ['process_media', 'estimate_prompt_run', 'execute_prompt']) {
      const definition = getToolDefinitions('full', true).find((tool) => tool.name === name);
      const properties = definition?.inputSchema.properties as Record<string, Record<string, unknown>>;
      const segmentation = properties[name === 'process_media' ? 'segmentation_mode' : 'video_segmentation_type'];
      expect(segmentation.enum).toEqual(expect.arrayContaining(['content_aware', 'fixed']));
      expect(segmentation.enum).not.toContain('smart');
      for (const field of ['segmentation_mode', 'video_segmentation_type', 'audio_segmentation_type',
        'advanced_transcription', 'create_image_embeddings', 'enable_transcription', 'enable_image_embedding']) {
        if (properties[field]) expect(properties[field]).not.toHaveProperty('default');
      }
    }
  });

  it('rejects fixed duration outside fixed mode before calling the API', async () => {
    const client = {
      workflowProcessMedia: vi.fn(),
    } as unknown as VideoVectorClient;

    const response = await executeTool(
      'process_media',
      {
        prompt_id: 'prompt_1',
        segmentation_mode: 'content_aware',
        fixed_segment_duration_seconds: 12,
      },
      client
    );

    expect(response.isError).toBe(true);
    expect(String(parseContent(response).message)).toContain('only valid');
    expect((client as any).workflowProcessMedia).not.toHaveBeenCalled();
  });

  it('starts vector search with Playground defaults and follows cursors with GET semantics', async () => {
    const client = {
      workflowSearchMedia: vi.fn().mockResolvedValue({
        data: [],
        mode: 'vector',
        result_level: 'segment',
        pagination: { next_cursor: 'next-1' },
      }),
      workflowSearchPage: vi.fn().mockResolvedValue({
        data: [],
        mode: 'vector',
        result_level: 'segment',
        pagination: { next_cursor: null },
      }),
    } as unknown as VideoVectorClient;

    await executeTool('search_media', { query: 'red car' }, client);
    await executeTool('search_media', { cursor: 'next-1' }, client);

    expect((client as any).workflowSearchMedia).toHaveBeenCalledWith(
      {
        query: 'red car',
        result_level: 'segment',
        limit: 10,
      },
      undefined
    );
    expect((client as any).workflowSearchPage).toHaveBeenCalledWith('next-1');
  });

  it('maps inferred conditional filters without adding legacy type fields', async () => {
    const client = {
      workflowSearchMedia: vi.fn().mockResolvedValue({
        data: [],
        mode: 'condition',
        result_level: 'video',
        pagination: { next_cursor: null },
      }),
    } as unknown as VideoVectorClient;

    await executeTool(
      'search_media',
      {
        filters: [
          { field: 'brand', value: 'Acme' },
          { field: 'topics', operator: 'is_not_empty' },
        ],
        result_level: 'video',
        video_ids: ['video_1'],
        limit: 25,
      },
      client
    );

    expect((client as any).workflowSearchMedia).toHaveBeenCalledWith(
      {
        filters: [
          { field: 'brand', operator: 'equals', value: 'Acme' },
          { field: 'topics', operator: 'is_not_empty' },
        ],
        result_level: 'video',
        video_ids: ['video_1'],
        limit: 25,
      },
      undefined
    );
  });

  it('rejects unknown conditional-filter fields before calling the API', async () => {
    const client = {
      workflowSearchMedia: vi.fn(),
    } as unknown as VideoVectorClient;

    const response = await executeTool(
      'search_media',
      {
        filters: [
          { field: 'brand', value: 'Acme', value_type: 'string' },
        ],
      },
      client
    );

    expect(response.isError).toBe(true);
    expect(String(parseContent(response).message)).toContain('filters[0]');
    expect(String(parseContent(response).message)).toContain('value_type');
    expect((client as any).workflowSearchMedia).not.toHaveBeenCalled();
  });

  it('rejects mixed search modes and cursor parameters', async () => {
    const client = {
      workflowSearchMedia: vi.fn(),
      workflowSearchPage: vi.fn(),
    } as unknown as VideoVectorClient;

    const hybrid = await executeTool(
      'search_media',
      { query: 'car', filters: [{ field: 'brand', value: 'Acme' }] },
      client
    );
    const cursor = await executeTool(
      'search_media',
      { cursor: 'next', limit: 5 },
      client
    );

    expect(hybrid.isError).toBe(true);
    expect(cursor.isError).toBe(true);
    expect((client as any).workflowSearchMedia).not.toHaveBeenCalled();
    expect((client as any).workflowSearchPage).not.toHaveBeenCalled();
  });

  it('keeps search scope selectors mutually exclusive like the backend facade', async () => {
    const client = {
      workflowSearchMedia: vi.fn(),
    } as unknown as VideoVectorClient;

    const response = await executeTool(
      'search_media',
      { query: 'car', video_ids: ['video_1'], index_id: 'index_1' },
      client
    );

    expect(response.isError).toBe(true);
    expect(String(parseContent(response).message)).toContain('cannot be combined');
    expect((client as any).workflowSearchMedia).not.toHaveBeenCalled();
  });
});

describe('local workflow uploads', () => {
  it('authorizes regular media only inside canonical configured roots', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'videovector-mcp-root-'));
    const outside = await fs.mkdtemp(join(tmpdir(), 'videovector-mcp-outside-'));
    const mediaPath = join(root, 'clip.mp4');
    const outsidePath = join(outside, 'clip.mp4');
    const escapedLink = join(root, 'escaped.mp4');
    await fs.writeFile(mediaPath, Buffer.from('media'));
    await fs.writeFile(outsidePath, Buffer.from('outside'));
    await fs.symlink(outsidePath, escapedLink);

    try {
      await expect(authorizeUploadFile(mediaPath, [root])).resolves.toMatchObject({
        identity: { size: 5 },
      });
      await expect(authorizeUploadFile(outsidePath, [root])).rejects.toThrow(
        'outside the configured upload roots'
      );
      await expect(authorizeUploadFile(escapedLink, [root])).rejects.toThrow(
        'outside the configured upload roots'
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('does not expose local upload through an HTTP execution context', async () => {
    const client = {
      workflowUploadMedia: vi.fn(),
    } as unknown as VideoVectorClient;

    const response = await executeTool(
      'upload_media',
      { file_path: '/tmp/example.mp4' },
      client,
      { transportMode: 'http' }
    );

    expect(response.isError).toBe(true);
    expect(String(parseContent(response).message)).toContain('local stdio');
    expect((client as any).workflowUploadMedia).not.toHaveBeenCalled();
  });

  it('streams multipart uploads and reopens the file on retry without buffering it', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'videovector-mcp-upload-'));
    const mediaPath = join(root, 'sample.mp4');
    await fs.writeFile(mediaPath, Buffer.from('stream-this-media'));
    let attempts = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      attempts += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as any) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      expect(body.toString('utf8')).toContain('stream-this-media');
      expect(Number((init.headers as Record<string, string>)['Content-Length'])).toBe(
        body.length
      );
      if (attempts === 1) {
        return new Response(
          JSON.stringify({ error: { code: 'temporary', message: 'retry' } }),
          { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '0' } }
        );
      }
      return new Response(
        JSON.stringify({
          video: { video_id: 'video_1' },
          destination: {
            type: 'playground',
            index_id: null,
            index_name: null,
            index_created: false,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      maxRetries: 1,
      timeout: 5_000,
    });

    try {
      const response = await executeTool(
        'upload_media',
        { file_path: mediaPath, idempotency_key: 'upload-1' },
        client,
        { transportMode: 'stdio', uploadRoots: [root] }
      );

      expect(response.isError).not.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
      expect(firstInit.body).not.toBeInstanceOf(Blob);
      expect((firstInit.headers as Record<string, string>)['Idempotency-Key']).toBe('upload-1');
      expect((secondInit.headers as Record<string, string>)['Idempotency-Key']).toBe('upload-1');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reopens workflow uploads after response-loss failures with one stable key', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'videovector-mcp-upload-loss-'));
    const mediaPath = join(root, 'sample.mp4');
    await fs.writeFile(mediaPath, Buffer.from('stream-this-media'));
    let attempt = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      attempt += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as any) {
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString('utf8')).toContain('stream-this-media');

      if (attempt === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => {
            throw new TypeError('terminated');
          },
        } as Response;
      }
      if (attempt === 2) {
        return new Response('', { status: 200 });
      }
      if (attempt === 3) {
        return new Response('{malformed', { status: 200 });
      }
      if (attempt === 4) {
        return {
          ok: true,
          status: 200,
          text: () => new Promise<string>((_resolve, reject) => {
            const abort = () => {
              const error = new Error('aborted while reading the response');
              error.name = 'AbortError';
              reject(error);
            };
            if (init.signal?.aborted) {
              abort();
            } else {
              init.signal?.addEventListener('abort', abort, { once: true });
            }
          }),
        } as Response;
      }
      return new Response(
        JSON.stringify({
          video: { video_id: 'video_1' },
          destination: {
            type: 'playground',
            index_id: null,
            index_name: null,
            index_created: false,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      maxRetries: 4,
      timeout: 5,
    });
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);

    try {
      await expect(
        client.workflowUploadMedia({ file_path: mediaPath }, 'upload-loss-1')
      ).resolves.toMatchObject({ video: { video_id: 'video_1' } });

      expect(fetchMock).toHaveBeenCalledTimes(5);
      const keys = fetchMock.mock.calls.map(
        ([, init]) => (init.headers as Record<string, string>)['Idempotency-Key']
      );
      expect(keys).toEqual(Array(5).fill('upload-loss-1'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an upload source that changed after path authorization', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'videovector-mcp-race-'));
    const mediaPath = join(root, 'sample.mp4');
    await fs.writeFile(mediaPath, Buffer.from('first'));
    const authorized = await authorizeUploadFile(mediaPath, [root]);
    await fs.writeFile(mediaPath, Buffer.from('different-size'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new VideoVectorClient({
      apiKey: 'sk_test_abc',
      baseUrl: 'https://example.com/api/v2',
      maxRetries: 0,
    });

    try {
      await expect(client.workflowUploadMedia(
        { file_path: authorized.filePath },
        'upload-race',
        authorized.identity
      )).rejects.toMatchObject({ code: 'upload_source_error' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
