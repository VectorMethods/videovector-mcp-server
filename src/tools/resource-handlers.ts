/**
 * Resource Tool Handlers
 *
 * Implements handlers for resource-related MCP tools:
 *
 * Discovery/Index Tools:
 * - list_indexes, get_index, list_prompts, create_index
 *
 * Video Tools:
 * - get_video, get_video_segments, list_videos, get_videos_status
 *
 * Prompt Run Tools:
 * - execute_prompt, get_prompt_run_status, get_prompt_run_results
 *
 * Prompt Management Tools:
 * - create_prompt, get_prompt, update_prompt
 *
 * Cloud Connector Tools:
 * - create_gcs_connector, create_s3_connector, create_azure_connector
 * - list_connectors, test_connector, browse_connector_files
 *
 * Import Job Tools:
 * - create_import_job, list_import_jobs, get_import_job, cancel_import_job
 *
 * Export Tools:
 * - export_index_metadata, export_prompt_run, get_export_status
 * - get_export_download_url
 *
 * Webhook Tools:
 * - create_webhook, list_webhooks, get_webhook, update_webhook
 * - list_webhook_events, test_webhook, list_webhook_deliveries
 */


import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { VideoVectorClient } from '../client/index.js';
import type {
  Index,
  Video,
  Segment,
  Prompt,
  PromptRun,
  PromptRunCostEstimate,
  PromptRunFailedSegmentsManifest,
  PromptRunSegmentRetry,
  PromptRunSegmentRetryStatus,
  PromptRunVideoResult,
  SegmentRunResult,
  ExecutePromptRequest,
  ExecutePromptTarget,
  PromptUsageStats,
  PromptVideoLevelConfig,
  TestSchemaResponse,
  Connector,
  ConnectorScope,
  CloudFile,
  ImportJob,
  ImportJobStatus,
  VideoStatus,
  PromptRunProcessingStatus,
  SegmentRunProcessingStatus,
  VideoLevelProcessingStatus,
  ExportJob,
  MarkerInfo,
  Webhook,
  WebhookDelivery,
} from '../types/index.js';
import { TOOL_NAMES } from './definitions.js';
import { formatError, validateRequired, validateOptional, formatDuration } from '../utils/helpers.js';

// ============================================================================
// Response Formatters
// ============================================================================

function formatIndex(index: Index): Record<string, unknown> {
  return {
    index_id: index.index_id,
    name: index.name,
    user_id: index.user_id,
    is_default: index.is_default,
    created_at: index.created_at,
    description: index.description ?? null,
    sort_order: index.sort_order ?? null,
  };
}

type SegmentStatusKey = 'pending' | 'processing' | 'successful' | 'failed';

interface SegmentStatusTotals {
  pending: number;
  processing: number;
  successful: number;
  failed: number;
}

interface ProcessingAggregate {
  by_run_status: Record<string, number>;
  segment_status_totals: SegmentStatusTotals;
  videos_with_processing_details: number;
}

function createSegmentStatusTotals(): SegmentStatusTotals {
  return {
    pending: 0,
    processing: 0,
    successful: 0,
    failed: 0,
  };
}

