import { normalizeConditionFilters } from '../../utils/conditionSearchState';
import { SEARCH_TILE_SIZE_DEFAULT, SEARCH_TILE_SIZE_MIN, SEARCH_TILE_SIZE_MAX } from '../search-workspace/tileSize';
import type { FilterCondition, SearchResult, Video } from '../../services/api';
import type { FieldDefinition } from '../../utils/filterUtils';

export type StudioVideo = Pick<Video, 'video_id' | 'title' | 'thumbnail_gcs_uri' | 'gif_gcs_uri'> & Partial<Video>;
export interface StudioRun {
  run_id: string;
  prompt_id?: string;
  prompt_name: string;
  executed_at: string;
  status: string;
  video_ids: string[];
}
export interface StudioBrowseTarget { video_id: string; run_id: string; cursor?: string; limit?: number }
export interface StudioSearchCatalog {
  videos: StudioVideo[];
  runs: StudioRun[];
  browse_targets: StudioBrowseTarget[];
  fields: FieldDefinition[];
  nextCursor?: string | null;
  warnings?: string[];
  scopeError?: string;
}
export interface StudioSearchPage { results: SearchResult[]; snapshotId: string; nextCursor?: string | null; truncated?: boolean; warnings?: string[] }
export interface StudioBrowsePage { video_id: string; run_id: string; results: SearchResult[]; nextCursor?: string | null }
export interface StudioSearchTransport {
  invalidateCatalog?: () => void;
  catalog(options: { videoIds?: string[]; cursor?: string; signal?: AbortSignal }): Promise<StudioSearchCatalog>;
  browse(options: { targets: StudioBrowseTarget[]; signal?: AbortSignal }): Promise<StudioBrowsePage[]>;
  search(options: { videoIds: string[]; query: string; filters: FilterCondition[]; signal?: AbortSignal }): Promise<StudioSearchPage>;
  page(options: { snapshotId: string; cursor?: string; signal?: AbortSignal }): Promise<StudioSearchPage>;
}
/** Only decisions and snapshot descriptors persist; grants and records stay in memory. */
export interface StudioSearchState {
  videoIds: string[] | null;
  query: string;
  filters: FilterCondition[];
  selectedResultKey: string | null;
  scrollTop: number;
  tileSize?: number;
  snapshotId?: string;
  loadedPageCursors?: Array<string | null>;
  submittedQuery?: string;
  semanticWindowFiltered?: boolean;
}
export const DEFAULT_STUDIO_SEARCH_STATE: StudioSearchState = {
  videoIds: null, query: '', filters: [], selectedResultKey: null, scrollTop: 0,
};
export const normalizeStudioSearchState = (value: Partial<StudioSearchState> | null | undefined): StudioSearchState => ({
  videoIds: Array.isArray(value?.videoIds) ? Array.from(new Set(value!.videoIds.filter((id) => typeof id === 'string' && id.trim()))) : null,
  query: typeof value?.query === 'string' ? value.query.slice(0, 2000) : '',
  filters: normalizeConditionFilters(value?.filters),
  selectedResultKey: typeof value?.selectedResultKey === 'string' ? value.selectedResultKey : null,
  scrollTop: Math.max(0, Number(value?.scrollTop) || 0),
  tileSize: Math.min(SEARCH_TILE_SIZE_MAX, Math.max(SEARCH_TILE_SIZE_MIN, Number(value?.tileSize) || SEARCH_TILE_SIZE_DEFAULT)),
  snapshotId: typeof value?.snapshotId === 'string' ? value.snapshotId : undefined,
  loadedPageCursors: Array.isArray(value?.loadedPageCursors) ? value!.loadedPageCursors.filter((cursor) => cursor === null || typeof cursor === 'string').slice(0, 100) : undefined,
  submittedQuery: typeof value?.submittedQuery === 'string' ? value.submittedQuery : undefined,
  semanticWindowFiltered: value?.semanticWindowFiltered === true,
});
