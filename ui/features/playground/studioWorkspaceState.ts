import type { PromptSelectionFilter } from '../../services/api';
import { normalizePromptSelectionFilter } from '../workflows/config';

export type StudioMetadataSortDirection = 'asc' | 'desc';
export type StudioMetadataViewMode = 'fields' | 'json';

export interface PlaygroundStudioWorkspaceState {
  scopeVideoId: string | null;
  scopeRunId: string | null;
  selectedSegmentId: string | null;
  metadataSortDirection: StudioMetadataSortDirection;
  metadataSearchTerm: string;
  metadataViewMode: StudioMetadataViewMode;
  collapsedMetadataPaths: string[];
  videoLevelViewMode: StudioMetadataViewMode;
  collapsedVideoLevelPaths: string[];
  resultSearchTerm: string;
  resultFilter: PromptSelectionFilter | null;
  muted: boolean;
  volume: number;
}

export const DEFAULT_PLAYGROUND_STUDIO_WORKSPACE_STATE: PlaygroundStudioWorkspaceState = {
  scopeVideoId: null,
  scopeRunId: null,
  selectedSegmentId: null,
  metadataSortDirection: 'asc',
  metadataSearchTerm: '',
  metadataViewMode: 'fields',
  collapsedMetadataPaths: [],
  videoLevelViewMode: 'fields',
  collapsedVideoLevelPaths: [],
  resultSearchTerm: '',
  resultFilter: null,
  muted: false,
  volume: 0.8,
};

const normalizeNullableString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const normalizePaths = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.flatMap((path) => {
    if (typeof path !== 'string') return [];
    const normalized = path.trim();
    return normalized && normalized.length <= 500 ? [normalized] : [];
  }))).slice(0, 250);
};

export const normalizePlaygroundStudioWorkspaceState = (
  value: unknown,
): PlaygroundStudioWorkspaceState => {
  const candidate = value && typeof value === 'object'
    ? value as Partial<PlaygroundStudioWorkspaceState>
    : {};
  const rawVolume = Number(candidate.volume);
  return {
    scopeVideoId: normalizeNullableString(candidate.scopeVideoId),
    scopeRunId: normalizeNullableString(candidate.scopeRunId),
    selectedSegmentId: normalizeNullableString(candidate.selectedSegmentId),
    metadataSortDirection: candidate.metadataSortDirection === 'desc' ? 'desc' : 'asc',
    metadataSearchTerm: typeof candidate.metadataSearchTerm === 'string'
      ? candidate.metadataSearchTerm.slice(0, 500)
      : '',
    metadataViewMode: candidate.metadataViewMode === 'json' ? 'json' : 'fields',
    collapsedMetadataPaths: normalizePaths(candidate.collapsedMetadataPaths),
    videoLevelViewMode: candidate.videoLevelViewMode === 'json' ? 'json' : 'fields',
    collapsedVideoLevelPaths: normalizePaths(candidate.collapsedVideoLevelPaths),
    resultSearchTerm: typeof candidate.resultSearchTerm === 'string' ? candidate.resultSearchTerm.slice(0, 500) : '',
    resultFilter: normalizePromptSelectionFilter(candidate.resultFilter),
    muted: Boolean(candidate.muted),
    volume: Number.isFinite(rawVolume) ? Math.min(1, Math.max(0, rawVolume)) : 0.8,
  };
};

export const createPlaygroundStudioWorkspaceState = (
  scopeVideoId: string | null,
  scopeRunId: string | null,
): PlaygroundStudioWorkspaceState => ({
  ...DEFAULT_PLAYGROUND_STUDIO_WORKSPACE_STATE,
  scopeVideoId,
  scopeRunId,
  collapsedMetadataPaths: [],
  collapsedVideoLevelPaths: [],
});
