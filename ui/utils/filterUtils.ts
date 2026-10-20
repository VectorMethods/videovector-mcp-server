import type { FilterCondition, SearchResult } from '../services/api';
import { canonicalizeOperator } from './conditionSearchFilters';

export interface FieldDefinition {
  name: string;
  label?: string;
  type: 'unknown' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  itemType?: 'string' | 'integer' | 'number' | 'boolean' | 'object';
  searchable?: boolean;
}

interface PathSegment {
  name: string;
  repeated: boolean;
}

interface ParsedFieldPath {
  repeatedScope: string | null;
  ancestorSegments: PathSegment[];
  relativeSegments: PathSegment[];
}

const NESTED_FIELD_NAME_PREFIX = '__nested__:';
const VALUELESS_OPERATORS = new Set(['is_empty', 'is_not_empty']);

const decodeLegacyNestedFieldName = (fieldName: string): string | null => {
  if (!fieldName.startsWith(NESTED_FIELD_NAME_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fieldName.slice(NESTED_FIELD_NAME_PREFIX.length));
    if (!Array.isArray(parsed) || !parsed.every((segment) => typeof segment === 'string' && segment.trim())) {
      return null;
    }
    return parsed.join('.');
  } catch {
    return null;
  }
};

export const canonicalizeFilterFieldName = (
  fieldName: string,
  availableFields: Pick<FieldDefinition, 'name'>[],
  _options: { dynamicNestedPrefixes?: string[] } = {},
): string => {
  const normalizedFieldName = (fieldName || '').trim();
  if (!normalizedFieldName) {
    return normalizedFieldName;
  }

  if (availableFields.some((field) => field.name === normalizedFieldName)) {
    return normalizedFieldName;
  }

  const decodedLegacyPath = decodeLegacyNestedFieldName(normalizedFieldName);
  if (decodedLegacyPath && availableFields.some((field) => field.name === decodedLegacyPath)) {
    return decodedLegacyPath;
  }

  return decodedLegacyPath || normalizedFieldName;
};

const isConditionFilterComplete = (filter: FilterCondition): boolean => {
  if (!filter || !String(filter.field || '').trim() || !String(filter.operator || '').trim()) {
    return false;
  }

  const operator = canonicalizeOperator(filter.operator);
  if (VALUELESS_OPERATORS.has(operator)) {
    return true;
  }

  if (typeof filter.value === 'boolean' || typeof filter.value === 'number') {
    return true;
  }

  return typeof filter.value === 'string'
    ? filter.value.trim().length > 0
    : filter.value !== null && filter.value !== undefined;
};

const parseFieldPath = (path: string): ParsedFieldPath => {
  const rawTokens = path.split('.').map((token) => token.trim()).filter(Boolean);
  const segments: PathSegment[] = rawTokens.map((token) => ({
    name: token.endsWith('[]') ? token.slice(0, -2) : token,
    repeated: token.endsWith('[]'),
  }));

  let deepestRepeatedIndex: number | undefined;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].repeated) {
      deepestRepeatedIndex = index;
      break;
    }
  }

  if (deepestRepeatedIndex === undefined) {
    return {
      repeatedScope: null,
      ancestorSegments: [],
      relativeSegments: segments,
    };
  }

  const ancestorSegments = segments.slice(0, deepestRepeatedIndex + 1);
  return {
    repeatedScope: ancestorSegments
      .map((segment) => (segment.repeated ? `${segment.name}[]` : segment.name))
      .join('.'),
    ancestorSegments,
    relativeSegments: segments.slice(deepestRepeatedIndex + 1),
  };
};

const resolveNodes = (node: any, segments: PathSegment[]): any[] => {
  if (segments.length === 0) {
    return [node];
  }

  const [segment, ...rest] = segments;
  if (!node || typeof node !== 'object') {
    return [];
  }

  const child = node[segment.name];
  if (segment.repeated) {
    if (!Array.isArray(child)) {
      return [];
    }
    if (rest.length === 0) {
      return child;
    }
    return child.flatMap((item) => resolveNodes(item, rest));
  }

  return resolveNodes(child, rest);
};

const resolveSingleValue = (node: any, segments: PathSegment[]): any => {
  let current = node;
  for (const segment of segments) {
    if (segment.repeated) {
      return undefined;
    }
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment.name];
  }
  return current;
};

const evaluateString = (value: any, operator: string, rawFilterValue: any): boolean => {
  if (value === null || value === undefined) {
    return false;
  }
  const candidate = String(value ?? '');
  const candidateLower = candidate.toLowerCase();
  const filterValue = String(rawFilterValue ?? '');
  const filterLower = filterValue.toLowerCase();

  switch (operator) {
    case 'equals':
      return candidateLower === filterLower;
    case 'contains':
      return candidateLower.includes(filterLower);
    case 'starts_with':
      return candidateLower.startsWith(filterLower);
    case 'ends_with':
      return candidateLower.endsWith(filterLower);
    case 'is_empty':
      return candidate.length === 0;
    case 'is_not_empty':
      return candidate.length > 0;
    default:
      return false;
  }
};

