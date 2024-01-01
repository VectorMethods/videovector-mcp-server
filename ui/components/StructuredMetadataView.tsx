import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import TranscriptSegmentsField, { getTranscriptSegmentsForDisplay } from './TranscriptSegmentsField';
import './StructuredMetadataView.css';

export type StructuredMetadataSortType = 'score' | 'alpha';
export type StructuredMetadataSortDirection = 'asc' | 'desc';
export type StructuredMetadataPathToken = string | number;

const getValueTypeLabel = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undef';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'array';
    const itemTypes = new Set(value.map(item => (
      typeof item === 'object' && item !== null ? 'object' : typeof item
    )));
    if (itemTypes.size > 1) return 'mixed[]';
    const itemType = itemTypes.values().next().value;
    return itemType === 'object' ? 'obj[]' : `${itemType}[]`;
  }
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'bool';
  return typeof value;
};

const getValueStyleCategory = (value: unknown): string => {
  if (value === null || value === undefined) return 'default';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'default';
};

const hasNestedContent = (value: unknown): boolean => {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) {
    return value.length > 0 && value.some(item => typeof item === 'object' && item !== null);
  }
  return typeof value === 'object' && Object.keys(value).length > 0;
};

export const getCollapsibleMetadataPaths = (
  value: unknown,
  parentPath = '',
): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const itemPath = `${parentPath}[${index}]`;
      return hasNestedContent(item)
        ? [itemPath, ...getCollapsibleMetadataPaths(item, itemPath)]
        : [];
    });
  }
  if (value === null || typeof value !== 'object') return [];

  return Object.entries(value).flatMap(([key, fieldValue]) => {
    if (!hasNestedContent(fieldValue)) return [];
    const fieldPath = parentPath ? `${parentPath}.${key}` : key;
    return [fieldPath, ...getCollapsibleMetadataPaths(fieldValue, fieldPath)];
  });
};

const getStickyFieldKeyStyle = (depth: number): React.CSSProperties => {
  const stickyTop = `${8 + Math.min(depth, 12) * 36}px`;
  return {
    top: stickyTop,
    '--metadata-key-sticky-top': stickyTop,
  } as React.CSSProperties;
};

const formatFieldKey = (key: string): string => (
  key
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
);

export interface StructuredMetadataViewProps {
  value: unknown;
  depth?: number;
  collapsedPaths: ReadonlySet<string>;
  onTogglePath: (path: string) => void;
  parentPath?: string;
  parentPathTokens?: StructuredMetadataPathToken[];
  getFieldScore?: (
    fieldPath: string,
    fieldPathTokens: StructuredMetadataPathToken[],
  ) => number | undefined;
  getFieldPriorityRank?: (fieldPathTokens: StructuredMetadataPathToken[]) => number;
  formatFieldScore?: (score: number) => string;
  sortBy?: StructuredMetadataSortType;
  sortDirection?: StructuredMetadataSortDirection;
  filterTerm?: string;
  highlightedFieldPath?: string | null;
  highlightedRowRef?: React.MutableRefObject<HTMLDivElement | null>;
}

const metadataValueContains = (value: unknown, normalizedSearchTerm: string): boolean => {
  if (!normalizedSearchTerm) return true;
  if (value === null || value === undefined) {
    return String(value).includes(normalizedSearchTerm);
  }
  if (Array.isArray(value)) {
    return value.some(item => metadataValueContains(item, normalizedSearchTerm));
  }
  if (typeof value === 'object') {
    return Object.entries(value).some(([key, nestedValue]) => (
      formatFieldKey(key).toLocaleLowerCase().includes(normalizedSearchTerm)
      || metadataValueContains(nestedValue, normalizedSearchTerm)
    ));
  }
  return String(value).toLocaleLowerCase().includes(normalizedSearchTerm);
};

const isHighlightedField = (
  highlightedFieldPath: string | null | undefined,
  fieldPath: string,
  fieldKey: string,
): boolean => Boolean(
  highlightedFieldPath
  && (highlightedFieldPath === fieldPath || highlightedFieldPath === fieldKey)
);

const PrimitiveValue: React.FC<{ value: unknown }> = ({ value }) => {
  if (value === null) return <span className="field-value">null</span>;
  if (value === undefined) return <span className="field-value">undefined</span>;
  if (typeof value === 'boolean') {
    return <span className="field-value field-boolean">{value ? 'true' : 'false'}</span>;
  }
  if (typeof value === 'number') return <span className="field-value field-number">{value}</span>;
  if (value === '') return <span className="field-value">&quot;&quot;</span>;
  if (typeof value === 'object') {
    let serializedValue: string;
    try {
      serializedValue = JSON.stringify(value) ?? String(value);
    } catch {
      serializedValue = String(value);
    }
    return <span className="field-value">{serializedValue}</span>;
  }
  return <span className="field-value">{String(value)}</span>;
};

