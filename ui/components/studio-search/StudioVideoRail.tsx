import React from 'react';
import { ChevronDown, Film, RefreshCw, Search } from 'lucide-react';
import type { StudioVideo } from '../../features/studio-search/types';
import { TabActivityProvider, useTabActivity } from '../../contexts/TabActivityContext';
import { DeferredPreviewTile, PreviewViewportProvider } from '../GrantedPreviewImage';
import ScopeSelectionCard from '../ScopeSelectionCard';
import VideoSegmentStatusBars, { getVideoSegmentStatusRows } from '../VideoSegmentStatusBars';
import './StudioVideoRail.css';

export interface StudioVideoRailProps<T extends StudioVideo = StudioVideo> {
  videos: T[];
  selectedVideoId?: string | null;
  searchActive: boolean;
  onSearch: () => void;
  onSelectVideo: (video: T) => void;
  isLoading?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onChooseMedia?: () => void;
  onRefresh?: () => void;
  error?: string | null;
  isActive?: boolean;
  className?: string;
  scrollRef?: React.Ref<HTMLDivElement>;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}

/** Shared media navigation for the app Studio and its embedded MCP surface. */
export default function StudioVideoRail<T extends StudioVideo>({
  videos, selectedVideoId, searchActive, onSearch, onSelectVideo,
  isLoading = false, hasMore = false, isLoadingMore = false, onLoadMore,
  onChooseMedia, onRefresh, error, isActive = true, className = '', scrollRef, onScroll,
}: StudioVideoRailProps<T>) {
  const { isActive: parentIsActive } = useTabActivity();
  return <TabActivityProvider isActive={parentIsActive && isActive}>
    <section className={`studio-video-rail ${className}`} aria-label="Studio media">
      <button type="button" className="studio-video-rail__search" aria-pressed={searchActive} onClick={onSearch}>
        <Search size={16} aria-hidden="true" /><span>Search</span>
      </button>
      {error && <p className="studio-video-rail__notice" role="alert">{error}</p>}
      {isLoading && videos.length === 0 ? <div className="studio-video-rail__empty" role="status">
        <RefreshCw size={18} className="studio-video-rail__spinner" aria-hidden="true" /><span>Loading media…</span>
      </div> : videos.length ? <PreviewViewportProvider>
        <div ref={scrollRef} className="studio-video-rail__videos" role="group" aria-label="Select Studio media" onScroll={onScroll}>
          {videos.map(video => <DeferredPreviewTile key={video.video_id}>
            <div className="studio-video-rail__video"><ScopeSelectionCard title={video.title || 'Untitled video'}
              selected={!searchActive && selectedVideoId === video.video_id}
              onSelect={() => onSelectVideo(video)}
              projection={video.thumbnail_gcs_uri || video.gif_gcs_uri || video.assets_revision ? {
                identity: { kind: 'video', video_id: video.video_id },
                assetsRevision: video.assets_revision,
                thumbnailGcsUri: video.thumbnail_gcs_uri || null,
                gifGcsUri: video.gif_gcs_uri || null,
              } : null} />
              <VideoSegmentStatusBars rows={getVideoSegmentStatusRows(video.processing_status)} />
            </div>
          </DeferredPreviewTile>)}
        </div>
      </PreviewViewportProvider> : <div className="studio-video-rail__empty">
        <Film size={18} aria-hidden="true" /><span>Upload media to begin working in Studio.</span>
        {onChooseMedia && <button type="button" className="studio-video-rail__action" onClick={onChooseMedia}>Choose media</button>}
      </div>}
      {hasMore && onLoadMore && <button type="button" className="studio-video-rail__action" onClick={onLoadMore} disabled={isLoadingMore}>
        {isLoadingMore ? <RefreshCw size={14} className="studio-video-rail__spinner" aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        {isLoadingMore ? 'Loading…' : 'Load more media'}
      </button>}
      {onRefresh && <button type="button" className="studio-video-rail__action" onClick={onRefresh} disabled={isLoading}>
        <RefreshCw size={14} aria-hidden="true" />Refresh media
      </button>}
    </section>
  </TabActivityProvider>;
}
