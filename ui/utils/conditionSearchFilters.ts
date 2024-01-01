import type { FilterCondition } from '../services/api';
import {
  MAX_CONDITION_FILTERS,
  getConditionOperatorsForField,
  operatorRequiresConditionValue,
} from '../config/conditionSearch';
import type { FieldDefinition } from './filterUtils';

export const MAX_CONDITIONS = MAX_CONDITION_FILTERS;

export const UNARY_OPERATORS = new Set(['is_empty', 'is_not_empty']);

type OperatorOption = { value: string; label: string; requiresValue: boolean };

export const OPERATORS_BY_TYPE: Record<string, OperatorOption[]> = {
  string: getConditionOperatorsForField({ type: 'string' }),
  integer: getConditionOperatorsForField({ type: 'integer' }),
  number: getConditionOperatorsForField({ type: 'number' }),
  boolean: getConditionOperatorsForField({ type: 'boolean' }),
  array: getConditionOperatorsForField({ type: 'array', itemType: 'string' }),
};

export function canonicalizeOperator(op: string): string {
  return (op || '').trim().toLowerCase();
}

export function getOperatorsForField(
  fieldDef?: Pick<FieldDefinition, 'type' | 'itemType'> | null,
): OperatorOption[] {
  if (!fieldDef) {
    return [];
  }
  if (fieldDef.type === 'unknown') {
    return [];
  }
  const normalizedItemType = fieldDef.itemType === 'string'
    || fieldDef.itemType === 'integer'
    || fieldDef.itemType === 'number'
    || fieldDef.itemType === 'boolean'
    ? fieldDef.itemType
    : undefined;
  return getConditionOperatorsForField({
    type: fieldDef.type,
    itemType: normalizedItemType,
  });
}

export function validateConditions(
  conditions: FilterCondition[],
  fieldDefinitions: FieldDefinition[],
): { ok: boolean; message?: string } {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return { ok: false, message: 'Please add at least one filter condition.' };
  }
  if (conditions.length > MAX_CONDITIONS) {
    return { ok: false, message: `Maximum ${MAX_CONDITIONS} filter conditions allowed.` };
  }

  for (let i = 0; i < conditions.length; i += 1) {
    const c = conditions[i];
    const field = (c.field || '').trim();
    if (!field) {
      return { ok: false, message: `Condition ${i + 1}: field is required.` };
    }

    const fieldDef = fieldDefinitions.find((candidate) => candidate.name === field);
    if (!fieldDef || fieldDef.searchable === false || fieldDef.type === 'unknown') {
      return { ok: false, message: `Condition ${i + 1}: field is invalid or not searchable.` };
    }

    const type = fieldDef.type as Exclude<FilterCondition['type'], 'unknown'>;
    const op = canonicalizeOperator(c.operator);
    const supported = new Set(getOperatorsForField(fieldDef).map((entry) => entry.value));
    if (!op || !supported.has(op)) {
      return { ok: false, message: `Condition ${i + 1}: operator is invalid for type '${type}'.` };
    }

    if (!operatorRequiresConditionValue(type, op)) {
      continue;
    }

    const value = c.value;
    if (value === null || value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
      return { ok: false, message: `Condition ${i + 1}: value is required.` };
    }

    const operandType = type === 'array' && op === 'item_equals' ? fieldDef.itemType : type;
    if (operandType === 'integer') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, message: `Condition ${i + 1}: value must be an integer.` };
      }
    }

    if (operandType === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) {
        return { ok: false, message: `Condition ${i + 1}: value must be a number.` };
      }
    }

    if (operandType === 'boolean') {
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
        return { ok: false, message: `Condition ${i + 1}: value must be true or false.` };
      }
    }

    if (type === 'array' && op.startsWith('length_')) {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return { ok: false, message: `Condition ${i + 1}: length must be a non-negative integer.` };
      }
    }
  }

  return { ok: true };
}
