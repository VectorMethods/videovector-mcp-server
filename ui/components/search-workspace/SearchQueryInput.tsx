import React, { useId } from 'react';
import { Search, X } from 'lucide-react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  label: string;
  hint?: string;
  placeholder?: string;
  inputId?: string;
  disabled?: boolean;
  clearDisabled?: boolean;
  maxLength?: number;
  hasAttachment?: boolean;
  controls?: React.ReactNode;
  children?: React.ReactNode;
}

/** The query control used by video and realtime search; providers stay with callers. */
const SearchQueryInput: React.FC<Props> = ({ value, onChange, label, hint, placeholder, inputId, disabled, clearDisabled = disabled, maxLength, hasAttachment = false, controls, children }) => {
  const generatedId = useId();
  const id = inputId || generatedId;
  return <div className="form-group flex-2 search-query-group">
    <div className="search-query-heading"><label htmlFor={id} className="form-label">{label}</label>{hint && <span>{hint}</span>}</div>
    <div className={`input-with-icon search-query-control ${hasAttachment ? 'has-image' : ''} ${controls ? 'has-extra-controls' : ''}`}>
      <Search size={18} className="input-icon" />
      <input id={id} type="text" value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} className="form-input search-input" disabled={disabled} maxLength={maxLength} />
      <div className="search-query-control-actions">
        {value && <button type="button" className="search-query-clear-btn" onClick={() => onChange('')} disabled={clearDisabled} aria-label="Clear search query" title="Clear query"><X size={14} /></button>}
        {controls}
      </div>
    </div>
    {children}
  </div>;
};

export default SearchQueryInput;
