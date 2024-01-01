import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

import {
  executeTool,
  getToolDefinition,
  getToolRequiredScope,
  TOOL_DEFINITIONS,
} from '../src/tools/index.js';
import type { VideoVectorClient } from '../src/client/index.js';
import { VideoVectorApiError } from '../src/types/index.js';

function parseContent(result: Awaited<ReturnType<typeof executeTool>>): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

function makeImportJob(status: 'pending' | 'scanning' | 'importing' | 'completed' | 'failed' | 'cancelled') {
  return {
    job_id: 'job_1',
    connector_id: 'conn_1',
    target_index_id: 'idx_1',
    source_prefix: '',
    file_pattern: '*',
    recursive: true,
    status,
    created_at: '2026-01-01T00:00:00Z',
    started_at: null,
    completed_at: null,
    error_message: null,
    progress: {
      total_files: 10,
      imported: 4,
      failed: 1,
      skipped: 0,
      bytes_transferred: 1024,
      current_file: 'videos/sample.mp4',
    },
    video_ids: ['vid_1'],
    failed_files: [],
    skipped_files: [],
  };
}

function makeWebhookDelivery(status: 'pending' | 'processing' | 'delivered' | 'failed' | 'retrying') {
  return {
    delivery_id: 'del_1',
    webhook_id: 'wh_1',
    event_type: 'video.processed',
    status,
    attempts: 1,
    last_attempt_at: '2026-01-01T00:00:00Z',
    next_retry_at: null,
    response_status_code: 200,
    response_body: null,
    error_message: null,
    created_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:00:00Z',
    payload: null,
  };
}