function parseTimestamp(value?: string | null): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function validateOptionalStringArray(
  args: Record<string, unknown>,
  field: string
): string[] | undefined {
  const value = args[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  if (!value.every((item) => typeof item === 'string')) {
    throw new Error(`${field} must contain only strings`);
  }
  return value;
}

function validateConnectorScopes(args: Record<string, unknown>): ConnectorScope[] | undefined {
  const scopes = validateOptionalStringArray(args, 'scopes');
  if (!scopes) {
    return undefined;
  }
  if (scopes.length === 0) {
    return undefined;
  }

  const allowedScopes: ConnectorScope[] = ['import', 'export'];
  for (const scope of scopes) {
    if (!allowedScopes.includes(scope as ConnectorScope)) {
      throw new Error(`scopes must contain only: ${allowedScopes.join(', ')}`);
    }
  }

  return scopes as ConnectorScope[];
}

function validateConnectorImportMode(args: Record<string, unknown>): 'all' | 'new_only' | undefined {
  const rawImportMode = args.import_mode;
  if (rawImportMode === undefined || rawImportMode === null) {
    return undefined;
  }
  if (rawImportMode !== 'all' && rawImportMode !== 'new_only') {
    throw new Error('import_mode must be one of: all, new_only');
  }
  return rawImportMode;
}

function normalizeRunStatus(status?: string | null): string {
  const normalized = (status ?? '').toString().trim().toLowerCase();
  return normalized || 'unknown';
}

function normalizeSegmentStatus(status?: string | null): SegmentStatusKey {
  const normalized = (status ?? '').toString().trim().toLowerCase();

  if (normalized === 'failed' || normalized === 'error') {
    return 'failed';
  }
  if (normalized === 'successful' || normalized === 'success' || normalized === 'processed' || normalized === 'completed') {
    return 'successful';
  }
  if (normalized === 'processing' || normalized === 'running' || normalized === 'started') {
    return 'processing';
  }
  return 'pending';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function getPromptRunProcessingStatuses(
  processingStatus?: PromptRunProcessingStatus[] | null
): PromptRunProcessingStatus[] {
  return Array.isArray(processingStatus) ? processingStatus : [];
}

function getSegmentProcessingStatuses(
  run: PromptRunProcessingStatus
): SegmentRunProcessingStatus[] {
  return Array.isArray(run.segments) ? run.segments : [];
}

function getRunSegmentCounts(run: PromptRunProcessingStatus): {
  total: number;
  pending: number;
  processing: number;
  successful: number;
  failed: number;
} {
  const derivedTotals = createSegmentStatusTotals();
  const segments = getSegmentProcessingStatuses(run);

  for (const segment of segments) {
    const key = normalizeSegmentStatus(segment.status);
    derivedTotals[key] += 1;
  }

  const pending = isFiniteNumber(run.pending_segments) ? run.pending_segments : derivedTotals.pending;
  const processing = isFiniteNumber(run.processing_segments) ? run.processing_segments : derivedTotals.processing;
  const successful = isFiniteNumber(run.successful_segments) ? run.successful_segments : derivedTotals.successful;
  const failed = isFiniteNumber(run.failed_segments) ? run.failed_segments : derivedTotals.failed;
  const total = isFiniteNumber(run.total_segments)
    ? run.total_segments
    : pending + processing + successful + failed;

  return { total, pending, processing, successful, failed };
}

function formatSegmentProcessingStatus(segment: SegmentRunProcessingStatus): Record<string, unknown> {
  return {
    segment_id: segment.segment_id,
    video_id: segment.video_id,
    status: normalizeSegmentStatus(segment.status),
    start_time: segment.start_time,
    end_time: segment.end_time,
    started_at: segment.started_at,
    completed_at: segment.completed_at,
    updated_at: segment.updated_at,
    error_message: segment.error_message,
    failure_stage: segment.failure_stage,
    attempt_id: segment.attempt_id,
  };
}

function formatVideoLevelProcessingStatus(
  videoLevel?: VideoLevelProcessingStatus | null
): Record<string, unknown> | null {
  if (!videoLevel) {
    return null;
  }

  return {
    status: normalizeRunStatus(videoLevel.status),
    result_available: videoLevel.result_available,
    successful_segment_count: videoLevel.successful_segment_count,
    failed_segment_count: videoLevel.failed_segment_count,
    started_at: videoLevel.started_at,
    completed_at: videoLevel.completed_at,
    updated_at: videoLevel.updated_at,
    error_message: videoLevel.error_message,
    attempt_id: videoLevel.attempt_id,
  };
}

function formatPromptRunProcessingStatus(
  run: PromptRunProcessingStatus,
  includeSegments: boolean
): Record<string, unknown> {
  const segmentCounts = getRunSegmentCounts(run);
  const segments = getSegmentProcessingStatuses(run);

  const payload: Record<string, unknown> = {
    run_id: run.run_id,
    prompt_id: run.prompt_id,
    status: normalizeRunStatus(run.status),
    created_at: run.created_at,
    updated_at: run.updated_at,
    attempt_id: run.attempt_id,
    segment_counts: segmentCounts,
    video_level: formatVideoLevelProcessingStatus(run.video_level),
  };

  if (includeSegments) {
    payload.segments = segments.map(formatSegmentProcessingStatus);
  } else {
    payload.failed_segment_ids = segments
      .filter((segment) => normalizeSegmentStatus(segment.status) === 'failed')
      .map((segment) => segment.segment_id);
  }

  return payload;
}

function buildVideoProcessingSummary(
  processingStatus?: PromptRunProcessingStatus[] | null
): Record<string, unknown> {
  const runs = getPromptRunProcessingStatuses(processingStatus);

  if (runs.length === 0) {
    return {
      total_runs: 0,
      by_run_status: {},
      segment_status_totals: createSegmentStatusTotals(),
    };
  }

  const byRunStatus: Record<string, number> = {};
  const segmentTotals = createSegmentStatusTotals();
  const runsWithFailures: string[] = [];

  for (const run of runs) {
    const normalizedRunStatus = normalizeRunStatus(run.status);
    byRunStatus[normalizedRunStatus] = (byRunStatus[normalizedRunStatus] || 0) + 1;

    const counts = getRunSegmentCounts(run);
    segmentTotals.pending += counts.pending;
    segmentTotals.processing += counts.processing;
    segmentTotals.successful += counts.successful;
    segmentTotals.failed += counts.failed;

    if (counts.failed > 0 || normalizedRunStatus === 'failed') {
      runsWithFailures.push(run.run_id);
    }
  }

  const sortedRuns = [...runs].sort((a, b) => {
    const aTime = parseTimestamp(a.updated_at ?? a.created_at);
    const bTime = parseTimestamp(b.updated_at ?? b.created_at);
    return bTime - aTime;
  });
  const latestRun = sortedRuns[0];

  return {
    total_runs: runs.length,
    latest_run_id: latestRun?.run_id ?? null,
    latest_run_status: latestRun ? normalizeRunStatus(latestRun.status) : null,
    runs_with_failures: runsWithFailures,
    by_run_status: byRunStatus,
    segment_status_totals: segmentTotals,
  };
}

function aggregateProcessingStatusSnapshots(
  snapshots: Array<PromptRunProcessingStatus[] | null | undefined>
): ProcessingAggregate {
  const byRunStatus: Record<string, number> = {};
  const segmentTotals = createSegmentStatusTotals();
  let videosWithProcessingDetails = 0;

  for (const snapshot of snapshots) {
    const runs = getPromptRunProcessingStatuses(snapshot);
    if (runs.length === 0) {
      continue;
    }

    videosWithProcessingDetails += 1;

    for (const run of runs) {
      const normalizedRunStatus = normalizeRunStatus(run.status);
      byRunStatus[normalizedRunStatus] = (byRunStatus[normalizedRunStatus] || 0) + 1;

      const counts = getRunSegmentCounts(run);
      segmentTotals.pending += counts.pending;
      segmentTotals.processing += counts.processing;
      segmentTotals.successful += counts.successful;
      segmentTotals.failed += counts.failed;
    }
  }

  return {
    by_run_status: byRunStatus,
    segment_status_totals: segmentTotals,
    videos_with_processing_details: videosWithProcessingDetails,
  };
}

function formatVideo(video: Video, includeSegmentStatuses = false): Record<string, unknown> {
  const processingStatus = getPromptRunProcessingStatuses(video.processing_status);

  return {
    video_id: video.video_id,
    title: video.title,
    media_type: video.media_type,
    status: video.status,
    processing_summary: buildVideoProcessingSummary(processingStatus),
    processing_status: processingStatus.map((run) =>
      formatPromptRunProcessingStatus(run, includeSegmentStatuses)
    ),
    created_at: video.created_at,
    updated_at: video.updated_at,
    duration_seconds: video.duration_seconds ?? null,
    metadata_keys: video.metadata_keys,
    marker: formatMarker(video.marker),
  };
}

function formatVideoStatusResponse(
  videoStatus: VideoStatus,
  includeSegmentStatuses = true
): Record<string, unknown> {
  const processingStatus = getPromptRunProcessingStatuses(videoStatus.processing_status);

  return {
    video_id: videoStatus.video_id,
    status: videoStatus.status,
    processing_summary: buildVideoProcessingSummary(processingStatus),
    processing_status: processingStatus.map((run) =>
      formatPromptRunProcessingStatus(run, includeSegmentStatuses)
    ),
  };
}

function formatSegment(segment: Segment): Record<string, unknown> {
  return {
    segment_id: segment.segment_id,
    video_id: segment.video_id,
    time_range: formatDuration(segment.start_time, segment.end_time),
    start_time: segment.start_time,
    end_time: segment.end_time,
    duration: Math.round((segment.end_time - segment.start_time) * 100) / 100,
    gcs_uri: segment.gcs_uri,
    thumbnail_gcs_uri: segment.thumbnail_gcs_uri,
    gif_gcs_uri: segment.gif_gcs_uri,
    thumbnail_uri: segment.thumbnail_uri,
    gif_uri: segment.gif_uri,
    processed: segment.processed,
    processing_failed: segment.processing_failed,
    segment_status: normalizeSegmentStatus(segment.segment_status),
    failure_stage: segment.failure_stage,
    failure_message: segment.failure_message,
    attempt_id: segment.attempt_id,
    status_source: segment.status_source,
    metadata: segment.metadata,
    metadata_text: segment.metadata_text,
    thumbnail_available: segment.thumbnail_available,
    thumbnail_data: segment.thumbnail_data,
    gif_available: segment.gif_available,
    gif_data: segment.gif_data,
    from_run_id: segment.from_run_id,
    error_message: segment.error_message,
    processing_warning: segment.processing_warning,
    marker: formatMarker(segment.marker),
    metadata_markers: formatMetadataMarkers(segment.metadata_markers),
    operations: {
      field_extraction: {
        succeeded: segment.field_extraction_succeeded,
        error: segment.field_extraction_error,
      },
      transcription: {
        succeeded: segment.transcription_succeeded,
        error: segment.transcription_error,
      },
      image_embedding: {
        succeeded: segment.image_embedding_succeeded,
        error: segment.image_embedding_error,
      },
    },
  };
}

function formatMarker(marker?: MarkerInfo | null): Record<string, unknown> | null {
  if (!marker) {
    return null;
  }

  return {
    marker_id: marker.marker_id,
    color: marker.color,
    note: marker.note,
    updated_at: marker.updated_at,
  };
}

function formatMetadataMarkers(
  markers?: Record<string, MarkerInfo> | null
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(markers ?? {}).map(([field, marker]) => [field, formatMarker(marker)])
  );
}

function formatVideoLevelConfig(
  config?: PromptVideoLevelConfig | null
): Record<string, unknown> | null {
  if (!config) {
    return null;
  }

  return {
    instructions_text: config.instructions_text,
    included_segment_fields: config.included_segment_fields,
    json_schema: config.json_schema,
  };
}

function formatSemanticIndexingConfig(
  config?: Prompt['semantic_indexing'] | null
): Record<string, unknown> {
  return {
    disabled_segment_fields: config?.disabled_segment_fields ?? [],
    disabled_video_level_fields: config?.disabled_video_level_fields ?? [],
  };
}

function formatPrompt(prompt: Prompt): Record<string, unknown> {
  const schema = prompt.json_schema as Record<string, unknown> | null | undefined;
  const properties = schema?.properties as Record<string, unknown> | undefined;

  return {
    prompt_id: prompt.prompt_id,
    name: prompt.name,
    description: prompt.description,
    prompt_text: prompt.prompt_text,
    json_schema: prompt.json_schema,
    video_level: formatVideoLevelConfig(prompt.video_level),
    semantic_indexing: formatSemanticIndexingConfig(prompt.semantic_indexing),
    is_active: prompt.is_active,
    created_at: prompt.created_at,
    schema_fields: properties ? Object.keys(properties) : [],
  };
}

function formatPromptRun(run: PromptRun): Record<string, unknown> {
  const totalMedia = run.total_videos + run.total_audios + run.total_images;
  const completedMedia = run.completed_videos + run.completed_audios + run.completed_images;
  const failedMedia = run.failed_videos + run.failed_audios + run.failed_images;
  const partialMedia = run.partial_videos + run.partial_audios + run.partial_images;
  const cancelledMedia = run.cancelled_videos + run.cancelled_audios + run.cancelled_images;

  return {
    run_id: run.run_id,
    prompt_id: run.prompt_id,
    prompt_name: run.prompt_name,
    status: run.status,
    progress: {
      total_media: totalMedia,
      completed: completedMedia,
      failed: failedMedia,
      partial: partialMedia,
      cancelled: cancelledMedia,
      percent: totalMedia > 0 ? Math.round((completedMedia / totalMedia) * 100) : 0,
      total_segments: run.total_segments,
      completed_segments: run.completed_segments,
    },
    media_breakdown: {
      videos: {
        total: run.total_videos,
        completed: run.completed_videos,
        failed: run.failed_videos,
        partial: run.partial_videos,
        cancelled: run.cancelled_videos,
      },
      audios: {
        total: run.total_audios,
        completed: run.completed_audios,
        failed: run.failed_audios,
        partial: run.partial_audios,
        cancelled: run.cancelled_audios,
      },
      images: {
        total: run.total_images,
        completed: run.completed_images,
        failed: run.failed_images,
        partial: run.partial_images,
        cancelled: run.cancelled_images,
      },
    },
    operations: {
      field_extraction: {
        succeeded: run.field_extraction_succeeded,
        failures: run.field_extraction_failures,
      },
      transcription: {
        enabled: run.enable_transcription,
        succeeded: run.transcription_succeeded,
        failures: run.transcription_failures,
      },
      image_embedding: {
        enabled: run.enable_image_embedding,
        succeeded: run.image_embedding_succeeded,
        failures: run.image_embedding_failures,
      },
    },
    configuration: {
      run_context: run.run_context,
      video_segmentation_type: run.video_segmentation_type,
      audio_segmentation_type: run.audio_segmentation_type,
      video_segment_duration: run.video_segment_duration,
      audio_segment_duration: run.audio_segment_duration,
      processing_model: run.processing_model,
    },
    video_level: {
      enabled: run.video_level_enabled,
      total_items: run.video_level_total_items,
      completed_items: run.video_level_completed_items,
      failed_items: run.video_level_failed_items,
      partial_items: run.video_level_partial_items,
    },
    billing_estimated_mt: run.billing_estimated_mt,
    billing_actual_mt: run.billing_actual_mt,
    billing_status: run.billing_status,
    billing_error: run.billing_error,
    billing: {
      estimated_mt: run.billing_estimated_mt,
      actual_mt: run.billing_actual_mt,
      status: run.billing_status,
      error: run.billing_error,
    },
    executed_at: run.executed_at,
    error_message: run.error_message,
    stop_state: run.stop_state ?? null,
    marker: formatMarker(run.marker),
  };
}

function formatSegmentRunResult(result: SegmentRunResult): Record<string, unknown> {
  const marker = formatMarker(result.marker);
  const extractedMetadataMarkers = formatMetadataMarkers(
    result.extracted_metadata_markers ?? result.metadata_markers
  );
  return {
    result_type: result.result_type ?? 'segment',
    result_id: result.result_id ?? `segment:${result.segment_id}:${result.run_id}`,
    segment_id: result.segment_id,
    video_id: result.video_id,
    run_id: result.run_id,
    prompt_id: result.prompt_id,
    prompt_run_id: result.prompt_run_id ?? result.run_id,
    video_name: result.video_name ?? null,
    source_index_id: result.source_index_id ?? null,
    metadata: result.metadata,
    extracted_metadata: result.metadata,
    metadata_text: result.metadata_text,
    text_content: result.metadata_text,
    content_preview: result.metadata_text,
    start_time: result.start_time ?? null,
    end_time: result.end_time ?? null,
    segment_uri: result.segment_uri ?? null,
    gcs_uri: result.gcs_uri ?? null,
    thumbnail_gcs_uri: result.thumbnail_gcs_uri ?? null,
    gif_gcs_uri: result.gif_gcs_uri ?? null,
    thumbnail_uri: result.thumbnail_uri ?? null,
    gif_uri: result.gif_uri ?? null,
    thumbnail_available: Boolean(result.thumbnail_available),
    gif_available: Boolean(result.gif_available),
    operations: {
      field_extraction: {
        succeeded: result.field_extraction_succeeded,
        error: result.field_extraction_error,
      },
      transcription: {
        succeeded: result.transcription_succeeded,
        error: result.transcription_error,
      },
      image_embedding: {
        succeeded: result.image_embedding_succeeded,
        error: result.image_embedding_error,
      },
    },
    executed_at: result.executed_at,
    processing_warning: result.processing_warning,
    marker,
    extracted_metadata_markers: extractedMetadataMarkers,
    metadata_markers: extractedMetadataMarkers,
  };
}

function formatPromptRunVideoResult(result: PromptRunVideoResult): Record<string, unknown> {
  const marker = formatMarker(result.marker);
  return {
    result_type: result.result_type ?? 'video',
    result_id: result.result_id ?? `video:${result.video_id}:${result.run_id}`,
    run_id: result.run_id,
    prompt_id: result.prompt_id,
    prompt_run_id: result.prompt_run_id ?? result.run_id,
    video_id: result.video_id,
    video_name: result.video_name ?? null,
    source_index_id: result.source_index_id ?? null,
    status: result.status,
    metadata: result.metadata,
    extracted_metadata: result.metadata,
    metadata_text: result.metadata_text,
    text_content: result.metadata_text,
    content_preview: result.metadata_text,
    raw_llm_response: result.raw_llm_response,
    successful_segment_count: result.successful_segment_count,
    failed_segment_count: result.failed_segment_count,
    omitted_segment_ids: result.omitted_segment_ids,
    template_fields: result.template_fields,
    llm_attempted: result.llm_attempted,
    rendered_prompt_char_count: result.rendered_prompt_char_count,
    source_fingerprint: result.source_fingerprint,
    attempt_id: result.attempt_id,
    schema_used: result.schema_used,
    processing_warning: result.processing_warning,
    error_message: result.error_message,
    executed_at: result.executed_at,
    started_at: result.started_at,
    completed_at: result.completed_at,
    segment_uri: result.segment_uri ?? result.preview_segment_uri ?? null,
    gcs_uri: result.gcs_uri ?? null,
    thumbnail_gcs_uri: result.thumbnail_gcs_uri ?? null,
    gif_gcs_uri: result.gif_gcs_uri ?? null,
    thumbnail_uri: result.thumbnail_uri ?? result.preview_thumbnail_uri ?? null,
    gif_uri: result.gif_uri ?? result.preview_gif_uri ?? null,
    thumbnail_available: Boolean(result.thumbnail_available ?? result.preview_thumbnail_uri),
    gif_available: Boolean(result.gif_available ?? result.preview_gif_uri),
    preview_segment_id: result.preview_segment_id ?? null,
    preview_start_time: result.preview_start_time ?? null,
    preview_end_time: result.preview_end_time ?? null,
    preview_segment_uri: result.preview_segment_uri ?? null,
    preview_thumbnail_uri: result.preview_thumbnail_uri ?? null,
    preview_gif_uri: result.preview_gif_uri ?? null,
    marker,
  };
}

function formatPromptRunFailedSegments(
  manifest: PromptRunFailedSegmentsManifest
): Record<string, unknown> {
  return {
    run_id: manifest.run_id,
    status: manifest.status,
    videos_with_failures: manifest.videos_with_failures,
    failed_segments: manifest.failed_segments,
    operation_counts: manifest.operation_counts,
    videos: manifest.videos.map((video) => ({
      video_id: video.video_id,
      failed_segments: video.failed_segments,
      operation_counts: video.operation_counts,
      segments: video.segments,
    })),
  };
}

function formatPromptRunRetry(retry: PromptRunSegmentRetry): Record<string, unknown> {
  return {
    run_id: retry.run_id,
    retry_id: retry.retry_id,
    status: retry.status,
    message: retry.message,
    idempotency_key: retry.idempotency_key,
    video_id: retry.video_id,
    segment_id: retry.segment_id,
    billing_estimated_mt: retry.billing_estimated_mt,
    billing_actual_mt: retry.billing_actual_mt,
    billing_status: retry.billing_status,
    billing_error: retry.billing_error,
    created_at: retry.created_at,
    started_at: retry.started_at,
    completed_at: retry.completed_at,
    error: retry.error,
  };
}

function formatPromptRunRetryStatus(
  retry: PromptRunSegmentRetryStatus
): Record<string, unknown> {
  return {
    run_id: retry.run_id,
    retry_id: retry.retry_id,
    status: retry.status,
    video_id: retry.video_id,
    segment_id: retry.segment_id,
    billing_estimated_mt: retry.billing_estimated_mt,
    billing_actual_mt: retry.billing_actual_mt,
    billing_status: retry.billing_status,
    billing_error: retry.billing_error,
    field_extraction_succeeded: retry.field_extraction_succeeded,
    transcription_succeeded: retry.transcription_succeeded,
    image_embedding_succeeded: retry.image_embedding_succeeded,
    created_at: retry.created_at,
    started_at: retry.started_at,
    completed_at: retry.completed_at,
    error: retry.error,
  };
}

function formatPromptUsage(usage: PromptUsageStats): Record<string, unknown> {
  return {
    prompt_id: usage.prompt_id,
    name: usage.name,
    is_active: usage.is_active,
    is_in_use: usage.is_in_use,
    created_at: usage.created_at,
    schema_properties_count: usage.schema_properties_count,
  };
}

// ============================================================================
// Handler Types
// ============================================================================

export interface ToolHandlerResult {
  content: TextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

type ToolHandler = (
  args: Record<string, unknown>,
  client: VideoVectorClient
) => Promise<ToolHandlerResult>;

// ============================================================================
// Index/Discovery Handlers
// ============================================================================

async function handleListIndexes(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const includeDefaults = validateOptional(args, 'include_defaults', 'boolean', true);

  const indexes = await client.listIndexes(includeDefaults);
  const formattedIndexes = indexes.map(formatIndex);

  // Group by type for better organization
  const userIndexes = formattedIndexes.filter((idx) => !idx.is_default);
  const defaultIndexes = formattedIndexes.filter((idx) => idx.is_default);

  const payload = {
    total_indexes: indexes.length,
    user_indexes: userIndexes,
    default_indexes: includeDefaults ? defaultIndexes : undefined,
    tip: 'Use an index_id from this list with search_videos or other tools.',
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

async function handleGetIndex(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const indexId = validateRequired<string>(args, 'index_id', 'string');

  const index = await client.getIndex(indexId);
  const payload = formatIndex(index);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

async function handleListPrompts(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const includeDefaults = validateOptional(args, 'include_defaults', 'boolean', true);
  const activeOnly = validateOptional(args, 'active_only', 'boolean', true);

  const response = await client.listPrompts(activeOnly, includeDefaults);
  const formattedPrompts = response.prompts.map(formatPrompt);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            total_count: response.total_count,
            active_count: response.active_count,
            prompts: formattedPrompts,
            tip: 'Use a prompt_id with execute_prompt to analyze videos.',
          },
          null,
          2
        ),
      },
    ],
  };
}

