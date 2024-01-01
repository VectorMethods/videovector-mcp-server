import React, { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MetadataValueView, MetadataViewModeToggle, type MetadataViewMode } from './components/MetadataViewControls';
import { SegmentPreviewGallery, SegmentPreviewGalleryItem } from './components/SegmentPreviewGallery';
import SegmentDownloadButtons from './components/SegmentDownloadButtons';
import StudioResultToolbar from './components/StudioResultToolbar';
import { createPlaygroundStudioWorkspaceState, type PlaygroundStudioWorkspaceState } from './features/playground/studioWorkspaceState';
import { getStudioConditionFields, selectStudioResults, studioSearchText } from './features/playground/studioResultFiltering';
import { resolveSegmentProcessingStatus, type SegmentProcessingStatus } from './utils/segmentStatus';
import { getTimelinePercent, globalFromLocal, locateGlobalTime, type VideoSegment } from './utils/segmentedVideo';
import './components/SegmentedTimeline.css';
import GrantedPreviewImage, { PreviewViewportProvider, useIsNearPreviewViewport } from './components/GrantedPreviewImage';
import { formatSearchScore, getHighestFieldSearchScore } from './utils/searchScore';
import { getBestFieldScoreForDisplayPath } from './utils/searchFieldScores';
import { getSearchSegmentPreviewProjection } from './utils/searchResultIdentity';

type ResultRow = {
  result_id?: string; video_id?: string; segment_id?: string; status?: string;
  field_extraction_succeeded?: boolean; field_extraction_error?: string;
  start_time?: number; end_time?: number; preview_start_time?: number; preview_end_time?: number;
  thumbnail_uri?: string; gif_uri?: string; thumbnail_gcs_uri?: string; gif_gcs_uri?: string; similarity_score?: number | null;
  run_id?: string; prompt_run_id?: string; source_run_id?: string;
  field_scores?: Record<string, number>; field_instance_scores?: Record<string, number>;
  result_type?: string; metadata?: Record<string, unknown>; metadata_text?: string; content?: string;
};
export { buildSegmentMetadataExport, buildStudioRunMetadata, buildStudioMetadataExport } from './utils/studioMetadataExport';
export { sanitizeDownloadFilenamePart } from './utils/download';
export const createResultState = createPlaygroundStudioWorkspaceState;
export const resultVideoKey = (row?: ResultRow) => `${row?.video_id}:${row?.run_id ?? row?.prompt_run_id ?? row?.source_run_id ?? ''}`;