const PrimitiveListValue: React.FC<{ values: unknown[] }> = ({ values }) => {
  if (values.length === 0) return <PrimitiveValue value={values} />;

  return (
    <ul className="structured-metadata-list">
      {values.map((item, index) => (
        <li key={`${typeof item}-${String(item)}-${index}`} className="structured-metadata-list__item">
          <PrimitiveValue value={item} />
        </li>
      ))}
    </ul>
  );
};

const FieldBadges: React.FC<{
  value: unknown;
  score?: number;
  formatScore: (score: number) => string;
}> = ({ value, score, formatScore }) => (
  <div className="field-badges">
    <span className={`field-type ${getValueStyleCategory(value)}`}>{getValueTypeLabel(value)}</span>
    {score !== undefined && <span className="field-score">{formatScore(score)}</span>}
  </div>
);

const FieldLabel: React.FC<{
  displayKey: string;
  value: unknown;
  score?: number;
  formatScore: (score: number) => string;
  depth: number;
  isNested?: boolean;
  isExpanded?: boolean;
  onToggle?: () => void;
  toggleLabel?: string;
}> = ({
  displayKey,
  value,
  score,
  formatScore,
  depth,
  isNested = false,
  isExpanded = false,
  onToggle,
  toggleLabel,
}) => (
  <div className="field-left">
    <div className="field-left-content" style={getStickyFieldKeyStyle(depth)}>
      <span className="field-key">{displayKey}</span>
      <FieldBadges value={value} score={score} formatScore={formatScore} />
      {isNested && onToggle && (
        <button
          type="button"
          className="field-toggle"
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          aria-expanded={isExpanded}
          aria-label={toggleLabel}
        >
          {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      )}
    </div>
  </div>
);

const StructuredMetadataView: React.FC<StructuredMetadataViewProps> = ({
  value,
  depth = 0,
  collapsedPaths,
  onTogglePath,
  parentPath = '',
  parentPathTokens = [],
  getFieldScore,
  getFieldPriorityRank,
  formatFieldScore = String,
  sortBy = 'alpha',
  sortDirection = 'asc',
  filterTerm = '',
  highlightedFieldPath,
  highlightedRowRef,
}) => {
  const normalizedSearchTerm = filterTerm.trim().toLocaleLowerCase();
  if (value === null || value === undefined || typeof value !== 'object') {
    return <PrimitiveValue value={value} />;
  }

  if (Array.isArray(value) && !value.some(item => typeof item === 'object' && item !== null)) {
    const primitiveItemScores = value.map((_, index) => (
      getFieldScore?.(`${parentPath}[${index}]`, [...parentPathTokens, index])
    ));
    const hasPrimitiveItemScores = primitiveItemScores.some(score => score !== undefined);
    if (!hasPrimitiveItemScores) {
      return <PrimitiveListValue values={value} />;
    }

    return (
      <div className={`structured-metadata-group ${depth === 0 ? 'fields-grid' : 'nested-children'}`}>
        {value
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => metadataValueContains(item, normalizedSearchTerm))
          .map(({ item, index }) => {
          const itemPath = `${parentPath}[${index}]`;
          const itemScore = primitiveItemScores[index];
          return (
            <div
              key={itemPath}
              className={`field-box ${depth === 0 ? 'root-field' : 'nested-field'}${itemScore !== undefined ? ' has-score' : ''}`}
            >
              <FieldLabel
                displayKey={`[${index}]`}
                value={item}
                score={itemScore}
                formatScore={formatFieldScore}
                depth={depth}
              />
              <div className="field-right field-right--primitive">
                <PrimitiveValue value={item} />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const isRootLevel = depth === 0;

  if (Array.isArray(value)) {
    return (
      <div className={`structured-metadata-group ${isRootLevel ? 'fields-grid' : 'nested-children'}`}>
        {value
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => metadataValueContains(item, normalizedSearchTerm))
          .map(({ item, index }) => {
          const itemPath = `${parentPath}[${index}]`;
          const itemPathTokens = [...parentPathTokens, index];
          const isExpanded = !collapsedPaths.has(itemPath);
          const isNested = hasNestedContent(item);
          const itemScore = getFieldScore?.(itemPath, itemPathTokens);

          return (
            <div
              key={itemPath}
              className={`field-box ${isRootLevel ? 'root-field' : 'nested-field'}${itemScore !== undefined ? ' has-score' : ''}`}
            >
              <FieldLabel
                displayKey={`[${index}]`}
                value={item}
                score={itemScore}
                formatScore={formatFieldScore}
                depth={depth}
                isNested={isNested}
                isExpanded={isExpanded}
                onToggle={() => onTogglePath(itemPath)}
                toggleLabel={`${isExpanded ? 'Collapse' : 'Expand'} item ${index + 1}`}
              />
              <div className={`field-right${isNested ? ' field-right--nested' : ' field-right--primitive'}`}>
                {isNested && isExpanded ? (
                  <StructuredMetadataView
                    value={item}
                    depth={depth + 1}
                    collapsedPaths={collapsedPaths}
                    onTogglePath={onTogglePath}
                    parentPath={itemPath}
                    parentPathTokens={itemPathTokens}
                    getFieldScore={getFieldScore}
                    getFieldPriorityRank={getFieldPriorityRank}
                    formatFieldScore={formatFieldScore}
                    sortBy={sortBy}
                    sortDirection={sortDirection}
                    filterTerm={filterTerm}
                    highlightedFieldPath={highlightedFieldPath}
                    highlightedRowRef={highlightedRowRef}
                  />
                ) : !isNested ? (
                  <PrimitiveValue value={item} />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const entries = Object.entries(value).filter(([key, fieldValue]) => (
    !normalizedSearchTerm
    || formatFieldKey(key).toLocaleLowerCase().includes(normalizedSearchTerm)
    || metadataValueContains(fieldValue, normalizedSearchTerm)
  ));
  const sortedEntries = [...entries].sort(([keyA], [keyB]) => {
    const keyPathA = parentPath ? `${parentPath}.${keyA}` : keyA;
    const keyPathB = parentPath ? `${parentPath}.${keyB}` : keyB;
    const keyPathATokens = [...parentPathTokens, keyA];
    const keyPathBTokens = [...parentPathTokens, keyB];
    const priorityA = getFieldPriorityRank?.(keyPathATokens) ?? Number.MAX_SAFE_INTEGER;
    const priorityB = getFieldPriorityRank?.(keyPathBTokens) ?? Number.MAX_SAFE_INTEGER;

    if (priorityA !== priorityB) return priorityA - priorityB;

    if (sortBy === 'score') {
      const scoreA = getFieldScore?.(keyPathA, keyPathATokens) ?? -1;
      const scoreB = getFieldScore?.(keyPathB, keyPathBTokens) ?? -1;
      const comparison = scoreB - scoreA;
      return sortDirection === 'asc' ? -comparison : comparison;
    }

    const comparison = keyA.localeCompare(keyB, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    return sortDirection === 'asc' ? comparison : -comparison;
  });

  return (
    <div className={`structured-metadata-group ${isRootLevel ? 'fields-grid' : 'nested-children'}`}>
      {sortedEntries.map(([key, fieldValue]) => {
        const keyPath = parentPath ? `${parentPath}.${key}` : key;
        const keyPathTokens = [...parentPathTokens, key];
        const isExpanded = !collapsedPaths.has(keyPath);
        const isNested = hasNestedContent(fieldValue);
        const transcriptSegments = getTranscriptSegmentsForDisplay(key, fieldValue);
        const fieldScore = getFieldScore?.(keyPath, keyPathTokens);
        const keyMatchesFilter = Boolean(
          normalizedSearchTerm
          && formatFieldKey(key).toLocaleLowerCase().includes(normalizedSearchTerm)
        );
        const isHighlighted = isHighlightedField(highlightedFieldPath, keyPath, key);

        return (
          <div
            key={key}
            ref={isHighlighted ? highlightedRowRef : undefined}
            className={`field-box ${isRootLevel ? 'root-field' : 'nested-field'}${fieldScore !== undefined ? ' has-score' : ''}${isHighlighted ? ' metadata-highlight' : ''}`}
          >
            <FieldLabel
              displayKey={formatFieldKey(key)}
              value={fieldValue}
              score={fieldScore}
              formatScore={formatFieldScore}
              depth={depth}
              isNested={isNested}
              isExpanded={isExpanded}
              onToggle={() => onTogglePath(keyPath)}
              toggleLabel={`${isExpanded ? 'Collapse' : 'Expand'} ${formatFieldKey(key)}`}
            />
            <div className={`field-right${isNested ? ' field-right--nested' : ' field-right--primitive'}`}>
              {transcriptSegments && isExpanded ? (
                <TranscriptSegmentsField segments={transcriptSegments} />
              ) : isNested && isExpanded ? (
                <StructuredMetadataView
                  value={fieldValue}
                  depth={depth + 1}
                  collapsedPaths={collapsedPaths}
                  onTogglePath={onTogglePath}
                  parentPath={keyPath}
                  parentPathTokens={keyPathTokens}
                  getFieldScore={getFieldScore}
                  getFieldPriorityRank={getFieldPriorityRank}
                  formatFieldScore={formatFieldScore}
                  sortBy={sortBy}
                  sortDirection={sortDirection}
                  filterTerm={keyMatchesFilter ? '' : filterTerm}
                  highlightedFieldPath={highlightedFieldPath}
                  highlightedRowRef={highlightedRowRef}
                />
              ) : !isNested ? (
                Array.isArray(fieldValue)
                  ? <PrimitiveListValue values={fieldValue} />
                  : <PrimitiveValue value={fieldValue} />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default StructuredMetadataView;
