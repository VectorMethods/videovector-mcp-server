import React, { useRef } from 'react';
import { Check, Database } from 'lucide-react';
import type { PreviewGrantProjection } from '../contexts/PreviewGrantContext';
import GrantedPreviewImage, { useIsNearPreviewViewport } from './GrantedPreviewImage';
import './IndexGallery.css';

export interface ScopeSelectionCardProps {
  title: string;
  secondaryText?: string;
  description?: string | null;
  projection?: PreviewGrantProjection | null;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  moreCount?: number;
  multiple?: boolean;
}

/** Canonical visual scope item, used for indexes and individual Studio videos. */
const ScopeSelectionCard: React.FC<ScopeSelectionCardProps> = ({
  title, secondaryText, description, projection, selected, onSelect,
  disabled = false, moreCount = 0, multiple = false,
}) => {
  const cardRef = useRef<HTMLButtonElement>(null);
  const nearViewport = useIsNearPreviewViewport(cardRef);
  return (
    <button type="button" ref={cardRef}
      className={`index-gallery-card${selected ? ' selected' : ''}`}
      role={multiple ? 'checkbox' : undefined}
      aria-checked={multiple ? selected : undefined}
      aria-pressed={multiple ? undefined : selected}
      onClick={onSelect} disabled={disabled} title={description || title}>
      <span className="index-gallery-preview" aria-hidden="true">
        {nearViewport && projection ? <GrantedPreviewImage
          projection={projection} alt="" className="index-gallery-image"
          engaged={false} placeholder={<Database size={22} />} /> : <Database size={22} />}
        {moreCount > 0 && <span className="index-gallery-more">+{moreCount}</span>}
      </span>
      <span className="index-gallery-caption"><strong>{title}</strong>{secondaryText && <span>{secondaryText}</span>}</span>
      {multiple && <span className="scope-selection-toggle" aria-hidden="true" />}
      {!multiple && selected && <Check className="index-gallery-selected" size={14} aria-hidden="true" />}
    </button>
  );
};

export default ScopeSelectionCard;
