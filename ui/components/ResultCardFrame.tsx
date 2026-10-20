import React from 'react';

interface Props extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onClick'> {
  onOpen: () => void;
  label: string;
}
/** Shared keyboard/click boundary for search results and realtime observations. */
const ResultCardFrame: React.FC<Props> = ({ onOpen, label, className = '', children, ...props }) => (
  <div {...props} className={`result-card ${className}`} role="button" aria-label={label} tabIndex={0}
    onClick={onOpen} onKeyDown={event => {
      if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); onOpen();
      }
    }}>{children}</div>
);
export default ResultCardFrame;
