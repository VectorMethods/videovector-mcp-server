import React from 'react';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';

interface Props {
  children: React.ReactNode;
  mode?: 'search' | 'agent';
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}
const SearchConfigurationPanel: React.FC<Props> = ({ children, mode = 'search', collapsed = false, onCollapsedChange }) => (
  <aside className={`search-configuration-panel ${mode}-mode${collapsed ? ' is-collapsed' : ''}`} aria-label="Search configuration">
    {onCollapsedChange && <button type="button" className="search-panel-collapse" onClick={() => onCollapsedChange(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand search panel' : 'Collapse search panel'}>
      <Search size={16} /><span>Search</span>{collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
    </button>}
    {onCollapsedChange ? <div hidden={collapsed}>{children}</div> : children}
  </aside>
);
export default SearchConfigurationPanel;