export function filterResultRows(rows: ResultRow[], videoRows: ResultRow[], state: PlaygroundStudioWorkspaceState) {
  const query = state.resultSearchTerm.trim().replace(/_/g, ' ').toLocaleLowerCase();
  const matches = new Set<ResultRow>();
  const videos = new Set<string>();
  const key = resultVideoKey;
  for (const group of new Set([...rows, ...videoRows].map(key))) {
    const segments = rows.filter(row => key(row) === group && row.result_type !== 'video');
    const video = videoRows.find(row => key(row) === group);
    const custom = selectStudioResults(segments.map((row, index) => ({ ...row, segment_id: String(index) })) as never[], video?.metadata ?? null, state.resultFilter);
    for (const [index, row] of segments.entries()) if (custom.segmentIds.has(String(index))
      && (!query || studioSearchText(row.metadata, row.metadata_text ?? row.content).includes(query))) matches.add(row);
    if (custom.videoMatched && (!query || studioSearchText(video?.metadata, video?.metadata_text ?? video?.content).includes(query))) {
      videos.add(key(video));
      rows.filter(row => key(row) === group && row.result_type === 'video').forEach(row => matches.add(row));
    }
  }
  return { rows: rows.filter(row => matches.has(row)), videoKeys: videos };
}
function status(row: ResultRow): SegmentProcessingStatus {
  const normalized = row.status === 'completed' ? 'successful' : row.status;
  return resolveSegmentProcessingStatus({
    segment_status: ['pending', 'processing', 'successful', 'failed'].includes(normalized ?? '') ? normalized as SegmentProcessingStatus : undefined,
    processed: row.field_extraction_succeeded,
    processing_failed: Boolean(row.field_extraction_error),
  });
}
const roots = new WeakMap<HTMLElement, Root>();
function render(element: HTMLElement, content: React.ReactNode) {
  let root = roots.get(element);
  if (!root) { root = createRoot(element); roots.set(element, root); }
  root.render(content);
}
function Metadata({ value, resultKey, title, row }: { value: unknown; resultKey: string; title: string; row?: ResultRow }) {
  const [mode, setMode] = useState<MetadataViewMode>('fields');
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  useEffect(() => setCollapsedPaths(new Set()), [resultKey]);
  return <>
    <div className="analysis-heading"><h2>{title}</h2><MetadataViewModeToggle mode={mode} onModeChange={setMode} /></div>
    <div className="analysis-fields" aria-label={`${title} fields`}><MetadataValueView mode={mode} value={value}
      getFieldScore={(path, tokens) => getBestFieldScoreForDisplayPath(row?.field_scores ?? {}, row?.field_instance_scores ?? {}, path, tokens)}
      formatFieldScore={formatSearchScore} collapsedPaths={collapsedPaths} onTogglePath={path => {
      setCollapsedPaths(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });
    }} /></div>
  </>;
}
export function renderMetadata(element: HTMLElement, value: unknown, key: string, title = 'Analysis', row?: ResultRow) {
  render(element, <Metadata resultKey={key} value={value} title={title} row={row} />);
}
function SegmentPreview({ row, label }: { row: ResultRow; label: string }) {
  const previewRef = useRef<HTMLSpanElement>(null);
  const nearViewport = useIsNearPreviewViewport(previewRef);
  const score = getHighestFieldSearchScore(row as never);
  const projection = nearViewport ? getSearchSegmentPreviewProjection(row as never) : null;
  return <span ref={previewRef} className="segment-preview-media">
    <GrantedPreviewImage projection={projection} alt={label} className="segment-gif" containerClassName="granted-segment-preview"
      placeholder={<span className="segment-card-label">{label}</span>}>
      {score !== null && <span className="search-segment-score">{formatSearchScore(score)}</span>}
    </GrantedPreviewImage>
  </span>;
}
export function ResultSegments({ rows, selected, onSelect, label, range, downloadMedia, downloadMetadata }: {
  rows: ResultRow[]; selected?: ResultRow; onSelect: (row: ResultRow) => void;
  label: (row: ResultRow, index: number) => string; range: (row: ResultRow) => string;
  downloadMedia: (row: ResultRow) => Promise<void>; downloadMetadata: (row: ResultRow) => Promise<void>;
}) {
  return <PreviewViewportProvider><SegmentPreviewGallery ariaLabel="Result segments">
    {rows.map((row, index) => <SegmentPreviewGalleryItem key={row.result_id ?? `${row.video_id}:${row.segment_id ?? index}`}
      selected={row.result_id === selected?.result_id} onSelect={() => onSelect(row)} title={`${label(row, index)} · ${range(row)}`}
      timeLabel={range(row)} status={status(row)} actions={<TileDownloads row={row} downloadMedia={downloadMedia} downloadMetadata={downloadMetadata} />}>
      <SegmentPreview row={row} label={label(row, index)} />
    </SegmentPreviewGalleryItem>)}
  </SegmentPreviewGallery></PreviewViewportProvider>;
}