const evaluateNumber = (value: any, operator: string, rawFilterValue: any): boolean => {
  // Number(null), Number('') and Number([]) become zero, unlike extraction's
  // numeric evaluator. Missing or non-numeric metadata must not match zero.
  const isNumericInput = (input: any): boolean => (
    typeof input === 'number'
    || typeof input === 'boolean'
    || (typeof input === 'string' && input.trim().length > 0)
  );
  if (!isNumericInput(value) || !isNumericInput(rawFilterValue)) {
    return false;
  }
  const candidate = Number(value);
  const target = Number(rawFilterValue);
  if (Number.isNaN(candidate) || Number.isNaN(target)) {
    return false;
  }

  switch (operator) {
    case 'equals':
      return candidate === target;
    case 'greater_than':
      return candidate > target;
    case 'greater_equal':
      return candidate >= target;
    case 'less_than':
      return candidate < target;
    case 'less_equal':
      return candidate <= target;
    default:
      return false;
  }
};

const coerceBooleanStrict = (value: any): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
};

const evaluateBoolean = (value: any, operator: string, rawFilterValue: any): boolean => {
  if (operator !== 'equals') {
    return false;
  }

  const candidate = coerceBooleanStrict(value);
  const target = coerceBooleanStrict(rawFilterValue);
  if (candidate === null || target === null) {
    return false;
  }
  return candidate === target;
};

const evaluateArray = (value: any, operator: string, rawFilterValue: any): boolean => {
  if (!Array.isArray(value)) {
    return false;
  }

  switch (operator) {
    case 'is_empty':
      return value.length === 0;
    case 'is_not_empty':
      return value.length > 0;
    case 'length_equals':
      return value.length === Number(rawFilterValue);
    case 'length_greater':
      return value.length > Number(rawFilterValue);
    case 'length_less':
      return value.length < Number(rawFilterValue);
    case 'item_equals': {
      const target = String(rawFilterValue ?? '').toLowerCase();
      return value.some((item) => String(item).toLowerCase() === target);
    }
    case 'item_contains': {
      const target = String(rawFilterValue ?? '').toLowerCase();
      return value.some((item) => typeof item === 'string' && item.toLowerCase().includes(target));
    }
    default:
      return false;
  }
};

const evaluateValue = (value: any, filter: FilterCondition): boolean => {
  const operator = canonicalizeOperator(filter.operator);
  switch (filter.type) {
    case 'string':
      return evaluateString(value, operator, filter.value);
    case 'integer':
    case 'number':
      return evaluateNumber(value, operator, filter.value);
    case 'boolean':
      return evaluateBoolean(value, operator, filter.value);
    case 'array':
      return evaluateArray(value, operator, filter.value);
    default:
      return false;
  }
};

const evaluateFilterGroup = (payload: Record<string, any>, filters: FilterCondition[]): boolean => {
  const grouped = new Map<string | null, Array<{ filter: FilterCondition; path: ParsedFieldPath }>>();

  filters.forEach((filter) => {
    const parsedPath = parseFieldPath(filter.field);
    const existing = grouped.get(parsedPath.repeatedScope) || [];
    existing.push({ filter, path: parsedPath });
    grouped.set(parsedPath.repeatedScope, existing);
  });

  for (const [repeatedScope, scopedFilters] of Array.from(grouped.entries())) {
    if (repeatedScope === null) {
      const matches = scopedFilters.every(({ filter, path }) => {
        const value = resolveSingleValue(payload, path.relativeSegments);
        return evaluateValue(value, filter);
      });
      if (!matches) {
        return false;
      }
      continue;
    }

    const items = resolveNodes(payload, scopedFilters[0].path.ancestorSegments);
    if (items.length === 0) {
      return false;
    }

    const matched = items.some((item) => (
      scopedFilters.every(({ filter, path }) => {
        const value = resolveSingleValue(item, path.relativeSegments);
        return evaluateValue(value, filter);
      })
    ));

    if (!matched) {
      return false;
    }
  }

  return true;
};

export const matchesMetadataConditions = (
  payload: Record<string, any>,
  filters: FilterCondition[],
  logic: 'and' | 'or' = 'and',
): boolean => {
  const activeFilters = filters.filter(isConditionFilterComplete);
  if (activeFilters.length === 0) {
    return true;
  }

  // AND retains same-item semantics for conditions within a repeated object.
  // OR allows any complete condition, including any item at its own path.
  return logic === 'or'
    ? activeFilters.some((filter) => evaluateFilterGroup(payload, [filter]))
    : evaluateFilterGroup(payload, activeFilters);
};

export const applyFilters = (
  results: SearchResult[],
  filters: FilterCondition[],
): SearchResult[] => {
  const activeFilters = filters.filter(isConditionFilterComplete);
  if (activeFilters.length === 0) {
    return results;
  }

  return results.filter((result) => {
    const metadata = result.extracted_metadata || {};
    return matchesMetadataConditions(metadata, activeFilters);
  });
};

