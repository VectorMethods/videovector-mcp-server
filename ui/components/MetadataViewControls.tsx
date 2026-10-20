import React from 'react';
import { Code, List, Maximize2, Minimize2, SortAsc } from 'lucide-react';
import StructuredMetadataView, { StructuredMetadataViewProps, StructuredMetadataSortType, StructuredMetadataSortDirection } from './StructuredMetadataView';
import './MetadataViewControls.css';

export type MetadataViewMode = 'fields' | 'json';

export interface MetadataViewModeToggleProps {
  mode: MetadataViewMode;
  onModeChange: (mode: MetadataViewMode) => void;
}

export const MetadataViewModeToggle: React.FC<MetadataViewModeToggleProps> = ({ mode, onModeChange }) => (
  <div className="view-mode-toggle">
    <button type="button" className={`view-mode-btn ${mode === 'fields' ? 'active' : ''}`} onClick={() => onModeChange('fields')} title="Graphical view" aria-pressed={mode === 'fields'}><List size={12} /></button>
    <button type="button" className={`view-mode-btn ${mode === 'json' ? 'active' : ''}`} onClick={() => onModeChange('json')} title="Raw JSON view" aria-pressed={mode === 'json'}><Code size={12} /></button>
  </div>
);

interface MetadataViewControlsProps extends MetadataViewModeToggleProps {
  sortBy: StructuredMetadataSortType;
  sortDirection: StructuredMetadataSortDirection;
  onSortChange: (sort: StructuredMetadataSortType) => void;
  allExpanded: boolean;
  onToggleAll: () => void;
  showScoreSort?: boolean;
}

const MetadataViewControls: React.FC<MetadataViewControlsProps> = ({
  mode, onModeChange, sortBy, sortDirection, onSortChange, allExpanded, onToggleAll, showScoreSort = false,
}) => <div className="metadata-controls">
  <MetadataViewModeToggle mode={mode} onModeChange={onModeChange} />
  {mode === 'fields' && <>
    <div className="sort-buttons">
      {showScoreSort && <button type="button" className={`sort-btn ${sortBy === 'score' ? 'active' : ''}`} onClick={() => onSortChange('score')}
        title={`Sort by score ${sortBy === 'score' ? (sortDirection === 'desc' ? '(High to Low)' : '(Low to High)') : ''}`}>
        <SortAsc size={12} style={{ transform: sortBy === 'score' && sortDirection === 'asc' ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />Score
      </button>}
      <button type="button" className={`sort-btn ${sortBy === 'alpha' ? 'active' : ''}`} onClick={() => onSortChange('alpha')}
        title={`Sort alphabetically ${sortBy === 'alpha' ? (sortDirection === 'asc' ? '(A-Z)' : '(Z-A)') : ''}`}>
        <SortAsc size={12} style={{ transform: sortBy === 'alpha' && sortDirection === 'desc' ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />A-Z
      </button>
    </div>
    <button type="button" className="expand-collapse-btn" onClick={onToggleAll} title={allExpanded ? 'Collapse all fields' : 'Expand all fields'}>
      {allExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  </>}
</div>;

export const MetadataValueView: React.FC<StructuredMetadataViewProps & { mode: MetadataViewMode }> = ({ mode, ...props }) => (
  mode === 'json'
    ? <div className="metadata-json-view"><pre>{JSON.stringify(props.value, null, 2)}</pre></div>
    : <div className="metadata-fields-view"><StructuredMetadataView {...props} /></div>
);

export default MetadataViewControls;
