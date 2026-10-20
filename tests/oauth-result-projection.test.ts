import { describe, expect, it, vi } from 'vitest';

import type { VideoVectorClient } from '../src/client/index.js';
import { executeTool } from '../src/tools/index.js';
import {
  projectOAuthToolResult,
  type OAuthProjectableToolResult,
} from '../src/tools/oauth-result-projection.js';

type JsonRecord = Record<string, unknown>;

const CAPABILITY_URL =
  'https://storage.googleapis.com/private/object?X-Goog-Signature=secret-signature';

function toolResult(
  payload: JsonRecord,
  options: { structured?: boolean; isError?: boolean } = {}
): OAuthProjectableToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(options.structured === false ? {} : { structuredContent: payload }),
    ...(options.isError === undefined ? {} : { isError: options.isError }),
  };
}

function parseContent(result: OAuthProjectableToolResult): JsonRecord {
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0]?.text ?? '') as JsonRecord;
}

function expectParity(result: OAuthProjectableToolResult): JsonRecord {
  const parsed = parseContent(result);
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function richSearchResult(overrides: JsonRecord = {}): JsonRecord {
  return {
    result_type: 'segment',
    result_id: 'segment:seg_1:run_1',
    video_id: 'vid_1',
    video_name: 'Launch video',
    segment_id: 'seg_1',
    start_time: 1,
    end_time: 4,
    content: 'A red car enters the frame.',
    text_content: 'A red car enters the frame.',
    content_preview: 'A red car',
    metadata_text: 'duplicate metadata text',
    metadata: {
      scene: 'road',
      // User-authored metadata is opaque and must not be stripped by key name.
      gcs_uri: 'customer-authored-value',
    },
    extracted_metadata: { scene: 'duplicate' },
    similarity_score: 0.9,
    video_uri: CAPABILITY_URL,
    segment_uri: CAPABILITY_URL,
    preview_segment_uri: CAPABILITY_URL,
    thumbnail_uri: CAPABILITY_URL,
    preview_thumbnail_uri: CAPABILITY_URL,
    gif_uri: CAPABILITY_URL,
    preview_gif_uri: CAPABILITY_URL,
    matched_image_uri: CAPABILITY_URL,
    gcs_uri: 'gs://private/segment.mp4',
    thumbnail_gcs_uri: 'gs://private/thumb.webp',
    gif_gcs_uri: 'gs://private/preview.webp',
    matched_image_gcs_uri: 'gs://private/matched.jpg',
    thumbnail_data: 'base64-thumbnail-secret',
    gif_data: 'base64-gif-secret',
    raw_llm_response: '{"internal":true}',
    marker: {
      marker_id: 'marker_1',
      color: 'green',
      note: 'Reviewed',
      updated_at: '2026-08-01T00:00:00Z',
      internal_owner_id: 'user_internal',
    },
    extracted_metadata_markers: {
      scene: {
        marker_id: 'marker_2',
        color: 'yellow',
        note: 'Check',
        updated_at: '2026-08-02T00:00:00Z',
        internal_owner_id: 'user_internal',
      },
    },
    segment: {
      segment_id: 'seg_1',
      attempt_id: 'attempt_internal',
      status_source: 'run_projection',
      operations: { transcription: { succeeded: false, error: 'provider trace' } },
      gcs_uri: 'gs://private/nested.mp4',
      thumbnail_data: 'nested-base64',
    },
    ...overrides,
  };
}

function expectSearchItemIsPublic(item: JsonRecord): void {
  expect(item).not.toHaveProperty('video_uri');
  expect(item).not.toHaveProperty('segment_uri');
  expect(item).not.toHaveProperty('preview_segment_uri');
  expect(item).not.toHaveProperty('thumbnail_uri');
  expect(item).not.toHaveProperty('preview_thumbnail_uri');
  expect(item).not.toHaveProperty('gif_uri');
  expect(item).not.toHaveProperty('preview_gif_uri');
  expect(item).not.toHaveProperty('matched_image_uri');
  expect(item).not.toHaveProperty('gcs_uri');
  expect(item).not.toHaveProperty('thumbnail_gcs_uri');
  expect(item).not.toHaveProperty('gif_gcs_uri');
  expect(item).not.toHaveProperty('matched_image_gcs_uri');
  expect(item).not.toHaveProperty('thumbnail_data');
  expect(item).not.toHaveProperty('gif_data');
  expect(item).not.toHaveProperty('raw_llm_response');
  expect(item).not.toHaveProperty('segment');
  expect(item).not.toHaveProperty('text_content');
  expect(item).not.toHaveProperty('content_preview');
  expect(item).not.toHaveProperty('metadata_text');
  expect(item).not.toHaveProperty('extracted_metadata');
  expect(item.content).toBe('A red car enters the frame.');
  expect(item.metadata).toEqual({
    scene: 'road',
    gcs_uri: 'customer-authored-value',
  });
  expect(item.marker).not.toHaveProperty('internal_owner_id');
  expect(
    ((item.metadata_markers as JsonRecord).scene as JsonRecord)
  ).not.toHaveProperty('internal_owner_id');
}

describe('OAuth-only tool result projection', () => {
  it.each([
    {
      tool: 'search_videos',
      payload: {
        query: 'red car',
        index_id: 'idx_1',
        total_results: 1,
        segment_enrichment: {
          resolved_results: 1,
          unresolved_results: 0,
          failed_groups: [{ error: 'internal enrichment error' }],
        },
        results: [richSearchResult()],
      },
      read: (payload: JsonRecord) => (payload.results as JsonRecord[])[0] as JsonRecord,
    },
    {
      tool: 'search_videos_by_image',
      payload: {
        index_id: 'idx_1',
        search_type: 'image',
        total_results: 1,
        results: [richSearchResult()],
      },
      read: (payload: JsonRecord) => (payload.results as JsonRecord[])[0] as JsonRecord,
    },
    {
      tool: 'multimodal_search',
      payload: {
        index_id: 'idx_1',
        search_type: 'multimodal',
        text_query: 'red car',
        has_image: true,
        text_weight: 0.5,
        image_weight: 0.5,
        total_results: 1,
        results: [richSearchResult()],
      },
      read: (payload: JsonRecord) => (payload.results as JsonRecord[])[0] as JsonRecord,
    },
    {
      tool: 'filter_videos',
      payload: {
        index_id: 'idx_1',
        search_type: 'filter',
        conditions: [{ field: 'scene', operator: 'equals', value: 'road' }],
        total_results: 1,
        has_more: false,
        next_cursor: null,
        results: [richSearchResult()],
      },
      read: (payload: JsonRecord) => (payload.results as JsonRecord[])[0] as JsonRecord,
    },
  ])('removes storage grants and internal search fields from $tool', ({ tool, payload, read }) => {
    const result = projectOAuthToolResult(tool, toolResult(payload));
    const projected = expectParity(result);
    expectSearchItemIsPublic(read(projected));
    if (tool === 'search_videos') {
      expect(projected.segment_enrichment).toEqual({
        resolved_results: 1,
        unresolved_results: 0,
      });
    }
  });

  it('projects video segments without storage, base64, attempt, or provider diagnostics', () => {
    const payload = {
      video_id: 'vid_1',
      run_id: 'run_1',
      total_segments: 1,
      has_more: false,
      segments: [
        {
          segment_id: 'seg_1',
          video_id: 'vid_1',
          start_time: 1,
          end_time: 4,
          metadata: { gcs_uri: 'user-authored', scene: 'road' },
          gcs_uri: 'gs://private/segment.mp4',
          thumbnail_gcs_uri: 'gs://private/thumb.webp',
          gif_gcs_uri: 'gs://private/gif.webp',
          thumbnail_uri: CAPABILITY_URL,
          gif_uri: CAPABILITY_URL,
          thumbnail_data: 'base64-thumbnail',
          gif_data: 'base64-gif',
          attempt_id: 'attempt_internal',
          status_source: 'run_projection',
          error_message: 'provider trace',
          operations: {
            field_extraction: { succeeded: true, error: 'provider detail' },
          },
        },
      ],
    };
    const result = projectOAuthToolResult('get_video_segments', toolResult(payload));
    const projected = expectParity(result);
    const segment = (projected.segments as JsonRecord[])[0] as JsonRecord;

    expect(segment.metadata).toEqual({ gcs_uri: 'user-authored', scene: 'road' });
    expect(segment).not.toHaveProperty('gcs_uri');
    expect(segment).not.toHaveProperty('thumbnail_gcs_uri');
    expect(segment).not.toHaveProperty('gif_gcs_uri');
    expect(segment).not.toHaveProperty('thumbnail_uri');
    expect(segment).not.toHaveProperty('gif_uri');
    expect(segment).not.toHaveProperty('thumbnail_data');
    expect(segment).not.toHaveProperty('gif_data');
    expect(segment).not.toHaveProperty('attempt_id');
    expect(segment).not.toHaveProperty('status_source');
    expect(segment).not.toHaveProperty('error_message');
    expect(segment.operations).toEqual({ field_extraction: { succeeded: true } });
  });

  it('projects video-level prompt results without raw model, fingerprint, attempt, or storage data', () => {
    const payload = {
      result_type: 'video',
      result_id: 'video:vid_1:run_1',
      run_id: 'run_1',
      prompt_id: 'prompt_1',
      prompt_run_id: 'run_1',
      video_id: 'vid_1',
      status: 'completed',
      metadata: { summary: 'Launch video' },
      metadata_text: 'Launch video',
      raw_llm_response: '{"debug":true}',
      source_fingerprint: 'fingerprint_internal',
      attempt_id: 'attempt_internal',
      schema_used: '{"type":"object"}',
      segment_uri: CAPABILITY_URL,
      thumbnail_uri: CAPABILITY_URL,
      gif_uri: CAPABILITY_URL,
      gcs_uri: 'gs://private/video.mp4',
      thumbnail_gcs_uri: 'gs://private/thumb.webp',
      gif_gcs_uri: 'gs://private/gif.webp',
    };
    const result = projectOAuthToolResult(
      'get_prompt_run_video_result',
      toolResult(payload)
    );
    const projected = expectParity(result);

    expect(projected).toMatchObject({ content: 'Launch video', status: 'completed' });
    for (const field of [
      'raw_llm_response',
      'source_fingerprint',
      'attempt_id',
      'schema_used',
      'rendered_prompt_char_count',
      'llm_attempted',
      'segment_uri',
      'thumbnail_uri',
      'gif_uri',
      'gcs_uri',
      'thumbnail_gcs_uri',
      'gif_gcs_uri',
    ]) {
      expect(projected).not.toHaveProperty(field);
    }
  });

  it('projects export status with public app links and the legacy authenticated download path', () => {
    const payload = {
      export_id: 'export_1',
      export_type: 'index_metadata',
      target_id: 'idx_1',
      status: 'failed',
      queue_status: 'failed',
      attempts: 3,
      max_attempts: 3,
      download_url: '/api/v2/exports/export_1/download',
      file_size_bytes: 1024,
      file_size_human: '1 KB',
      error_message: 'Export failed',
      last_error: 'internal storage trace',
      destination_type: 'download',
      destination_connector_id: null,
      destination_base_path: 'private/base',
      destination_subpath: 'requested/subpath',
      destination_uri: null,
      gcs_uri: 'gs://private/export.json',
      export_params: { admission_identity: 'internal' },
      links: {
        open_in_app: 'https://app.vectormethods.com/jobs?tab=exports&export=export_1&scope=all',
        private_storage: CAPABILITY_URL,
      },
      tip: 'Review the failure.',
    };
    const result = projectOAuthToolResult(
      'get_export_status',
      toolResult(payload, { structured: false, isError: true })
    );
    const projected = expectParity(result);

    expect(projected.download_url).toBe('/api/v2/exports/export_1/download');
    expect(projected.links).toEqual({
      open_in_app: payload.links.open_in_app,
    });
    expect(JSON.stringify(result)).not.toContain(CAPABILITY_URL);
    for (const field of [
      'queue_status',
      'attempts',
      'max_attempts',
      'file_size_human',
      'last_error',
      'destination_base_path',
      'gcs_uri',
      'export_params',
    ]) {
      expect(projected).not.toHaveProperty(field);
    }
  });

  it('fails closed on malformed projected results without echoing original data', () => {
    const result = projectOAuthToolResult('search_videos', {
      content: [{ type: 'text', text: `not-json ${CAPABILITY_URL}` }],
    });
    const payload = parseContent(result);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(payload).toEqual({
      error: true,
      code: 'oauth_result_projection_failed',
      message: 'The tool returned an invalid public response shape.',
      recoverable: true,
    });
    expect(result.content[0]?.text).not.toContain('secret-signature');
  });

  it('applies projection only to OAuth and preserves API-key/stdio output byte-for-byte', async () => {
    const response = richSearchResult({ result_type: 'video', segment_id: null });
    const makeClient = () => ({
      searchVideos: vi.fn().mockResolvedValue([response]),
    }) as unknown as VideoVectorClient;
    const args = { query: 'red car', index_id: 'idx_1' };

    const stdio = await executeTool('search_videos', args, makeClient());
    const apiKey = await executeTool(
      'search_videos',
      args,
      makeClient(),
      { authenticationKind: 'api-key' }
    );
    const oauth = await executeTool(
      'search_videos',
      args,
      makeClient(),
      { authenticationKind: 'oauth' }
    );

    expect(apiKey.content[0]?.text).toBe(stdio.content[0]?.text);
    expect(apiKey.structuredContent).toEqual(stdio.structuredContent);
    expect(apiKey.content[0]?.text).toContain('X-Goog-Signature');
    const oauthPayload = expectParity(oauth);
    expectSearchItemIsPublic((oauthPayload.results as JsonRecord[])[0] as JsonRecord);
  });

  it('leaves model-safe OAuth error responses untouched', () => {
    const error = toolResult(
      {
        error: true,
        code: 'resource_not_found',
        message: 'The requested resource was not found.',
      },
      { structured: false, isError: true }
    );
    expect(projectOAuthToolResult('get_export_status', error)).toBe(error);
  });
});
