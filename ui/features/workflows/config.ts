import type {
  Prompt,
  PromptExecutionConfig,
  PromptRun,
  PromptSelectionCondition,
  PromptSelectionFilter,
  PromptSelectionFilterGroup,
} from '../../services/api';
import type { ConditionFieldDefinition } from '../../config/conditionSearch';
import {
  MAX_CONDITION_FILTERS,
  operatorRequiresConditionValue,
} from '../../config/conditionSearch';
import { validateConditions } from '../../utils/conditionSearchFilters';

export const DEFAULT_PROMPT_EXECUTION_CONFIG: PromptExecutionConfig = {
  video_segmentation_type: 'content_aware',
  audio_segmentation_type: 'content_aware',
  video_segment_duration: null,
  audio_segment_duration: null,
  processing_model: null,

  enable_image_embedding: true,
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const asFinitePositiveInteger = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const normalizePromptExecutionConfig = (
  value: unknown,
): PromptExecutionConfig => {
  const config = isRecord(value) ? value : {};
  const videoSegmentationType = config.video_segmentation_type;
  const audioSegmentationType = config.audio_segmentation_type;

  return {
    video_segmentation_type: videoSegmentationType === 'fixed'
      || videoSegmentationType === 'content_aware'
      ? videoSegmentationType
      : DEFAULT_PROMPT_EXECUTION_CONFIG.video_segmentation_type,
    audio_segmentation_type: audioSegmentationType === 'fixed'
      || audioSegmentationType === 'content_aware'
      ? audioSegmentationType
      : DEFAULT_PROMPT_EXECUTION_CONFIG.audio_segmentation_type,
    video_segment_duration: videoSegmentationType === 'fixed'
      ? asFinitePositiveInteger(config.video_segment_duration, 10)
      : null,
    audio_segment_duration: audioSegmentationType === 'fixed'
      ? asFinitePositiveInteger(config.audio_segment_duration, 30)
      : null,
    processing_model: typeof config.processing_model === 'string' && config.processing_model.trim()
      ? config.processing_model.trim()
      : null,
    enable_image_embedding: typeof config.enable_image_embedding === 'boolean'
      ? config.enable_image_embedding
      : DEFAULT_PROMPT_EXECUTION_CONFIG.enable_image_embedding,
  };
};

const normalizeCondition = (value: unknown): PromptSelectionCondition | null => {
  if (!isRecord(value)) return null;
  const field = typeof value.field === 'string' ? value.field.trim() : '';
  const operator = typeof value.operator === 'string' ? value.operator.trim().toLowerCase() : '';
  if (!field || !operator) return null;
  const type = value.type === 'integer'
    || value.type === 'number'
    || value.type === 'boolean'
    || value.type === 'array'
    ? value.type
    : 'string';
  const itemType = value.item_type === 'string'
    || value.item_type === 'integer'
    || value.item_type === 'number'
    || value.item_type === 'boolean'
    ? value.item_type
    : undefined;
  return {
    field,
    operator,
    type,
    ...(itemType ? { item_type: itemType } : {}),
    ...(Object.prototype.hasOwnProperty.call(value, 'value') ? { value: value.value } : {}),
  };
};

const normalizeGroup = (value: unknown): PromptSelectionFilterGroup | undefined => {
  if (!isRecord(value) || !Array.isArray(value.conditions)) return undefined;
  const conditions = value.conditions
    .map(normalizeCondition)
    .filter((condition): condition is PromptSelectionCondition => Boolean(condition));
  if (conditions.length === 0) return undefined;
  return {
    logic: value.logic === 'or' ? 'or' : 'and',
    conditions,
  };
};

export const normalizePromptSelectionFilter = (
  value: unknown,
): PromptSelectionFilter | null => {
  if (!isRecord(value)) return null;
  const segment = normalizeGroup(value.segment);
  const video = normalizeGroup(value.video);
  if (!segment && !video) return null;
  return {
    ...(segment ? { segment } : {}),
    ...(video ? { video } : {}),
    level_logic: value.level_logic === 'or' ? 'or' : 'and',
  };
};

export const hasPromptSelectionFilter = (
  value: PromptSelectionFilter | null | undefined,
): boolean => Boolean(value?.segment?.conditions.length || value?.video?.conditions.length);

export const promptRunHasSelectionFilter = (
  run: PromptRun | null | undefined,
): boolean => Boolean(
  run?.selection_summary
  && run.selection_summary.status !== 'not_applicable',
);

export const getEffectivePromptExecutionConfig = (
  prompt: Pick<Prompt, 'execution_config'>,
  defaultProcessingModel?: string | null,
): PromptExecutionConfig => {
  const normalized = normalizePromptExecutionConfig(prompt.execution_config);
  return {
    ...normalized,
    processing_model: normalized.processing_model || defaultProcessingModel || null,
  };
};

const coerceConditionValue = (
  value: unknown,
  field: ConditionFieldDefinition,
  operator: string,
): unknown => {
  if (!operatorRequiresConditionValue(field.type, operator)) return undefined;
  if (
    field.type === 'integer'
    || field.type === 'number'
    || (field.type === 'array' && operator.startsWith('length_'))
    || (field.type === 'array' && (field.itemType === 'integer' || field.itemType === 'number'))
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  if (field.type === 'boolean' || (field.type === 'array' && field.itemType === 'boolean')) {
    return value === true || value === 'true';
  }
  return typeof value === 'string' ? value.trim() : value;
};

export const validateAndBuildSelectionFilter = (
  value: PromptSelectionFilter | null | undefined,
  segmentFields: ConditionFieldDefinition[],
  videoFields: ConditionFieldDefinition[],
): { filter: PromptSelectionFilter | null; error: string | null } => {
  const normalized = normalizePromptSelectionFilter(value);
  if (!normalized) return { filter: null, error: null };
  const totalConditions = (normalized.segment?.conditions.length || 0)
    + (normalized.video?.conditions.length || 0);
  if (totalConditions > MAX_CONDITION_FILTERS) {
    return { filter: null, error: `A workflow can have at most ${MAX_CONDITION_FILTERS} selection conditions.` };
  }

  const validateGroup = (
    group: PromptSelectionFilterGroup | undefined,
    fields: ConditionFieldDefinition[],
    label: string,
  ): PromptSelectionFilterGroup | undefined => {
    if (!group) return undefined;
    const validation = validateConditions(
      group.conditions.map((condition) => ({ ...condition, value: condition.value })),
      fields.map((field) => ({ ...field, name: field.path })),
    );
    if (!validation.ok) throw new Error(`${label} ${validation.message}`);
    const conditions = group.conditions.map((condition) => {
      const field = fields.find((candidate) => candidate.path === condition.field)!;
      return {
        field: condition.field,
        operator: condition.operator,
        type: field.type,
        ...(field.itemType ? { item_type: field.itemType } : {}),
        ...(operatorRequiresConditionValue(field.type, condition.operator)
          ? { value: coerceConditionValue(condition.value, field, condition.operator) }
          : {}),
      };
    });
    return { logic: group.logic, conditions };
  };

  try {
    const segment = validateGroup(normalized.segment, segmentFields, 'Segment');
    const video = validateGroup(normalized.video, videoFields, 'Video');
    return {
      filter: {
        ...(segment ? { segment } : {}),
        ...(video ? { video } : {}),
        level_logic: normalized.level_logic,
      },
      error: null,
    };
  } catch (error) {
    return {
      filter: null,
      error: error instanceof Error ? error.message : 'Selection filter is invalid.',
    };
  }
};