describe('resource tool handlers', () => {
  it('does not expose internal account IDs in index discovery results', async () => {
    const index = {
      index_id: 'idx_1',
      name: 'Launch footage',
      user_id: 'internal-user-id',
      created_at: '2026-01-01T00:00:00Z',
      is_default: false,
      description: 'Product launch media',
      sort_order: 1,
    };
    const client = {
      listIndexes: vi.fn().mockResolvedValue([index]),
      getIndex: vi.fn().mockResolvedValue(index),
    } as unknown as VideoVectorClient;

    const listed = await executeTool('list_indexes', {}, client);
    const fetched = await executeTool('get_index', { index_id: 'idx_1' }, client);
    const listedPayload = parseContent(listed);
    const fetchedPayload = parseContent(fetched);

    expect((listedPayload.user_indexes as Array<Record<string, unknown>>)[0])
      .not.toHaveProperty('user_id');
    expect(fetchedPayload).not.toHaveProperty('user_id');
    expect(listed.structuredContent).toEqual(listedPayload);
    expect(fetched.structuredContent).toEqual(fetchedPayload);
    expect(getToolDefinition('get_index')?.outputSchema?.properties)
      .not.toHaveProperty('user_id');
  });

  it('marks test_connector as write-scoped because it mutates connector status', () => {
    const definition = getToolDefinition('test_connector');

    expect(getToolRequiredScope('test_connector')).toBe('write');
    expect(definition?.annotations?.readOnlyHint).toBe(false);
    expect(definition?.annotations?.idempotentHint).toBe(false);
    expect(definition?.inputSchema.properties?.idempotency_key).toMatchObject({
      type: 'string',
    });
  });

  it('forwards connector probe idempotency identity to the API client', async () => {
    const client = {
      testConnector: vi.fn().mockResolvedValue({
        success: true,
        error_message: null,
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'test_connector',
      {
        connector_id: 'connector_1',
        idempotency_key: 'connector-probe-1',
      },
      client
    );

    expect((client as any).testConnector).toHaveBeenCalledWith(
      'connector_1',
      'connector-probe-1'
    );
    expect(parseContent(result)).toMatchObject({
      connector_id: 'connector_1',
      success: true,
    });
  });

  it('advertises the backend write scope for read-only prompt schema tests', () => {
    const definition = getToolDefinition('test_prompt_schema');

    expect(getToolRequiredScope('test_prompt_schema')).toBe('write');
    expect(definition?.annotations?.readOnlyHint).toBe(true);
    expect(definition?.annotations?.idempotentHint).toBe(true);
  });

  it('separates side-effect-free export status from explicit capability minting', () => {
    const statusDefinition = getToolDefinition('get_export_status');
    const mintDefinition = getToolDefinition('get_export_download_url');

    expect(getToolRequiredScope('get_export_status')).toBe('read');
    expect(statusDefinition?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(getToolRequiredScope('get_export_download_url')).toBe('read');
    expect(mintDefinition?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('keeps the public tool registry unique and includes additive workflow tools', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);

    expect(names).toHaveLength(53);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('get_export_status');
    expect(names).toContain('get_export_download_url');
    expect(names).toEqual(expect.arrayContaining([
      'upload_media',
      'define_prompt',
      'process_media',
      'search_media',
    ]));
  });

  it('retires duplicate execute_prompt submission', async () => {
    expect(TOOL_DEFINITIONS.some((tool) => tool.name === 'execute_prompt')).toBe(false);
    const result = await executeTool('execute_prompt', {}, {} as VideoVectorClient);
    expect(result.isError).toBe(true);
  });

  it('estimate_prompt_run forwards canonical target', async () => {
    const client = {
      estimatePromptRun: vi.fn().mockResolvedValue({
        estimated_mt: 12.5,
        sufficient_balance: true,
        current_balance_mt: 100,
        breakdown: { base_estimate_mt: 10 },
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'estimate_prompt_run',
      {
        prompt_id: 'prompt_1',
        target: { type: 'index', index_id: 'idx_1' },
        video_segmentation_type: 'fixed',
        video_segment_duration: 20,
      },
      client
    );

    expect((client as any).estimatePromptRun).toHaveBeenCalledWith({
      prompt_id: 'prompt_1',
      target: { type: 'index', index_id: 'idx_1' },
      video_segmentation_type: 'fixed',
      audio_segmentation_type: undefined,
      video_segment_duration: 20,
      audio_segment_duration: undefined,
      processing_model: undefined,
      enable_transcription: undefined,
      enable_image_embedding: undefined,
    });

    const payload = parseContent(result);
    expect(payload.estimated_mt).toBe(12.5);
  });

  it('estimate_prompt_run accepts content-aware and rejects unsupported modes', async () => {
    const client = { estimatePromptRun: vi.fn().mockResolvedValue({ estimated_mt: 1 }) } as unknown as VideoVectorClient;
    const args = { prompt_id: 'prompt_1', target: { type: 'playground' }, video_segmentation_type: 'content_aware' };
    expect((await executeTool('estimate_prompt_run', args, client)).isError).not.toBe(true);
    expect((client as any).estimatePromptRun).toHaveBeenCalledWith(expect.objectContaining(args));
    expect((await executeTool('estimate_prompt_run', { ...args, video_segmentation_type: 'unsupported' }, client)).isError).toBe(true);
    expect((client as any).estimatePromptRun).toHaveBeenCalledTimes(1);
  });

  it('get_video surfaces backend marker and processing snapshot fields', async () => {
    const client = {
      getVideo: vi.fn().mockResolvedValue({
        video_id: 'vid_1',
        title: 'Demo',
        video_uri: 'gs://bucket/demo.mp4',
        status: 'processed',
        processing_status: [
          {
            run_id: 'run_1',
            prompt_id: 'prompt_1',
            status: 'processing',
            total_segments: 2,
            pending_segments: 0,
            processing_segments: 1,
            successful_segments: 1,
            failed_segments: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:01Z',
            attempt_id: 'attempt_1',
            video_level: {
              status: 'processing',
              result_available: false,
              successful_segment_count: 1,
              failed_segment_count: 0,
              started_at: '2026-01-01T00:00:00Z',
              completed_at: null,
              updated_at: '2026-01-01T00:00:01Z',
              error_message: null,
              attempt_id: 'attempt_1',
            },
            segments: [
              {
                segment_id: 'seg_1',
                video_id: 'vid_1',
                status: 'processing',
                start_time: 0,
                end_time: 10,
                started_at: '2026-01-01T00:00:00Z',
                completed_at: null,
                updated_at: '2026-01-01T00:00:01Z',
                error_message: null,
                failure_stage: null,
                attempt_id: 'attempt_seg_1',
              },
            ],
          },
        ],
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:01Z',
        duration_seconds: 61.25,
        metadata_keys: ['summary'],
        media_type: 'video',
        marker: {
          marker_id: 'marker_1',
          color: 'green',
          note: 'review',
          updated_at: '2026-01-01T00:00:00Z',
        },
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool('get_video', { video_id: 'vid_1' }, client);
    const payload = parseContent(result);

    expect((client as any).getVideo).toHaveBeenCalledWith('vid_1');
    expect(payload.duration_seconds).toBe(61.25);
    expect((payload.marker as Record<string, unknown>).marker_id).toBe('marker_1');
    const processingStatus = (payload.processing_status as Array<Record<string, unknown>>)[0];
    expect(processingStatus.attempt_id).toBe('attempt_1');
    expect((processingStatus.video_level as Record<string, unknown>).attempt_id).toBe('attempt_1');
    const segment = ((processingStatus.segments as Array<Record<string, unknown>>)[0]) ?? {};
    expect(segment.video_id).toBe('vid_1');
    expect(segment.attempt_id).toBe('attempt_seg_1');
  });

  it('list_prompt_runs routes user, index, and video scopes correctly', async () => {
    const client = {
      listPromptRuns: vi.fn().mockResolvedValue([
        {
          run_id: 'run_1',
          prompt_id: 'prompt_1',
          prompt_name: 'Prompt',
          prompt_type: 'custom',
          executed_at: '2026-01-01T00:00:00Z',
          executed_by: 'user_1',
          status: 'completed',
          run_context: { index_id: 'idx_1' },
          completed_videos: 1,
          failed_videos: 0,
          partial_videos: 0,
          cancelled_videos: 0,
          total_videos: 1,
          error_message: null,
          video_segmentation_type: 'content_aware',
          audio_segmentation_type: 'content_aware',
          image_segmentation_type: 'image',
          video_segment_duration: null,
          audio_segment_duration: null,
          created_new_segments: false,
          processing_model: null,
          total_video_seconds: 0,
          enable_transcription: true,
          enable_image_embedding: true,
          total_audios: 0,
          total_images: 0,
          completed_audios: 0,
          completed_images: 0,
          failed_audios: 0,
          failed_images: 0,
          partial_audios: 0,
          partial_images: 0,
          cancelled_audios: 0,
          cancelled_images: 0,
          total_segments: 0,
          completed_segments: 0,
          field_extraction_failures: 0,
          transcription_failures: 0,
          image_embedding_failures: 0,
          field_extraction_succeeded: true,
          transcription_succeeded: true,
          image_embedding_succeeded: null,
          video_level_enabled: false,
          video_level_total_items: 0,
          video_level_completed_items: 0,
          video_level_failed_items: 0,
          video_level_partial_items: 0,
          billing_estimated_mt: 2.5,
          billing_actual_mt: 2.25,
          billing_status: 'confirmed',
          billing_error: null,
          marker: { marker_id: null, color: null, note: null, updated_at: null },
        },
      ]),
    } as unknown as VideoVectorClient;

    const listResult = await executeTool('list_prompt_runs', {}, client);
    const listPayload = parseContent(listResult);
    expect(((listPayload.runs as Array<Record<string, unknown>>)[0]).billing_status).toBe('confirmed');
    expect(((listPayload.runs as Array<Record<string, unknown>>)[0]).billing_actual_mt).toBe(2.25);
    expect((client as any).listPromptRuns).toHaveBeenNthCalledWith(1, {
      indexId: undefined,
      videoId: undefined,
      limit: 200,
      cursor: undefined,
    });

    await executeTool('list_prompt_runs', { limit: 25 }, client);
    expect((client as any).listPromptRuns).toHaveBeenNthCalledWith(2, {
      indexId: undefined,
      videoId: undefined,
      limit: 25,
      cursor: undefined,
    });

    await executeTool('list_prompt_runs', { index_id: 'idx_1', cursor: 'abc' }, client);
    expect((client as any).listPromptRuns).toHaveBeenNthCalledWith(3, {
      indexId: 'idx_1',
      videoId: undefined,
      limit: 50,
      cursor: 'abc',
    });

    await executeTool('list_prompt_runs', { video_id: 'vid_1' }, client);
    expect((client as any).listPromptRuns).toHaveBeenNthCalledWith(4, {
      indexId: undefined,
      videoId: 'vid_1',
      limit: undefined,
      cursor: undefined,
    });

    const bad = await executeTool(
      'list_prompt_runs',
      { index_id: 'idx_1', video_id: 'vid_1' },
      client
    );
    const badPayload = parseContent(bad);
    expect(bad.isError).toBe(true);
    expect(String(badPayload.message)).toContain('either index_id or video_id');

    const badCursor = await executeTool(
      'list_prompt_runs',
      { video_id: 'vid_1', cursor: 'abc' },
      client
    );
    const badCursorPayload = parseContent(badCursor);
    expect(badCursor.isError).toBe(true);
    expect(String(badCursorPayload.message)).toContain('cursor is only supported');

    const tooLarge = await executeTool(
      'list_prompt_runs',
      { index_id: 'idx_1', limit: 150 },
      client
    );
    const tooLargePayload = parseContent(tooLarge);
    expect(tooLarge.isError).toBe(true);
    expect(String(tooLargePayload.message)).toContain('cannot exceed 100');
  });

  it('create_prompt accepts open-object schemas and nested video_level config', async () => {
    const client = {
      createPrompt: vi.fn().mockResolvedValue({
        prompt_id: 'prompt_1',
        user_id: 'user_1',
        name: 'Prompt',
        description: 'desc',
        prompt_text: 'Extract metadata',
        json_schema: { type: 'object', additionalProperties: { type: 'string' } },
        video_level: {
          instructions_text: 'Summarize',
          json_schema: { type: 'object', properties: {} },
        },
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'create_prompt',
      {
        name: 'Prompt',
        prompt_text: 'Extract metadata',
        json_schema: { type: 'object', additionalProperties: { type: 'string' } },
        video_level: {
          instructions_text: 'Summarize',
          json_schema: { type: 'object', properties: {} },
        },
        idempotency_key: 'prompt-create-1',
      },
      client
    );

    expect((client as any).createPrompt).toHaveBeenCalledWith(
      {
        name: 'Prompt',
        description: '',
        prompt_text: 'Extract metadata',
        json_schema: { type: 'object', additionalProperties: { type: 'string' } },
        video_level: {
          instructions_text: 'Summarize',
          json_schema: { type: 'object', properties: {} },
        },
      },
      'prompt-create-1'
    );

    const payload = parseContent(result);
    expect((payload.prompt as any).video_level.instructions_text).toBe('Summarize');
  });

  it('update_prompt forwards prompt text, schema, and video_level changes', async () => {
    const client = {
      updatePrompt: vi.fn().mockResolvedValue({
        prompt_id: 'prompt_1',
        user_id: 'user_1',
        name: 'Prompt Updated',
        description: 'desc',
        prompt_text: 'Updated prompt text',
        json_schema: { type: 'object', properties: { headline: { type: 'string' } } },
        video_level: null,
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
      }),
    } as unknown as VideoVectorClient;

    await executeTool(
      'update_prompt',
      {
        prompt_id: 'prompt_1',
        name: 'Prompt Updated',
        prompt_text: 'Updated prompt text',
        json_schema: { type: 'object', properties: { headline: { type: 'string' } } },
        clear_video_level: true,
        idempotency_key: 'prompt-update-1',
      },
      client
    );

    expect((client as any).updatePrompt).toHaveBeenCalledWith(
      'prompt_1',
      {
        name: 'Prompt Updated',
        prompt_text: 'Updated prompt text',
        json_schema: { type: 'object', properties: { headline: { type: 'string' } } },
        clear_video_level: true,
      },
      'prompt-update-1'
    );
  });

  it('update_prompt rejects null-only updates', async () => {
    const client = {
      updatePrompt: vi.fn(),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'update_prompt',
      {
        prompt_id: 'prompt_1',
        description: null,
        video_level: null,
        clear_video_level: false,
      },
      client
    );

    const payload = parseContent(result);
    expect(result.isError).toBe(true);
    expect(String(payload.message)).toContain('At least one prompt field must be provided');
    expect((client as any).updatePrompt).not.toHaveBeenCalled();
  });

  it('test_prompt_schema and get_prompt_usage call backend prompt utilities', async () => {
    const client = {
      testPromptSchema: vi.fn().mockResolvedValue({
        valid: true,
        validated_data: { summary: 'ok' },
        error: null,
        message: 'Schema validation successful',
      }),
      getPromptUsage: vi.fn().mockResolvedValue({
        prompt_id: 'prompt_1',
        name: 'Prompt',
        is_active: true,
        is_in_use: true,
        created_at: '2026-01-01T00:00:00Z',
        schema_properties_count: 1,
      }),
    } as unknown as VideoVectorClient;

    const schemaResult = await executeTool(
      'test_prompt_schema',
      {
        json_schema: { type: 'object', properties: { summary: { type: 'string' } } },
        sample_data: { summary: 'ok' },
      },
      client
    );
    expect((client as any).testPromptSchema).toHaveBeenCalled();
    expect(parseContent(schemaResult).valid).toBe(true);

    const usageResult = await executeTool('get_prompt_usage', { prompt_id: 'prompt_1' }, client);
    expect((client as any).getPromptUsage).toHaveBeenCalledWith('prompt_1');
    expect(parseContent(usageResult).is_in_use).toBe(true);
  });

  it('returns an invalid prompt-schema verdict as a successful tool result', async () => {
    const client = {
      testPromptSchema: vi.fn().mockResolvedValue({
        valid: false,
        validated_data: null,
        error: 'summary must be a string',
        message: 'Schema validation failed',
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'test_prompt_schema',
      {
        json_schema: { type: 'object' },
        sample_data: { summary: 42 },
      },
      client
    );

    expect(result.isError).not.toBe(true);
    expect(parseContent(result)).toMatchObject({ valid: false });
  });

  it('prompt-run detail tools forward video results, failed segments, and retries', async () => {
    const client = {
      getPromptRunVideoResult: vi.fn().mockResolvedValue({
        result_id: 'video:vid_1:run_1',
        run_id: 'run_1',
        prompt_id: 'prompt_1',
        prompt_run_id: 'run_1',
        video_id: 'vid_1',
        video_name: 'Episode 1',
        source_index_id: 'idx_1',
        executed_at: '2026-01-01T00:00:00Z',
        status: 'completed',
        metadata: { summary: 'done' },
        metadata_text: 'done',
        raw_llm_response: null,
        processing_warning: null,
        schema_used: null,
        successful_segment_count: 4,
        failed_segment_count: 0,
        source_fingerprint: 'fp1',
        attempt_id: 'attempt_1',
        error_message: null,
        started_at: null,
        completed_at: null,
        segment_uri: 'gs://segments/seg_1.mp4',
        gcs_uri: 'gs://segments/seg_1.mp4',
        thumbnail_gcs_uri: 'gs://segments/seg_1.jpg',
        gif_gcs_uri: 'gs://segments/seg_1.gif',
        thumbnail_uri: 'https://example.com/thumb.jpg',
        gif_uri: 'https://example.com/preview.gif',
        thumbnail_available: true,
        gif_available: true,
        preview_segment_id: 'seg_1',
        preview_start_time: 54,
        preview_end_time: 73,
        preview_segment_uri: 'gs://segments/seg_1.mp4',
        preview_thumbnail_uri: 'https://example.com/thumb.jpg',
        preview_gif_uri: 'https://example.com/preview.gif',
        marker: { marker_id: 'marker-video', color: 'blue', note: null, updated_at: null },
      }),
      getPromptRunFailedSegments: vi.fn().mockResolvedValue({
        run_id: 'run_1',
        status: 'completed_with_failures',
        videos_with_failures: 1,
        failed_segments: 1,
        operation_counts: {
          field_extraction: 1,
          transcription: 0,
          image_embedding: 0,
          processing: 0,
        },
        videos: [],
      }),
      retryPromptRunSegment: vi.fn().mockResolvedValue({
        run_id: 'run_1',
        retry_id: 'retry_1',
        status: 'pending',
        message: 'queued',
        idempotency_key: 'idem-1',
        video_id: 'vid_1',
        segment_id: 'seg_1',
        created_at: '2026-01-01T00:00:00Z',
        started_at: null,
        completed_at: null,
        error: null,
        billing_estimated_mt: 1,
        billing_actual_mt: 0,
        billing_status: 'pending',
        billing_error: null,
      }),
      getPromptRunSegmentRetryStatus: vi.fn().mockResolvedValue({
        run_id: 'run_1',
        retry_id: 'retry_1',
        status: 'completed',
        video_id: 'vid_1',
        segment_id: 'seg_1',
        created_at: '2026-01-01T00:00:00Z',
        started_at: null,
        completed_at: null,
        error: null,
        billing_estimated_mt: 1,
        billing_actual_mt: 1,
        billing_status: 'confirmed',
        billing_error: null,
        field_extraction_succeeded: true,
        transcription_succeeded: true,
        image_embedding_succeeded: null,
      }),
    } as unknown as VideoVectorClient;

    const videoResult = await executeTool(
      'get_prompt_run_video_result',
      { run_id: 'run_1', video_id: 'vid_1' },
      client
    );
    expect((client as any).getPromptRunVideoResult).toHaveBeenCalledWith('run_1', 'vid_1');
    expect(parseContent(videoResult).raw_llm_response).toBeNull();
    expect(videoResult.structuredContent).toMatchObject({
      result_type: 'video',
      result_id: 'video:vid_1:run_1',
      video_id: 'vid_1',
      video_name: 'Episode 1',
      preview_segment_id: 'seg_1',
      preview_start_time: 54,
      preview_end_time: 73,
      segment_uri: 'gs://segments/seg_1.mp4',
      gcs_uri: 'gs://segments/seg_1.mp4',
      thumbnail_gcs_uri: 'gs://segments/seg_1.jpg',
      gif_gcs_uri: 'gs://segments/seg_1.gif',
      thumbnail_uri: 'https://example.com/thumb.jpg',
      gif_uri: 'https://example.com/preview.gif',
    });

    await executeTool('get_prompt_run_failed_segments', { run_id: 'run_1' }, client);
    expect((client as any).getPromptRunFailedSegments).toHaveBeenCalledWith('run_1');

    const retryResult = await executeTool(
      'retry_prompt_run_segment',
      {
        run_id: 'run_1',
        video_id: 'vid_1',
        segment_id: 'seg_1',
        idempotency_key: 'idem-1',
      },
      client
    );
    expect((client as any).retryPromptRunSegment).toHaveBeenCalledWith(
      'run_1',
      'vid_1',
      'seg_1',
      'idem-1'
    );
    expect(parseContent(retryResult).billing_status).toBe('pending');

    const retryStatusResult = await executeTool(
      'get_prompt_run_segment_retry_status',
      { run_id: 'run_1', video_id: 'vid_1', segment_id: 'seg_1', retry_id: 'retry_1' },
      client
    );
    expect((client as any).getPromptRunSegmentRetryStatus).toHaveBeenCalledWith(
      'run_1',
      'vid_1',
      'seg_1',
      'retry_1'
    );
    expect(parseContent(retryStatusResult).billing_status).toBe('confirmed');
  });

  it('get_prompt_run_results preserves independent pages and cursors', async () => {
    const payload = {
      run_id: 'run_1', status: 'completed', result_level: 'segment',
      selection_filter: null, selection_summary: { status: 'not_applicable' },
      filtered: null,
      unfiltered: { data: [{ result_id: 'segment:seg_1:run_1', video_id: 'video_1', segment_id: 'seg_1', metadata: { score: 8 } }],
        pagination: { limit: 10, has_more: true, next_cursor: 'unfiltered-next' } },
    };
    const client = { workflowRunResults: vi.fn().mockResolvedValue(payload) } as unknown as VideoVectorClient;
    const result = await executeTool('get_prompt_run_results', {
      run_id: 'run_1', view: 'unfiltered', unfiltered_cursor: 'opaque-next',
    }, client);
    expect((client as any).workflowRunResults).toHaveBeenCalledWith('run_1', {
      result_level: 'segment', view: 'unfiltered', limit: 10,
      video_id: undefined, filtered_cursor: undefined, unfiltered_cursor: 'opaque-next',
    });
    expect(result.structuredContent).toMatchObject({
      contract_version: 2, detail: 'summary', run_id: payload.run_id,
      filtered: null, unfiltered: { pagination: payload.unfiltered.pagination, data: [{ result_id: 'segment:seg_1:run_1', metadata_fields: ['score'] }] },
    });
    expect(parseContent(result)).toEqual(result.structuredContent);
  });

  it('get_prompt_run_results rejects an oversized page', async () => {
    const client = { workflowRunResults: vi.fn() } as unknown as VideoVectorClient;
    const result = await executeTool('get_prompt_run_results', { run_id: 'run_1', limit: 51 }, client);
    expect(result.isError).toBe(true);
    expect((client as any).workflowRunResults).not.toHaveBeenCalled();
  });

  it('rejects non-string idempotency keys for prompt-run segment retries', async () => {
    const client = {
      retryPromptRunSegment: vi.fn(),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'retry_prompt_run_segment',
      {
        run_id: 'run_1',
        video_id: 'vid_1',
        segment_id: 'seg_1',
        idempotency_key: 123,
      },
      client
    );

    expect(result.isError).toBe(true);
    expect(parseContent(result).message).toBe('idempotency_key must be a string');
  });

  it('connector creation and export tools forward scopes and connector destinations', async () => {
    const client = {
      getIdempotencyScope: vi.fn().mockReturnValue('scope-1'),
      createGCSConnector: vi.fn().mockResolvedValue({
        connector_id: 'conn_1',
        name: 'Archive',
        provider: 'gcs',
        status: 'active',
        scopes: ['import', 'export'],
        import_mode: 'new_only',
        export_base_path: 'exports/',
        bucket: 'bucket-a',
        region: null,
        storage_account: null,
        container: null,
        gcp_project_id: 'proj_1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        last_tested_at: null,
        last_test_result: null,
        last_test_error: null,
      }),
      exportIndexMetadata: vi.fn().mockResolvedValue({
        export_id: 'exp_1',
        status: 'processing',
      }),
      exportPromptRun: vi.fn().mockResolvedValue({
        export_id: 'exp_2',
        status: 'processing',
      }),
    } as unknown as VideoVectorClient;

    const connectorResult = await executeTool(
      'create_gcs_connector',
      {
        name: 'Archive',
        bucket: 'bucket-a',
        gcp_project_id: 'proj_1',
        credentials_json: {
          type: 'service_account',
          project_id: 'proj_1',
          private_key_id: 'pk_1',
          private_key: 'secret',
          client_email: 'svc@example.com',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
        scopes: ['import', 'export'],
        export_base_path: 'exports/',
        import_mode: 'new_only',
        idempotency_key: 'gcs-create-1',
      },
      client
    );
    expect((client as any).createGCSConnector).toHaveBeenCalledWith(
      {
        name: 'Archive',
        bucket: 'bucket-a',
        gcp_project_id: 'proj_1',
        credentials_json: {
          type: 'service_account',
          project_id: 'proj_1',
          private_key_id: 'pk_1',
          private_key: 'secret',
          client_email: 'svc@example.com',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
        scopes: ['import', 'export'],
        export_base_path: 'exports/',
        import_mode: 'new_only',
      },
      'gcs-create-1'
    );
    expect((parseContent(connectorResult).connector as any).import_mode).toBe('new_only');

    await executeTool(
      'export_index_metadata',
      {
        index_id: 'idx_1',
        prompt_run_ids: ['run_1'],
        destination_connector_id: 'conn_1',
        destination_subpath: 'daily/',
        idempotency_key: 'export-1',
      },
      client
    );
    expect((client as any).exportIndexMetadata).toHaveBeenCalledWith(
      'idx_1',
      {
        prompt_run_ids: ['run_1'],
        destination_connector_id: 'conn_1',
        destination_subpath: 'daily/',
      },
      'export-1'
    );

    await executeTool(
      'export_prompt_run',
      {
        run_id: 'run_1',
        destination_connector_id: 'conn_1',
        destination_subpath: 'daily/',
        idempotency_key: 'export-2',
      },
      client
    );
    expect((client as any).exportPromptRun).toHaveBeenCalledWith(
      'run_1',
      {
        destination_connector_id: 'conn_1',
        destination_subpath: 'daily/',
      },
      'export-2'
    );
  });

  it('requires a caller-stable idempotency key for every connector provider', async () => {
    const client = {
      createGCSConnector: vi.fn(),
      createS3Connector: vi.fn(),
      createAzureConnector: vi.fn(),
    } as unknown as VideoVectorClient;
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        'create_gcs_connector',
        {
          name: 'GCS',
          bucket: 'bucket-a',
          gcp_project_id: 'project-1',
          credentials_json: {
            type: 'service_account',
            project_id: 'project-1',
            private_key_id: 'key-1',
            private_key: 'secret',
            client_email: 'service@example.com',
            token_uri: 'https://oauth2.googleapis.com/token',
          },
        },
      ],
      [
        'create_s3_connector',
        {
          name: 'S3',
          bucket: 'bucket-a',
          region: 'us-east-1',
          aws_access_key_id: 'A'.repeat(20),
          aws_secret_access_key: 's'.repeat(40),
        },
      ],
      [
        'create_azure_connector',
        {
          name: 'Azure',
          storage_account: 'accounta',
          container: 'container-a',
          tenant_id: '11111111-1111-4111-8111-111111111111',
          client_id: '22222222-2222-4222-8222-222222222222',
          client_secret: 'secret',
        },
      ],
    ];

    for (const [toolName, args] of cases) {
      const result = await executeTool(toolName, args, client);
      expect(result.isError).toBe(true);
      expect(parseContent(result).message).toBe('idempotency_key is required');
    }
    expect((client as any).createGCSConnector).not.toHaveBeenCalled();
    expect((client as any).createS3Connector).not.toHaveBeenCalled();
    expect((client as any).createAzureConnector).not.toHaveBeenCalled();
  });

  it.each(['index', 'prompt_run', 'search_snapshot'])('returns valid durable %s export status without minting a bearer credential', async exportType => {
    const client = {
      getExportStatus: vi.fn().mockResolvedValue({
        export_id: 'exp_1',
        export_type: exportType,
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
        file_size_bytes: 104857600,
        error_message: null,
        last_error: null,
        destination_type: 'download',
        destination_connector_id: null,
        destination_base_path: null,
        destination_subpath: null,
        destination_uri: null,
        gcs_uri: 'gs://private-exports/exports/user-1/export.json',
        export_params: {},
      }),
      mintExportDownloadUrl: vi.fn(),
    } as unknown as VideoVectorClient;

    const result = await executeTool('get_export_status', { export_id: 'exp_1' }, client);
    const payload = parseContent(result);

    expect((client as any).getExportStatus).toHaveBeenCalledWith('exp_1');
    expect((client as any).mintExportDownloadUrl).not.toHaveBeenCalled();
    expect(payload.file_size_bytes).toBe(104857600);
    expect(payload.download_url).toBe('/api/v2/exports/exp_1/download');
    expect(payload.destination_type).toBe('download');
    expect(payload.destination_connector_id).toBeNull();
    expect(payload.destination_uri).toBeNull();
    expect(String(payload.download_url)).not.toContain('?token=');
    const links = payload.links as Record<string, string>;
    const openLink = new URL(links.open_in_app);
    expect(openLink.origin).toBe('https://app.vectormethods.com');
    expect(openLink.pathname).toBe('/jobs');
    expect(Object.fromEntries(openLink.searchParams)).toEqual({
      tab: 'exports', export: 'exp_1',
      ...(exportType === 'index' ? {} : { source_kind: exportType, source_id: 'idx_1' }),
      scope: exportType === 'search_snapshot' ? 'search_results' : 'all',
    });
    expect(links.download_json).toBe(`${links.open_in_app}&action=download`);
    expect(String(payload.tip)).toContain('links.download_json');
    expect(String(payload.tip)).toContain('authenticated API endpoint');
    expect(result.structuredContent).toEqual(payload);
    expect(payload.export_type).toBe(exportType);
    const validate = new AjvJsonSchemaValidator().getValidator(getToolDefinition('get_export_status')!.outputSchema!);
    expect(validate(payload).valid).toBe(true);
  });

  it('preserves connector delivery fields in durable export status', async () => {
    const client = {
      getExportStatus: vi.fn().mockResolvedValue({
        export_id: 'exp_connector',
        export_type: 'prompt_run',
        target_id: 'run_1',
        created_at: '2026-07-17T00:00:00Z',
        status: 'completed',
        queue_status: 'succeeded',
        attempts: 1,
        max_attempts: 3,
        available_at: '2026-07-17T00:00:00Z',
        started_at: '2026-07-17T00:00:01Z',
        completed_at: '2026-07-17T00:00:02Z',
        updated_at: '2026-07-17T00:00:02Z',
        download_url: null,
        file_size_bytes: 2048,
        error_message: null,
        last_error: null,
        destination_type: 'connector',
        destination_connector_id: 'conn_1',
        destination_base_path: 'exports/',
        destination_subpath: 'daily/',
        destination_uri: 's3://customer-bucket/exports/daily/export.json',
        gcs_uri: 's3://customer-bucket/exports/daily/export.json',
        export_params: {
          destination_connector_id: 'conn_1',
          destination_subpath: 'daily/',
        },
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'get_export_status',
      { export_id: 'exp_connector' },
      client
    );
    const payload = parseContent(result);

    expect(payload.download_url).toBeNull();
    expect(payload.destination_type).toBe('connector');
    expect(payload.destination_connector_id).toBe('conn_1');
    expect(payload.destination_uri).toBe(
      's3://customer-bucket/exports/daily/export.json'
    );
    expect(String(payload.tip)).toContain('configured connector destination');
    expect(payload.links).toEqual({
      open_in_app: 'https://app.vectormethods.com/jobs?tab=exports&export=exp_connector&source_kind=prompt_run&source_id=run_1&scope=all',
    });
  });

  it.each(['pending', 'processing', 'completed'])('keeps unavailable %s direct status downloads null', async status => {
    const client = {
      getExportStatus: vi.fn().mockResolvedValue({
        export_id: 'exp_processing',
        export_type: 'index',
        target_id: 'idx_1',
        created_at: '2026-07-17T00:00:00Z',
        status,
        queue_status: status === 'completed' ? 'succeeded' : status === 'pending' ? 'queued' : 'running',
        attempts: 1,
        max_attempts: 3,
        available_at: null,
        started_at: '2026-07-17T00:00:01Z',
        completed_at: null,
        updated_at: '2026-07-17T00:00:02Z',
        download_url: null,
        file_size_bytes: null,
        error_message: null,
        last_error: null,
        destination_type: 'download',
        destination_connector_id: null,
        destination_base_path: null,
        destination_subpath: null,
        destination_uri: null,
        gcs_uri: null,
        export_params: {},
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'get_export_status',
      { export_id: 'exp_processing' },
      client
    );
    const payload = parseContent(result);

    expect(payload.download_url).toBeNull();
    expect(payload.destination_type).toBe('download');
    expect(payload.links).toEqual({
      open_in_app: 'https://app.vectormethods.com/jobs?tab=exports&export=exp_processing&scope=all',
    });
    expect(String(payload.tip)).toContain(status === 'pending' ? 'queued'
      : status === 'processing' ? 'still processing' : 'no authenticated direct-download endpoint');
  });

  it('returns a terminal failed export as resource state, not a tool invocation error', async () => {
    const client = {
      getExportStatus: vi.fn().mockResolvedValue({
        export_id: 'exp_failed',
        export_type: 'index',
        target_id: 'idx_1',
        created_at: '2026-07-17T00:00:00Z',
        status: 'failed',
        queue_status: 'failed',
        attempts: 3,
        max_attempts: 3,
        available_at: null,
        started_at: '2026-07-17T00:00:01Z',
        completed_at: '2026-07-17T00:00:02Z',
        updated_at: '2026-07-17T00:00:02Z',
        download_url: null,
        file_size_bytes: null,
        error_message: 'Export destination rejected the write',
        last_error: 'provider detail',
        destination_type: 'connector',
        destination_connector_id: 'conn_1',
        destination_base_path: 'exports/',
        destination_subpath: null,
        destination_uri: null,
        gcs_uri: null,
        export_params: {},
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'get_export_status',
      { export_id: 'exp_failed' },
      client
    );

    expect(result.isError).not.toBe(true);
    expect(parseContent(result)).toMatchObject({
      export_id: 'exp_failed',
      status: 'failed',
      error_message: 'Export destination rejected the write',
      links: { open_in_app: 'https://app.vectormethods.com/jobs?tab=exports&export=exp_failed&scope=all' },
    });
    expect(parseContent(result).links).not.toHaveProperty('download_json');
  });

  it('explicitly mints and returns the exact five-field export capability', async () => {
    const response = {
      export_id: 'exp_1',
      status: 'completed',
      destination_type: 'download',
      destination_connector_id: null,
      download_url:
        'https://api.vectormethods.com/api/v2/exports/exp_1/download?token=bounded-test-token',
    };
    const client = {
      getExportStatus: vi.fn(),
      mintExportDownloadUrl: vi.fn().mockResolvedValue(response),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'get_export_download_url',
      { export_id: 'exp_1' },
      client
    );

    expect((client as any).getExportStatus).not.toHaveBeenCalled();
    expect((client as any).mintExportDownloadUrl).toHaveBeenCalledWith('exp_1');
    expect(parseContent(result)).toEqual(response);
  });

  it('keeps explicit connector capability responses nullable', async () => {
    const client = {
      mintExportDownloadUrl: vi.fn().mockResolvedValue({
        export_id: 'exp_connector',
        status: 'completed',
        destination_type: 'connector',
        destination_connector_id: 'conn_1',
        download_url: null,
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'get_export_download_url',
      { export_id: 'exp_connector' },
      client
    );

    expect(parseContent(result)).toEqual({
      export_id: 'exp_connector',
      status: 'completed',
      destination_type: 'connector',
      destination_connector_id: 'conn_1',
      download_url: null,
    });
  });

  it('redacts export mint diagnostics through the canonical MCP error', async () => {
    const client = {
      mintExportDownloadUrl: vi.fn().mockRejectedValue(
        new VideoVectorApiError(
          'Bearer minting is temporarily unavailable',
          'metadata_export_token_configuration_invalid',
          503,
          { retryable: true },
          'req_export_1'
        )
      ),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'get_export_download_url',
      { export_id: 'exp_1' },
      client
    );
    const payload = parseContent(result);

    expect(result.isError).toBe(true);
    expect(payload.code).toBe('metadata_export_token_configuration_invalid');
    expect(payload.message).toBe('A download link is temporarily unavailable.');
    expect(payload.details).toBeUndefined();
    expect(payload.request_id).toBeUndefined();
  });

  it('delegates GCS connector retry replay to the durable backend boundary', async () => {
    const client = {
      getIdempotencyScope: vi.fn().mockReturnValue('scope-1'),
      createGCSConnector: vi.fn().mockResolvedValue({
        connector_id: 'conn_1',
        name: 'Archive',
        provider: 'gcs',
        status: 'active',
        scopes: ['import'],
        import_mode: 'all',
        export_base_path: null,
        bucket: 'bucket-a',
        region: null,
        storage_account: null,
        container: null,
        gcp_project_id: 'proj_1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        last_tested_at: null,
        last_test_result: null,
        last_test_error: null,
      }),
    } as unknown as VideoVectorClient;

    const args = {
      name: 'Archive',
      bucket: 'bucket-a',
      gcp_project_id: 'proj_1',
      credentials_json: {
        type: 'service_account',
        project_id: 'proj_1',
        private_key_id: 'pk_1',
        private_key: 'secret',
        client_email: 'svc@example.com',
        token_uri: 'https://oauth2.googleapis.com/token',
      },
      idempotency_key: 'gcs-dedupe-1',
    };

    const first = await executeTool('create_gcs_connector', args, client);
    const second = await executeTool(
      'create_gcs_connector',
      {
        ...args,
        scopes: [],
        export_base_path: '',
        import_mode: 'all',
        idempotency_key: ' gcs-dedupe-1 ',
      },
      client
    );

    expect((client as any).createGCSConnector).toHaveBeenCalledTimes(2);
    expect((client as any).createGCSConnector.mock.calls[0][1]).toBe('gcs-dedupe-1');
    expect((client as any).createGCSConnector.mock.calls[1][1]).toBe('gcs-dedupe-1');
    expect(parseContent(first)).toEqual(parseContent(second));
  });

  it('delegates GCS connector semantic mismatch enforcement to the backend', async () => {
    const client = {
      getIdempotencyScope: vi.fn().mockReturnValue('scope-1'),
      createGCSConnector: vi.fn().mockResolvedValue({
        connector_id: 'conn_1',
        name: 'Archive',
        provider: 'gcs',
        status: 'active',
        scopes: ['import'],
        import_mode: 'all',
        export_base_path: null,
        bucket: 'bucket-a',
        region: null,
        storage_account: null,
        container: null,
        gcp_project_id: 'proj_1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        last_tested_at: null,
        last_test_result: null,
        last_test_error: null,
      }),
    } as unknown as VideoVectorClient;

    await executeTool(
      'create_gcs_connector',
      {
        name: 'Archive',
        bucket: 'bucket-a',
        gcp_project_id: 'proj_1',
        credentials_json: {
          type: 'service_account',
          project_id: 'proj_1',
          private_key_id: 'pk_1',
          private_key: 'secret',
          client_email: 'svc@example.com',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
        idempotency_key: 'gcs-dedupe-2',
      },
      client
    );

    const result = await executeTool(
      'create_gcs_connector',
      {
        name: 'Archive',
        bucket: 'bucket-b',
        gcp_project_id: 'proj_1',
        credentials_json: {
          type: 'service_account',
          project_id: 'proj_1',
          private_key_id: 'pk_1',
          private_key: 'secret',
          client_email: 'svc@example.com',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
        idempotency_key: 'gcs-dedupe-2',
      },
      client
    );

    expect(result.isError).not.toBe(true);
    expect((client as any).createGCSConnector).toHaveBeenCalledTimes(2);
    expect((client as any).createGCSConnector.mock.calls[1][0].bucket).toBe('bucket-b');
    expect((client as any).createGCSConnector.mock.calls[1][1]).toBe('gcs-dedupe-2');
  });

  it('scopes GCS retry dedupe by client identity', async () => {
    const clientA = {
      getIdempotencyScope: vi.fn().mockReturnValue('scope-a'),
      createGCSConnector: vi.fn().mockResolvedValue({
        connector_id: 'conn_a',
        name: 'Archive A',
        provider: 'gcs',
        status: 'active',
        scopes: ['import'],
        import_mode: 'all',
        export_base_path: null,
        bucket: 'bucket-a',
        region: null,
        storage_account: null,
        container: null,
        gcp_project_id: 'proj_1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        last_tested_at: null,
        last_test_result: null,
        last_test_error: null,
      }),
    } as unknown as VideoVectorClient;
    const clientB = {
      getIdempotencyScope: vi.fn().mockReturnValue('scope-b'),
      createGCSConnector: vi.fn().mockResolvedValue({
        connector_id: 'conn_b',
        name: 'Archive B',
        provider: 'gcs',
        status: 'active',
        scopes: ['import'],
        import_mode: 'all',
        export_base_path: null,
        bucket: 'bucket-b',
        region: null,
        storage_account: null,
        container: null,
        gcp_project_id: 'proj_2',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        last_tested_at: null,
        last_test_result: null,
        last_test_error: null,
      }),
    } as unknown as VideoVectorClient;

    await executeTool(
      'create_gcs_connector',
      {
        name: 'Archive A',
        bucket: 'bucket-a',
        gcp_project_id: 'proj_1',
        credentials_json: {
          type: 'service_account',
          project_id: 'proj_1',
          private_key_id: 'pk_1',
          private_key: 'secret',
          client_email: 'svc-a@example.com',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
        idempotency_key: 'shared-key',
      },
      clientA
    );

    const result = await executeTool(
      'create_gcs_connector',
      {
        name: 'Archive B',
        bucket: 'bucket-b',
        gcp_project_id: 'proj_2',
        credentials_json: {
          type: 'service_account',
          project_id: 'proj_2',
          private_key_id: 'pk_2',
          private_key: 'secret',
          client_email: 'svc-b@example.com',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
        idempotency_key: 'shared-key',
      },
      clientB
    );

    expect(result.isError).not.toBe(true);
    expect((clientA as any).createGCSConnector).toHaveBeenCalledTimes(1);
    expect((clientB as any).createGCSConnector).toHaveBeenCalledTimes(1);
  });

  it('list_import_jobs normalizes allowed statuses and rejects stale values', async () => {
    const client = {
      listImportJobs: vi.fn().mockResolvedValue([makeImportJob('scanning')]),
    } as unknown as VideoVectorClient;

    await executeTool('list_import_jobs', { status: 'SCANNING' }, client);
    expect((client as any).listImportJobs).toHaveBeenCalledWith('scanning');

    const bad = await executeTool('list_import_jobs', { status: 'running' }, client);
    const badPayload = parseContent(bad);
    expect(bad.isError).toBe(true);
    expect(String(badPayload.message)).toContain('status must be one of');
  });

  it('returns a terminal failed import as resource state, not a tool invocation error', async () => {
    const client = {
      getImportJob: vi.fn().mockResolvedValue({
        ...makeImportJob('failed'),
        error_message: 'Source object could not be read',
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool('get_import_job', { job_id: 'job_1' }, client);

    expect(result.isError).not.toBe(true);
    expect(parseContent(result)).toMatchObject({
      job_id: 'job_1',
      status: 'failed',
      error_message: 'This import job needs attention. Open the job in the app to review the failed or skipped files before retrying.',
    });
  });

  it('forwards idempotency keys for prompt-run cancellation, import-job cancellation, and webhook writes', async () => {
    const client = {
      cancelPromptRun: vi.fn().mockResolvedValue({
        run_id: 'run_1',
        status: 'cancelled',
        prompt_id: 'prompt_1',
        prompt_name: 'Prompt',
        total_videos: 3,
        total_audios: 0,
        total_images: 0,
        completed_videos: 1,
        completed_audios: 0,
        completed_images: 0,
        failed_videos: 0,
        failed_audios: 0,
        failed_images: 0,
        partial_videos: 0,
        partial_audios: 0,
        partial_images: 0,
        cancelled_videos: 2,
        cancelled_audios: 0,
        cancelled_images: 0,
        total_segments: 4,
        completed_segments: 2,
        field_extraction_succeeded: true,
        field_extraction_failures: 0,
        enable_transcription: true,
        transcription_succeeded: true,
        transcription_failures: 0,
        enable_image_embedding: true,
        image_embedding_succeeded: true,
        image_embedding_failures: 0,
        run_context: { index_id: 'idx_1', video_ids: ['vid_1', 'vid_2', 'vid_3'] },
        video_segmentation_type: 'content_aware',
        audio_segmentation_type: 'content_aware',
        video_segment_duration: null,
        audio_segment_duration: null,
        processing_model: null,
        video_level_enabled: false,
        video_level_total_items: 0,
        video_level_completed_items: 0,
        video_level_failed_items: 0,
        video_level_partial_items: 0,
        billing_estimated_mt: 3,
        billing_actual_mt: 1,
        billing_status: 'confirmed',
        billing_error: null,
        executed_at: '2026-01-01T00:00:00Z',
        error_message: null,
        stop_state: { requested_at: '2026-01-01T00:01:00Z' },
        marker: null,
      }),
      cancelImportJob: vi.fn().mockResolvedValue(makeImportJob('cancelled')),
      updateWebhook: vi.fn().mockResolvedValue({
        webhook_id: 'wh_1',
        name: 'Prompt Terminal Updated',
        url: 'https://example.com/webhook',
        events: ['prompt.run.completed'],
        index_ids: ['idx_1'],
        status: 'active',
        failure_count: 0,
        last_failure_at: null,
        last_success_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        metadata: null,
      }),
      testWebhook: vi.fn().mockResolvedValue({
        success: true,
        status_code: 200,
        error: null,
      }),
    } as unknown as VideoVectorClient;

    const cancelResult = await executeTool(
      'cancel_prompt_run',
      { run_id: 'run_1', idempotency_key: 'prompt-run-cancel-1' },
      client
    );
    expect((client as any).cancelPromptRun).toHaveBeenCalledWith('run_1', 'prompt-run-cancel-1');
    expect((parseContent(cancelResult).run as Record<string, unknown>).billing_status).toBe('confirmed');

    await executeTool(
      'cancel_import_job',
      { job_id: 'job_1', idempotency_key: 'import-cancel-1' },
      client
    );
    expect((client as any).cancelImportJob).toHaveBeenCalledWith('job_1', 'import-cancel-1');

    await executeTool(
      'update_webhook',
      { webhook_id: 'wh_1', name: 'Prompt Terminal Updated', idempotency_key: 'webhook-update-1' },
      client
    );
    expect((client as any).updateWebhook).toHaveBeenCalledWith(
      'wh_1',
      { name: 'Prompt Terminal Updated' },
      'webhook-update-1'
    );

    const nullOnlyUpdate = await executeTool(
      'update_webhook',
      { webhook_id: 'wh_1', name: null, metadata: null },
      client
    );
    const nullOnlyPayload = parseContent(nullOnlyUpdate);
    expect(nullOnlyUpdate.isError).toBe(true);
    expect(String(nullOnlyPayload.message)).toContain('At least one field must be provided to update');

    const invalidStatusUpdate = await executeTool(
      'update_webhook',
      { webhook_id: 'wh_1', status: 'disabled' },
      client
    );
    const invalidStatusPayload = parseContent(invalidStatusUpdate);
    expect(invalidStatusUpdate.isError).toBe(true);
    expect(String(invalidStatusPayload.message)).toContain("status must be 'active' or 'paused'");

    await executeTool(
      'test_webhook',
      { webhook_id: 'wh_1', idempotency_key: 'webhook-test-1' },
      client
    );
    expect((client as any).testWebhook).toHaveBeenCalledWith('wh_1', 'webhook-test-1');
  });

  it('list_webhook_deliveries validates backend statuses including processing', async () => {
    const client = {
      listWebhookDeliveries: vi
        .fn()
        .mockResolvedValue([makeWebhookDelivery('processing')]),
    } as unknown as VideoVectorClient;

    await executeTool(
      'list_webhook_deliveries',
      { webhook_id: 'wh_1', status: 'PROCESSING', limit: 25 },
      client
    );

    expect((client as any).listWebhookDeliveries).toHaveBeenCalledWith('wh_1', {
      status: 'processing',
      limit: 25,
    });

    const bad = await executeTool(
      'list_webhook_deliveries',
      { webhook_id: 'wh_1', status: 'running' },
      client
    );

    const badPayload = parseContent(bad);
    expect(bad.isError).toBe(true);
    expect(String(badPayload.message)).toContain('status must be one of');
  });
});

it('preserves ordered output pagination and part counters through the public MCP projection', async () => {
  const cursor = 'opaque-next-' + 'x'.repeat(400);
  const outputs = { items: [{ file_id: 'f', file_name: 'long.mp4', source_ordinal: 0, part_index: 100, part_count: 101, source_start_seconds: 1000, source_end_seconds: 1010, video_id: 'v101', title: 'Part 101', status: 'completed', download_url: 'https://private.example/secret' }], next_cursor: cursor, total: 101 };
  const client = { getImportJob: vi.fn().mockResolvedValue({ ...makeImportJob('completed'), phase: 'completed', outputs: { items: [], total: 101, next_cursor: 'first' }, execution: { status: 'not_requested' }, progress: { ...makeImportJob('completed').progress, parts_total: 101, parts_completed: 101, parts_failed: 0 } }), getImportJobOutputs: vi.fn().mockResolvedValue(outputs) } as unknown as VideoVectorClient;
  const response = await executeTool('get_import_job', { job_id: 'job_1', limit: 1, cursor: 'first' }, client);
  expect(response.isError).not.toBe(true);
  expect(client.getImportJobOutputs).toHaveBeenCalledWith('job_1', 1, 'first');
  expect(parseContent(response)).toMatchObject({ phase: 'completed', video_ids: ['v101'], outputs: { next_cursor: cursor, total: 101, items: [{ part_index: 100, source_ordinal: 0 }] }, progress: { parts_total: 101, parts_completed: 101 }, execution: { status: 'not_requested' } });
  expect(JSON.stringify(response)).not.toContain('private.example');
});


it('keeps failure-page cursors and every source descriptor through projection', async () => {
  const failures = Array.from({ length: 100 }, (_, i) => ({ file_id: `f${i}`, file_name: `source${i}.mp4`, source_ordinal: i, status: 'failed', failure: { error: 'private detail', error_code: 'attachment_download_unavailable', refresh_required: true } }));
  const client = { getImportJob: vi.fn().mockResolvedValue({ ...makeImportJob('failed'), failed_files_next_cursor: 'first' }), getImportJobFiles: vi.fn().mockResolvedValue({ items: failures, next_cursor: 'last', total: 101 }) } as unknown as VideoVectorClient;
  const response = await executeTool('get_import_job', { job_id: 'job_1', failed_files_cursor: 'first' }, client);
  expect(response.isError).not.toBe(true);
  expect(client.getImportJobFiles).toHaveBeenCalledWith('job_1', 100, 'first', true);
  const payload = parseContent(response);
  expect(payload.failed_files_next_cursor).toBe('last');
  expect(payload.failed_files).toHaveLength(100);
  expect(payload.failed_files[99]).toMatchObject({ file_id: 'f99', refresh_required: true });
  expect(JSON.stringify(response)).not.toContain('private detail');
});