// ============================================================================
// Video Handlers
// ============================================================================

async function handleGetVideo(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const videoId = validateRequired<string>(args, 'video_id', 'string');

  const video = await client.getVideo(videoId);
  const payload = formatVideo(video, true);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

async function handleGetVideoSegments(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const videoId = validateRequired<string>(args, 'video_id', 'string');
  const runId = args.run_id as string | undefined;
  const latestRun = validateOptional(args, 'latest_run', 'boolean', false);
  const limit = validateOptional(args, 'limit', 'number', 50);

  const response = await client.getVideoSegments(videoId, {
    runId,
    latestRun,
    limit: Math.min(Math.max(limit, 1), 100),
  });

  const formattedSegments = response.data.map(formatSegment);
  const payload = {
    video_id: videoId,
    run_id: runId ?? (latestRun ? 'latest' : null),
    total_segments: formattedSegments.length,
    has_more: response.pagination.has_more,
    segments: formattedSegments,
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

// ============================================================================
// Prompt Run Handlers
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePromptRunTarget(rawTarget: unknown): ExecutePromptTarget {
  if (!isRecord(rawTarget)) {
    throw new Error('target must be an object');
  }

  const type = rawTarget.type;
  if (type !== 'index' && type !== 'videos' && type !== 'playground') {
    throw new Error("target.type must be one of: index, videos, playground");
  }

  if (type === 'index') {
    if (typeof rawTarget.index_id !== 'string' || rawTarget.index_id.trim().length === 0) {
      throw new Error("target.index_id is required when target.type is 'index'");
    }
    return { type, index_id: rawTarget.index_id };
  }

  if (type === 'videos') {
    if (!Array.isArray(rawTarget.video_ids) || rawTarget.video_ids.length === 0) {
      throw new Error("target.video_ids must be a non-empty array when target.type is 'videos'");
    }
    if (!rawTarget.video_ids.every((value) => typeof value === 'string' && value.trim().length > 0)) {
      throw new Error('target.video_ids must contain non-empty strings');
    }

    const target: ExecutePromptTarget = {
      type,
      video_ids: rawTarget.video_ids as string[],
    };
    if (typeof rawTarget.index_id === 'string' && rawTarget.index_id.trim().length > 0) {
      target.index_id = rawTarget.index_id;
    }
    return target;
  }

  return { type };
}

function validateOptionalIdempotencyKey(args: Record<string, unknown>): string | undefined {
  const value = args.idempotency_key;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error('idempotency_key must be a string');
  }
  const candidate = value.trim();
  return candidate || undefined;
}

function validateRequiredIdempotencyKey(args: Record<string, unknown>): string {
  const value = validateOptionalIdempotencyKey(args);
  if (!value) {
    throw new Error('idempotency_key is required');
  }
  return value;
}

function parsePromptRunDuration(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 300) {
    throw new Error(`${fieldName} must be an integer between 1 and 300`);
  }
  return parsed;
}

function buildPromptRunRequest(args: Record<string, unknown>): ExecutePromptRequest {
  const promptId = validateRequired<string>(args, 'prompt_id', 'string');
  const target = validatePromptRunTarget(args.target);
  const videoSegmentationType = args.video_segmentation_type as string | undefined;
  const audioSegmentationType = args.audio_segmentation_type as string | undefined;
  const videoSegmentDuration = parsePromptRunDuration(
    args.video_segment_duration,
    'video_segment_duration'
  );
  const audioSegmentDuration = parsePromptRunDuration(
    args.audio_segment_duration,
    'audio_segment_duration'
  );
  const processingModel = args.processing_model as string | undefined;
  const enableTranscription = validateOptional(args, 'enable_transcription', 'boolean', true);
  const enableImageEmbedding = validateOptional(args, 'enable_image_embedding', 'boolean', true);

  const validVideoSegmentationTypes = ['smart', 'fixed', 'content_aware'];
  const validAudioSegmentationTypes = ['fixed', 'content_aware'];

  if (
    videoSegmentationType !== undefined &&
    !validVideoSegmentationTypes.includes(videoSegmentationType)
  ) {
    throw new Error(
      `video_segmentation_type must be one of: ${validVideoSegmentationTypes.join(', ')}`
    );
  }
  if (
    audioSegmentationType !== undefined &&
    !validAudioSegmentationTypes.includes(audioSegmentationType)
  ) {
    throw new Error(
      `audio_segmentation_type must be one of: ${validAudioSegmentationTypes.join(', ')}`
    );
  }
  if (videoSegmentationType === 'fixed' && videoSegmentDuration === undefined) {
    throw new Error("video_segment_duration is required when video_segmentation_type is 'fixed'");
  }
  if (audioSegmentationType === 'fixed' && audioSegmentDuration === undefined) {
    throw new Error("audio_segment_duration is required when audio_segmentation_type is 'fixed'");
  }

  return {
    prompt_id: promptId,
    target,
    video_segmentation_type: videoSegmentationType as
      | 'smart'
      | 'fixed'
      | 'content_aware'
      | undefined,
    audio_segmentation_type: audioSegmentationType as 'fixed' | 'content_aware' | undefined,
    video_segment_duration: videoSegmentDuration,
    audio_segment_duration: audioSegmentDuration,
    processing_model: processingModel,
    enable_transcription: enableTranscription,
    enable_image_embedding: enableImageEmbedding,
  };
}

async function handleListPromptRuns(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const indexId = args.index_id as string | undefined;
  const videoId = args.video_id as string | undefined;
  const limit = validateOptional<number | undefined>(args, 'limit', 'number', undefined);
  const cursor = args.cursor as string | undefined;
  const normalizedLimit = limit === undefined ? undefined : Math.min(Math.max(limit, 1), 200);
  const defaultedIndexLimit = normalizedLimit ?? 50;
  const defaultedUserLimit = normalizedLimit ?? 200;

  if (indexId !== undefined && typeof indexId !== 'string') {
    throw new Error('index_id must be a string');
  }
  if (videoId !== undefined && typeof videoId !== 'string') {
    throw new Error('video_id must be a string');
  }
  if (indexId && videoId) {
    throw new Error('Provide either index_id or video_id, not both');
  }
  if (cursor && !indexId) {
    throw new Error('cursor is only supported when listing prompt runs for an index');
  }
  if (indexId && defaultedIndexLimit > 100) {
    throw new Error('limit cannot exceed 100 when listing prompt runs for an index');
  }

  const response = await client.listPromptRuns({
    indexId,
    videoId,
    limit: videoId ? normalizedLimit : (indexId ? defaultedIndexLimit : defaultedUserLimit),
    cursor,
  });

  if (Array.isArray(response)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              scope: videoId ? 'video' : 'user',
              index_id: indexId ?? null,
              video_id: videoId ?? null,
              total_runs: response.length,
              runs: response.map(formatPromptRun),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            scope: 'index',
            index_id: indexId ?? null,
            total_runs: response.data.length,
            has_more: response.pagination.has_more,
            next_cursor: response.pagination.next_cursor,
            runs: response.data.map(formatPromptRun),
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleEstimatePromptRun(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const request = buildPromptRunRequest(args);
  const estimate: PromptRunCostEstimate = await client.estimatePromptRun(request);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            prompt_id: request.prompt_id,
            target: request.target,
            estimated_mt: estimate.estimated_mt,
            sufficient_balance: estimate.sufficient_balance,
            current_balance_mt: estimate.current_balance_mt,
            breakdown: estimate.breakdown,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleExecutePrompt(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const request = buildPromptRunRequest(args);
  const idempotencyKey = validateOptionalIdempotencyKey(args);
  const run = await client.executePrompt(request, idempotencyKey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Prompt execution started successfully',
            run_id: run.run_id,
            status: run.status,
            prompt_name: run.prompt_name,
            target: request.target,
            total_media: run.total_videos + run.total_audios + run.total_images,
            tip: `Use get_prompt_run_status with run_id="${run.run_id}" to check progress.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleGetPromptRunStatus(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const runId = validateRequired<string>(args, 'run_id', 'string');

  const run = await client.getPromptRun(runId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(formatPromptRun(run), null, 2),
      },
    ],
  };
}

async function handleCancelPromptRun(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const runId = validateRequired<string>(args, 'run_id', 'string');
  const idempotencyKey = validateOptionalIdempotencyKey(args);
  const run = await client.cancelPromptRun(runId, idempotencyKey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: run.status === 'cancelled' ? 'Prompt run cancelled' : 'Prompt run stop requested',
            run: formatPromptRun(run),
            note: 'Already-started videos may finish, but no new videos will start after stop is observed.',
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleGetPromptRunResults(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const runId = validateRequired<string>(args, 'run_id', 'string');
  const videoId = validateRequired<string>(args, 'video_id', 'string');
  const limit = validateOptional(args, 'limit', 'number', 50);

  const response = await client.getPromptRunResults(runId, {
    videoId,
    limit: Math.min(Math.max(limit, 1), 100),
  });

  const formattedResults = response.data.map(formatSegmentRunResult);
  const payload = {
    run_id: runId,
    video_id: videoId,
    total_results: formattedResults.length,
    has_more: response.pagination.has_more,
    results: formattedResults,
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

async function handleGetPromptRunVideoResult(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const runId = validateRequired<string>(args, 'run_id', 'string');
  const videoId = validateRequired<string>(args, 'video_id', 'string');
  const result = await client.getPromptRunVideoResult(runId, videoId);
  const payload = formatPromptRunVideoResult(result);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

async function handleGetPromptRunFailedSegments(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const runId = validateRequired<string>(args, 'run_id', 'string');
  const manifest = await client.getPromptRunFailedSegments(runId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(formatPromptRunFailedSegments(manifest), null, 2),
      },
    ],
  };
}

async function handleRetryPromptRunSegment(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const runId = validateRequired<string>(args, 'run_id', 'string');
  const videoId = validateRequired<string>(args, 'video_id', 'string');
  const segmentId = validateRequired<string>(args, 'segment_id', 'string');
  const idempotencyKey = validateOptionalIdempotencyKey(args);

  const retry = await client.retryPromptRunSegment(runId, videoId, segmentId, idempotencyKey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(formatPromptRunRetry(retry), null, 2),
      },
    ],
  };
}

async function handleGetPromptRunSegmentRetryStatus(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const runId = validateRequired<string>(args, 'run_id', 'string');
  const videoId = validateRequired<string>(args, 'video_id', 'string');
  const segmentId = validateRequired<string>(args, 'segment_id', 'string');
  const retryId = validateRequired<string>(args, 'retry_id', 'string');

  const retry = await client.getPromptRunSegmentRetryStatus(runId, videoId, segmentId, retryId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(formatPromptRunRetryStatus(retry), null, 2),
      },
    ],
  };
}

// ============================================================================
// Prompt Management Handlers
// ============================================================================

async function handleCreatePrompt(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const name = validateRequired<string>(args, 'name', 'string');
  const promptText = validateRequired<string>(args, 'prompt_text', 'string');
  const jsonSchema = validateRequired<Record<string, unknown>>(args, 'json_schema', 'object');
  const description = validateOptional(args, 'description', 'string', '');
  const videoLevel = args.video_level as Record<string, unknown> | undefined;
  const semanticIndexing = validateOptional<Record<string, unknown> | undefined>(
    args,
    'semantic_indexing',
    'object',
    undefined
  );
  const idempotencyKey = validateOptionalIdempotencyKey(args);

  if (typeof (jsonSchema as { type?: unknown }).type !== 'string') {
    throw new Error("json_schema must declare a root 'type'");
  }
  if ((jsonSchema as { type?: string }).type !== 'object') {
    throw new Error("json_schema root type must be 'object'");
  }
  if (videoLevel !== undefined && !isRecord(videoLevel)) {
    throw new Error('video_level must be an object');
  }
  if (semanticIndexing !== undefined && !isRecord(semanticIndexing)) {
    throw new Error('semantic_indexing must be an object');
  }

  const prompt = await client.createPrompt(
    {
      name,
      description,
      prompt_text: promptText,
      json_schema: jsonSchema,
      video_level: videoLevel as unknown as PromptVideoLevelConfig | undefined,
      semantic_indexing: semanticIndexing as unknown as Prompt['semantic_indexing'] | undefined,
    },
    idempotencyKey
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Prompt created successfully',
            prompt: formatPrompt(prompt),
            tip: `Use execute_prompt with prompt_id="${prompt.prompt_id}" to analyze videos with this prompt.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleGetPrompt(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const promptId = validateRequired<string>(args, 'prompt_id', 'string');

  const prompt = await client.getPromptDetail(promptId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(formatPrompt(prompt), null, 2),
      },
    ],
  };
}

async function handleUpdatePrompt(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const promptId = validateRequired<string>(args, 'prompt_id', 'string');
  const idempotencyKey = validateOptionalIdempotencyKey(args);
  const name = validateOptional<string | undefined>(args, 'name', 'string', undefined);
  const description = validateOptional<string | undefined>(args, 'description', 'string', undefined);
  const promptText = validateOptional<string | undefined>(args, 'prompt_text', 'string', undefined);
  const jsonSchema = validateOptional<Record<string, unknown> | undefined>(
    args,
    'json_schema',
    'object',
    undefined
  );
  const videoLevel = validateOptional<Record<string, unknown> | undefined>(
    args,
    'video_level',
    'object',
    undefined
  );
  const semanticIndexing = validateOptional<Record<string, unknown> | undefined>(
    args,
    'semantic_indexing',
    'object',
    undefined
  );
  const clearVideoLevel = validateOptional(args, 'clear_video_level', 'boolean', false);

  const updateRequest: {
    name?: string;
    description?: string;
    prompt_text?: string;
    json_schema?: Record<string, unknown>;
    video_level?: PromptVideoLevelConfig | null;
    semantic_indexing?: Prompt['semantic_indexing'] | null;
    clear_video_level?: boolean;
  } = {};
  if (name !== undefined) {
    updateRequest.name = name;
  }
  if (description !== undefined) {
    updateRequest.description = description;
  }
  if (promptText !== undefined) {
    updateRequest.prompt_text = promptText;
  }
  if (jsonSchema !== undefined) {
    if (typeof (jsonSchema as { type?: unknown }).type !== 'string') {
      throw new Error("json_schema must declare a root 'type'");
    }
    if ((jsonSchema as { type?: string }).type !== 'object') {
      throw new Error("json_schema root type must be 'object'");
    }
    updateRequest.json_schema = jsonSchema;
  }
  if (videoLevel !== undefined) {
    if (!isRecord(videoLevel)) {
      throw new Error('video_level must be an object');
    }
    updateRequest.video_level = videoLevel as unknown as PromptVideoLevelConfig;
  }
  if (semanticIndexing !== undefined) {
    if (!isRecord(semanticIndexing)) {
      throw new Error('semantic_indexing must be an object');
    }
    updateRequest.semantic_indexing = semanticIndexing as unknown as Prompt['semantic_indexing'];
  }
  if (clearVideoLevel) {
    updateRequest.clear_video_level = true;
  }

  if (Object.keys(updateRequest).length === 0) {
    throw new Error('At least one prompt field must be provided');
  }

  const prompt = await client.updatePrompt(promptId, updateRequest, idempotencyKey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Prompt updated successfully',
            prompt: formatPrompt(prompt),
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleTestPromptSchema(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const jsonSchema = validateRequired<Record<string, unknown>>(args, 'json_schema', 'object');
  const sampleData = validateRequired<Record<string, unknown>>(args, 'sample_data', 'object');
  const result: TestSchemaResponse = await client.testPromptSchema(jsonSchema, sampleData);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
    isError: !result.valid,
  };
}

async function handleGetPromptUsage(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const promptId = validateRequired<string>(args, 'prompt_id', 'string');
  const usage = await client.getPromptUsage(promptId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(formatPromptUsage(usage), null, 2),
      },
    ],
  };
}

// ============================================================================
// Cloud Connector Handlers
// ============================================================================

function formatConnector(connector: Connector): Record<string, unknown> {
  const result: Record<string, unknown> = {
    connector_id: connector.connector_id,
    name: connector.name,
    provider: connector.provider,
    status: connector.status,
    scopes: connector.scopes,
    import_mode: connector.import_mode,
    export_base_path: connector.export_base_path,
    created_at: connector.created_at,
    updated_at: connector.updated_at,
  };

  // Add provider-specific fields
  if (connector.provider === 'gcs') {
    result.bucket = connector.bucket;
    result.gcp_project_id = connector.gcp_project_id;
  } else if (connector.provider === 's3') {
    result.bucket = connector.bucket;
    result.region = connector.region;
  } else if (connector.provider === 'azure') {
    result.storage_account = connector.storage_account;
    result.container = connector.container;
  }

  // Add test status if available
  if (connector.last_tested_at) {
    result.last_test = {
      tested_at: connector.last_tested_at,
      result: connector.last_test_result,
      error: connector.last_test_error,
    };
  }

  return result;
}

function formatCloudFile(file: CloudFile): Record<string, unknown> {
  return {
    path: file.path,
    name: file.name,
    size_bytes: file.size_bytes,
    size_human: formatFileSize(file.size_bytes),
    last_modified: file.last_modified,
    content_type: file.content_type,
    extension: file.extension,
  };
}

function formatFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

async function handleCreateGCSConnector(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const name = validateRequired<string>(args, 'name', 'string');
  const bucket = validateRequired<string>(args, 'bucket', 'string');
  const gcpProjectId = validateRequired<string>(args, 'gcp_project_id', 'string');
  const credentialsJson = validateRequired<Record<string, unknown>>(args, 'credentials_json', 'object');
  const scopes = validateConnectorScopes(args) ?? ['import'];
  const exportBasePath = args.export_base_path as string | undefined;
  const importMode = validateConnectorImportMode(args) ?? 'all';
  const idempotencyKey = validateRequiredIdempotencyKey(args);

  // Validate credentials structure - GCP service account keys require these fields
  const requiredCredentialFields = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email', 'token_uri'];
  const missingFields = requiredCredentialFields.filter((field) => !credentialsJson[field]);
  if (missingFields.length > 0) {
    throw new Error(
      `credentials_json is missing required fields: ${missingFields.join(', ')}. ` +
      'Ensure you are using a valid GCP service account key JSON file.'
    );
  }
  if (credentialsJson.type !== 'service_account') {
    throw new Error("credentials_json.type must be 'service_account'");
  }

  const request = {
    name,
    bucket,
    gcp_project_id: gcpProjectId,
    credentials_json: credentialsJson,
    scopes,
    export_base_path: exportBasePath,
    import_mode: importMode,
  };

  const connector = await client.createGCSConnector(request, idempotencyKey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'GCS connector created successfully',
            connector: formatConnector(connector),
            tip: `Use test_connector with connector_id="${connector.connector_id}" to verify the connection.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleCreateS3Connector(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const name = validateRequired<string>(args, 'name', 'string');
  const bucket = validateRequired<string>(args, 'bucket', 'string');
  const region = validateRequired<string>(args, 'region', 'string');
  const awsAccessKeyId = validateRequired<string>(args, 'aws_access_key_id', 'string');
  const awsSecretAccessKey = validateRequired<string>(args, 'aws_secret_access_key', 'string');
  const scopes = validateConnectorScopes(args) ?? ['import'];
  const exportBasePath = args.export_base_path as string | undefined;
  const importMode = validateConnectorImportMode(args) ?? 'all';
  const idempotencyKey = validateRequiredIdempotencyKey(args);

  const connector = await client.createS3Connector(
    {
      name,
      bucket,
      region,
      aws_access_key_id: awsAccessKeyId,
      aws_secret_access_key: awsSecretAccessKey,
      scopes,
      export_base_path: exportBasePath,
      import_mode: importMode,
    },
    idempotencyKey
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'S3 connector created successfully',
            connector: formatConnector(connector),
            tip: `Use test_connector with connector_id="${connector.connector_id}" to verify the connection.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleCreateAzureConnector(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const name = validateRequired<string>(args, 'name', 'string');
  const storageAccount = validateRequired<string>(args, 'storage_account', 'string');
  const container = validateRequired<string>(args, 'container', 'string');
  const tenantId = validateRequired<string>(args, 'tenant_id', 'string');
  const clientId = validateRequired<string>(args, 'client_id', 'string');
  const clientSecret = validateRequired<string>(args, 'client_secret', 'string');
  const scopes = validateConnectorScopes(args) ?? ['import'];
  const exportBasePath = args.export_base_path as string | undefined;
  const importMode = validateConnectorImportMode(args) ?? 'all';
  const idempotencyKey = validateRequiredIdempotencyKey(args);

  const connector = await client.createAzureConnector(
    {
      name,
      storage_account: storageAccount,
      container,
      tenant_id: tenantId,
      client_id: clientId,
      client_secret: clientSecret,
      scopes,
      export_base_path: exportBasePath,
      import_mode: importMode,
    },
    idempotencyKey
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Azure connector created successfully',
            connector: formatConnector(connector),
            tip: `Use test_connector with connector_id="${connector.connector_id}" to verify the connection.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleListConnectors(
  _args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const connectors = await client.listConnectors();
  const formattedConnectors = connectors.map(formatConnector);

  // Group by provider
  const gcsConnectors = formattedConnectors.filter((c) => c.provider === 'gcs');
  const s3Connectors = formattedConnectors.filter((c) => c.provider === 's3');
  const azureConnectors = formattedConnectors.filter((c) => c.provider === 'azure');

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            total_connectors: connectors.length,
            by_provider: {
              gcs: gcsConnectors.length,
              s3: s3Connectors.length,
              azure: azureConnectors.length,
            },
            connectors: formattedConnectors,
            tip: connectors.length > 0
              ? 'Use browse_connector_files with a connector_id to explore available files.'
              : 'Create a connector with create_gcs_connector, create_s3_connector, or create_azure_connector.',
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleTestConnector(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const connectorId = validateRequired<string>(args, 'connector_id', 'string');

  const result = await client.testConnector(connectorId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            connector_id: connectorId,
            success: result.success,
            error_message: result.error_message,
            tip: result.success
              ? 'Connection verified. Use browse_connector_files to explore available files.'
              : 'Check your credentials and bucket/container permissions.',
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleBrowseConnectorFiles(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const connectorId = validateRequired<string>(args, 'connector_id', 'string');
  const prefix = validateOptional(args, 'prefix', 'string', '');
  const pattern = validateOptional(args, 'pattern', 'string', '*');
  const recursive = validateOptional(args, 'recursive', 'boolean', true);

  const files = await client.browseConnectorFiles(connectorId, {
    prefix,
    pattern,
    recursive,
  });

  const formattedFiles = files.map(formatCloudFile);

  // Group by extension
  const extensionCounts: Record<string, number> = {};
  for (const file of files) {
    const ext = file.extension.toLowerCase() || 'no extension';
    extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
  }

  // Calculate total size
  const totalBytes = files.reduce((sum, f) => sum + f.size_bytes, 0);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            connector_id: connectorId,
            filter: { prefix, pattern, recursive },
            total_files: files.length,
            total_size: formatFileSize(totalBytes),
            by_extension: extensionCounts,
            files: formattedFiles,
            tip: files.length > 0
              ? 'Use create_import_job with connector_id and index_id to import these files.'
              : 'No files found. Try adjusting the prefix or pattern.',
          },
          null,
          2
        ),
      },
    ],
  };
}

// ============================================================================
// Import Job Handlers
// ============================================================================

function formatImportJob(job: ImportJob): Record<string, unknown> {
  const progressPercent = job.progress.total_files > 0
    ? Math.round((job.progress.imported / job.progress.total_files) * 100)
    : 0;

  return {
    job_id: job.job_id,
    connector_id: job.connector_id,
    target_index_id: job.target_index_id,
    status: job.status,
    source: {
      prefix: job.source_prefix,
      pattern: job.file_pattern,
      recursive: job.recursive,
    },
    progress: {
      total_files: job.progress.total_files,
      imported: job.progress.imported,
      failed: job.progress.failed,
      skipped: job.progress.skipped,
      percent: progressPercent,
      bytes_transferred: job.progress.bytes_transferred,
      bytes_transferred_human: formatFileSize(job.progress.bytes_transferred),
      current_file: job.progress.current_file,
    },
    timestamps: {
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
    },
    video_ids: job.video_ids,
    error_message: job.error_message,
    failed_files_count: job.failed_files.length,
    skipped_files_count: job.skipped_files.length,
  };
}

function formatImportJobDetail(job: ImportJob): Record<string, unknown> {
  const base = formatImportJob(job);
  return {
    ...base,
    failed_files: job.failed_files.map((f) => ({ path: f.path, error: f.error })),
    skipped_files: job.skipped_files.map((f) => ({ path: f.path, reason: f.reason })),
  };
}

async function handleCreateImportJob(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const connectorId = validateRequired<string>(args, 'connector_id', 'string');
  const indexId = validateRequired<string>(args, 'index_id', 'string');
  const sourcePrefix = validateOptional(args, 'source_prefix', 'string', '');
  const filePattern = validateOptional(args, 'file_pattern', 'string', '*');
  const recursive = validateOptional(args, 'recursive', 'boolean', true);
  const idempotencyKey = validateOptionalIdempotencyKey(args);

  const job = await client.createImportJob(
    {
      connector_id: connectorId,
      index_id: indexId,
      source_prefix: sourcePrefix,
      file_pattern: filePattern,
      recursive,
    },
    idempotencyKey
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Import job created and started',
            job: formatImportJob(job),
            tip: `Use get_import_job with job_id="${job.job_id}" to check progress.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleListImportJobs(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const rawStatusFilter = args.status;
  let statusFilter: ImportJobStatus | undefined;
  if (rawStatusFilter !== undefined) {
    if (typeof rawStatusFilter !== 'string') {
      throw new Error('status must be a string');
    }
    const normalizedStatus = rawStatusFilter.toLowerCase();
    const validStatuses: ImportJobStatus[] = [
      'pending',
      'scanning',
      'importing',
      'completed',
      'failed',
      'cancelled',
    ];
    if (!validStatuses.includes(normalizedStatus as ImportJobStatus)) {
      throw new Error(`status must be one of: ${validStatuses.join(', ')}`);
    }
    statusFilter = normalizedStatus as ImportJobStatus;
  }

  const jobs = await client.listImportJobs(statusFilter);
  const formattedJobs = jobs.map(formatImportJob);

  // Group by status
  const byStatus: Record<string, number> = {};
  for (const job of jobs) {
    byStatus[job.status] = (byStatus[job.status] || 0) + 1;
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            total_jobs: jobs.length,
            filter: statusFilter ?? 'all',
            by_status: byStatus,
            jobs: formattedJobs,
            tip: jobs.length > 0
              ? 'Use get_import_job with a job_id for detailed status including failed files.'
              : 'Create an import job with create_import_job to import files from cloud storage.',
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleGetImportJob(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const jobId = validateRequired<string>(args, 'job_id', 'string');

  const job = await client.getImportJob(jobId);

  // Mark as error if job failed so MCP clients can distinguish failed operations
  const isError = job.status === 'failed';

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(formatImportJobDetail(job), null, 2),
      },
    ],
    isError,
  };
}

async function handleCancelImportJob(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const jobId = validateRequired<string>(args, 'job_id', 'string');
  const idempotencyKey = validateOptionalIdempotencyKey(args);

  const job = await client.cancelImportJob(jobId, idempotencyKey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Import job cancelled',
            job: formatImportJob(job),
            note: 'Files already imported remain in the index. Only pending files were skipped.',
          },
          null,
          2
        ),
      },
    ],
  };
}

// ============================================================================
// Index Management Handlers
// ============================================================================

async function handleCreateIndex(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const name = validateRequired<string>(args, 'name', 'string');
  const idempotencyKey = validateOptionalIdempotencyKey(args);

  const index = await client.createIndex({ name }, idempotencyKey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Index created successfully',
            index: formatIndex(index),
            tip: `Use create_import_job with index_id="${index.index_id}" to import videos from cloud storage.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

// ============================================================================
// Video Management Handlers
// ============================================================================

async function handleListVideos(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const indexId = validateRequired<string>(args, 'index_id', 'string');
  const limit = validateOptional(args, 'limit', 'number', 50);
  const cursor = args.cursor as string | undefined;

  const response = await client.getVideosInIndex(
    indexId,
    Math.min(Math.max(limit, 1), 100),
    cursor
  );

  const formattedVideos = response.data.map((video) => formatVideo(video, false));
  const processingAggregate = aggregateProcessingStatusSnapshots(
    response.data.map((video) => video.processing_status)
  );

  // Group by status
  const byStatus: Record<string, number> = {};
  for (const video of response.data) {
    byStatus[video.status] = (byStatus[video.status] || 0) + 1;
  }

  // Group by media type
  const byMediaType: Record<string, number> = {};
  for (const video of response.data) {
    byMediaType[video.media_type] = (byMediaType[video.media_type] || 0) + 1;
  }

  const payload = {
    index_id: indexId,
    videos_returned: formattedVideos.length,
    has_more: response.pagination.has_more,
    next_cursor: response.pagination.next_cursor,
    by_status: byStatus,
    by_media_type: byMediaType,
    by_run_status: processingAggregate.by_run_status,
    segment_status_totals: processingAggregate.segment_status_totals,
    videos_with_processing_details: processingAggregate.videos_with_processing_details,
    videos: formattedVideos,
    tip: response.pagination.has_more
      ? `Use cursor="${response.pagination.next_cursor}" to get the next page.`
      : undefined,
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

async function handleGetVideosStatus(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const videoIds = validateRequired<string[]>(args, 'video_ids', 'object');

  if (!Array.isArray(videoIds) || videoIds.length === 0) {
    throw new Error('video_ids must be a non-empty array of strings');
  }
  if (videoIds.length > 100) {
    throw new Error('video_ids cannot contain more than 100 items');
  }
  if (!videoIds.every((id) => typeof id === 'string')) {
    throw new Error('video_ids must contain only strings');
  }

  const statuses = await client.getVideosStatus(videoIds);
  const formattedStatuses = statuses.map((status) => formatVideoStatusResponse(status, true));
  const processingAggregate = aggregateProcessingStatusSnapshots(
    statuses.map((status) => status.processing_status)
  );

  // Group by status
  const byStatus: Record<string, number> = {};
  for (const s of statuses) {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            total_videos: statuses.length,
            by_status: byStatus,
            by_run_status: processingAggregate.by_run_status,
            segment_status_totals: processingAggregate.segment_status_totals,
            videos_with_processing_details: processingAggregate.videos_with_processing_details,
            statuses: formattedStatuses,
          },
          null,
          2
        ),
      },
    ],
  };
}

// ============================================================================
// Export Handlers
// ============================================================================

function formatExportJob(job: ExportJob): Record<string, unknown> {
  return {
    export_id: job.export_id,
    export_type: job.export_type,
    target_id: job.target_id,
    status: job.status,
    queue_status: job.queue_status,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    created_at: job.created_at,
    available_at: job.available_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    updated_at: job.updated_at,
    download_url: job.download_url,
    file_size_bytes: job.file_size_bytes,
    file_size_human:
      job.file_size_bytes !== null ? formatFileSize(job.file_size_bytes) : null,
    error_message: job.error_message,
    last_error: job.last_error,
    destination_type: job.destination_type,
    destination_connector_id: job.destination_connector_id,
    destination_base_path: job.destination_base_path,
    destination_subpath: job.destination_subpath,
    destination_uri: job.destination_uri,
    gcs_uri: job.gcs_uri,
    export_params: job.export_params,
  };
}

async function handleExportIndexMetadata(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const indexId = validateRequired<string>(args, 'index_id', 'string');
  const promptRunIds = validateOptionalStringArray(args, 'prompt_run_ids');
  const destinationConnectorId = args.destination_connector_id as string | undefined;
  const destinationSubpath = args.destination_subpath as string | undefined;
  const idempotencyKey = validateOptionalIdempotencyKey(args);

  const result = await client.exportIndexMetadata(
    indexId,
    {
      prompt_run_ids: promptRunIds,
      destination_connector_id: destinationConnectorId,
      destination_subpath: destinationSubpath,
    },
    idempotencyKey
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Export job created',
            export_id: result.export_id,
            status: result.status,
            index_id: indexId,
            prompt_run_ids: promptRunIds ?? 'all',
            destination_connector_id: destinationConnectorId ?? null,
            destination_subpath: destinationSubpath ?? null,
            tip: `Use get_export_status with export_id="${result.export_id}" to check when the file is ready.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleExportPromptRun(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const runId = validateRequired<string>(args, 'run_id', 'string');
  const destinationConnectorId = args.destination_connector_id as string | undefined;
  const destinationSubpath = args.destination_subpath as string | undefined;
  const idempotencyKey = validateOptionalIdempotencyKey(args);

  const result = await client.exportPromptRun(
    runId,
    {
      destination_connector_id: destinationConnectorId,
      destination_subpath: destinationSubpath,
    },
    idempotencyKey
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Export job created',
            export_id: result.export_id,
            status: result.status,
            run_id: runId,
            destination_connector_id: destinationConnectorId ?? null,
            destination_subpath: destinationSubpath ?? null,
            tip: `Use get_export_status with export_id="${result.export_id}" to check when the file is ready.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleGetExportStatus(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const exportId = validateRequired<string>(args, 'export_id', 'string');

  const job = await client.getExportStatus(exportId);
  const result = formatExportJob(job);

  // Add contextual tip based on status
  let tip: string | undefined;
  if (job.status === 'pending') {
    tip = 'Export job is queued and will start processing shortly. Check again in a few moments.';
  } else if (job.status === 'processing') {
    tip = 'Export is still processing. Check again in a few moments.';
  } else if (
    job.status === 'completed'
    && job.destination_type === 'download'
    && job.download_url
  ) {
    tip =
      'Export is ready at the authenticated download endpoint. ' +
      'Use the VideoVector SDK/API for bounded streaming. Call get_export_download_url ' +
      'only when another header-free client explicitly needs a short-lived bearer URL.';
  } else if (job.status === 'completed' && job.destination_type === 'connector') {
    tip =
      'Export completed to the configured connector destination. ' +
      'No bearer download URL is created for connector-delivered exports.';
  } else if (job.status === 'completed') {
    tip =
      'Export completed, but no authenticated direct-download endpoint is available.';
  } else if (job.status === 'failed') {
    tip = 'Export failed. Check error_message for details.';
  }

  // Mark as error if job failed so MCP clients can distinguish failed operations
  const isError = job.status === 'failed';

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ...result,
            tip,
          },
          null,
          2
        ),
      },
    ],
    isError,
  };
}

async function handleGetExportDownloadUrl(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const exportId = validateRequired<string>(args, 'export_id', 'string');
  const result = await client.mintExportDownloadUrl(exportId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            export_id: result.export_id,
            status: result.status,
            destination_type: result.destination_type,
            destination_connector_id: result.destination_connector_id,
            download_url: result.download_url,
          },
          null,
          2
        ),
      },
    ],
  };
}

// ============================================================================
// Webhook Handlers
// ============================================================================

function formatWebhook(webhook: Webhook): Record<string, unknown> {
  return {
    webhook_id: webhook.webhook_id,
    name: webhook.name,
    url: webhook.url,
    events: webhook.events,
    index_ids: webhook.index_ids,
    status: webhook.status,
    failure_count: webhook.failure_count,
    last_failure_at: webhook.last_failure_at,
    last_success_at: webhook.last_success_at,
    created_at: webhook.created_at,
    updated_at: webhook.updated_at,
    metadata: webhook.metadata,
  };
}

function formatWebhookDelivery(delivery: WebhookDelivery): Record<string, unknown> {
  return {
    delivery_id: delivery.delivery_id,
    webhook_id: delivery.webhook_id,
    event_type: delivery.event_type,
    status: delivery.status,
    attempts: delivery.attempts,
    last_attempt_at: delivery.last_attempt_at,
    next_retry_at: delivery.next_retry_at,
    response_status_code: delivery.response_status_code,
    error_message: delivery.error_message,
    created_at: delivery.created_at,
    completed_at: delivery.completed_at,
  };
}

async function handleCreateWebhook(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const name = validateRequired<string>(args, 'name', 'string');
  const url = validateRequired<string>(args, 'url', 'string');
  const events = validateRequired<string[]>(args, 'events', 'object');

  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('events must be a non-empty array of event types');
  }

  if (!url.startsWith('https://')) {
    throw new Error('URL must use HTTPS');
  }

  const indexIds = args.index_ids as string[] | undefined;
  const metadata = args.metadata as Record<string, unknown> | undefined;
  const idempotencyKey = validateOptionalIdempotencyKey(args);

  const webhook = await client.createWebhook(
    {
      name,
      url,
      events,
      index_ids: indexIds,
      metadata,
    },
    idempotencyKey
  );

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Webhook created successfully',
            webhook: formatWebhook(webhook),
            secret: webhook.secret,
            important: 'Store the secret securely - it is only shown once. Use it to verify webhook signatures.',
            tip: `Use test_webhook with webhook_id="${webhook.webhook_id}" to verify the endpoint is reachable.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleListWebhooks(
  _args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const webhooks = await client.listWebhooks();
  const formattedWebhooks = webhooks.map(formatWebhook);

  // Group by status
  const byStatus: Record<string, number> = {};
  for (const w of webhooks) {
    byStatus[w.status] = (byStatus[w.status] || 0) + 1;
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            total_webhooks: webhooks.length,
            by_status: byStatus,
            webhooks: formattedWebhooks,
            tip: webhooks.length > 0
              ? 'Use get_webhook with a webhook_id for full details, or test_webhook to verify an endpoint.'
              : 'Create a webhook with create_webhook to receive real-time event notifications.',
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleGetWebhook(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const webhookId = validateRequired<string>(args, 'webhook_id', 'string');

  const webhook = await client.getWebhook(webhookId);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(formatWebhook(webhook), null, 2),
      },
    ],
  };
}

async function handleUpdateWebhook(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const webhookId = validateRequired<string>(args, 'webhook_id', 'string');
  const idempotencyKey = validateOptionalIdempotencyKey(args);
  const name = validateOptional<string | undefined>(args, 'name', 'string', undefined);
  const url = validateOptional<string | undefined>(args, 'url', 'string', undefined);
  const events = validateOptionalStringArray(args, 'events');
  const indexIds = validateOptionalStringArray(args, 'index_ids');
  const status = validateOptional<string | undefined>(args, 'status', 'string', undefined);
  const metadata = validateOptional<Record<string, unknown> | undefined>(
    args,
    'metadata',
    'object',
    undefined
  );

  const updateRequest: Record<string, unknown> = {};
  if (name !== undefined) {
    updateRequest.name = name;
  }
  if (url !== undefined) {
    if (!url.startsWith('https://')) {
      throw new Error('URL must use HTTPS');
    }
    updateRequest.url = url;
  }
  if (events !== undefined) {
    if (events.length === 0) {
      throw new Error('events cannot be empty');
    }
    updateRequest.events = events;
  }
  if (indexIds !== undefined) {
    updateRequest.index_ids = indexIds;
  }
  if (status !== undefined) {
    if (!['active', 'paused'].includes(status)) {
      throw new Error("status must be 'active' or 'paused'");
    }
    updateRequest.status = status;
  }
  if (metadata !== undefined) {
    updateRequest.metadata = metadata;
  }

  if (Object.keys(updateRequest).length === 0) {
    throw new Error('At least one field must be provided to update');
  }

  const webhook = await client.updateWebhook(webhookId, updateRequest, idempotencyKey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            message: 'Webhook updated successfully',
            webhook: formatWebhook(webhook),
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleListWebhookEvents(
  _args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const events = await client.getWebhookEvents();

  // Group events by category
  const byCategory: Record<string, string[]> = {};
  for (const event of events) {
    const category = event.split('.')[0] ?? 'other';
    if (!byCategory[category]) {
      byCategory[category] = [];
    }
    byCategory[category].push(event);
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            total_events: events.length,
            by_category: byCategory,
            events: events,
            tip: 'Use these event names when creating or updating webhooks.',
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleTestWebhook(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const webhookId = validateRequired<string>(args, 'webhook_id', 'string');
  const idempotencyKey = validateOptionalIdempotencyKey(args);

  const result = await client.testWebhook(webhookId, idempotencyKey);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            webhook_id: webhookId,
            success: result.success,
            status_code: result.status_code,
            error: result.error,
            tip: result.success
              ? 'Webhook endpoint is reachable and responding correctly.'
              : 'Check your endpoint URL, ensure it accepts POST requests, and returns a 2xx status code.',
          },
          null,
          2
        ),
      },
    ],
  };
}

async function handleListWebhookDeliveries(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const webhookId = validateRequired<string>(args, 'webhook_id', 'string');
  const rawStatus = args.status;
  let status: string | undefined;
  if (rawStatus !== undefined) {
    if (typeof rawStatus !== 'string') {
      throw new Error('status must be a string');
    }
    const normalizedStatus = rawStatus.toLowerCase();
    const validStatuses = ['pending', 'processing', 'delivered', 'failed', 'retrying'];
    if (!validStatuses.includes(normalizedStatus)) {
      throw new Error(`status must be one of: ${validStatuses.join(', ')}`);
    }
    status = normalizedStatus;
  }
  const limit = validateOptional(args, 'limit', 'number', 50);

  const deliveries = await client.listWebhookDeliveries(webhookId, {
    status,
    limit: Math.min(Math.max(limit, 1), 100),
  });

  const formattedDeliveries = deliveries.map(formatWebhookDelivery);

  // Group by status
  const byStatus: Record<string, number> = {};
  for (const d of deliveries) {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  }

  // Group by event type
  const byEventType: Record<string, number> = {};
  for (const d of deliveries) {
    byEventType[d.event_type] = (byEventType[d.event_type] || 0) + 1;
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            webhook_id: webhookId,
            filter: status ?? 'all',
            total_deliveries: deliveries.length,
            by_status: byStatus,
            by_event_type: byEventType,
            deliveries: formattedDeliveries,
          },
          null,
          2
        ),
      },
    ],
  };
}

