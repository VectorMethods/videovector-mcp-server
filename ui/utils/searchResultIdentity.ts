import type { PreviewGrantProjection } from '../contexts/PreviewGrantContext';
import type { SearchResult } from '../services/api';
import type { BatchVideoSegmentsTarget } from '../services/api';
import { isStorageMediaUri, pickDurableMediaUri } from './mediaSources';

type RunScopedResult = Pick<SearchResult, 'run_id' | 'prompt_run_id' | 'source_run_id'>;

export const getSearchResultRunId = (result: Partial<RunScopedResult>): string | null => (
  result.run_id ?? result.prompt_run_id ?? result.source_run_id ?? null
);

export const getSearchResultReferenceSegmentId = (
  result: Partial<Pick<SearchResult, 'segment_id' | 'preview_segment_id'>>,
): string | null => (
  result.segment_id ?? result.preview_segment_id ?? null
);

export const getSearchResultKey = (result: Partial<SearchResult>): string => {
  const indexId = result.source_index_id || 'no-index';
  const videoId = result.video_id || 'no-video';
  const runId = getSearchResultRunId(result) || 'no-run';
  const segmentId = getSearchResultReferenceSegmentId(result)
    || (result.result_type === 'video' ? 'video' : null)
    || result.result_id
    || 'no-segment';
  return `${indexId}:${videoId}:${runId}:${segmentId}`;
};

/**
 * A rendered occurrence is allowed to repeat the same run-scoped result in
 * multiple Agent messages/result sets. Keep that UI identity separate from
 * the physical result identity used for hydration and patching.
 */
export const getSearchResultOccurrenceKey = (
  result: Partial<SearchResult>,
  context?: { turnId?: string | null; resultSetId?: string | null },
): string => [
  context?.turnId || 'no-turn',
  context?.resultSetId || 'no-result-set',
  getSearchResultKey(result),
].join('::');

export const getSearchResultIdentity = (result: Partial<SearchResult>): string => (
  getSearchResultKey(result)
);

export type SearchResultMediaKind = 'thumbnail' | 'gif' | 'segment';

interface MediaAssetCacheKeyOptions {
  durableSource?: string | null;
  videoId?: string | null;
  runId?: string | null;
  segmentId?: string | null;
  mediaKind: SearchResultMediaKind;
}

/**
 * Physical preview identity is deliberately separate from rendered-result
 * identity. A durable asset URI lets Index, Search, SQL, and Agent reuse the
 * same decoded bitmap even when their result wrappers differ. When a gallery
 * projection has no durable URI, retain the full run-scoped tuple so two runs
 * cannot accidentally alias different derived media.
 */
export const getMediaAssetCacheKey = ({
  durableSource,
  videoId,
  runId,
  segmentId,
  mediaKind,
}: MediaAssetCacheKeyOptions): string => {
  const durableAssetUri = pickDurableMediaUri(durableSource);
  if (isStorageMediaUri(durableAssetUri)) {
    return `media:${mediaKind}:asset:${durableAssetUri}`;
  }
  return [
    'media',
    videoId || 'no-video',
    runId || 'no-run',
    segmentId || 'video',
    mediaKind,
  ].join(':');
};

/**
 * Stable identity for the combined media projection persisted by agent
 * hydration. Unlike an individual preview asset this key must not change
 * after hydration adds a GCS URI, otherwise the fulfilled patch would no
 * longer match the result that requested it.
 */
export const getSearchResultMediaKey = (result: Partial<SearchResult>): string => [
  'media-projection',
  result.video_id || 'no-video',
  getSearchResultRunId(result) || 'no-run',
  getSearchResultReferenceSegmentId(result) || 'video',
].join(':');

const getSearchResultDurableAssetUri = (
  result: Partial<SearchResult>,
  kind: SearchResultMediaKind,
): string | null => {
  if (kind === 'thumbnail') {
    return pickDurableMediaUri(
      result.thumbnail_gcs_uri,
      result.preview_thumbnail_uri,
      result.thumbnail_uri,
    );
  }
  if (kind === 'gif') {
    return pickDurableMediaUri(
      result.gif_gcs_uri,
      result.preview_gif_uri,
      result.gif_uri,
    );
  }
  return pickDurableMediaUri(
    result.gcs_uri,
    result.preview_segment_uri,
    result.segment_uri,
    result.result_type === 'video' ? result.video_uri : null,
  );
};

export const getSearchResultPreviewCacheKey = (
  result: Partial<SearchResult>,
  kind: SearchResultMediaKind,
): string => getMediaAssetCacheKey({
  durableSource: getSearchResultDurableAssetUri(result, kind),
  videoId: result.video_id,
  runId: getSearchResultRunId(result),
  segmentId: getSearchResultReferenceSegmentId(result),
  mediaKind: kind,
});

export const getSearchResultVideoRunScopeKey = (
  videoId: string | null | undefined,
  runId: string | null | undefined,
): string => `${videoId || 'no-video'}:${runId || 'no-run'}`;

export const getSearchResultVideoRunScopeKeyForResult = (
  result: Partial<SearchResult>,
): string => getSearchResultVideoRunScopeKey(result.video_id, getSearchResultRunId(result));

