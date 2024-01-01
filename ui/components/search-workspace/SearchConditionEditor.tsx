import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { FilterCondition } from '../../services/api';
import { FieldDefinition } from '../../utils/filterUtils';
import { canonicalizeOperator, getOperatorsForField, UNARY_OPERATORS } from '../../utils/conditionSearchFilters';
import { useTabActivity } from '../../contexts/TabActivityContext';
const ARRAY_LENGTH_OPERATORS = new Set(['length_equals', 'length_greater', 'length_less']);
interface Props {
  filters: FilterCondition[];
  fieldDefinitions: FieldDefinition[];
  onChange: (filters: FilterCondition[]) => void;
  disabled?: boolean;
}
const SearchConditionEditor: React.FC<Props> = ({ filters, fieldDefinitions, onChange, disabled = false }) => {
  const { isActive } = useTabActivity();
  const root = useRef<HTMLDivElement>(null);
  const [openFieldDropdown, setOpenFieldDropdown] = useState<number | null>(null);
  const [openOperatorDropdown, setOpenOperatorDropdown] = useState<number | null>(null);
  const getFilterFieldDefinition = (name: string) => fieldDefinitions.find(field => field.name === name);
  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) {
        setOpenFieldDropdown(null); setOpenOperatorDropdown(null);
      }
    };
    if (!isActive) { setOpenFieldDropdown(null); setOpenOperatorDropdown(null); return; }
    document.addEventListener('click', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
  }, [isActive]);
  return <div ref={root} className="shared-condition-editor">
                {/* Inline filters */}
                {filters.length > 0 && <div className="inline-filters">
                  {filters.map((filter: FilterCondition, index: number) => (
                    <div
                      key={index}
                      className="inline-filter-item"
                      role="group"
                      aria-label={`Filter ${index + 1}`}
                    >
                      {index > 0 && <span className="filter-and-label">AND</span>}
                      <div className="inline-filter-controls">
                        {/* Field selector dropdown */}
                        <div className="filter-field-container">
                          <button
                            type="button"
                            className="filter-field-trigger"
                            aria-label={`Filter ${index + 1} field`}
                            aria-haspopup="true"
                            aria-expanded={openFieldDropdown === index && !disabled}
                            onClick={() => {
                              setOpenFieldDropdown(openFieldDropdown === index ? null : index);
                              setOpenOperatorDropdown(null);
                            }}
                            disabled={disabled}
                          >
                            <span className="filter-select-value">
                              {filter.field || 'Select Field'}
                            </span>
                            {openFieldDropdown === index && !disabled ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </button>

                          {openFieldDropdown === index && !disabled && (
                            <div className="filter-dropdown">
                              <div className="filter-dropdown-header">
                                <span className="filter-dropdown-title">Select Field</span>
                              </div>
                              <div className="filter-dropdown-list">
                                {fieldDefinitions.length === 0 ? (
                                  <div className="filter-dropdown-item disabled">
                                    No fields available
                                  </div>
                                ) : (
                                  fieldDefinitions.map((field) => (
                                    <button
                                      key={field.name}
                                      type="button"
                                      className={`filter-dropdown-item ${filter.field === field.name ? 'selected' : ''}`}
                                      onClick={() => {
                                        const newFilters = [...filters];
                                        const availableOperators = getOperatorsForField(field);
                                        newFilters[index] = {
                                          field: field.name,
                                          operator: availableOperators[0]?.value || 'equals',
                                          value: '',
                                          type: field.type
                                        };
                                        onChange(newFilters);
                                        setOpenFieldDropdown(null);
                                      }}
                                    >
                                      <span className="filter-item-name">{field.label || field.name}</span>
                                      <span className="filter-item-type">{field.type}</span>
                                    </button>
                                  ))
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Operator selector dropdown */}
                        <div className="filter-operator-container">
                          <button
                            type="button"
                            className="filter-operator-trigger"
                            aria-label={`Filter ${index + 1} operator`}
                            aria-haspopup="true"
                            aria-expanded={openOperatorDropdown === index && !disabled}
                            onClick={() => {
                              setOpenOperatorDropdown(openOperatorDropdown === index ? null : index);
                              setOpenFieldDropdown(null);
                            }}
                            disabled={disabled || !filter.field}
                          >
                            <span className="filter-select-value">
                              {filter.field
                                ? (
                                  getOperatorsForField(getFilterFieldDefinition(filter.field))
                                    .find((op) => op.value === canonicalizeOperator(filter.operator))
                                    ?.label
                                  || canonicalizeOperator(filter.operator)
                                  || filter.operator
                                )
                                : 'Operator'}
                            </span>
                            {openOperatorDropdown === index && !disabled ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </button>

                          {openOperatorDropdown === index && filter.field && !disabled && (
                            <div className="filter-dropdown">
                              <div className="filter-dropdown-header">
                                <span className="filter-dropdown-title">Select Operator</span>
                              </div>
                              <div className="filter-dropdown-list">
                                {getOperatorsForField(getFilterFieldDefinition(filter.field)).map((op) => (
                                  <button
                                    key={op.value}
                                    type="button"
                                    className={`filter-dropdown-item ${canonicalizeOperator(filter.operator) === op.value ? 'selected' : ''}`}
                                    onClick={() => {
                                      const newFilters = [...filters];
                                      newFilters[index] = { ...newFilters[index], operator: op.value };
                                      onChange(newFilters);
                                      setOpenOperatorDropdown(null);
                                    }}
                                  >
                                    <span className="filter-item-name">{op.label}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>

                        {!UNARY_OPERATORS.has(canonicalizeOperator(filter.operator)) && (
                          filter.type === 'boolean' ? (
                            <select
                              className="filter-value-input"
                              aria-label={`Filter ${index + 1} value`}
                              value={String(filter.value ?? '')}
                              onChange={(e) => {
                                const newFilters = [...filters];
                                newFilters[index] = {
                                  ...newFilters[index],
                                  value: e.target.value === '' ? '' : e.target.value === 'true',
                                };
                                onChange(newFilters);
                              }}
                              disabled={disabled || !filter.field}
                            >
                              <option value="">Value</option>
                              <option value="true">True</option>
                              <option value="false">False</option>
                            </select>
                          ) : (
                            <input
                              type={
                                filter.type === 'integer' || filter.type === 'number' ||
                                ARRAY_LENGTH_OPERATORS.has(canonicalizeOperator(filter.operator))
                                  ? 'number'
                                  : 'text'
                              }
                              className="filter-value-input"
                              aria-label={`Filter ${index + 1} value`}
                              placeholder={
                                ARRAY_LENGTH_OPERATORS.has(canonicalizeOperator(filter.operator))
                                  ? 'Number'
                                  : 'Value'
                              }
                              value={String(filter.value ?? '')}
                              onChange={(e) => {
                                const newFilters = [...filters];
                                newFilters[index] = { ...newFilters[index], value: e.target.value };
                                onChange(newFilters);
                              }}
                              disabled={disabled || !filter.field}
                            />
                          )
                        )}

                        <button
                          type="button"
                          className="filter-remove-btn"
                          onClick={() => {
                            setOpenFieldDropdown(null);
                            setOpenOperatorDropdown(null);
                            const newFilters = filters.filter((_: FilterCondition, i: number) => i !== index);
                            onChange(newFilters);
                          }}
                          disabled={disabled}
                          title="Remove filter"
                          aria-label={`Remove filter ${index + 1}`}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>}
  </div>;
};
export default SearchConditionEditor;
