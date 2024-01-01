import type { VideoVectorClient } from '../client/index.js';
import type { PreviewGrantIdentity, WorkflowRunResultsRequest, WorkflowSearchRequest } from '../types/index.js';
import { VideoVectorApiError } from '../types/index.js';
import type { ToolHandlerResult } from './index.js';
import { ToolInputError } from '../utils/helpers.js';
import { RESULTS_ARTIFACT_TOOL, RESULTS_MEDIA_TOOL, RESULTS_VIEW_TOOL, STUDIO_SCOPE_TOOL, STUDIO_PREVIEWS_TOOL, ANALYSIS_VIEW_TOOL } from './workflow-result-contract.js';
import { projectWorkflowPayload, asRecord, appOrigin, resultLink } from './workflow-result-projection.js';
import { addWorkflowPreviewReferences } from './workflow-result-previews.js';

function required(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new ToolInputError(`${key} must be a non-empty ID`);
  return value;
}
function optional(args: Record<string, unknown>, key: string): string | undefined {
  return args[key] === undefined ? undefined : required(args, key);
}
function optionalCursor(args: Record<string, unknown>, key: string): string | undefined {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== 'string' || !args[key]) throw new ToolInputError(`${key} must be a non-empty cursor`);
  return args[key] as string;
}
function exact(args: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(args).some(key => !keys.includes(key))) throw new ToolInputError('Unsupported results card argument');
}

async function loadViewContext(runId: string, videoId: string, destination: unknown, client: VideoVectorClient): Promise<Record<string, unknown>> {
  const [run, video] = await Promise.all([client.getPromptRun(runId), client.getVideo(videoId)]);
  const pick = (value: object, keys: string[]): Record<string, unknown> => Object.fromEntries(
    keys.flatMap(key => (value as Record<string, unknown>)[key] === undefined ? [] : [[key, (value as Record<string, unknown>)[key]]]),
  );
  let videoLevelOutput: Record<string, unknown> | null = null;
  if (run.video_level_enabled) {
    try {
      const output = await client.getPromptRunVideoResult(runId, videoId);
      const projected = projectWorkflowPayload('analysis_results', {
        run_id: runId, destination, filtered: null, unfiltered: { data: [output], pagination: {} },
      }, 'full');
      videoLevelOutput = (asRecord(projected.unfiltered).data as Record<string, unknown>[])[0] ?? null;
    } catch (error) {
      if (!(error instanceof VideoVectorApiError) || error.statusCode !== 404) throw error;
    }
  }
  return {
    run: pick(run, ['run_id', 'prompt_id', 'prompt_name', 'prompt_type', 'executed_at', 'status',
      'video_segmentation_type', 'audio_segmentation_type', 'video_segment_duration', 'audio_segment_duration',
      'total_videos', 'completed_videos', 'failed_videos', 'enable_transcription', 'enable_image_embedding',
      'field_extraction_succeeded', 'transcription_succeeded', 'image_embedding_succeeded', 'video_level_enabled',
      'selection_filter', 'selection_summary']),
    video: pick(video, ['video_id', 'title', 'status', 'created_at', 'media_type', 'duration_seconds']),
    video_level_output: videoLevelOutput,
  };
}

