import specJson from './conditionSearchSpec.json';
import type { FilterCondition } from '../services/api';

export interface ConditionOperatorDefinition {
  value: string;
  label: string;
  requiresValue: boolean;
}

export interface ConditionSearchSpec {
  maxConditions: number;
  supportedFieldTypes: Array<'string' | 'integer' | 'number' | 'boolean' | 'array'>;
  operatorsByType: Record<string, ConditionOperatorDefinition[]>;
}

export interface ConditionFieldDefinition {
  path: string;
  label: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  itemType?: 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
}

export const CONDITION_SEARCH_SPEC = specJson as ConditionSearchSpec;
export const CONDITION_OPERATORS_BY_TYPE = CONDITION_SEARCH_SPEC.operatorsByType;
export const MAX_CONDITION_FILTERS = CONDITION_SEARCH_SPEC.maxConditions;

export const getConditionOperatorsForField = (
  field: Pick<ConditionFieldDefinition, 'type' | 'itemType'>
): ConditionOperatorDefinition[] => {
  const operators = CONDITION_OPERATORS_BY_TYPE[field.type] || [];

  if (field.type !== 'array') {
    return operators;
  }

  if (field.itemType === 'string') {
    return operators;
  }

  return operators.filter((operator) => operator.value !== 'item_contains');
};

export const getConditionOperatorDefinition = (
  fieldType: FilterCondition['type'],
  operator: string
): ConditionOperatorDefinition | undefined => {
  return (CONDITION_OPERATORS_BY_TYPE[fieldType] || []).find((entry) => entry.value === operator);
};

export const operatorRequiresConditionValue = (
  fieldType: FilterCondition['type'],
  operator: string
): boolean => {
  return getConditionOperatorDefinition(fieldType, operator)?.requiresValue ?? true;
};

export const isConditionFilterComplete = (filter: FilterCondition): boolean => {
  if (!filter.field || !filter.operator || !filter.type) {
    return false;
  }

  if (!operatorRequiresConditionValue(filter.type, filter.operator)) {
    return true;
  }

  return filter.value !== '' && filter.value !== null && filter.value !== undefined;
};