// ============================================================================
// Handler Registry
// ============================================================================

export const RESOURCE_HANDLERS: Record<string, ToolHandler> = {
  [TOOL_NAMES.LIST_INDEXES]: handleListIndexes,
  [TOOL_NAMES.GET_INDEX]: handleGetIndex,
  [TOOL_NAMES.LIST_PROMPTS]: handleListPrompts,
  [TOOL_NAMES.GET_VIDEO]: handleGetVideo,
  [TOOL_NAMES.GET_VIDEO_SEGMENTS]: handleGetVideoSegments,
  [TOOL_NAMES.LIST_PROMPT_RUNS]: handleListPromptRuns,
  [TOOL_NAMES.ESTIMATE_PROMPT_RUN]: handleEstimatePromptRun,
  [TOOL_NAMES.EXECUTE_PROMPT]: handleExecutePrompt,
  [TOOL_NAMES.GET_PROMPT_RUN_STATUS]: handleGetPromptRunStatus,
  [TOOL_NAMES.CANCEL_PROMPT_RUN]: handleCancelPromptRun,
  [TOOL_NAMES.GET_PROMPT_RUN_RESULTS]: handleGetPromptRunResults,
  [TOOL_NAMES.GET_PROMPT_RUN_VIDEO_RESULT]: handleGetPromptRunVideoResult,
  [TOOL_NAMES.GET_PROMPT_RUN_FAILED_SEGMENTS]: handleGetPromptRunFailedSegments,
  [TOOL_NAMES.RETRY_PROMPT_RUN_SEGMENT]: handleRetryPromptRunSegment,
  [TOOL_NAMES.GET_PROMPT_RUN_SEGMENT_RETRY_STATUS]: handleGetPromptRunSegmentRetryStatus,
  // Prompt Management
  [TOOL_NAMES.CREATE_PROMPT]: handleCreatePrompt,
  [TOOL_NAMES.GET_PROMPT]: handleGetPrompt,
  [TOOL_NAMES.UPDATE_PROMPT]: handleUpdatePrompt,
  [TOOL_NAMES.TEST_PROMPT_SCHEMA]: handleTestPromptSchema,
  [TOOL_NAMES.GET_PROMPT_USAGE]: handleGetPromptUsage,
  // Cloud Connectors
  [TOOL_NAMES.CREATE_GCS_CONNECTOR]: handleCreateGCSConnector,
  [TOOL_NAMES.CREATE_S3_CONNECTOR]: handleCreateS3Connector,
  [TOOL_NAMES.CREATE_AZURE_CONNECTOR]: handleCreateAzureConnector,
  [TOOL_NAMES.LIST_CONNECTORS]: handleListConnectors,
  [TOOL_NAMES.TEST_CONNECTOR]: handleTestConnector,
  [TOOL_NAMES.BROWSE_CONNECTOR_FILES]: handleBrowseConnectorFiles,
  // Import Jobs
  [TOOL_NAMES.CREATE_IMPORT_JOB]: handleCreateImportJob,
  [TOOL_NAMES.LIST_IMPORT_JOBS]: handleListImportJobs,
  [TOOL_NAMES.GET_IMPORT_JOB]: handleGetImportJob,
  [TOOL_NAMES.CANCEL_IMPORT_JOB]: handleCancelImportJob,
  // Index Management
  [TOOL_NAMES.CREATE_INDEX]: handleCreateIndex,
  // Video Management
  [TOOL_NAMES.LIST_VIDEOS]: handleListVideos,
  [TOOL_NAMES.GET_VIDEOS_STATUS]: handleGetVideosStatus,
  // Exports
  [TOOL_NAMES.EXPORT_INDEX_METADATA]: handleExportIndexMetadata,
  [TOOL_NAMES.EXPORT_PROMPT_RUN]: handleExportPromptRun,
  [TOOL_NAMES.GET_EXPORT_STATUS]: handleGetExportStatus,
  [TOOL_NAMES.GET_EXPORT_DOWNLOAD_URL]: handleGetExportDownloadUrl,
  // Webhooks
  [TOOL_NAMES.CREATE_WEBHOOK]: handleCreateWebhook,
  [TOOL_NAMES.LIST_WEBHOOKS]: handleListWebhooks,
  [TOOL_NAMES.GET_WEBHOOK]: handleGetWebhook,
  [TOOL_NAMES.UPDATE_WEBHOOK]: handleUpdateWebhook,
  [TOOL_NAMES.LIST_WEBHOOK_EVENTS]: handleListWebhookEvents,
  [TOOL_NAMES.TEST_WEBHOOK]: handleTestWebhook,
  [TOOL_NAMES.LIST_WEBHOOK_DELIVERIES]: handleListWebhookDeliveries,
};

export function isResourceTool(toolName: string): boolean {
  return toolName in RESOURCE_HANDLERS;
}

export async function executeResourceTool(
  toolName: string,
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const handler = RESOURCE_HANDLERS[toolName];
  if (!handler) {
    throw new Error(`Unknown resource tool: ${toolName}`);
  }

  try {
    return await handler(args, client);
  } catch (error) {
    return formatError(error);
  }
}