export async function executeResultsAppTool(name: string, args: Record<string, unknown>, client: VideoVectorClient): Promise<ToolHandlerResult> {
  if (name === ANALYSIS_VIEW_TOOL) {
    exact(args, ['analysis_id', 'import_id', 'detail', 'video_id', 'intent', 'cursor', 'page_size']);
    if (args.import_id !== undefined) {
      exact(args, ['import_id']);
      const snapshot = await client.mcpImportProgress(required(args, 'import_id'));
      return { content: [{ type: 'text', text: 'Import updated in Studio.' }], _meta: { import: snapshot } };
    }
    if (args.intent !== undefined && args.intent !== 'download') throw new ToolInputError('Invalid analysis intent');
    const analysisId = required(args, 'analysis_id');
    const detail = args.detail ?? 'summary';
    if (detail !== 'summary' && detail !== 'full') throw new ToolInputError('detail must be summary or full');
    if (args.page_size !== undefined && (!Number.isInteger(args.page_size) || Number(args.page_size) < 1 || Number(args.page_size) > 20)) throw new ToolInputError('page_size must be between 1 and 20');
    const analysis = await client.getAnalysis(analysisId, {
      ...(args.cursor === undefined ? {} : { cursor: optionalCursor(args, 'cursor') }),
      ...(args.page_size === undefined ? {} : { page_size: Number(args.page_size) }),
      detail, include_download: args.intent === 'download',
      ...(args.video_id === undefined ? {} : { video_id: required(args, 'video_id') }),
    });
    const videoId = optional(args, 'video_id') ?? (analysis.results.videos?.[0] as { video_id?: string } | undefined)?.video_id;
    const openInApp = videoId ? resultLink({ video_id: videoId, source_index_id: analysis.scope?.index_id }, analysisId, 'all', appOrigin()) : undefined;
    return { content: [{ type: 'text', text: 'Analysis updated in Studio.' }], _meta: { analysis: { ...analysis, ...(openInApp ? { links: { open_in_app: openInApp } } : {}) } } };
  }
  if (name === STUDIO_SCOPE_TOOL) {
    exact(args, ['index_id', 'video_ids', 'prompt_run_ids', 'cursor', 'limit']);
    const indexId = optional(args, 'index_id');
    if (args.video_ids !== undefined && args.prompt_run_ids !== undefined) throw new ToolInputError('Select videos or prompt runs, not both');
    const limit = args.limit ?? 100;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ToolInputError('limit must be between 1 and 100');
    let videoIds: string[] | undefined;
    if (args.video_ids !== undefined) {
      if (!Array.isArray(args.video_ids) || args.video_ids.length < 1 || args.video_ids.length > 100) throw new ToolInputError('video_ids must contain between 1 and 100 IDs');
      videoIds = [...new Set(args.video_ids.map((id: unknown) => required({ id }, 'id')))];
    }
    let promptRunIds: string[] | undefined;
    if (args.prompt_run_ids !== undefined) {
      if (!Array.isArray(args.prompt_run_ids) || args.prompt_run_ids.length < 1 || args.prompt_run_ids.length > 100) throw new ToolInputError('prompt_run_ids must contain between 1 and 100 IDs');
      promptRunIds = [...new Set(args.prompt_run_ids.map((id: unknown) => required({ id }, 'id')))];
    }
    const cursor = optionalCursor(args, 'cursor');
    if (cursor && (videoIds || promptRunIds)) throw new ToolInputError('Library continuation does not accept a scope selector');
    const videos = videoIds || promptRunIds
      ? { data: [], pagination: { limit, has_more: false, next_cursor: null } }
      : indexId && indexId !== 'playground'
        ? await client.getVideosInIndex(indexId, limit, cursor)
        : await client.getPlaygroundVideos({ limit, cursor });
    const emptyScope = { runs: [], browse_targets: [], fields: [], warnings: [] };
    const selectedVideos = videoIds ?? (!promptRunIds ? videos.data.map(video => video.video_id) : undefined);
    const scope = selectedVideos?.length === 0 ? emptyScope
      : await client.workflowSearchScope(promptRunIds ? { prompt_run_ids: promptRunIds } : {
        video_ids: selectedVideos!, latest_only: true, container_index_id: indexId ?? 'playground',
      }).catch(error => {
        if (!(error instanceof VideoVectorApiError) || error.code !== 'scope_too_large') throw error;
        return { ...emptyScope, scope_error: error.message };
      });
    const targets = (scope as { browse_targets?: Array<{ video_id: string }> }).browse_targets;
    const scopeError = (scope as { scope_error?: string }).scope_error;
    const processedIds = targets && !scopeError ? new Set(targets.map(target => target.video_id)) : null;
    const publicVideos = videos.data.filter(video => !processedIds || processedIds.has(video.video_id)).map(video => ({
      ...Object.fromEntries(
        ['video_id', 'title', 'media_type', 'status', 'created_at', 'duration_seconds', 'thumbnail_gcs_uri', 'gif_gcs_uri'].flatMap(key =>
          (video as unknown as Record<string, unknown>)[key] === undefined ? [] : [[key, (video as unknown as Record<string, unknown>)[key]]]),
      ),
      processing_status: (video.processing_status ?? []).map(run => ({
        run_id: run.run_id, created_at: run.created_at, updated_at: run.updated_at,
        segments: (run.segments ?? []).map(segment => ({ status: segment.status })),
      })),
    }));
    return {
      content: [{ type: 'text', text: 'Studio videos and searchable executions loaded.' }],
      _meta: { catalog: { ...scope, container: { type: indexId && indexId !== 'playground' ? 'index' : 'playground', ...(indexId && indexId !== 'playground' ? { index_id: indexId } : {}) }, videos: publicVideos, pagination: videos.pagination, nextCursor: videos.pagination.next_cursor } },
    };
  }
  if (name === STUDIO_PREVIEWS_TOOL) {
    exact(args, ['items']);
    if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 24) throw new ToolInputError('items must contain between 1 and 24 preview identities');
    const items: PreviewGrantIdentity[] = args.items.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputError('Invalid preview identity');
      const item = value as Record<string, unknown>;
      exact(item, ['kind', 'video_id', 'segment_id']);
      const videoId = required(item, 'video_id');
      if (item.kind === 'segment') return { kind: 'segment', video_id: videoId, segment_id: required(item, 'segment_id') };
      if (item.kind !== 'video' || item.segment_id !== undefined) throw new ToolInputError('Invalid preview identity');
      return { kind: 'video', video_id: videoId };
    });
    return {
      content: [{ type: 'text', text: 'Studio previews loaded.' }],
      _meta: { previews: await client.getPreviewGrants(items) },
    };
  }
  if (name === RESULTS_ARTIFACT_TOOL) {
    exact(args, ['source_kind', 'source_id', 'scope', 'export_id']);
    const sourceKind = required(args, 'source_kind');
    const sourceId = required(args, 'source_id');
    const scope = required(args, 'scope');
    const exportId = required(args, 'export_id');
    if ((sourceKind !== 'prompt_run' && sourceKind !== 'search_snapshot')
      || (sourceKind === 'search_snapshot' ? scope !== 'search_results' : !['all', 'matches'].includes(scope))) {
      throw new ToolInputError('Invalid artifact source or result scope');
    }
    const job = await client.getExportStatus(exportId);
    const actualScope = job.export_type === 'search_snapshot' ? 'search_results'
      : job.export_params?.result_scope === 'matches' ? 'matches' : 'all';
    if (job.export_id !== exportId || job.export_type !== sourceKind || job.target_id !== sourceId || actualScope !== scope) {
      throw new ToolInputError('The export does not match this result source and scope');
    }
    if (job.status !== 'completed' || job.destination_type !== 'download' || !job.download_url
      || !Number.isSafeInteger(job.file_size_bytes) || (job.file_size_bytes ?? 0) <= 0) {
      throw new ToolInputError('This JSON artifact is not ready for direct download');
    }
    const grant = await client.mintExportDownloadUrl(exportId);
    if (!grant.download_url) throw new ToolInputError('This JSON artifact is not ready for direct download');
    const filename = scope === 'matches' ? 'matching-results.json'
      : scope === 'search_results' ? 'search-results.json' : 'full-results.json';
    return {
      content: [{ type: 'text', text: 'The JSON download is ready in the results card.' }],
      _meta: { artifact: { url: grant.download_url, name: filename, mimeType: 'application/json', sizeBytes: job.file_size_bytes } },
    };
  }
  if (name === RESULTS_MEDIA_TOOL) {
    exact(args, ['video_id', 'run_id', 'segment_id', 'intent']);
    const videoId = required(args, 'video_id');
    const runId = optional(args, 'run_id');
    const segmentId = optional(args, 'segment_id');
    const intent = args.intent ?? 'playback';
    if (intent !== 'playback' && intent !== 'download') throw new ToolInputError('Invalid media intent');
    if (segmentId && !runId) throw new ToolInputError('run_id is required for segment playback');
    const grant = await client.workflowMediaGrant({ video_id: videoId, ...(runId ? { run_id: runId } : {}), ...(segmentId ? { segment_id: segmentId } : {}), ...(intent === 'download' ? { intent } : {}) });
    const url = new URL(grant.url);
    if (url.protocol !== 'https:' || url.username || url.password
      || !(url.hostname === 'storage.googleapis.com' || url.hostname.endsWith('.storage.googleapis.com'))
      || !Number.isFinite(Date.parse(grant.expires_at))) {
      throw new ToolInputError('The playback grant is unavailable. Open this result in the application.');
    }
    if (intent === 'download') {
      if (!grant.filename || !/^[A-Za-z0-9._-]{1,180}$/.test(grant.filename)) throw new ToolInputError('Media download is unavailable');
      return {
        content: [{ type: 'text', text: 'The media download is ready in the results card.' }],
        _meta: { file: { url: grant.url, name: grant.filename, mimeType: grant.mime_type || 'application/octet-stream' } },
      };
    }
    return {
      content: [{ type: 'text', text: 'Playback is ready in the results card.' }],
      _meta: { media: { url: grant.url, expires_at: grant.expires_at,
        ...(grant.mime_type ? { mime_type: grant.mime_type } : {}),
        ...(grant.start_time === undefined ? {} : { start_time: grant.start_time }),
        ...(grant.end_time === undefined ? {} : { end_time: grant.end_time }),
      } },
    };
  }
  if (name !== RESULTS_VIEW_TOOL) throw new ToolInputError('Unknown results card tool');
  if (args.action === 'search') {
    exact(args, ['action', 'container_index_id', 'video_ids', 'query', 'filters', 'idempotency_key', 'limit', 'result_level']);
    if (!Array.isArray(args.video_ids) || !args.video_ids.length || args.video_ids.length > 100) throw new ToolInputError('Select between 1 and 100 videos');
    if (args.query !== undefined && typeof args.query !== 'string') throw new ToolInputError('query must be a string');
    if (args.filters !== undefined && (!Array.isArray(args.filters) || args.filters.length > 4)) throw new ToolInputError('filters must contain at most four conditions');
    const request: WorkflowSearchRequest = {
      video_ids: [...new Set(args.video_ids.map((id: unknown) => required({ id }, 'id')))],
      latest_only: true, result_level: 'segment', limit: 50,
      container_index_id: optional(args, 'container_index_id') ?? 'playground',
      ...(args.query ? { query: args.query as string } : {}),
      ...(args.filters ? { filters: args.filters as WorkflowSearchRequest['filters'] } : {}),
    };
    const response = await client.workflowSearchMedia(request, optional(args, 'idempotency_key'));
    const projected = projectWorkflowPayload('search_results', response as unknown as Record<string, unknown>, 'full');
    addWorkflowPreviewReferences(projected, response as unknown as Record<string, unknown>);
    return { content: [{ type: 'text', text: 'Search results loaded in Studio.' }], _meta: { view: projected } };
  }
  exact(args, ['source_kind', 'source_id', 'result_level', 'view', 'video_id', 'cursor', 'filtered_cursor', 'unfiltered_cursor', 'limit', 'include_context']);
  const sourceId = required(args, 'source_id');
  const kind = required(args, 'source_kind');
  if (kind !== 'prompt_run' && kind !== 'search_snapshot') throw new ToolInputError('Unsupported result source');
  if (args.include_context !== undefined && typeof args.include_context !== 'boolean') throw new ToolInputError('include_context must be a boolean');
  if (args.include_context && (kind !== 'prompt_run' || !args.video_id)) throw new ToolInputError('Context requires a prompt_run source and video_id');
  const limit = args.limit ?? 10;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new ToolInputError('limit must be between 1 and 50');
  let projected: Record<string, unknown>;
  if (kind === 'search_snapshot') {
    if (['result_level', 'view', 'video_id', 'filtered_cursor', 'unfiltered_cursor'].some(key => args[key] !== undefined)) throw new ToolInputError('Search snapshot pages accept only cursor and limit');
    const response = await client.workflowSnapshotResults(sourceId, { cursor: optionalCursor(args, 'cursor'), limit, include_download: false });
    projected = projectWorkflowPayload('search_results', response, 'full');
    addWorkflowPreviewReferences(projected, response as unknown as Record<string, unknown>);
  } else {
    if (args.cursor !== undefined) throw new ToolInputError('Use the filtered or unfiltered cursor for prompt run pages');
    const resultLevel = args.result_level ?? 'segment';
    const view = args.view ?? 'both';
    if (!['segment', 'video'].includes(String(resultLevel)) || !['both', 'filtered', 'unfiltered'].includes(String(view))) throw new ToolInputError('Invalid result level or view');
    const options: WorkflowRunResultsRequest = {
      result_level: resultLevel as 'segment' | 'video', view: view as WorkflowRunResultsRequest['view'], limit,
      video_id: optional(args, 'video_id'), filtered_cursor: optionalCursor(args, 'filtered_cursor'), unfiltered_cursor: optionalCursor(args, 'unfiltered_cursor'),
    };
    const response = await client.workflowRunResults(sourceId, options);
    projected = projectWorkflowPayload('analysis_results', { ...response }, 'full');
    addWorkflowPreviewReferences(projected, { ...response });
  }
  const context = args.include_context ? await loadViewContext(sourceId, required(args, 'video_id'), projected.destination, client) : undefined;
  return { content: [{ type: 'text', text: 'Result page loaded in the results card.' }], _meta: { view: projected, ...(context ? { context } : {}) } };
}