const mergeFieldDefinition = (
  existing: FieldDefinition | undefined,
  incoming: FieldDefinition,
): FieldDefinition => {
  if (!existing) {
    return incoming;
  }

  const sameType = existing.type === incoming.type;
  const sameItemType = existing.itemType === incoming.itemType;
  const numericTypes = (existing.type === 'integer' || existing.type === 'number')
    && (incoming.type === 'integer' || incoming.type === 'number');
  const numericItemTypes = (existing.itemType === 'integer' || existing.itemType === 'number')
    && (incoming.itemType === 'integer' || incoming.itemType === 'number');
  const unobservedArrayItemType = existing.type === 'array' && incoming.type === 'array'
    && (!existing.itemType || !incoming.itemType);
  if ((sameType || numericTypes) && (sameItemType || numericItemTypes || unobservedArrayItemType)) {
    return {
      ...existing,
      type: sameType ? existing.type : 'number',
      ...(!sameItemType ? { itemType: numericItemTypes ? 'number' as const : existing.itemType || incoming.itemType } : {}),
      label: existing.label || incoming.label,
      description: existing.description || incoming.description,
      searchable: existing.searchable !== false && incoming.searchable !== false,
    };
  }

  return {
    ...existing,
    type: 'unknown',
    searchable: false,
  };
};

export const mergeFieldDefinitions = (fields: FieldDefinition[]): FieldDefinition[] => {
  const merged = new Map<string, FieldDefinition>();
  fields.forEach((field) => {
    const current = merged.get(field.name);
    merged.set(field.name, mergeFieldDefinition(current, field));
  });
  return Array.from(merged.values()).sort((left, right) => left.name.localeCompare(right.name));
};

const getValueType = (value: any): FieldDefinition['type'] => {
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (Number.isInteger(value)) {
    return 'integer';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  return 'unknown';
};

const collectSchemaFields = (
  schema: Record<string, any> | null | undefined,
  prefix = '',
): FieldDefinition[] => {
  if (!schema || schema.type !== 'object' || !schema.properties) {
    return [];
  }

  const fields: FieldDefinition[] = [];
  Object.entries(schema.properties).forEach(([name, propertySchema]: [string, any]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    const description = propertySchema?.description;
    const type = propertySchema?.type;

    if (type === 'string' || type === 'integer' || type === 'number' || type === 'boolean') {
      fields.push({
        name: path,
        label: path,
        type,
        description,
      });
      return;
    }

    if (type === 'object') {
      fields.push(...collectSchemaFields(propertySchema, path));
      return;
    }

    if (type !== 'array' || !propertySchema?.items) {
      return;
    }

    const itemType = propertySchema.items.type;
    if (itemType === 'string' || itemType === 'integer' || itemType === 'number' || itemType === 'boolean') {
      fields.push({
        name: path,
        label: path,
        type: 'array',
        itemType,
        description,
      });
      return;
    }

    if (itemType === 'object') {
      fields.push(...collectSchemaFields(propertySchema.items, `${path}[]`));
    }
  });

  return fields;
};

const collectRuntimeFields = (
  value: any,
  prefix: string,
  fieldMap: Map<string, FieldDefinition>,
): void => {
  if (value === null || value === undefined || !prefix) {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      fieldMap.set(prefix, mergeFieldDefinition(fieldMap.get(prefix), {
        name: prefix,
        label: prefix,
        type: 'array',
      }));
      return;
    }

    const primitiveItems = value.filter(
      (item) => item !== null && item !== undefined && typeof item !== 'object',
    );
    if (primitiveItems.length === value.length) {
      const itemType = getValueType(primitiveItems[0]);
      fieldMap.set(prefix, mergeFieldDefinition(fieldMap.get(prefix), {
        name: prefix,
        label: prefix,
        type: 'array',
        itemType: itemType === 'integer' || itemType === 'number' || itemType === 'boolean' || itemType === 'string'
          ? itemType
          : undefined,
      }));
      return;
    }

    value.forEach((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        collectRuntimeFields(item, `${prefix}[]`, fieldMap);
      }
    });
    return;
  }

  if (typeof value === 'object') {
    Object.entries(value).forEach(([childKey, childValue]) => {
      const childPath = prefix ? `${prefix}.${childKey}` : childKey;
      collectRuntimeFields(childValue, childPath, fieldMap);
    });
    return;
  }

  const type = getValueType(value);
  if (type === 'unknown') {
    return;
  }

  fieldMap.set(prefix, mergeFieldDefinition(fieldMap.get(prefix), {
    name: prefix,
    label: prefix,
    type,
  }));
};

export const extractFieldsFromResults = (
  results: readonly Pick<SearchResult, 'extracted_metadata'>[],
  promptSchema?: Record<string, any> | null,
): FieldDefinition[] => {
  if (promptSchema?.properties) {
    return mergeFieldDefinitions(collectSchemaFields(promptSchema));
  }

  const fieldMap = new Map<string, FieldDefinition>();
  results.forEach((result) => {
    if (!result.extracted_metadata || typeof result.extracted_metadata !== 'object') {
      return;
    }

    Object.entries(result.extracted_metadata).forEach(([key, value]) => {
      collectRuntimeFields(value, key, fieldMap);
    });
  });

  return mergeFieldDefinitions(Array.from(fieldMap.values()));
};
