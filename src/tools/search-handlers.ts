/**
 * Search Tool Handlers
 *
 * Implements handlers for all search-related MCP tools:
 * - search_videos
 * - search_videos_by_image
 * - multimodal_search
 * - filter_videos
 */

import type { TextContent } from '@modelcontextprotocol/sdk/types.js';
import type { VideoVectorClient } from '../client/index.js';
import type {
  SearchResult,
  ImageSearchResult,
  MultimodalSearchResult,
  FilterCondition,
  Segment,
  MarkerInfo,
} from '../types/index.js';
import { TOOL_NAMES } from './definitions.js';
import { formatError, validateRequired } from '../utils/helpers.js';

// ============================================================================
// Response Formatters
// ============================================================================

const SEGMENT_ENRICHMENT_MAX_PAGES = 10;
const SEGMENT_ENRICHMENT_MIN_PAGE_SIZE = 20;

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

function formatSegmentForSearch(segment: Segment): Record<string, unknown> {
  return {
    segment_id: segment.segment_id,
    video_id: segment.video_id,
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
    segment_status: segment.segment_status,
    failure_stage: segment.failure_stage,
    failure_message: segment.failure_message,
    attempt_id: segment.attempt_id,
    status_source: segment.status_source,
    metadata: segment.metadata,
    metadata_text: segment.metadata_text,
    thumbnail_available: segment.thumbnail_available,
    gif_available: segment.gif_available,
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

function formatSearchResult(
  result: SearchResult,
  segment: Segment | null,
  videoName?: string | null
): Record<string, unknown> {
  const hasTiming = typeof result.start_time === 'number' && typeof result.end_time === 'number';
  const payload: Record<string, unknown> = {
    result_type: result.result_type,
    result_id: result.result_id,
    video_id: result.video_id,
    video_uri: result.video_uri,
    video_name: videoName ?? result.video_name ?? null,
    segment_id: result.segment_id,
    start_time: result.start_time,
    end_time: result.end_time,
    preview_segment_id: result.preview_segment_id ?? null,
    preview_start_time: result.preview_start_time ?? null,
    preview_end_time: result.preview_end_time ?? null,
    preview_segment_uri: result.preview_segment_uri ?? null,
    preview_thumbnail_uri: result.preview_thumbnail_uri ?? null,
    preview_gif_uri: result.preview_gif_uri ?? null,
    duration: hasTiming ? Math.round(((result.end_time as number) - (result.start_time as number)) * 100) / 100 : null,
    score: Math.round(result.similarity_score * 1000) / 1000,
    similarity_score: result.similarity_score,
    content: result.text_content,
    text_content: result.text_content,
    content_preview: result.content_preview,
    metadata: result.extracted_metadata,
    extracted_metadata: result.extracted_metadata,
    field_scores: result.field_scores ?? null,
    field_instance_scores: result.field_instance_scores ?? null,
    matched_field_paths: result.matched_field_paths ?? null,
    matched_field_instances: result.matched_field_instances ?? null,
    thumbnail_available: result.thumbnail_available,
    thumbnail_uri: result.thumbnail_uri,
    thumbnail_data: result.thumbnail_data,
    gif_available: result.gif_available,
    gif_uri: result.gif_uri,
    gif_data: result.gif_data,
    segment_uri: result.segment_uri,
    run_id: result.run_id,
    source_run_id: result.source_run_id ?? null,
    prompt_run_id: result.prompt_run_id ?? null,
    source_index_id: result.source_index_id,
    marker: formatMarker(result.marker),
    extracted_metadata_markers: formatMetadataMarkers(result.extracted_metadata_markers),
  };

  payload.segment = result.result_type === 'segment' && segment ? formatSegmentForSearch(segment) : null;
  return payload;
}

function formatImageSearchResult(
  result: ImageSearchResult,
  videoName?: string | null
): Record<string, unknown> {
  const matchedImageScore =
    result.matched_image_score === null || result.matched_image_score === undefined
      ? null
      : Math.round(result.matched_image_score * 1000) / 1000;

  return {
    ...formatSearchResult(result, null, videoName),
    matched_image_uri: result.matched_image_uri,
    matched_image_score: matchedImageScore,
    matched_image_timestamp: result.matched_image_timestamp,
    shot_timestamp: result.shot_timestamp,
  };
}

function formatMultimodalResult(
  result: MultimodalSearchResult,
  videoName?: string | null
): Record<string, unknown> {
  const hasTextScore = result.text_score !== null && result.text_score !== undefined;
  const hasImageScore = result.image_score !== null && result.image_score !== undefined;
  const hasMatchedImageScore = result.matched_image_score !== null && result.matched_image_score !== undefined;
  const textScore = hasTextScore ? Math.round((result.text_score as number) * 1000) / 1000 : null;
  const imageScore = hasImageScore ? Math.round((result.image_score as number) * 1000) / 1000 : null;
  const matchedImageScore = hasMatchedImageScore
    ? Math.round((result.matched_image_score as number) * 1000) / 1000
    : null;

  return {
    ...formatSearchResult(result, null, videoName),
    fused_score: Math.round(result.fused_score * 1000) / 1000,
    text_score: textScore,
    image_score: imageScore,
    text_rank: result.text_rank,
    image_rank: result.image_rank,
    match_type: result.match_type,
    matched_image_uri: result.matched_image_uri,
    matched_image_timestamp: result.matched_image_timestamp,
    matched_image_score: matchedImageScore,
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

interface SegmentLookupGroup {
  videoId: string;
  runId?: string;
  segmentIds: Set<string>;
}

function normalizeRunId(runId: string | null | undefined): string | undefined {
  return typeof runId === 'string' && runId.trim().length > 0 ? runId : undefined;
}

function segmentLookupKey(videoId: string, segmentId: string, runId?: string): string {
  return `${videoId}::${segmentId}::${runId ?? ''}`;
}

function buildSegmentLookupGroups(results: SearchResult[]): SegmentLookupGroup[] {
  const groups = new Map<string, SegmentLookupGroup>();

  for (const result of results) {
    if (result.result_type !== 'segment' || !result.segment_id) {
      continue;
    }
    const runId = normalizeRunId(result.run_id);
    const key = `${result.video_id}::${runId ?? ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.segmentIds.add(result.segment_id);
      continue;
    }

    groups.set(key, {
      videoId: result.video_id,
      runId,
      segmentIds: new Set([result.segment_id]),
    });
  }

  return Array.from(groups.values());
}

async function enrichSearchResultsWithSegments(
  results: SearchResult[],
  client: VideoVectorClient
): Promise<{ segmentsByResultKey: Map<string, Segment>; failedGroups: number }> {
  const segmentsByResultKey = new Map<string, Segment>();
  let failedGroups = 0;

  if (results.length === 0 || typeof client.getVideoSegments !== 'function') {
    return { segmentsByResultKey, failedGroups };
  }

  const groups = buildSegmentLookupGroups(results);

  for (const group of groups) {
    try {
      const pageSize = Math.min(Math.max(group.segmentIds.size, SEGMENT_ENRICHMENT_MIN_PAGE_SIZE), 100);
      let cursor: string | undefined;
      let pagesFetched = 0;

      while (pagesFetched < SEGMENT_ENRICHMENT_MAX_PAGES) {
        const response = await client.getVideoSegments(group.videoId, {
          runId: group.runId,
          limit: pageSize,
          cursor,
        });

        for (const segment of response.data) {
          if (!group.segmentIds.has(segment.segment_id)) {
            continue;
          }
          const key = segmentLookupKey(segment.video_id, segment.segment_id, group.runId);
          if (!segmentsByResultKey.has(key)) {
            segmentsByResultKey.set(key, segment);
          }
        }

        const unresolved = Array.from(group.segmentIds).some(
          (segmentId) => !segmentsByResultKey.has(segmentLookupKey(group.videoId, segmentId, group.runId))
        );

        if (!unresolved) {
          break;
        }

        if (!response.pagination.has_more || !response.pagination.next_cursor) {
          break;
        }

        cursor = response.pagination.next_cursor ?? undefined;
        pagesFetched += 1;
      }
    } catch {
      failedGroups += 1;
    }
  }

  return { segmentsByResultKey, failedGroups };
}

async function fetchVideoNames(
  results: SearchResult[],
  client: VideoVectorClient
): Promise<Map<string, string>> {
  const videoNameMap = new Map<string, string>();

  if (results.length === 0 || typeof client.getVideo !== 'function') {
    return videoNameMap;
  }

  // Get unique video IDs
  const uniqueVideoIds = new Set(results.map((r) => r.video_id));

  // Fetch video info for each unique video ID
  const fetchPromises = Array.from(uniqueVideoIds).map(async (videoId) => {
    try {
      const video = await client.getVideo(videoId);
      if (video?.title) {
        videoNameMap.set(videoId, video.title);
      }
    } catch {
      // Silently ignore failures - video name is optional enrichment
    }
  });

  await Promise.all(fetchPromises);
  return videoNameMap;
}

// ============================================================================
// Search Handlers
// ============================================================================

async function handleSearchVideos(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const query = validateRequired<string>(args, 'query', 'string');
  const indexId = validateRequired<string>(args, 'index_id', 'string');
  const rawTopK = args.top_k;
  const topK = rawTopK !== undefined ? Number(rawTopK) : 10;
  if (rawTopK !== undefined && (isNaN(topK) || !Number.isInteger(topK))) {
    throw new Error('top_k must be a valid integer');
  }
  const searchFields = validateOptionalStringArray(args, 'search_fields');
  const runIds = validateOptionalStringArray(args, 'run_ids');
  const indexIds = validateOptionalStringArray(args, 'index_ids');

  const results = await client.searchVideos(indexId, {
    query,
    top_k: Math.min(Math.max(topK, 1), 100),
    search_fields: searchFields,
    run_ids: runIds,
    index_ids: indexIds,
  });

  // Fetch enrichments in parallel: segments and video names
  const [{ segmentsByResultKey, failedGroups }, videoNameMap] = await Promise.all([
    enrichSearchResultsWithSegments(results, client),
    fetchVideoNames(results, client),
  ]);

  let enrichedCount = 0;
  const formattedResults = results.map((result) => {
    const segment = result.result_type === 'segment' && result.segment_id
      ? segmentsByResultKey.get(
          segmentLookupKey(result.video_id, result.segment_id, normalizeRunId(result.run_id))
        ) ?? null
      : null;
    if (segment) {
      enrichedCount += 1;
    }
    const videoName = videoNameMap.get(result.video_id) ?? null;
    return formatSearchResult(result, segment, videoName);
  });
  const payload = {
    query,
    index_id: indexId,
    total_results: results.length,
    segment_enrichment: {
      resolved_results: enrichedCount,
      unresolved_results: results.length - enrichedCount,
      failed_groups: failedGroups,
    },
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

async function handleSearchByImage(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const imageData = validateRequired<string>(args, 'image_data', 'string');
  const indexId = validateRequired<string>(args, 'index_id', 'string');
  const rawTopK = args.top_k;
  const topK = rawTopK !== undefined ? Number(rawTopK) : 10;
  if (rawTopK !== undefined && (isNaN(topK) || !Number.isInteger(topK))) {
    throw new Error('top_k must be a valid integer');
  }
  const runIds = validateOptionalStringArray(args, 'run_ids');
  const indexIds = validateOptionalStringArray(args, 'index_ids');

  // Validate image data is base64
  if (!/^[A-Za-z0-9+/=]+$/.test(imageData.replace(/\s/g, ''))) {
    throw new Error('image_data must be valid base64-encoded data');
  }

  const results = await client.searchByImage(indexId, {
    image_data: imageData,
    top_k: Math.min(Math.max(topK, 1), 100),
    run_ids: runIds,
    index_ids: indexIds,
  });

  // Fetch video names for enrichment
  const videoNameMap = await fetchVideoNames(results, client);
  const formattedResults = results.map((result) => {
    const videoName = videoNameMap.get(result.video_id) ?? null;
    return formatImageSearchResult(result, videoName);
  });
  const payload = {
    index_id: indexId,
    search_type: 'image',
    total_results: results.length,
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

async function handleMultimodalSearch(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const indexId = validateRequired<string>(args, 'index_id', 'string');
  const textQuery = args.text_query as string | undefined;
  const imageData = args.image_data as string | undefined;
  const searchFields = validateOptionalStringArray(args, 'search_fields');
  const runIds = validateOptionalStringArray(args, 'run_ids');
  const indexIds = validateOptionalStringArray(args, 'index_ids');

  // Parse and validate weights - convert to number and check for NaN
  const rawTextWeight = args.text_weight;
  const rawImageWeight = args.image_weight;
  const textWeight = rawTextWeight !== undefined ? Number(rawTextWeight) : 0.5;
  const imageWeight = rawImageWeight !== undefined ? Number(rawImageWeight) : 0.5;

  // Validate weights are valid numbers in range [0, 1]
  if (typeof rawTextWeight !== 'undefined' && (isNaN(textWeight) || typeof rawTextWeight === 'string' && rawTextWeight.trim() === '')) {
    throw new Error('text_weight must be a valid number');
  }
  if (typeof rawImageWeight !== 'undefined' && (isNaN(imageWeight) || typeof rawImageWeight === 'string' && rawImageWeight.trim() === '')) {
    throw new Error('image_weight must be a valid number');
  }
  if (textWeight < 0 || textWeight > 1) {
    throw new Error('text_weight must be between 0 and 1');
  }
  if (imageWeight < 0 || imageWeight > 1) {
    throw new Error('image_weight must be between 0 and 1');
  }

  const rawTopK = args.top_k;
  const topK = rawTopK !== undefined ? Number(rawTopK) : 10;
  if (rawTopK !== undefined && (isNaN(topK) || !Number.isInteger(topK))) {
    throw new Error('top_k must be a valid integer');
  }

  // Validate at least one query type is provided
  if (!textQuery && !imageData) {
    throw new Error('At least one of text_query or image_data must be provided');
  }

  // Validate weights sum to 1 (now safe since we've validated both are numbers)
  if (Math.abs(textWeight + imageWeight - 1.0) > 0.01) {
    throw new Error('text_weight and image_weight must sum to 1.0');
  }

  // Validate image data if provided
  if (imageData && !/^[A-Za-z0-9+/=]+$/.test(imageData.replace(/\s/g, ''))) {
    throw new Error('image_data must be valid base64-encoded data');
  }

  const results = await client.searchMultimodal(indexId, {
    text_query: textQuery,
    image_data: imageData,
    text_weight: textWeight,
    image_weight: imageWeight,
    top_k: Math.min(Math.max(topK, 1), 100),
    search_fields: searchFields,
    run_ids: runIds,
    index_ids: indexIds,
  });

  // Fetch video names for enrichment
  const videoNameMap = await fetchVideoNames(results, client);
  const formattedResults = results.map((result) => {
    const videoName = videoNameMap.get(result.video_id) ?? null;
    return formatMultimodalResult(result, videoName);
  });
  const payload = {
    index_id: indexId,
    search_type: 'multimodal',
    text_query: textQuery ?? null,
    has_image: !!imageData,
    text_weight: textWeight,
    image_weight: imageWeight,
    total_results: results.length,
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

async function handleFilterVideos(
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const indexId = validateRequired<string>(args, 'index_id', 'string');
  const conditions = validateRequired<unknown[]>(args, 'conditions', 'object');
  const startAfter = args.start_after as string | undefined;
  const runIds = validateOptionalStringArray(args, 'run_ids');
  const indexIds = validateOptionalStringArray(args, 'index_ids');
  const rawPageSize = args.page_size;
  const pageSize = rawPageSize !== undefined ? Number(rawPageSize) : 50;
  if (rawPageSize !== undefined && (isNaN(pageSize) || !Number.isInteger(pageSize))) {
    throw new Error('page_size must be a valid integer');
  }

  // Validate conditions
  if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > 5) {
    throw new Error('conditions must be an array with 1-5 filter conditions');
  }

  const validatedConditions: FilterCondition[] = conditions.map((cond, index) => {
    const condition = cond as Record<string, unknown>;
    if (!condition.field || typeof condition.field !== 'string') {
      throw new Error(`Condition ${index + 1}: 'field' is required and must be a string`);
    }
    if (!condition.operator || typeof condition.operator !== 'string') {
      throw new Error(`Condition ${index + 1}: 'operator' is required and must be a string`);
    }
    if (condition.value === undefined) {
      throw new Error(`Condition ${index + 1}: 'value' is required`);
    }
    if (!condition.type || typeof condition.type !== 'string') {
      throw new Error(`Condition ${index + 1}: 'type' is required and must be a string`);
    }
    if (
      condition.fuzzyMatch !== undefined &&
      condition.fuzzyMatch !== null &&
      typeof condition.fuzzyMatch !== 'boolean'
    ) {
      throw new Error(`Condition ${index + 1}: 'fuzzyMatch' must be a boolean when provided`);
    }

    return {
      field: condition.field as string,
      operator: condition.operator as FilterCondition['operator'],
      value: condition.value,
      type: condition.type as FilterCondition['type'],
      fuzzyMatch: condition.fuzzyMatch as boolean | undefined,
    };
  });

  const response = await client.filterSearch(indexId, {
    conditions: validatedConditions,
    page_size: Math.min(Math.max(pageSize, 1), 100),
    start_after: startAfter,
    run_ids: runIds,
    index_ids: indexIds,
  });

  // Fetch video names for enrichment
  const videoNameMap = await fetchVideoNames(response.results, client);
  const formattedResults = response.results.map((result) => {
    const videoName = videoNameMap.get(result.video_id) ?? null;
    return formatSearchResult(result, null, videoName);
  });
  const payload = {
    index_id: indexId,
    search_type: 'filter',
    conditions: validatedConditions.map((c) => ({
      field: c.field,
      operator: c.operator,
      value: c.value,
    })),
    total_results: response.total_shown,
    has_more: !!response.next_page_token,
    next_cursor: response.next_page_token ?? null,
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

// ============================================================================
// Handler Registry
// ============================================================================

export const SEARCH_HANDLERS: Record<string, ToolHandler> = {
  [TOOL_NAMES.SEARCH_VIDEOS]: handleSearchVideos,
  [TOOL_NAMES.SEARCH_VIDEOS_BY_IMAGE]: handleSearchByImage,
  [TOOL_NAMES.MULTIMODAL_SEARCH]: handleMultimodalSearch,
  [TOOL_NAMES.FILTER_VIDEOS]: handleFilterVideos,
};

export function isSearchTool(toolName: string): boolean {
  return toolName in SEARCH_HANDLERS;
}

export async function executeSearchTool(
  toolName: string,
  args: Record<string, unknown>,
  client: VideoVectorClient
): Promise<ToolHandlerResult> {
  const handler = SEARCH_HANDLERS[toolName];
  if (!handler) {
    throw new Error(`Unknown search tool: ${toolName}`);
  }

  try {
    return await handler(args, client);
  } catch (error) {
    return formatError(error);
  }
}
