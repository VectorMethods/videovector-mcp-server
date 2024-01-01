import { describe, expect, it, vi } from 'vitest';

import { executeTool } from '../src/tools/index.js';
import type { VideoVectorClient } from '../src/client/index.js';

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
  it('execute_prompt requires canonical target and forwards expanded options', async () => {
    const client = {
      executePrompt: vi.fn().mockResolvedValue({
        run_id: 'run_1',
        status: 'pending',
        prompt_name: 'metadata-extractor',
        total_videos: 3,
        total_audios: 2,
        total_images: 1,
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'execute_prompt',
      {
        prompt_id: 'prompt_1',
        target: { type: 'videos', index_id: 'idx_1', video_ids: ['vid_1', 'vid_2'] },
        video_segmentation_type: 'fixed',
        video_segment_duration: 15,
        audio_segmentation_type: 'fixed',
        audio_segment_duration: 12,
        processing_model: 'gemini-2.5-pro',
        enable_transcription: true,
        enable_image_embedding: true,
        idempotency_key: 'exec-1',
      },
      client
    );

    expect((client as any).executePrompt).toHaveBeenCalledWith(
      {
        prompt_id: 'prompt_1',
        target: { type: 'videos', index_id: 'idx_1', video_ids: ['vid_1', 'vid_2'] },
        video_segmentation_type: 'fixed',
        audio_segmentation_type: 'fixed',
        video_segment_duration: 15,
        audio_segment_duration: 12,
        processing_model: 'gemini-2.5-pro',
        enable_transcription: true,
        enable_image_embedding: true,
      },
      'exec-1'
    );

    const payload = parseContent(result) as { results: any[] };
    expect(payload.run_id).toBe('run_1');
    expect(payload.total_media).toBe(6);
  });

  it('execute_prompt validates fixed audio segmentation duration', async () => {
    const client = {
      executePrompt: vi.fn(),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'execute_prompt',
      {
        prompt_id: 'prompt_1',
        target: { type: 'index', index_id: 'idx_1' },
        audio_segmentation_type: 'fixed',
      },
      client
    );

    const payload = parseContent(result);
    expect(result.isError).toBe(true);
    expect(String(payload.message)).toContain('audio_segment_duration is required');
    expect((client as any).executePrompt).not.toHaveBeenCalled();
  });

  it('execute_prompt rejects empty video targets', async () => {
    const client = {
      executePrompt: vi.fn(),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'execute_prompt',
      {
        prompt_id: 'prompt_1',
        target: { type: 'videos', video_ids: [] },
      },
      client
    );

    const payload = parseContent(result);
    expect(result.isError).toBe(true);
    expect(String(payload.message)).toContain('target.video_ids must be a non-empty array');
    expect((client as any).executePrompt).not.toHaveBeenCalled();
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
      enable_transcription: true,
      enable_image_embedding: true,
    });

    const payload = parseContent(result);
    expect(payload.estimated_mt).toBe(12.5);
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
          video_segmentation_type: 'smart',
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
          included_segment_fields: ['summary'],
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
          included_segment_fields: ['summary'],
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
          included_segment_fields: ['summary'],
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
        omitted_segment_ids: [],
        template_fields: ['summary'],
        source_fingerprint: 'fp1',
        rendered_prompt_char_count: 42,
        llm_attempted: true,
        attempt_id: 'attempt_1',
        error_message: null,
        started_at: null,
        completed_at: null,
        segment_uri: 'gs://segments/seg_1.mp4',
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

  it('get_prompt_run_results returns structured canonical segment payloads', async () => {
    const client = {
      getPromptRunResults: vi.fn().mockResolvedValue({
        data: [
          {
            segment_id: 'seg_1',
            video_id: 'vid_1',
            run_id: 'run_1',
            prompt_id: 'prompt_1',
            prompt_run_id: 'run_1',
            video_name: 'Episode 1',
            source_index_id: 'idx_1',
            executed_at: '2026-01-01T00:00:00Z',
            start_time: 54,
            end_time: 73,
            segment_uri: 'gs://segments/seg_1.mp4',
            thumbnail_uri: 'https://example.com/thumb.jpg',
            gif_uri: 'https://example.com/preview.gif',
            thumbnail_available: true,
            gif_available: true,
            metadata: { summary: 'A futuristic vehicle scene.' },
            metadata_text: 'A futuristic vehicle scene.',
            processing_warning: null,
            schema_used: null,
            field_extraction_succeeded: true,
            transcription_succeeded: true,
            image_embedding_succeeded: null,
            field_extraction_error: null,
            transcription_error: null,
            image_embedding_error: null,
            marker: { marker_id: 'marker-segment', color: 'blue', note: null, updated_at: null },
            extracted_metadata_markers: {
              summary: { marker_id: 'marker-summary', color: 'green', note: null, updated_at: null },
            },
          },
        ],
        pagination: {
          has_more: false,
          next_cursor: null,
        },
      }),
    } as unknown as VideoVectorClient;

    const result = await executeTool(
      'get_prompt_run_results',
      { run_id: 'run_1', video_id: 'vid_1', limit: 10 },
      client
    );

    expect((client as any).getPromptRunResults).toHaveBeenCalledWith('run_1', {
      videoId: 'vid_1',
      limit: 10,
    });

    const payload = parseContent(result);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]).toMatchObject({
      result_type: 'segment',
      result_id: 'segment:seg_1:run_1',
      video_name: 'Episode 1',
      start_time: 54,
      end_time: 73,
      segment_uri: 'gs://segments/seg_1.mp4',
      extracted_metadata: { summary: 'A futuristic vehicle scene.' },
      extracted_metadata_markers: {
        summary: { marker_id: 'marker-summary', color: 'green', note: null, updated_at: null },
      },
      metadata_markers: {
        summary: { marker_id: 'marker-summary', color: 'green', note: null, updated_at: null },
      },
    });
    expect(result.structuredContent).toEqual(payload);
  });

  it('get_prompt_run_results requires video_id', async () => {
    const client = {
      getPromptRunResults: vi.fn(),
    } as unknown as VideoVectorClient;

    const result = await executeTool('get_prompt_run_results', { run_id: 'run_1' }, client);

    const payload = parseContent(result);
    expect(result.isError).toBe(true);
    expect(String(payload.message)).toContain("Required parameter 'video_id' is missing");
    expect((client as any).getPromptRunResults).not.toHaveBeenCalled();
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

  it('deduplicates GCS connector creation retries when idempotency_key is reused', async () => {
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

    expect((client as any).createGCSConnector).toHaveBeenCalledTimes(1);
    expect(parseContent(first)).toEqual(parseContent(second));
  });

  it('rejects reused GCS connector idempotency keys when the request body changes', async () => {
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

    expect(result.isError).toBe(true);
    expect(parseContent(result).message).toBe('Idempotency key has already been used with a different request');
    expect((client as any).createGCSConnector).toHaveBeenCalledTimes(1);
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
        video_segmentation_type: 'smart',
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
