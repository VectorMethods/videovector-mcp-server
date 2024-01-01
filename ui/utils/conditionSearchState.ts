import type { FilterCondition } from '../services/api';
import {
  canonicalizeOperator,
  getOperatorsForField,
  MAX_CONDITIONS,
} from './conditionSearchFilters';
import {
  canonicalizeFilterFieldName,
  type FieldDefinition,
} from './filterUtils';

type ConditionFilterType = FilterCondition['type'];
type ConditionFilterItemType = NonNullable<FilterCondition['itemType']>;

const SUPPORTED_FILTER_TYPES = new Set<ConditionFilterType>([
  'unknown',
  'string',
  'integer',
  'number',
  'boolean',
  'array',
]);

const SUPPORTED_ARRAY_ITEM_TYPES = new Set<ConditionFilterItemType>([
  'string',
  'integer',
  'number',
  'boolean',
]);

export const DEFAULT_CONDITION_FILTER: FilterCondition = {
  field: '',
  operator: 'equals',
  value: '',
  type: 'string',
};

const hasOwnFilterValue = (filter: Partial<FilterCondition>): boolean => (
  Object.prototype.hasOwnProperty.call(filter, 'value')
);

const isSupportedFilterType = (value: unknown): value is ConditionFilterType => (
  typeof value === 'string' && SUPPORTED_FILTER_TYPES.has(value as ConditionFilterType)
);

const isSupportedArrayItemType = (value: unknown): value is ConditionFilterItemType => (
  typeof value === 'string' && SUPPORTED_ARRAY_ITEM_TYPES.has(value as ConditionFilterItemType)
);

export const inferConditionFilterItemType = (
  filter: Pick<FilterCondition, 'type' | 'operator' | 'itemType'>,
): FilterCondition['itemType'] | undefined => {
  if (filter.type !== 'array') {
    return undefined;
  }

  if (isSupportedArrayItemType(filter.itemType)) {
    return filter.itemType;
  }

  if (canonicalizeOperator(filter.operator) === 'item_contains') {
    return 'string';
  }

  return undefined;
};

export const normalizeConditionFilters = (
  filters: unknown,
  options: {
    availableFields?: FieldDefinition[];
    dynamicNestedPrefixes?: string[];
  } = {},
): FilterCondition[] => {
  if (!Array.isArray(filters)) {
    return [];
  }

  const availableFields = options.availableFields || [];
  const dynamicNestedPrefixes = options.dynamicNestedPrefixes || [];

  return filters
    .filter((filter): filter is Partial<FilterCondition> => Boolean(filter) && typeof filter === 'object')
    .slice(0, MAX_CONDITIONS)
    .map((filter) => {
      const rawFieldName = typeof filter.field === 'string' ? filter.field : '';
      const fieldName = canonicalizeFilterFieldName(
        rawFieldName,
        availableFields,
        { dynamicNestedPrefixes },
      );
      const fieldDefinition = fieldName
        ? availableFields.find((field) => field.name === fieldName)
        : undefined;
      const operator = canonicalizeOperator(
        typeof filter.operator === 'string' ? filter.operator : '',
      );
      const type = fieldDefinition?.type && fieldDefinition.type !== 'unknown'
        ? fieldDefinition.type
        : isSupportedFilterType(filter.type)
          ? filter.type
          : 'unknown';
      const rawFieldItemType = fieldDefinition?.itemType;
      const fieldItemType = isSupportedArrayItemType(rawFieldItemType)
        ? rawFieldItemType
        : undefined;
      const itemType = inferConditionFilterItemType({
        type,
        operator,
        itemType: fieldItemType,
      }) ?? inferConditionFilterItemType({
        type,
        operator,
        itemType: filter.itemType,
      });

      return {
        field: fieldName,
        operator,
        value: hasOwnFilterValue(filter) ? filter.value : '',
        type,
        ...(itemType ? { itemType } : {}),
      };
    });
};

export const isConditionFilterSupported = (
  filter: FilterCondition,
): boolean => {
  if (!filter.field || !filter.operator || !filter.type || filter.type === 'unknown') {
    return false;
  }

  return getOperatorsForField({
    type: filter.type,
    itemType: inferConditionFilterItemType(filter),
  }).some((operator) => operator.value === canonicalizeOperator(filter.operator));
};

export const restoreConditionFilters = (
  filters: unknown,
  options: {
    availableFields?: FieldDefinition[];
    dynamicNestedPrefixes?: string[];
  } = {},
): FilterCondition[] => {
  const normalized = normalizeConditionFilters(filters, options);
  if (normalized.length === 0) {
    return [{ ...DEFAULT_CONDITION_FILTER }];
  }

  return normalized.every(isConditionFilterSupported)
    ? normalized
    : [{ ...DEFAULT_CONDITION_FILTER }];
};

export const areConditionFiltersEqual = (
  left: FilterCondition[],
  right: FilterCondition[],
): boolean => {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }

  return left.every((filter, index) => {
    const other = right[index];
    return filter.field === other.field
      && filter.operator === other.operator
      && filter.type === other.type
      && filter.value === other.value
      && filter.itemType === other.itemType;
  });
};
