import React, { useEffect, useRef, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import type { ConditionFieldDefinition } from '../config/conditionSearch';
import { getConditionOperatorsForField, MAX_CONDITION_FILTERS, operatorRequiresConditionValue } from '../config/conditionSearch';
import type { PromptSelectionCondition, PromptSelectionFilter } from '../services/api';
import type { PlaygroundStudioWorkspaceState } from '../features/playground/studioWorkspaceState';
import { normalizePromptSelectionFilter, validateAndBuildSelectionFilter } from '../features/workflows/config';
import { formatEngineConditionValue, formatEngineFieldLabel } from '../features/workflows/presentation';
import CustomSelect from './CustomSelect';
import './StudioResultToolbar.css';

interface StudioResultToolbarProps {
  state: PlaygroundStudioWorkspaceState;
  onChange: (patch: Partial<PlaygroundStudioWorkspaceState>) => void;
  segmentFields: ConditionFieldDefinition[];
  videoFields: ConditionFieldDefinition[];
  runFilter: PromptSelectionFilter | null;
  hasRunFilter: boolean;
  resultMode: 'matches' | 'all';
  onResultModeChange: (mode: 'matches' | 'all') => void;
  resultStatus?: React.ReactNode;
  resultsAvailable: boolean;
  visibleCount: number;
  totalCount: number;
  hasVideoResult: boolean;
  videoMatched: boolean;
  isImage: boolean;
  trailingControls?: React.ReactNode;
  resultLabel?: string;
}

type Level = 'segment' | 'video';
type Logic = 'and' | 'or';
interface DraftChip {
  id: number;
  level: Level;
  condition: PromptSelectionCondition;
  applied?: { level: Level; condition: PromptSelectionCondition };
}
interface Draft {
  chips: DraftChip[];
  segmentLogic: Logic;
  videoLogic: Logic;
  levelLogic: Logic;
}
const levels: Level[] = ['segment', 'video'];
const LogicToggle = ({ value, label, onChange }: { value: Logic; label: string; onChange: (value: Logic) => void }) => (
  <button type="button" className="studio-result-tools__logic"
    aria-label={`${label}: ${value.toUpperCase()}`}
    title={`Click to switch to ${value === 'and' ? 'OR' : 'AND'}`}
    onClick={() => onChange(value === 'and' ? 'or' : 'and')}>
    {value.toUpperCase()}
  </button>
);
const filterKey = (value: PromptSelectionFilter | null) => JSON.stringify(normalizePromptSelectionFilter(value));
const newCondition = (field: ConditionFieldDefinition, operator?: string): PromptSelectionCondition => {
  const selected = getConditionOperatorsForField(field).find((item) => item.value === operator)
    || getConditionOperatorsForField(field)[0];
  return {
    field: field.path, type: field.type, operator: selected.value,
    ...(field.itemType ? { item_type: field.itemType } : {}),
    ...(selected.requiresValue ? { value: '' } : {}),
  };
};

const StudioResultToolbar: React.FC<StudioResultToolbarProps> = ({
  state, onChange, segmentFields, videoFields, runFilter, hasRunFilter, resultMode, onResultModeChange, resultStatus,
  resultsAvailable, visibleCount, totalCount, hasVideoResult, videoMatched, isImage, trailingControls, resultLabel,
}) => {
  const nextId = useRef(0);
  const fromFilter = (filter: PromptSelectionFilter | null): Draft => ({
    chips: levels.flatMap((level) => (filter?.[level]?.conditions || []).map((condition) => ({
      id: nextId.current++, level, condition, applied: { level, condition },
    }))),
    segmentLogic: filter?.segment?.logic || 'and', videoLogic: filter?.video?.logic || 'and', levelLogic: filter?.level_logic || 'and',
  });
  const [draft, setDraft] = useState<Draft>(() => fromFilter(state.resultFilter));
  const published = useRef(filterKey(state.resultFilter));
  const scope = `${state.scopeVideoId || ''}:${state.scopeRunId || ''}`;
  const priorScope = useRef(scope);
  const externalFilter = filterKey(state.resultFilter);
  useEffect(() => {
    if (externalFilter !== published.current || priorScope.current !== scope) {
      setDraft(fromFilter(state.resultFilter));
      published.current = externalFilter;
      priorScope.current = scope;
    }
    // A parent echo must not replace unfinished input with its last valid value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalFilter, scope]);

  const fieldsFor = (level: Level) => level === 'segment' ? segmentFields : videoFields;
  const publish = (next: Draft) => {
    const validated: Draft = { ...next, chips: next.chips.map((chip) => {
      const condition = chip.condition;
      const numeric = condition.type === 'number' || condition.type === 'integer'
        || condition.operator.startsWith('length_')
        || (condition.type === 'array' && ['number', 'integer'].includes(condition.item_type || ''));
      const unfinishedNumber = numeric && typeof condition.value === 'string' && /[.eE+-]$/.test(condition.value.trim());
      const result = validateAndBuildSelectionFilter({ level_logic: 'and', [chip.level]: { logic: 'and', conditions: [condition] } }, segmentFields, videoFields);
      return !unfinishedNumber && !result.error && result.filter?.[chip.level]
        ? { ...chip, applied: { level: chip.level, condition: result.filter[chip.level]!.conditions[0] } } : chip;
    }) };
    setDraft(validated);
    const filter: PromptSelectionFilter = { level_logic: validated.levelLogic };
    levels.forEach((level) => {
      const conditions = validated.chips.flatMap((chip) => chip.applied?.level === level ? [chip.applied.condition] : []);
      if (conditions.length) filter[level] = { logic: level === 'segment' ? validated.segmentLogic : validated.videoLogic, conditions };
    });
    const value = filter.segment || filter.video ? filter : null;
    const serialized = filterKey(value);
    if (serialized !== published.current) {
      published.current = serialized;
      onChange({ resultFilter: value });
    }
  };
  const edit = (id: number, condition: PromptSelectionCondition, level?: Level, resetApplied = false) => publish({
    ...draft, chips: draft.chips.map((chip) => chip.id === id ? { ...chip, condition, level: level || chip.level, ...(resetApplied ? { applied: undefined } : {}) } : chip),
  });
  const savedFilterSummary = levels.flatMap((level) => {
    const group = runFilter?.[level];
    if (!group?.conditions.length) return [];
    const conditions = group.conditions.map((condition) => {
      const field = fieldsFor(level).find((item) => item.path === condition.field)
        || { path: condition.field, label: condition.field, type: condition.type, itemType: condition.item_type };
      const operator = getConditionOperatorsForField(field).find((item) => item.value === condition.operator);
      const value = operatorRequiresConditionValue(condition.type, condition.operator)
        ? ` ${formatEngineConditionValue(condition)}` : '';
      return `${formatEngineFieldLabel(field.label)} ${operator?.label || condition.operator}${value}`;
    });
    return [`${level === 'video' ? 'Video' : 'Segment'}: (${conditions.join(` ${group.logic.toUpperCase()} `)})`];
  }).join(` ${(runFilter?.level_logic || 'and').toUpperCase()} `);

  return <section className="studio-result-tools" aria-label="Search and filter extracted results">
    <div className="studio-result-tools__bar">
      <label className="studio-result-tools__search"><Search size={15} aria-hidden="true" />
        <input type="search" value={state.resultSearchTerm} onChange={(event) => onChange({ resultSearchTerm: event.target.value })}
          placeholder="Search extracted results…" aria-label="Search segment and video results" maxLength={500} />
      </label>
      {hasRunFilter && <button type="button" className="studio-result-tools__engine-filter"
        aria-label="Engine filter" aria-pressed={resultMode === 'matches'}
        title={`${resultMode === 'matches' ? 'Turn off engine filter' : 'Turn on engine filter'}${savedFilterSummary ? ` — ${savedFilterSummary}` : ''}`}
        onClick={() => onResultModeChange(resultMode === 'matches' ? 'all' : 'matches')}>
        <span className="studio-result-tools__engine-label">Engine filter</span>
        {savedFilterSummary && <span className="studio-result-tools__engine-summary">{savedFilterSummary}</span>}
      </button>}
      {draft.chips.length < MAX_CONDITION_FILTERS && <button type="button" className="studio-result-tools__add" aria-label="Add result filter"
        disabled={!segmentFields.length && !videoFields.length} onClick={() => {
          const level = segmentFields.length ? 'segment' : 'video';
          const field = fieldsFor(level)[0];
          if (field) publish({ ...draft, chips: [...draft.chips, { id: nextId.current++, level, condition: newCondition(field) }] });
        }}><Plus size={14} aria-hidden="true" /><span>Filter</span></button>}
      <div className="studio-result-tools__actions">
        {resultsAvailable && <span className="studio-result-tools__count" role="status">
          {visibleCount}/{totalCount} {resultLabel || (isImage ? 'images' : 'segments')}
          {hasVideoResult && ` · Video ${videoMatched ? 'shown' : 'hidden'}`}
        </span>}
        {trailingControls}
      </div>
    </div>
    {draft.chips.length > 0 && <div className="studio-result-tools__filters">
      {levels.map((level) => {
        const chips = draft.chips.filter((chip) => chip.level === level);
        if (!chips.length) return null;
        return <React.Fragment key={level}>
          {level === 'video' && draft.chips.some((chip) => chip.level === 'segment') && <div className="studio-result-tools__group-join">
            <LogicToggle value={draft.levelLogic} label="Combine segment and video conditions" onChange={(value) => publish({ ...draft, levelLogic: value })} />
          </div>}
          <div className="studio-result-tools__condition-group" role="group" aria-label={`${level === 'video' ? 'Video' : 'Segment'} conditions`}>
            <div className="studio-result-tools__group-heading">
              <span>{level === 'video' ? 'Video' : 'Segment'} conditions</span>
              {chips.length > 1 && <LogicToggle value={level === 'segment' ? draft.segmentLogic : draft.videoLogic}
                label={`${level} condition logic`} onChange={(value) => publish({ ...draft, [level === 'segment' ? 'segmentLogic' : 'videoLogic']: value })} />}
            </div>
            <div className="studio-result-tools__conditions">
          {chips.map((chip, index) => {
            const condition = chip.condition;
            const field = fieldsFor(level).find((item) => item.path === condition.field);
            const operators = field ? getConditionOperatorsForField(field) : [];
            const valueType = condition.operator.startsWith('length_') ? 'integer' : condition.type === 'array' ? condition.item_type : condition.type;
            const requiresValue = operatorRequiresConditionValue(condition.type, condition.operator);
            return <div key={chip.id} className="studio-result-tools__chip" role="group" aria-label={`${level} filter ${index + 1}`}>
                <CustomSelect className="studio-result-tools__field" value={`${level}:${condition.field}`} ariaLabel={`${level} filter ${index + 1} field`}
                  options={[
                    ...(!field ? [{ value: `${level}:${condition.field}`, label: condition.field }] : []),
                    ...levels.flatMap((optionLevel) => fieldsFor(optionLevel).map((item) => ({
                      value: `${optionLevel}:${item.path}`, label: `${optionLevel === 'video' ? 'Video · ' : ''}${formatEngineFieldLabel(item.label)}`,
                    }))),
                  ]} onChange={(value) => {
                  const nextLevel = value.startsWith('video:') ? 'video' : 'segment';
                  const nextField = fieldsFor(nextLevel).find((item) => item.path === value.slice(nextLevel.length + 1));
                  if (nextLevel === level && nextField?.path === condition.field) return;
                  if (nextField) edit(chip.id, newCondition(nextField), nextLevel, true);
                }} />
                <CustomSelect className="studio-result-tools__operator" value={condition.operator} options={operators} ariaLabel={`${level} filter ${index + 1} operator`} disabled={!field} onChange={(value) => {
                  if (!field || value === condition.operator) return;
                  const next = newCondition(field, value);
                  if (requiresValue && Object.prototype.hasOwnProperty.call(next, 'value')
                    && condition.operator.startsWith('length_') === next.operator.startsWith('length_')) next.value = condition.value;
                  edit(chip.id, next, undefined, true);
                }} />
                {requiresValue && (valueType === 'boolean'
                  ? <CustomSelect className="studio-result-tools__value" value={String(condition.value ?? '')} ariaLabel={`${level} filter ${index + 1} value`}
                    options={[{ value: '', label: 'Value' }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
                    onChange={(value) => edit(chip.id, { ...condition, value: value === '' ? '' : value === 'true' })} />
                  : <input className="studio-result-tools__value" type="text" inputMode={valueType === 'number' || valueType === 'integer' ? 'decimal' : undefined}
                    value={String(condition.value ?? '')} placeholder="Value" aria-label={`${level} filter ${index + 1} value`}
                    onChange={(event) => edit(chip.id, { ...condition, value: event.target.value })} />)}
                <button type="button" className="studio-result-tools__remove" aria-label={`Remove ${level} filter ${index + 1}`} title="Remove condition"
                  onClick={() => publish({ ...draft, chips: draft.chips.filter((item) => item.id !== chip.id) })}><Trash2 size={14} aria-hidden="true" /></button>
              </div>;
          })}
            </div>
          </div>
        </React.Fragment>;
      })}
    </div>}
    {resultStatus}
  </section>;
};

export default StudioResultToolbar;
