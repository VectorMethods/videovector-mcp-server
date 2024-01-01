import { describe, expect, it, vi } from 'vitest';

import { executeTool } from '../src/tools/index.js';
import type { VideoVectorClient } from '../src/client/index.js';
import { VideoVectorApiError } from '../src/types/index.js';

function parseContent(result: Awaited<ReturnType<typeof executeTool>>): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const baseSearchResult = {
  result_type: 'segment',
  result_id: 'segment:seg_1:run_1',
  segment_id: 'seg_1',
  video_id: 'vid_1',
  start_time: 10,
  end_time: 20,
  text_content: 'sample',
  similarity_score: 0.87,
  segment_uri: null,
  thumbnail_uri: null,
  thumbnail_data: null,
  thumbnail_available: true,
  gif_uri: null,
  gif_data: null,
  gif_available: false,
  extracted_metadata: { scene: 'intro' },
  field_scores: null,
  run_id: 'run_1',
  source_index_id: 'idx_1',
  marker: {
    marker_id: 'marker_1',
    color: 'green',
    note: 'review',
    updated_at: '2026-01-01T00:00:00Z',
  },
  extracted_metadata_markers: {
    scene: {
      marker_id: 'marker_scene_1',
      color: 'yellow',
      note: 'verified',
      updated_at: '2026-01-01T00:00:00Z',
    },
  },
};

