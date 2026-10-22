import React from 'react';
import { Download, FileJson, RefreshCw } from 'lucide-react';

/** Shared tile controls; each host owns authorization and download transport. */
const SegmentDownloadButtons: React.FC<{
  onDownloadMedia: () => void;
  onDownloadMetadata: () => void;
  mediaAvailable: boolean;
  isDownloading?: boolean;
  mediaLabel?: string;
  metadataLabel?: string;
  showLabels?: boolean;
  renderAction?: (button: React.ReactElement) => React.ReactNode;
}> = ({
  onDownloadMedia, onDownloadMetadata, mediaAvailable, isDownloading = false,
  mediaLabel = 'Download segment', metadataLabel = 'Download segment metadata', showLabels = false,
  renderAction = (button) => button,
}) => <>
  {renderAction(<button type="button" className="segment-preview-gallery__action"
    onClick={onDownloadMedia} title={mediaLabel} aria-label={mediaLabel}
    disabled={!mediaAvailable || isDownloading}>
    {isDownloading ? <RefreshCw size={14} className="spinning" /> : <Download size={14} />}
    {showLabels && <span>{mediaLabel}</span>}
  </button>)}
  {renderAction(<button type="button" className="segment-preview-gallery__action"
    onClick={onDownloadMetadata} title={metadataLabel} aria-label={metadataLabel}>
    <FileJson size={14} />
    {showLabels && <span>{metadataLabel}</span>}
  </button>)}
</>;

export default SegmentDownloadButtons;
