import type { PromptSelectionFilter } from '../../services/api';
import type { SegmentData } from '../../services/segmentCache';
import type { ConditionFieldDefinition } from '../../config/conditionSearch';
import { extractFieldsFromResults, matchesMetadataConditions } from '../../utils/filterUtils';

export const getStudioConditionFields = (
  metadata: ReadonlyArray<Record<string, unknown> | undefined>,
): ConditionFieldDefinition[] => extractFieldsFromResults(
  metadata.map((value) => ({ extracted_metadata: value })),
).flatMap((field) => field.type === 'unknown' || field.searchable === false ? [] : [{
  path: field.name,
  label: field.label || field.name,
  type: field.type,
  itemType: field.itemType === 'object' ? undefined : field.itemType,
  description: field.description,
}]);

// Ad-hoc conditions narrow the chosen run result view. A level without
// conditions stays unconstrained; saved run filters are evaluated by the API.
export const selectStudioResults = (
  segments: readonly SegmentData[],
  videoMetadata: Record<string, unknown> | null,
  filter: PromptSelectionFilter | null,
): { segmentIds: Set<string>; videoMatched: boolean } => {
  if (!filter) return {
    segmentIds: new Set(segments.map((segment) => segment.segment_id)),
    videoMatched: videoMetadata !== null,
  };
  const videoMatched = filter.video ? Boolean(videoMetadata && matchesMetadataConditions(
    videoMetadata,
    filter.video.conditions.map((condition) => ({ ...condition, value: condition.value })),
    filter.video.logic,
  )) : videoMetadata !== null;
  const segmentGroup = filter.segment;
  const segmentConditions = segmentGroup?.conditions.map((condition) => ({ ...condition, value: condition.value })) || [];
  const segmentIds = new Set(segmentGroup ? segments.filter((segment) => (
    segment.metadata && segment.field_extraction_succeeded !== false
    && matchesMetadataConditions(segment.metadata, segmentConditions, segmentGroup.logic)
  )).map((segment) => segment.segment_id) : videoMatched
    ? segments.map((segment) => segment.segment_id) : []);
  if (filter.segment && filter.video && filter.level_logic !== 'or'
    && (!videoMatched || segmentIds.size === 0)) {
    return { segmentIds: new Set(), videoMatched: false };
  }
  return { segmentIds, videoMatched };
};

// A plain, case-insensitive substring search across field names and values.
export const studioSearchText = (metadata: unknown, text = ''): string => (
  `${JSON.stringify(metadata || {})} ${text}`.replace(/_/g, ' ').toLocaleLowerCase()
);