describe('search tool handlers', () => {
  it('search_videos clamps top_k to 100 and forwards optional filters', async () => {
    const client = {
      searchVideos: vi.fn().mockResolvedValue([baseSearchResult]),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'search_videos',
      {
        query: 'find intro scenes',
        index_id: 'idx_primary',
        top_k: 999,
        search_fields: ['scene', 'summary'],
        run_ids: ['run_1'],
        index_ids: ['idx_primary', 'idx_secondary'],
      },
      client
    );

    expect((client as any).searchVideos).toHaveBeenCalledWith('idx_primary', {
      query: 'find intro scenes',
      top_k: 100,
      search_fields: ['scene', 'summary'],
      run_ids: ['run_1'],
      index_ids: ['idx_primary', 'idx_secondary'],
    });

    const payload = parseContent(result);
    expect(payload.total_results).toBe(1);
    expect((payload.results as Array<Record<string, unknown>>)[0].marker).toMatchObject({
      marker_id: 'marker_1',
      color: 'green',
    });
    expect(
      ((payload.results as Array<Record<string, unknown>>)[0].extracted_metadata_markers as Record<
        string,
        unknown
      >).scene
    ).toMatchObject({
      marker_id: 'marker_scene_1',
    });
  });

  it('search_videos keeps segment enrichment scoped to run_id for duplicate segment IDs', async () => {
    const client = {
      searchVideos: vi.fn().mockResolvedValue([
        {
          ...baseSearchResult,
          result_id: 'segment:seg_shared:run_1',
          video_id: 'vid_shared',
          segment_id: 'seg_shared',
          run_id: 'run_1',
        },
        {
          ...baseSearchResult,
          result_id: 'segment:seg_shared:run_2',
          video_id: 'vid_shared',
          segment_id: 'seg_shared',
          run_id: 'run_2',
        },
      ]),
      getVideoSegments: vi.fn().mockImplementation((_videoId: string, options: { runId?: string }) => {
        const runId = options.runId;
        if (runId === 'run_1') {
          return Promise.resolve({
            data: [
              {
                segment_id: 'seg_shared',
                video_id: 'vid_shared',
                start_time: 10,
                end_time: 20,
                gcs_uri: null,
                thumbnail_gcs_uri: null,
                gif_gcs_uri: null,
                processed: true,
                processing_failed: false,
                metadata: { source: 'run_1' },
              metadata_text: 'run one segment',
              created_at: null,
              processed_at: null,
              error_message: null,
              processing_warning: null,
              thumbnail_data: 'thumb-bytes',
              thumbnail_available: true,
              gif_data: 'gif-bytes',
              gif_available: false,
              from_run_id: 'run_1',
              thumbnail_uri: null,
              gif_uri: null,
              segment_status: 'successful',
              failure_stage: null,
              failure_message: null,
              attempt_id: null,
              status_source: null,
              marker: { marker_id: null, color: null, note: null, updated_at: null },
              metadata_markers: {},
              field_extraction_succeeded: true,
              transcription_succeeded: true,
              image_embedding_succeeded: null,
              field_extraction_error: null,
              transcription_error: null,
              image_embedding_error: null,
            },
          ],
          pagination: { has_more: false, next_cursor: null, total_count: 1 },
          });
        }

        return Promise.resolve({
          data: [
            {
              segment_id: 'seg_shared',
              video_id: 'vid_shared',
              start_time: 11,
              end_time: 21,
              gcs_uri: null,
              thumbnail_gcs_uri: null,
              gif_gcs_uri: null,
              processed: true,
              processing_failed: false,
              metadata: { source: 'run_2' },
              metadata_text: 'run two segment',
              created_at: null,
              processed_at: null,
              error_message: null,
              processing_warning: null,
              thumbnail_data: 'thumb-bytes-2',
              thumbnail_available: true,
              gif_data: 'gif-bytes-2',
              gif_available: false,
              from_run_id: 'run_2',
              thumbnail_uri: null,
              gif_uri: null,
              segment_status: 'successful',
              failure_stage: null,
              failure_message: null,
              attempt_id: null,
              status_source: null,
              marker: { marker_id: null, color: null, note: null, updated_at: null },
              metadata_markers: {},
              field_extraction_succeeded: true,
              transcription_succeeded: true,
              image_embedding_succeeded: null,
              field_extraction_error: null,
              transcription_error: null,
              image_embedding_error: null,
            },
          ],
          pagination: { has_more: false, next_cursor: null, total_count: 1 },
        });
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'search_videos',
      {
        query: 'shared segment',
        index_id: 'idx_primary',
      },
      client
    );

    const payload = parseContent(result);
    const results = payload.results as Array<Record<string, unknown>>;
    const firstSegment = (results[0].segment ?? null) as Record<string, unknown> | null;
    const secondSegment = (results[1].segment ?? null) as Record<string, unknown> | null;
    expect(results).toHaveLength(2);
    expect(results[0].run_id).toBe('run_1');
    expect(firstSegment?.from_run_id).toBe('run_1');
    expect(firstSegment).not.toHaveProperty('thumbnail_data');
    expect(firstSegment).not.toHaveProperty('gif_data');
    expect(results[1].run_id).toBe('run_2');
    expect(secondSegment?.from_run_id).toBe('run_2');
    expect((payload.segment_enrichment as Record<string, unknown>).resolved_results).toBe(2);
  });

  it('search_videos preserves video titles and field confidence payloads', async () => {
    const client = {
      searchVideos: vi.fn().mockResolvedValue([
        {
          ...baseSearchResult,
          video_name: 'Episode 1',
          field_scores: { headline: 0.81 },
          field_instance_scores: { '__instance__:["headline"]': 0.81 },
          matched_field_paths: ['headline'],
          matched_field_instances: [
            {
              field_path: 'headline',
              field_display_label: 'Headline',
              field_instance_key: '__instance__:["headline"]',
              field_instance_path: 'headline',
              field_instance_display_label: 'Headline',
              score: 0.81,
              value_preview: 'sample',
            },
          ],
        },
      ]),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'search_videos',
      {
        query: 'find intro scenes',
        index_id: 'idx_primary',
      },
      client
    );

    const payload = parseContent(result);
    expect((payload.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      video_name: 'Episode 1',
      field_scores: { headline: 0.81 },
      field_instance_scores: { '__instance__:["headline"]': 0.81 },
      matched_field_paths: ['headline'],
      matched_field_instances: [
        expect.objectContaining({
          field_path: 'headline',
          score: 0.81,
        }),
      ],
    });
  });

  it('search_videos preserves preview fields for video-level results', async () => {
    const client = {
      searchVideos: vi.fn().mockResolvedValue([
        {
          result_type: 'video',
          result_id: 'video:vid_1:run_1',
          video_id: 'vid_1',
          video_uri: 'https://example.com/video.mp4',
          video_name: 'Episode 1',
          segment_id: null,
          start_time: null,
          end_time: null,
          text_content: 'video-level summary',
          content_preview: 'video-level summary',
          similarity_score: 0.91,
          preview_segment_id: 'seg_9',
          preview_start_time: 12.5,
          preview_end_time: 18,
          preview_segment_uri: 'gs://segments/seg_9.mp4',
          preview_thumbnail_uri: 'https://example.com/thumb.jpg',
          preview_gif_uri: 'https://example.com/preview.gif',
          segment_uri: null,
          thumbnail_uri: 'https://example.com/thumb.jpg',
          thumbnail_data: null,
          thumbnail_available: true,
          gif_uri: 'https://example.com/preview.gif',
          gif_data: null,
          gif_available: true,
          extracted_metadata: { summary: 'video-level summary' },
          field_scores: null,
          field_instance_scores: null,
          matched_field_paths: null,
          matched_field_instances: null,
          run_id: 'run_1',
          prompt_run_id: 'run_1',
          source_run_id: 'run_1',
          source_index_id: 'idx_1',
          marker: null,
          extracted_metadata_markers: null,
        },
      ]),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'search_videos',
      { query: 'video summary', index_id: 'idx_primary' },
      client
    );

    const payload = parseContent(result);
    expect((payload.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      result_type: 'video',
      preview_segment_id: 'seg_9',
      preview_start_time: 12.5,
      preview_end_time: 18,
      preview_segment_uri: 'gs://segments/seg_9.mp4',
      preview_thumbnail_uri: 'https://example.com/thumb.jpg',
      preview_gif_uri: 'https://example.com/preview.gif',
      prompt_run_id: 'run_1',
      source_run_id: 'run_1',
    });
  });

  it('search_videos_by_image forwards run_ids and index_ids', async () => {
    const client = {
      searchByImage: vi.fn().mockResolvedValue([
        {
          ...baseSearchResult,
          matched_image_uri: null,
          matched_image_timestamp: 12.3,
          matched_image_score: 0.73,
          shot_timestamp: 12.1,
        },
      ]),
    } as unknown as VideoVectorClient;

    const base64Png = 'iVBORw0KGgoAAAANSUhEUgAA';

    const result = await executeTool(
      'search_videos_by_image',
      {
        image_data: base64Png,
        index_id: 'idx_primary',
        run_ids: ['run_1', 'run_2'],
        index_ids: ['idx_primary'],
      },
      client
    );

    expect((client as any).searchByImage).toHaveBeenCalledWith('idx_primary', {
      image_data: base64Png,
      top_k: 10,
      run_ids: ['run_1', 'run_2'],
      index_ids: ['idx_primary'],
    });

    const payload = parseContent(result);
    expect((payload.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      matched_image_uri: null,
      matched_image_timestamp: 12.3,
      matched_image_score: 0.73,
      shot_timestamp: 12.1,
    });
  });

  it('search_videos_by_image preserves null matched image score', async () => {
    const client = {
      searchByImage: vi.fn().mockResolvedValue([
        {
          ...baseSearchResult,
          matched_image_uri: null,
          matched_image_timestamp: 12.3,
          matched_image_score: null,
          shot_timestamp: 12.1,
        },
      ]),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'search_videos_by_image',
      {
        image_data: 'iVBORw0KGgoAAAANSUhEUgAA',
        index_id: 'idx_primary',
      },
      client
    );

    const payload = parseContent(result);
    expect((payload.results as Array<Record<string, unknown>>)[0]).toMatchObject({
      matched_image_score: null,
    });
  });

  it('multimodal_search preserves 0 text/image scores in formatted response', async () => {
    const client = {
      searchMultimodal: vi.fn().mockResolvedValue([
        {
          ...baseSearchResult,
          fused_score: 0.51,
          text_score: 0,
          image_score: 0,
          text_rank: 3,
          image_rank: 2,
          match_type: 'both',
          matched_image_uri: null,
          matched_image_timestamp: 11.1,
          matched_image_score: 0.62,
        },
      ]),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'multimodal_search',
      {
        index_id: 'idx_primary',
        text_query: 'crowded street',
        image_data: 'iVBORw0KGgoAAAANSUhEUgAA',
        text_weight: 0.5,
        image_weight: 0.5,
      },
      client
    );

    const payload = parseContent(result);
    const first = ((payload.results as unknown[])?.[0] as Record<string, unknown>) ?? {};

    expect(first.text_score).toBe(0);
    expect(first.image_score).toBe(0);
    expect(first.matched_image_score).toBe(0.62);
  });

  it('multimodal_search rejects invalid weight sums', async () => {
    const client = {
      searchMultimodal: vi.fn(),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'multimodal_search',
      {
        index_id: 'idx_primary',
        text_query: 'query',
        text_weight: 0.9,
        image_weight: 0.9,
      },
      client
    );

    const payload = parseContent(result);
    expect(result.isError).toBe(true);
    expect(String(payload.message)).toContain('sum to 1.0');
    expect((client as any).searchMultimodal).not.toHaveBeenCalled();
  });

  it('filter_videos forwards fuzzyMatch, run_ids, index_ids, and start_after', async () => {
    const client = {
      filterSearch: vi.fn().mockResolvedValue({
        results: [baseSearchResult],
        next_page_token: 'cursor_2',
        total_shown: 1,
      }),
    } as unknown as VideoVectorClient;

    await executeTool(
      'filter_videos',
      {
        index_id: 'idx_primary',
        conditions: [
          {
            field: 'title',
            operator: 'contains_word',
            value: 'launch',
            type: 'unknown',
            fuzzyMatch: true,
          },
        ],
        page_size: 75,
        start_after: 'cursor_1',
        run_ids: ['run_1'],
        index_ids: ['idx_primary'],
      },
      client
    );

    expect((client as any).filterSearch).toHaveBeenCalledWith('idx_primary', {
      conditions: [
        {
          field: 'title',
          operator: 'contains_word',
          value: 'launch',
          type: 'unknown',
          fuzzyMatch: true,
        },
      ],
      page_size: 75,
      start_after: 'cursor_1',
      run_ids: ['run_1'],
      index_ids: ['idx_primary'],
    });
  });

  it('filter_videos accepts up to five backend-valid conditions', async () => {
    const client = {
      filterSearch: vi.fn().mockResolvedValue({
        results: [baseSearchResult],
        next_page_token: null,
        total_shown: 1,
      }),
    } as unknown as VideoVectorClient;

    await executeTool(
      'filter_videos',
      {
        index_id: 'idx_primary',
        conditions: [
          { field: 'title', operator: 'contains', value: 'launch', type: 'string' },
          { field: 'duration', operator: 'greater_equal', value: 10, type: 'number' },
          { field: 'status', operator: 'not_equals', value: 'failed', type: 'string' },
          { field: 'labels', operator: 'item_contains', value: 'car', type: 'array' },
          { field: 'custom_field', operator: 'is_not_null', value: true, type: 'unknown' },
        ],
      },
      client
    );

    expect((client as any).filterSearch).toHaveBeenCalled();
    expect(((client as any).filterSearch.mock.calls[0]?.[1]?.conditions as unknown[]).length).toBe(5);
  });

  it('maps backend API errors to MCP-friendly error payloads', async () => {
    const client = {
      searchVideos: vi
        .fn()
        .mockRejectedValue(new VideoVectorApiError('Unauthorized', 'invalid_api_key', 401)),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'search_videos',
      { query: 'anything', index_id: 'idx_primary' },
      client
    );

    const payload = parseContent(result);
    expect(result.isError).toBe(true);
    expect(payload.code).toBe('invalid_api_key');
    expect(payload.recoverable).toBe(false);
    expect(String(payload.suggestion)).toContain('VIDEOVECTOR_API_KEY');
  });
});
