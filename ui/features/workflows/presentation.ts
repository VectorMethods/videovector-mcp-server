import type { PromptExecutionConfig, PromptSelectionCondition } from '../../services/api';
import { getConditionOperatorDefinition } from '../../config/conditionSearch';

export type EngineEditorTab = 'processing' | 'extraction' | 'filters';

export const getEngineSegmentationLabel = (
  config: PromptExecutionConfig,
): string => {
  const mode = config.video_segmentation_type;
  const duration = config.video_segment_duration;
  if (mode === 'content_aware') return 'Content-aware';
  return duration ? `Fixed · ${duration}s` : 'Fixed';
};

export const formatEngineFieldLabel = (path: string): string => path
  .split('.')
  .map((part) => part.replace(/_/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase()))
  .join(' › ');

export const formatEngineConditionValue = (condition: PromptSelectionCondition): string => {
  const value = condition.value;
  if (value === '' || value === undefined || value === null) return 'Not set';
  const type = condition.operator.startsWith('length_') ? 'integer'
    : condition.type === 'array' ? condition.item_type : condition.type;
  if (type === 'boolean') return value === true || value === 'true' ? 'true' : 'false';
  return type === 'number' || type === 'integer' ? String(value) : `“${String(value)}”`;
};

export const getEngineConditionPreview = (condition: PromptSelectionCondition): string => {
  const operator = getConditionOperatorDefinition(condition.type, condition.operator);
  return [
    formatEngineFieldLabel(condition.field),
    operator?.label.toLowerCase() || condition.operator.replace(/_/g, ' '),
    operator?.requiresValue === false ? '' : formatEngineConditionValue(condition),
  ].filter(Boolean).join(' ');
};