/** Build one exact-segment target per video/run scope. */
export const buildBatchVideoSegmentTargetsForResults = (
  results: Array<Partial<SearchResult>>,
): BatchVideoSegmentsTarget[] => {
  const grouped = new Map<string, {
    videoId: string;
    runId: string | null;
    segmentIds: Set<string>;
  }>();
  results.forEach((result) => {
    const videoId = String(result.video_id || '').trim();
    const segmentId = String(getSearchResultReferenceSegmentId(result) || '').trim();
    if (!videoId || !segmentId) return;
    const runId = getSearchResultRunId(result);
    const scopeKey = getSearchResultVideoRunScopeKey(videoId, runId);
    const scope = grouped.get(scopeKey) || {
      videoId,
      runId,
      segmentIds: new Set<string>(),
    };
    scope.segmentIds.add(segmentId);
    grouped.set(scopeKey, scope);
  });
  return Array.from(grouped.values())
    .sort((left, right) => (
      getSearchResultVideoRunScopeKey(left.videoId, left.runId)
        .localeCompare(getSearchResultVideoRunScopeKey(right.videoId, right.runId))
    ))
    .map((scope) => ({
      video_id: scope.videoId,
      run_id: scope.runId || undefined,
      segment_ids: Array.from(scope.segmentIds).sort(),
    }));
};

export const buildSearchResultIdentitySignature = (
  results: SearchResult[],
): string => Array.from(
  new Set(
    results
      .map((result) => getSearchResultIdentity(result))
      .filter((identity) => identity.length > 0),
  ),
)
  .sort()
  .join('|');

export const mergeSearchResultsByIdentity = (
  existingResults: SearchResult[],
  incomingResults: SearchResult[],
): SearchResult[] => {
  const mergedResults = new Map<string, SearchResult>();

  existingResults.forEach((result) => {
    mergedResults.set(getSearchResultIdentity(result), result);
  });

  incomingResults.forEach((result) => {
    mergedResults.set(getSearchResultIdentity(result), result);
  });

  return Array.from(mergedResults.values());
};

export const collectUniqueSearchResultsByIdentity = (
  ...resultGroups: Array<SearchResult[] | null | undefined>
): SearchResult[] => (
  resultGroups.reduce<SearchResult[]>(
    (collectedResults, group) => mergeSearchResultsByIdentity(collectedResults, group || []),
    [],
  )
);

type SegmentIdentityResult = Pick<
  SearchResult,
  'segment_id' | 'preview_segment_id' | 'video_id' | 'start_time' | 'end_time' | 'preview_start_time' | 'preview_end_time' | 'source_index_id'
> & Partial<RunScopedResult>;

export const getSegmentIdentityKey = (segment: SegmentIdentityResult): string => {
  const startValue = typeof segment.start_time === 'number'
    ? segment.start_time
    : typeof segment.preview_start_time === 'number'
      ? segment.preview_start_time
      : null;
  const endValue = typeof segment.end_time === 'number'
    ? segment.end_time
    : typeof segment.preview_end_time === 'number'
      ? segment.preview_end_time
      : null;
  const start = startValue !== null ? startValue.toFixed(3) : '0.000';
  const end = endValue !== null ? endValue.toFixed(3) : '0.000';
  const runId = getSearchResultRunId(segment) || 'no-run';
  const sourceIndexId = segment.source_index_id || 'no-index';
  return `${segment.video_id}::${getSearchResultReferenceSegmentId(segment) || 'video'}::${start}::${end}::${runId}::${sourceIndexId}`;
};

export const getSegmentRefLookupKey = (
  videoId: string,
  segmentId: string,
  runId?: string | null,
  sourceIndexId?: string | null,
): string => `${videoId}::${segmentId}::${runId || 'no-run'}::${sourceIndexId || 'no-index'}`;

export const mergeUniqueSearchResults = (
  current: SearchResult[],
  incoming: SearchResult[],
): SearchResult[] => {
  if (!incoming.length) return current;

  const merged = new Map<string, SearchResult>();
  current.forEach((result) => {
    merged.set(getSegmentIdentityKey(result), result);
  });
  incoming.forEach((result) => {
    merged.set(getSegmentIdentityKey(result), result);
  });
  return Array.from(merged.values());
};

export const getSearchSegmentPreviewProjection = (result: SearchResult): PreviewGrantProjection | null => {
  const segmentId = result.result_type === 'video'
    ? result.preview_segment_id
    : result.segment_id;
  const thumbnailGcsUri = pickDurableMediaUri(result.thumbnail_gcs_uri);
  const gifGcsUri = pickDurableMediaUri(result.gif_gcs_uri);
  const assetsRevision = (result as SearchResult & { assets_revision?: string }).assets_revision;
  if (!segmentId || (!thumbnailGcsUri && !gifGcsUri && !assetsRevision)) return null;
  return {
    identity: {
      kind: 'segment',
      video_id: result.video_id,
      segment_id: segmentId,
    },
    thumbnailGcsUri,
    gifGcsUri,
    ...(assetsRevision ? { assetsRevision } : {}),
  };
};
