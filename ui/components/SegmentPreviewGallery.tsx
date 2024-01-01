import React from 'react';
import type { SegmentProcessingStatus } from '../utils/segmentStatus';
import './SegmentPreviewGallery.css';

export const SegmentPreviewGallery: React.FC<{
  children: React.ReactNode;
  ariaLabel?: string;
  stableHeight?: boolean;
  emptyState?: React.ReactNode;
}> = ({ children, ariaLabel = 'Video segments', stableHeight = false, emptyState }) => (
  <ul className={`segment-preview-gallery${stableHeight ? ' segment-preview-gallery--stable' : ''}${React.Children.count(children) === 0 && emptyState ? ' segment-preview-gallery--empty' : ''}`} aria-label={ariaLabel}>
    {React.Children.count(children) > 0 ? children : emptyState && (
      <li className="segment-preview-gallery__empty">{emptyState}</li>
    )}
  </ul>
);

export const SegmentPreviewGalleryItem: React.FC<{
  children: React.ReactNode;
  selected: boolean;
  onSelect: () => void;
  title: string;
  timeLabel?: string;
  className?: string;
  status: SegmentProcessingStatus;
  actions?: React.ReactNode;
}> = ({
  actions,
  children,
  selected,
  onSelect,
  title,
  timeLabel,
  className = '',
  status,
}) => (
  <li
    className="segment-preview-gallery__item"
    data-status={status}
  >
    <button
      type="button"
      className={`segment-preview-gallery__button ${selected ? 'selected' : ''} ${className}`.trim()}
      onClick={onSelect}
      title={title}
      aria-pressed={selected}
    >
      {children}
      {timeLabel && (
        <span className="segment-preview-gallery__time">{timeLabel}</span>
      )}
    </button>
    {actions && (
      <div className="segment-preview-gallery__actions">
        {actions}
      </div>
    )}
    <span className="segment-preview-gallery__status-line" aria-hidden="true" />
    <span className="segment-preview-gallery__status-text">
      {`Segment status: ${status}`}
    </span>
  </li>
);