function TileDownloads({ row, downloadMedia, downloadMetadata }: { row: ResultRow; downloadMedia: (row: ResultRow) => Promise<void>; downloadMetadata: (row: ResultRow) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <SegmentDownloadButtons mediaAvailable={Boolean(row.video_id)} isDownloading={busy}
    onDownloadMedia={() => { if (busy) return; setBusy(true); void downloadMedia(row).finally(() => setBusy(false)); }}
    onDownloadMetadata={() => { void downloadMetadata(row); }} />;
}

export function renderToolbar(element: HTMLElement, props: {
  state: PlaygroundStudioWorkspaceState; onChange: (patch: Partial<PlaygroundStudioWorkspaceState>) => void;
  rows: ResultRow[]; videos: ResultRow[]; runFilter: any; hasRunFilter: boolean; mode: 'matches' | 'all'; onModeChange: (mode: 'matches' | 'all') => void;
  visibleCount: number; videoMatched: boolean; complete: boolean; loading: boolean; isImage: boolean;
}) {
  render(element, <StudioResultToolbar state={props.state} onChange={props.onChange}
    segmentFields={getStudioConditionFields(props.rows.filter(row => row.result_type !== 'video').map(row => row.metadata))}
    videoFields={getStudioConditionFields(props.videos.map(row => row.metadata))}
    runFilter={props.runFilter} hasRunFilter={props.hasRunFilter} resultMode={props.mode} onResultModeChange={props.onModeChange}
    visibleCount={props.visibleCount} totalCount={props.rows.length} hasVideoResult={props.videos.length > 0} videoMatched={props.videoMatched}
    resultsAvailable isImage={props.isImage} resultLabel={props.complete ? undefined : 'loaded results'}
    resultStatus={!props.complete && <span className="muted">{props.loading ? 'Loading remaining analysis…' : 'More analysis is available. Load more to filter all results.'}</span>} />);
}

function Downloads({ onMedia, onMetadata, mediaLabel }: { onMedia: () => Promise<void>; onMetadata: () => Promise<void>; mediaLabel: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (kind: string, action: () => Promise<void>) => { if (busy) return; setBusy(kind); try { await action(); } finally { setBusy(null); } };
  return <SegmentDownloadButtons mediaAvailable isDownloading={busy === 'media'} showLabels
    mediaLabel={`Download ${mediaLabel.toLowerCase()}`} metadataLabel={busy === 'metadata' ? 'Preparing metadata…' : 'Download All Metadata'}
    onDownloadMedia={() => void run('media', onMedia)} onDownloadMetadata={() => void run('metadata', onMetadata)} />;
}
export function renderDownloads(element: HTMLElement, onMedia: () => Promise<void>, onMetadata: () => Promise<void>, mediaLabel: string) {
  render(element, <Downloads onMedia={onMedia} onMetadata={onMetadata} mediaLabel={mediaLabel} />);
}

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
}
function timelineSegments(rows: ResultRow[]): (VideoSegment & { row: ResultRow })[] {
  return rows.map((row, index) => {
    const start = row.start_time ?? row.preview_start_time ?? 0;
    const end = row.end_time ?? row.preview_end_time ?? start;
    return { id: row.result_id ?? row.segment_id ?? String(index), start, end, duration: end - start, row, playbackUrl: '', previewGifUrl: '' };
  }).filter(segment => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start).sort((a, b) => a.start - b.start);
}
export function resolveTimelineSelection(rows: ResultRow[], time: number) {
  const { segment, localTime } = locateGlobalTime(time, timelineSegments(rows));
  return { row: (segment as VideoSegment & { row: ResultRow }).row, time: globalFromLocal(segment, localTime) };
}
export function renderTimeline(element: HTMLElement, rows: ResultRow[], currentTime: number, duration: number,
  onSeek: (row: ResultRow, time: number) => void) {
  const segments = timelineSegments(rows);
  if (!segments.length || !Number.isFinite(duration) || duration <= 0) { render(element, null); return; }
  const time = Math.max(0, Math.min(currentTime, duration));
  const playedPercent = getTimelinePercent(time, duration) * 100;
  const seek = (value: number) => {
    const target = resolveTimelineSelection(rows, value);
    onSeek(target.row, target.time);
  };
  render(element, <div className="segmented-timeline-container">
    <div className="timeline-bar-container">
      <div className="timeline-bar">
        {segments.map((segment, index) => <div key={segment.id} className="timeline-segment-boundary" style={{
          left: `${getTimelinePercent(segment.start, duration) * 100}%`,
          width: `${getTimelinePercent(segment.end - segment.start, duration) * 100}%`,
          background: index % 2 === 0 ? 'color-mix(in srgb, currentColor 8%, transparent)' : 'transparent',
        }} />)}
        <div className="timeline-progress" style={{ width: `${playedPercent}%` }} />
        <div className="timeline-playhead" style={{ left: `${playedPercent}%` }} />
        {segments.slice(1).map(segment => <div key={segment.id} className="timeline-segment-marker" style={{ left: `${getTimelinePercent(segment.start, duration) * 100}%` }} />)}
      </div>
      <input className="timeline-seek" type="range" min={0} max={duration} step={0.1} value={time}
        aria-label="Video timeline" aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`}
        onChange={event => seek(Number(event.currentTarget.value))} />
    </div>
    <div className="timeline-time-display"><span className="current-time">{formatTime(time)}</span><span className="time-separator">/</span><span className="total-time">{formatTime(duration)}</span></div>
  </div>);
}
