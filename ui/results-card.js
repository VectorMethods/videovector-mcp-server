import { createStudioSearchHost, createStudioTransport, normalizeStudioResult, readStudioState, saveStudioState } from './results-search';
import { getSearchResultKey } from './utils/searchResultIdentity';
import { App } from '@modelcontextprotocol/ext-apps';
import { renderMetadata, renderTimeline, renderToolbar, renderDownloads, createResultState, filterResultRows, resultVideoKey, buildSegmentMetadataExport, buildStudioRunMetadata, buildStudioMetadataExport, sanitizeDownloadFilenamePart } from './results-view';
import './results-card.css';
import { createAnalysisProgressController, analysisResultView, readAnalysisVideo, processingView, metadataRevision } from './analysis-progress';
import { uploadAttachmentBatch } from '../src/attachments/upload-batch.js';
import { describeAttachmentFile, transferAttachmentFile } from '../src/attachments/resumable-file.js';

const app = new App({ name: 'VideoVector results', version: '2.0.0' });
const byId = id => document.getElementById(id);
const player = byId('player');
const imagePreview = byId('image-preview');
const PAGE_LIMIT = 50;
const PRELOAD_PAGES = 20;
const DOWNLOAD_PAGES = 200;
let source, data, selected, grant, pendingSeek, filterState, initialContext;
let initialRows = [], initialMatches = [], visibleRows = [];
let viewRequest = {}, resultMode = 'all';
let selectionSequence = 0;
const videoViews = new Map();
const mediaGrants = new Map();
const mediaRetries = new Set();
const downloads = new Map();
let catalogRevision = 0, restoringPlayer = false;
let sessionKey = '', studioMode = 'studio', searchMounted = false, searchState, searchResults = [], originalPlayer, pendingRestoreSelected;
let activeImportId, activeAnalysisId, progressSnapshot, uploadGrant, uploadFiles = [], disposed = false, analysisLoadController, uploadController;
const uploadedFiles = new Set();
const callStudioTool = async (name, args, signal) => {
  const result = await app.callServerTool({ name, arguments: args }, signal ? { signal } : undefined);
  if (result.isError) {
    let message = 'The Studio request could not be completed.';
    try { message = JSON.parse(result.content?.find(item => item.type === 'text')?.text ?? '{}').message || message; } catch { /* Use the bounded public fallback. */ }
    throw new Error(message);
  }
  return result;
};
let studioTransport = createStudioTransport(callStudioTool);
const studioHost = createStudioSearchHost(byId('studio-search'));
const analysisProgress = createAnalysisProgressController({
  read: async (identity, version, signal) => {
    const response = await callStudioTool('read_analysis', {
      ...(activeAnalysisId ? { analysis_id: identity } : { import_id: identity }),
      observe: true, wait_seconds: 25, ...(version ? { after_version: version } : {}),
    }, signal);
    if (!response._meta?.progress) throw new Error('Progress is unavailable.');
    return response._meta.progress;
  },
  apply: applyProcessingSnapshot,
  unavailable: () => {
    byId('analysis-updated').textContent = 'Live updates are unavailable. Processing continues.';
    byId('analysis-reconnect').hidden = false;
  },
});
function showAnalysisProgress(value) {
  byId('result-workspace').hidden = !source;
  byId('analysis-progress').hidden = false;
  byId('analysis-stage').textContent = String(value.stage ?? value.status ?? '').replaceAll('_', ' ');
  byId('analysis-message').textContent = value.message ?? '';
  const progress = value.progress ?? {};
  byId('analysis-counts').textContent = [
    typeof progress.imported === 'number' ? `${progress.imported} received` : '',
    typeof (progress.completed ?? progress.parts_completed) === 'number' ? `${progress.completed ?? progress.parts_completed} complete` : '',
    progress.processing ? `${progress.processing} processing` : '',
    progress.partial ? `${progress.partial} with partial results` : '',
    progress.failed ? `${progress.failed} failed` : '',
  ].filter(Boolean).join(' · ');
  byId('analysis-files').textContent = (value.files?.items ?? value.files ?? []).map(file => `${file.name ?? file.file_name ?? file.video_id ?? 'Media'}: ${String(file.status ?? 'received').replaceAll('_', ' ')}`).join(' · ');
  byId('analysis-newer').hidden = !value.newer_processing?.length;
  byId('analysis-newer').textContent = 'A newer analysis is processing. You are viewing the completed analysis shown here.';
  byId('analysis-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}
function initializeAnalysisWorkspace(value) {
  if (source || !activeAnalysisId) return;
  source = { kind: 'prompt_run', id: activeAnalysisId }; sessionKey = `analysis:${activeAnalysisId}`;
  studioTransport = createStudioTransport(callStudioTool, value.scope);
  const restored = readStudioState(sessionKey);
  searchState = restored?.search ?? { videoIds: null, query: '', filters: [], selectedResultKey: null, scrollTop: 0 };
  studioMode = restored?.mode ?? 'studio'; searchMounted = studioMode !== 'studio' || Boolean(searchState.snapshotId); viewRequest = {};
  if (restored?.mode === 'result') { pendingRestoreSelected = restored.selected; studioMode = 'results'; }
  else if (restored?.mode === 'studio') pendingRestoreSelected = restored.selected;
  filterState = createResultState(null, activeAnalysisId); resultMode = 'all';
  data = { run_id: activeAnalysisId, result_level: 'segment', unfiltered: { data: [], pagination: { has_more: false } }, filtered: null };
  initialRows = []; initialMatches = [];
}
async function refreshAnalysisVideo(videoId, revision, signal) {
  const requestSource = source;
  if (!videoId || requestSource?.kind !== 'prompt_run' || requestSource.id !== activeAnalysisId) return;
  const key = viewKey(videoId, activeAnalysisId);
  if (revision && videoViews.get(key)?.metadataRevision === revision) return;
  const analysis = await readAnalysisVideo(callStudioTool, activeAnalysisId, videoId, signal);
  if (disposed || signal?.aborted || source !== requestSource || selected && selected.video_id !== videoId) return;
  const view = analysisResultView(analysis);
  cacheAnalysisViews(analysis, view, revision);
  data = { ...data, status: analysis.status, links: analysis.links, selection_summary: view.selection_summary };
  initialRows = analysisInitialRows(view); initialMatches = view.filtered?.data ?? [];
  const refreshed = [...view.unfiltered.data].find(row => identity(row) === identity(selected));
  if (refreshed) selected = refreshed;
  render();
  if (!selected && studioMode === 'studio' && initialRows[0]) await choose(initialRows[0]);
}
async function applyAnalysisSnapshot(value, signal) {
  if (disposed || value.analysis_id !== activeAnalysisId) return;
  initializeAnalysisWorkspace(value);
  showAnalysisProgress(value); render();
  // The observer selects a canonical metadata revision before loading its body.
}
async function applyProcessingSnapshot(value, signal) {
  if (disposed || value.analysis_id !== (activeAnalysisId ?? activeImportId)) return;
  progressSnapshot = value;
  const state = processingView(value);
  byId('analysis-progress').hidden = false;
  byId('analysis-stage').textContent = String(state.stage).replaceAll('_', ' ');
  byId('analysis-message').textContent = state.message;
  byId('analysis-counts').textContent = state.counts;
  byId('analysis-files').textContent = state.entries.map(({ video, entry }) => {
    const phase = entry?.activity?.phase ?? entry?.status ?? video.status;
    const parts = entry?.total_parts ? ` (${(entry.completed_parts ?? 0) + (entry.failed_parts ?? 0)}/${entry.total_parts} parts)` : '';
    const images = entry?.enrichment?.image;
    return `${video.title ?? 'Media'}: ${String(phase ?? 'received').replaceAll('_', ' ')}${parts}${images?.total ? ` · images ${images.completed ?? 0}/${images.total}` : ''}`;
  }).join(' · ');
  byId('analysis-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  byId('analysis-reconnect').hidden = true;
  if (!activeAnalysisId) return;
  initializeAnalysisWorkspace(value);
  if (studioTransport.updateProgress?.(state.entries.map(({ video, entry }) => ({ ...video, assets_revision: entry?.result_revisions?.assets })))) ++catalogRevision;
  render();
  const restore = studioMode === 'studio' && pendingRestoreSelected?.run_id === value.run_id ? pendingRestoreSelected : undefined;
  const chosen = state.entries.find(({ video }) => video.video_id === (restore?.video_id ?? selected?.video_id))
    ?? (!selected ? state.entries[0] : undefined);
  if (!chosen || source?.id !== activeAnalysisId) return;
  if (restore && chosen.entry?.readiness?.metadata_available) {
    pendingRestoreSelected = undefined;
    await restoreStudioSelection(restore);
  } else if (chosen.entry?.readiness?.metadata_available) {
    await refreshAnalysisVideo(chosen.video.video_id, metadataRevision(chosen.entry), signal);
  } else if (!selected && value.run_id) {
    await choose({ result_id: `media:${chosen.video.video_id}`, result_type: 'video', video_id: chosen.video.video_id,
      video_name: chosen.video.title, media_type: chosen.video.media_type, run_id: value.run_id });
  }
  applyAssetRevision(chosen.video.video_id, chosen.entry?.result_revisions?.assets);
}
function applyAssetRevision(videoId, revision) {
  const view = videoViews.get(viewKey(videoId, activeAnalysisId));
  if (!view || !revision || view.assetsRevision === revision) return;
  view.assetsRevision = revision;
  for (const level of ['segment', 'video']) for (const scope of ['unfiltered', 'filtered']) {
    for (const row of view[level]?.[scope]?.data ?? []) row.assets_revision = revision;
  }
  render();
}
function beginAnalysisRead() {
  analysisLoadController?.abort(); analysisLoadController = new AbortController();
  return analysisLoadController.signal;
}
function analysisInitialRows(view) {
  const segmented = new Set(view.unfiltered.data.filter(row => row.result_type === 'segment').map(row => row.video_id));
  return view.unfiltered.data.filter(row => row.result_type === 'segment' || !segmented.has(row.video_id));
}
function cacheAnalysisViews(analysis, view = analysisResultView(analysis), revision) {
  const page = rows => ({ data: rows, pagination: { has_more: false, next_cursor: null } });
  for (const video of view.videos) {
    const matching = new Set(video.selection?.matched_segment_ids ?? []);
    const native = progressSnapshot?.records.find(row => row.kind === 'video' && row.id === video.video_id)?.state;
    const assetsRevision = native?.processing_status?.find(row => row.run_id === analysis.analysis_id)?.result_revisions?.assets;
    if (assetsRevision) for (const row of [...video.rows, ...video.videoRows]) row.assets_revision = assetsRevision;
    videoViews.set(viewKey(video.video_id, analysis.analysis_id), { runId: analysis.analysis_id, videoId: video.video_id, loading: false, metadataRevision: revision, assetsRevision, links: analysis.links,
      context: { run: { run_id: analysis.analysis_id, status: analysis.status }, video: { video_id: video.video_id, title: video.name, media_type: video.media_type }, video_level_output: video.videoRows[0] ?? null },
      segment: { unfiltered: page(video.rows), filtered: page(video.rows.filter(row => matching.has(row.segment_id))) },
      video: { unfiltered: page(video.videoRows), filtered: page(video.selection?.video_matched ? video.videoRows : []) },
    });
  }
}
function persistStudio() { if (sessionKey) saveStudioState(sessionKey, studioMode, searchState, selected); }
function showSearch() {
  if (studioMode === 'studio') originalPlayer = { source, data, initialRows, initialMatches, viewRequest, resultMode, filterState, selected };
  studioMode = 'results'; searchMounted = true; player.pause(); render(); persistStudio();
}
function showStudio() {
  studioMode = 'studio';
  if (originalPlayer) {
    ({ source, data, initialRows, initialMatches, viewRequest, resultMode, filterState } = originalPlayer);
    const row = originalPlayer.selected; originalPlayer = undefined;
    if (row) { void choose(row); return; }
  }
  if (source?.kind === 'search_snapshot') {
    const row = selected ?? searchResults[0] ?? initialRows[0];
    if (row) { void selectSearchResult(row, searchResults, 'studio'); return; }
  }
  render(); persistStudio();
}
async function selectSearchResult(row, results, mode = 'result') {
  const normalized = normalizeStudioResult(row);
  const id = runId(normalized);
  if (!id) { status('This result has no execution identity.', true); return; }
  studioMode = mode; searchMounted = true; searchResults = results;
  searchState = { ...searchState, selectedResultKey: getSearchResultKey(normalized) };
  if (source?.kind !== 'prompt_run' || source.id !== id) source = { kind: 'prompt_run', id };
  data = { run_id: id, result_level: 'segment', filtered: null, unfiltered: null };
  initialRows = [normalized]; initialMatches = [];
  viewRequest = { video_id: normalized.video_id, result_level: 'segment', view: 'unfiltered' };
  resultMode = 'all'; filterState = createResultState(normalized.video_id, id);
  await choose(normalized);
}
async function selectStudioVideo(video) {
  const requestSelection = ++selectionSequence;
  status('Loading video…');
  try {
    const signal = beginAnalysisRead();
    const observed = progressSnapshot?.records.find(row => row.kind === 'video' && row.id === video.video_id)?.state;
    const entry = observed?.processing_status?.find(row => row.run_id === progressSnapshot.run_id);
    const pinned = activeAnalysisId && progressSnapshot?.run_id && progressSnapshot.scope.video_ids.includes(video.video_id);
    const catalog = pinned ? null : await studioTransport.catalog({ videoIds: [video.video_id], signal });
    if (catalog?.scopeError) throw new Error(catalog.scopeError);
    const target = pinned ? { run_id: progressSnapshot.run_id, video_id: video.video_id }
      : catalog.browse_targets.find(item => item.video_id === video.video_id);
    const existing = pinned ? videoViews.get(viewKey(video.video_id, target.run_id)) : undefined;
    const revision = pinned ? metadataRevision(entry) : undefined;
    const cached = revision && existing?.metadataRevision === revision && viewComplete(existing) ? existing : undefined;
    const analysis = !cached && target && activeAnalysisId && (!pinned || entry?.readiness?.metadata_available)
      ? await readAnalysisVideo(callStudioTool, target.run_id, video.video_id, signal) : null;
    const completeView = analysis ? analysisResultView(analysis) : null;
    const page = cached ? { results: analysisInitialRows({ unfiltered: { data: [...cached.segment.unfiltered.data, ...cached.video.unfiltered.data] } }), nextCursor: null }
      : completeView ? { results: analysisInitialRows(completeView), nextCursor: null }
      : target && !pinned ? (await studioTransport.browse({ targets: [{ ...target, limit: 50 }] }))[0] : null;
    if (requestSelection !== selectionSequence) return;
    studioMode = 'studio'; originalPlayer = undefined; initialContext = undefined;
    initialMatches = []; resultMode = 'all';
    source = target ? { kind: 'prompt_run', id: target.run_id } : { kind: 'media', id: video.video_id };
    initialRows = page?.results ?? [];
    if (completeView) cacheAnalysisViews(analysis, completeView, pinned ? metadataRevision(entry) : undefined);
    viewRequest = { video_id: video.video_id, result_level: 'segment', view: 'unfiltered' };
    data = { run_id: target?.run_id, ...((completeView || cached) ? { links: (completeView ?? cached).links } : {}), filtered: null, unfiltered: page ? { data: initialRows, pagination: { has_more: Boolean(page.nextCursor), next_cursor: page.nextCursor } } : null };
    filterState = createResultState(video.video_id, target?.run_id ?? null);
    if (cached) applyAssetRevision(video.video_id, entry?.result_revisions?.assets);
    status('');
    await choose(initialRows[0] ?? { result_id: `media:${video.video_id}`, result_type: 'video', video_id: video.video_id, video_name: video.title, media_type: video.media_type, run_id: target?.run_id });
  } catch (error) { if (requestSelection === selectionSequence) status(error.message, true); }
}
async function restoreStudioSelection(saved) {
  studioMode = 'studio'; initialContext = undefined; initialRows = []; initialMatches = []; resultMode = 'all';
  source = saved.run_id ? { kind: 'prompt_run', id: saved.run_id } : { kind: 'media', id: saved.video_id };
  const requestSource = source;
  data = { run_id: saved.run_id, result_level: 'segment', filtered: null, unfiltered: null };
  viewRequest = { video_id: saved.video_id, result_level: 'segment', view: 'unfiltered' };
  filterState = createResultState(saved.video_id, saved.run_id ?? null);
  if (!saved.run_id) {
    await choose({ ...saved, result_type: 'video', result_id: saved.result_id ?? `media:${saved.video_id}` });
    return;
  }
  restoringPlayer = true;
  try {
    await preload(saved.video_id, true);
    if (source !== requestSource) return;
    const row = [...allRows(), ...videoRows()].find(item => identity(item) === saved.result_id
      || item.video_id === saved.video_id && runId(item) === saved.run_id && item.segment_id === saved.segment_id);
    if (!row) throw new Error('The saved Studio result is no longer available. Select another video or segment.');
    await choose(row);
  } catch (error) { if (source === requestSource) status(error.message, true); }
  finally { restoringPlayer = false; }
}
function receiveSearchResults(rows) {
  searchResults = rows;
  if (pendingRestoreSelected) {
    const row = rows.find(item => identity(item) === pendingRestoreSelected.result_id
      || item.video_id === pendingRestoreSelected.video_id && runId(item) === pendingRestoreSelected.run_id && item.segment_id === pendingRestoreSelected.segment_id);
    if (row) { pendingRestoreSelected = undefined; void selectSearchResult(row, rows); return; }
  }
  render();
}
function viewKey(videoId, id = source?.id) { return `${id ?? ''}:${videoId}`; }


function status(message, error = false) {
  byId('status').textContent = message;
  byId('status').className = error ? 'error' : '';
  byId('status').hidden = !message;
}
function clearSelection() {
  ++selectionSequence;
  selected = undefined; grant = undefined; pendingSeek = undefined;
  player.pause(); player.hidden = true; player.removeAttribute('src'); player.load();
  imagePreview.hidden = true; imagePreview.removeAttribute('src');
  for (const id of ['timeline', 'analysis', 'video-analysis', 'selected-title', 'downloads']) byId(id).hidden = true;
}
function identity(row) { return row?.result_id ?? `${row?.video_id}:${row?.segment_id ?? row?.preview_segment_id ?? 'video'}`; }
function runId(row = selected) { return row?.run_id ?? row?.prompt_run_id ?? row?.source_run_id ?? (source?.kind === 'prompt_run' ? source.id : undefined); }
function mediaKey(row) { return `${runId(row) ?? ''}:${row.video_id}`; }
function mediaLabel(row) { return row?.media_type === 'image' ? 'Image' : row?.media_type === 'audio' ? 'Audio' : 'Video'; }
function isImage(row, media) { return row?.media_type === 'image' || media?.mime_type?.startsWith('image/'); }
function label(row) { return row?.video_name || videoViews.get(viewKey(row?.video_id, runId(row)))?.context?.video?.title || mediaLabel(row); }
function range(row) {
  if (row.media_type === 'image' || row.result_type === 'video') return mediaLabel(row);
  const start = row.start_time ?? row.preview_start_time, end = row.end_time ?? row.preview_end_time;
  return typeof start === 'number' ? `${start.toFixed(1)}–${typeof end === 'number' ? end.toFixed(1) : '?'}s` : mediaLabel(row);
}
function unique(rows) { return [...new Map(rows.map(row => [identity(row), row])).values()]; }
function hasEngineFilter() {
  if (studioMode === 'result') return false;
  const state = data?.selection_summary?.status ?? data?.selection_summary?.state;
  return source?.kind === 'prompt_run' && Boolean(data?.selection_filter || state && state !== 'not_applicable');
}
function engineStatus() {
  if (!hasEngineFilter() || resultMode !== 'matches') return '';
  const state = data?.selection_summary?.status ?? data?.selection_summary?.state;
  return state === 'failed' ? 'The engine filter failed. Turn it off to browse extracted results.'
    : state && state !== 'ready' ? 'Engine matches are not available yet. Turn off the engine filter to browse extracted results.' : '';
}
function allRows() {
  if (source?.kind === 'search_snapshot') return initialRows;
  const views = [...videoViews.values()].filter(view => view.runId === source?.id);
  const videoIds = [...new Set([...initialRows.map(row => row.video_id), ...views.map(view => view.videoId)])];
  const rows = videoIds.flatMap(videoId => {
    const view = views.find(view => view.videoId === videoId);
    const hydrated = view?.segment?.unfiltered?.data ?? view?.segment?.filtered?.data ?? [];
    const hydratedIds = new Set(hydrated.map(identity));
    return unique([...hydrated, ...initialRows.filter(row => row.video_id === videoId && !hydratedIds.has(identity(row)))]);
  });
  if (studioMode !== 'result') return rows;
  const scores = new Map(searchResults.map(row => [identity(row), row]));
  return rows.filter(row => row.video_id === selected?.video_id && runId(row) === runId(selected)).map(row => {
    const hit = scores.get(identity(row));
    return hit ? { ...row, similarity_score: hit.similarity_score, field_scores: hit.field_scores, field_instance_scores: hit.field_instance_scores, matched_field_paths: hit.matched_field_paths, matched_field_instances: hit.matched_field_instances } : row;
  }).sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
}

function videoRows() {
  if (source?.kind === 'search_snapshot') return allRows().filter(row => row.result_type === 'video');
  return unique([...initialRows.filter(row => row.result_type === 'video'), ...[...videoViews.values()].filter(view => view.runId === source?.id).flatMap(view => view.video?.unfiltered?.data ?? view.video?.filtered?.data ?? [])]);
}
function matchedRows(level = 'segment') {
  return unique([...(level === 'segment' ? initialMatches : initialMatches.filter(row => row.result_type === 'video')),
    ...[...videoViews.values()].filter(view => view.runId === source?.id).flatMap(view => view[level]?.filtered?.data ?? [])]);
}
function currentView() { return videoViews.get(viewKey(selected?.video_id ?? viewRequest.video_id)); }
function pageComplete(page) { return Boolean(page && !page.pagination?.has_more); }
function moreAuthoredResults() {
  return source?.kind === 'prompt_run' && !viewRequest.video_id && data[resultMode === 'matches' ? 'filtered' : 'unfiltered']?.pagination?.has_more;
}
function viewComplete(view) {
  if (source?.kind === 'media') return true;
  if (!view) return false;
  return Boolean(view.context && ['segment', 'video'].every(level => pageComplete(view[level]?.unfiltered)
    && (!hasEngineFilter() || pageComplete(view[level]?.filtered))));
}
function render() {
  if (!source) return;
  byId('result-workspace').hidden = false;
  const rows = allRows();
  const matches = new Set(matchedRows().map(identity));
  const videoMatches = new Set(matchedRows('video').map(identity));
  const engineRows = resultMode === 'matches' ? rows.filter(row => matches.has(identity(row))) : rows;
  const videos = videoRows();
  const engineVideos = resultMode === 'matches' ? videos.filter(row => videoMatches.has(identity(row))) : videos;
  const filtered = studioMode === 'result' ? { rows: engineRows, videoKeys: new Set(engineVideos.map(resultVideoKey)) } : filterResultRows(engineRows, engineVideos, filterState);
  visibleRows = filtered.rows;
  const view = currentView();
  renderToolbar(byId('toolbar'), {
    state: filterState, onChange: patch => { filterState = { ...filterState, ...patch }; reconcile(); },
    rows, videos, runFilter: data.selection_filter ?? null, hasRunFilter: hasEngineFilter(), mode: resultMode,
    onModeChange: mode => { resultMode = mode; reconcile(); }, visibleCount: visibleRows.length,
    videoMatched: filtered.videoKeys.has(resultVideoKey(selected)), complete: viewComplete(view) && !moreAuthoredResults(), loading: Boolean(view?.loading), isImage: isImage(selected),
  });
  byId('toolbar').hidden = studioMode === 'result' || source.kind === 'media';
  byId('rows').hidden = rows.length === 0;
  byId('player-area').hidden = studioMode === 'results';
  byId('studio-search').hidden = studioMode !== 'results';
  byId('search-carousel').hidden = studioMode !== 'result';
  byId('back-results').hidden = studioMode !== 'result';
  studioHost.update({ sessionKey, refreshKey: catalogRevision, railRefreshKey: progressSnapshot?.version ?? catalogRevision, mode: studioMode, searchMounted, transport: studioTransport, callTool: callStudioTool,
    state: searchState, onStateChange: state => { searchState = state; persistStudio(); }, onResultsChange: receiveSearchResults,
    onSelectResult: selectSearchResult, onSelectVideo: selectStudioVideo, onSearch: showSearch, onExit: showStudio, searchResults,
    segmentProps: { rows: visibleRows, selected, onSelect: choose, label, range, downloadMedia, downloadMetadata: downloadSegmentMetadata },
  });
  byId('empty').hidden = visibleRows.length !== 0;
  byId('empty').textContent = engineStatus() || (rows.length ? 'No matching results. Change your search or filters to see more.' : 'No analysis is available yet.');
  byId('next').hidden = viewComplete(view) && !moreAuthoredResults();
  byId('next').disabled = Boolean(view?.loading);
  byId('analysis').hidden = source.kind === 'media' || !selected || !(visibleRows.some(row => identity(row) === identity(selected)) || selected.result_type === 'video' && filtered.videoKeys.has(resultVideoKey(selected)));
  const selectedRow = rows.find(row => identity(row) === identity(selected)) ?? selected;
  if (!byId('analysis').hidden) renderMetadata(byId('analysis'), selectedRow.metadata ?? {}, identity(selectedRow), 'Analysis', selectedRow);
  const video = engineVideos.find(row => resultVideoKey(row) === resultVideoKey(selected) && filtered.videoKeys.has(resultVideoKey(row)));
  byId('video-analysis').hidden = !video || identity(video) === identity(selected);
  if (!byId('video-analysis').hidden) renderMetadata(byId('video-analysis'), video.metadata ?? {}, identity(video), 'Video analysis');
  byId('downloads').hidden = source.kind === 'media' || !selected;
  if (selected) renderDownloads(byId('downloads'), () => downloadMedia(selected, true), downloadAllMetadata, mediaLabel(selected));
  updateTimeline();
}
function reconcile() {
  render();
  if (restoringPlayer) return;
  if (visibleRows.length && !visibleRows.some(row => identity(row) === identity(selected))) void choose(visibleRows[0]);
  else if (!selected && videoRows().length) void choose(videoRows().find(row => row.video_id === viewRequest.video_id) ?? videoRows()[0]);
}
function seekSelected() {
  if (!selected || !grant || player.hidden || player.readyState < 1) return;
  player.currentTime = pendingSeek ?? (selected.result_type === 'video' ? 0 : selected.start_time ?? selected.preview_start_time ?? 0);
  pendingSeek = undefined;
  updateTimeline();
}
async function choose(row, time) {
  ++selectionSequence;
  selected = row;
  filterState = { ...filterState, scopeVideoId: row.video_id, scopeRunId: runId(row) ?? null };
  pendingSeek = time ?? (row.result_type === 'video' ? 0 : row.start_time ?? row.preview_start_time ?? 0);
  player.pause();
  byId('selected-title').textContent = `${label(row)} · ${range(row)}`;
  byId('selected-title').hidden = false;
  render();
  await Promise.all([preparePlayback(), preload(row.video_id)]);
  persistStudio();
}
function updateTimeline() {
  const rows = visibleRows.filter(row => row.video_id === selected?.video_id && runId(row) === runId(selected) && row.result_type !== 'video');
  const visible = selected && !isImage(selected, grant) && rows.some(row => typeof (row.end_time ?? row.preview_end_time) === 'number');
  byId('timeline').hidden = !visible;
  if (!visible) return;
  const duration = !player.hidden && Number.isFinite(player.duration) && player.duration > 0
    ? player.duration : Math.max(...rows.map(row => row.end_time ?? row.preview_end_time ?? 0));
  renderTimeline(byId('timeline'), rows, pendingSeek ?? player.currentTime ?? 0, duration, choose);
}
function seedView(videoId) {
  const view = { runId: source.id, videoId, segment: {}, video: {}, loading: false, context: initialContext?.video?.video_id === videoId && initialContext?.run?.run_id === source.id ? initialContext : undefined, error: null };
  const level = viewRequest.result_level ?? data.result_level ?? 'segment';
  for (const scope of ['unfiltered', 'filtered']) {
    const page = data[scope];
    if (page && !viewRequest[`${scope}_cursor`] && (viewRequest.video_id === videoId || !page.pagination?.has_more)) {
      view[level][scope] = { data: page.data.filter(row => row.video_id === videoId), pagination: page.pagination };
    }
  }
  return view;
}
async function preload(videoId, complete = false) {
  if (source?.kind !== 'prompt_run') return;
  const requestSource = source;
  const key = viewKey(videoId);
  let view = videoViews.get(key);
  if (!view) { view = seedView(videoId); videoViews.set(key, view); }
  if (view.promise) { await view.promise; if (!complete || viewComplete(view)) return; }
  if (viewComplete(view)) return;
  if (activeAnalysisId) {
    const native = progressSnapshot?.records.find(row => row.kind === 'video' && row.id === videoId)?.state;
    const entry = native?.processing_status?.find(row => row.run_id === requestSource.id);
    if (requestSource.id === activeAnalysisId && !entry?.readiness?.metadata_available) return;
    const signal = beginAnalysisRead();
    const analysis = await readAnalysisVideo(callStudioTool, requestSource.id, videoId, signal);
    if (source !== requestSource || signal.aborted) return;
    cacheAnalysisViews(analysis, undefined, metadataRevision(entry)); render(); return;
  }
  if (view.error && !complete) return;
  view.loading = true; view.error = null;
  const active = () => source === requestSource;
  const budget = complete ? DOWNLOAD_PAGES : PRELOAD_PAGES;
  let requests = 0;
  const read = async args => {
    const bytes = JSON.stringify(view.segment).length + JSON.stringify(view.video ?? {}).length;
    if (bytes > (complete ? 32 : 8) * 1024 * 1024 || ++requests > budget) return null;
    const result = await app.callServerTool({ name: 'view_workflow_results', arguments: { source_kind: requestSource.kind, source_id: requestSource.id, limit: PAGE_LIMIT, ...args } });
    if (!active()) return null;
    if (result.isError || !result._meta?.view) throw new Error('Some analysis could not be loaded. Open this result in the app or use Load more to try again.');
    if (result._meta.context) view.context = result._meta.context;
    const next = result._meta.view;
    if (next.selection_filter !== undefined) data.selection_filter = next.selection_filter;
    if (next.selection_summary) data.selection_summary = next.selection_summary;
    return next;
  };
  const merge = (prior, next, cursor) => {
    if (next.pagination?.has_more && (!next.pagination.next_cursor || next.pagination.next_cursor === cursor)) throw new Error('The next result page is unavailable. Open this result in the app to continue.');
    return { data: unique([...(prior?.data ?? []), ...(next.data ?? [])]), pagination: next.pagination };
  };
  view.promise = (async () => {
    try {
        for (const level of ['segment', 'video']) {
          if (!active() || requests >= budget) break;
          const pages = view[level];
          if (!pages.unfiltered || hasEngineFilter() && !pages.filtered || level === 'video' && !view.context) {
            const next = await read({ video_id: videoId, result_level: level, view: 'both', ...(level === 'video' && !view.context ? { include_context: true } : {}) });
            if (!next) break;
            for (const scope of ['unfiltered', 'filtered']) if (next[scope]) pages[scope] = merge(undefined, next[scope]);
            render();
          }
          for (const scope of ['unfiltered', ...(hasEngineFilter() ? ['filtered'] : [])]) {
            while (pages[scope]?.pagination?.has_more && active()) {
              const cursor = pages[scope].pagination.next_cursor;
              const next = await read({ video_id: videoId, result_level: level, view: scope, [`${scope}_cursor`]: cursor });
              if (!next) break;
              if (!next[scope]) throw new Error('This result page is unavailable. Open this result in the app to continue.');
              pages[scope] = merge(pages[scope], next[scope], cursor);
              render();
            }
          }
        }
      if (complete && active() && !viewComplete(view)) throw new Error('This analysis is too large for an inline download. Open this result in the app to export all metadata.');
    } catch (error) {
      view.error = error.message;
      if (active()) status(error.message, true);
      if (complete) throw error;
    } finally {
      view.loading = false; view.promise = undefined;
      if (active()) { render(); if (!view.error) reconcile(); }
    }
  })();
  render();
  return view.promise;
}
async function open(url) {
  if (!url) return;
  try { await app.openLink({ url }); } catch { status('Open this result using its link in the conversation.', true); }
}
async function metadataFallback(row) {
  const url = row?.links?.json ?? row?.links?.play ?? data?.links?.open_in_app;
  if (!url) throw new Error('This chat client does not support metadata file downloads. Open this result using its link in the conversation.');
  const result = await app.openLink({ url });
  if (result.isError) throw new Error('Opening metadata in the app was cancelled or unavailable.');
  status('Use Export metadata in the opened result.');
}
async function deliverJson(value, filename, row) {
  if (!app.getHostCapabilities()?.downloadFile) return metadataFallback(row);
  const text = JSON.stringify(value, null, 2);
  if (text.length > 32 * 1024 * 1024) throw new Error('This metadata file is too large for an inline download. Open this result in the app to export it.');
  const outcome = await app.downloadFile({ contents: [{ type: 'resource', resource: { uri: `file:///${filename}`, mimeType: 'application/json', text } }] });
  if (outcome.isError) throw new Error('The download was cancelled or unavailable.');
}
function downloadAction(key, action) {
  if (downloads.has(key)) return downloads.get(key);
  const requestSource = source;
  const promise = action().catch(error => { if (source === requestSource) status(error.message || 'Download failed. Please try again.', true); }).finally(() => { if (downloads.get(key) === promise) downloads.delete(key); });
  downloads.set(key, promise);
  return promise;
}
function downloadMedia(row, whole = false) {
  return downloadAction(`media:${identity(row)}:${whole}`, async () => {
    const requestSource = source;
    const result = await app.callServerTool({ name: 'play_workflow_media', arguments: {
      video_id: row.video_id, ...(runId(row) ? { run_id: runId(row) } : {}),
      ...(!whole && row.result_type !== 'video' && row.segment_id ? { segment_id: row.segment_id } : {}), intent: 'download',
    } });
    if (source !== requestSource) return;
    const file = result._meta?.file;
    if (result.isError || !file) throw new Error('This media download is unavailable. Open this result in the app to inspect it.');
    const outcome = app.getHostCapabilities()?.downloadFile
      ? await app.downloadFile({ contents: [{ type: 'resource_link', uri: file.url, name: file.name, mimeType: file.mimeType }] })
      : await app.openLink({ url: file.url });
    if (outcome.isError) throw new Error('The download was cancelled or unavailable.');
  });
}
function downloadSegmentMetadata(row) {
  return downloadAction(`metadata:${identity(row)}`, async () => {
    const view = videoViews.get(viewKey(row.video_id, runId(row)));
    const prefix = sanitizeDownloadFilenamePart(label(row), 'video', 30);
    const rows = allRows().filter(candidate => candidate.video_id === row.video_id && candidate.result_type !== 'video');
    const value = row.result_type === 'video' ? { export_info: { exported_at: new Date().toISOString(), video_id: row.video_id, prompt_run_id: runId(row) }, video_level_output: publicVideoResult(row) }
      : buildSegmentMetadataExport({ segment: row, segmentIndex: Math.max(0, rows.findIndex(candidate => identity(candidate) === identity(row))), videoId: row.video_id, videoTitle: label(row), runId: runId(row), promptName: view?.context?.run?.prompt_name });
    await deliverJson(value, `${prefix}_${sanitizeDownloadFilenamePart(row.segment_id ?? 'video', 'result')}_metadata.json`, row);
  });
}
function publicVideoResult(row) {
  if (!row) return null;
  return Object.fromEntries(['video_id', 'run_id', 'result_id', 'status', 'metadata', 'metadata_text', 'content', 'field_extraction_succeeded', 'field_extraction_error'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}
function downloadAllMetadata() {
  if (!selected) return Promise.resolve();
  const row = selected, requestSource = source;
  return downloadAction(`all:${row.video_id}`, async () => {
    if (activeAnalysisId && runId(row)) {
      const response = await callStudioTool('read_analysis', { analysis_id: runId(row), video_id: row.video_id, intent: 'download' });
      const url = response._meta?.analysis?.results?.download_url;
      if (!url) throw new Error('This video’s analysis is not ready for download yet.');
      const outcome = app.getHostCapabilities()?.downloadFile
        ? await app.downloadFile({ contents: [{ type: 'resource_link', uri: url, name: `${sanitizeDownloadFilenamePart(label(row), 'video', 30)}_analysis.json`, mimeType: 'application/json' }] })
        : await app.openLink({ url });
      if (outcome.isError) throw new Error('The download was cancelled or unavailable.');
      return;
    }
    if (!app.getHostCapabilities()?.downloadFile) return metadataFallback(row);
    await preload(row.video_id, true);
    if (source !== requestSource) return;
    const view = videoViews.get(viewKey(row.video_id, runId(row)));
    if (!viewComplete(view)) throw new Error('All analysis is not loaded. Open this result in the app to export its metadata.');
    const context = view.context ?? {};
    const rows = view.segment.unfiltered.data.filter(item => item.video_id === row.video_id);
    const grouped = new Map();
    for (const item of rows) { const id = runId(item); if (!grouped.has(id)) grouped.set(id, []); grouped.get(id).push(item); }
    if (!grouped.size && runId(row)) grouped.set(runId(row), []);
    const value = buildStudioMetadataExport({ video: context.video ?? { video_id: row.video_id, title: label(row) }, resultScope: 'all', promptRuns: [...grouped].map(([id, items]) => buildStudioRunMetadata({
      run: context.run ?? { run_id: id }, segments: items.filter(item => item.result_type !== 'video'), mediaType: row.media_type,
      videoLevelOutput: context.video_level_output ?? publicVideoResult(view.video.unfiltered.data[0]),
    })) });
    value.export_info.source_kind = source.kind; value.export_info.source_id = source.id;
    await deliverJson(value, `${sanitizeDownloadFilenamePart(label(row), 'video', 30)}_all_metadata.json`, row);
  });
}
async function preparePlayback() {
  if (!selected) return;
  const row = selected, requestSource = source, requestSelection = selectionSequence;
  const active = () => row === selected && requestSource === source && requestSelection === selectionSequence;
  const key = mediaKey(row);
  try {
    let cached = mediaGrants.get(key);
    if (!cached || Date.parse(cached.expires_at) < Date.now() + 15000) {
      player.hidden = true; imagePreview.hidden = true;
      const pending = app.callServerTool({ name: 'play_workflow_media', arguments: { video_id: row.video_id, ...(runId(row) ? { run_id: runId(row) } : {}) } }).then(result => {
        if (result.isError || !result._meta?.media) throw new Error('Media is unavailable. Open this result in the app to inspect it.');
        if (mediaGrants.get(key) === pending) mediaGrants.set(key, result._meta.media);
        return result._meta.media;
      }).catch(error => { if (mediaGrants.get(key) === pending) mediaGrants.delete(key); throw error; });
      mediaGrants.set(key, pending); cached = pending;
    }
    const media = await cached;
    if (!active()) return;
    grant = media;
    if (isImage(row, media)) {
      player.hidden = true; player.removeAttribute('src'); player.load();
      imagePreview.alt = label(row);
      if (imagePreview.getAttribute('src') !== grant.url) imagePreview.src = grant.url;
      imagePreview.hidden = false;
    } else {
      imagePreview.hidden = true; imagePreview.removeAttribute('src');
      if (player.getAttribute('src') !== grant.url) player.src = grant.url;
      player.hidden = false; seekSelected();
    }
    updateTimeline();
  } catch (error) { if (active()) status(error.message, true); }
}
function recoverMedia(kind) {
  if (!selected) return;
  const key = mediaKey(selected);
  if (mediaRetries.has(key)) { status(`${kind} could not load. Open this result in the app to inspect it.`, true); return; }
  mediaRetries.add(key); mediaGrants.delete(key);
  void preparePlayback();
}
async function receiveResult(result) {
  ++catalogRevision; studioTransport.invalidateCatalog?.();
  const incomingKey = result.structuredContent?.source_id ? `${result.structuredContent.source_kind}:${result.structuredContent.source_id}` : '';
  if (incomingKey && incomingKey === sessionKey && source && (studioMode !== 'studio' || result.structuredContent.source_kind === 'search_snapshot')) { render(); return; }
  clearSelection(); videoViews.clear(); mediaGrants.clear(); mediaRetries.clear(); downloads.clear();
  for (const id of ['toolbar', 'rows', 'next', 'empty']) byId(id).hidden = true;
  initialRows = []; initialMatches = []; visibleRows = [];
  const value = result.structuredContent;
  if (result.isError || !value?.source_id) {
    source = undefined; data = undefined;
    for (const id of ['toolbar', 'rows', 'next']) byId(id).hidden = true;
    status('Results are not ready. Continue using the links in the conversation.', true); return;
  }
  sessionKey = incomingKey; originalPlayer = undefined; searchResults = []; pendingRestoreSelected = undefined;
  const restored = readStudioState(sessionKey);
  source = { kind: value.source_kind, id: value.source_id }; data = result._meta?.view ?? value;
  initialContext = result._meta?.context;
  const requestSource = source;
  viewRequest = result._meta?.viewRequest ?? {};
  filterState = createResultState(viewRequest.video_id ?? null, source.kind === 'prompt_run' ? source.id : null);
  let scopedVideoIds = viewRequest.video_ids ?? data.scope?.video_ids;
  if (!restored && source.kind === 'search_snapshot' && !scopedVideoIds && data.scope?.prompt_run_ids?.length) {
    try {
      const scope = await callStudioTool('list_studio_scope', { prompt_run_ids: data.scope.prompt_run_ids });
      if (source !== requestSource) return;
      if (scope._meta?.catalog?.scope_error) throw new Error(scope._meta.catalog.scope_error);
      scopedVideoIds = [...new Set((scope._meta?.catalog?.runs ?? []).flatMap(run => run.video_ids))];
    } catch (error) { status(error.message, true); return; }
  }
  searchState = restored?.search ?? { videoIds: scopedVideoIds ?? null, query: viewRequest.query ?? '', filters: viewRequest.filters ?? [], selectedResultKey: null, scrollTop: 0,
    ...(source.kind === 'search_snapshot' ? { snapshotId: source.id, loadedPageCursors: [viewRequest.cursor ?? null], submittedQuery: viewRequest.query ?? '', semanticWindowFiltered: Boolean(viewRequest.query && viewRequest.filters?.length) } : {}),
  };
  studioMode = restored?.mode ?? (source.kind === 'search_snapshot' ? 'results' : 'studio');
  searchMounted = studioMode !== 'studio' || Boolean(searchState.snapshotId);
  if (restored?.mode === 'result') { pendingRestoreSelected = restored.selected; studioMode = 'results'; }
  studioTransport = createStudioTransport(callStudioTool, data.destination ?? data.scope);
  if (!result._meta?.view) {
    const loaded = await app.callServerTool({ name: 'view_workflow_results', arguments: { source_kind: source.kind, source_id: source.id, ...(source.kind === 'search_snapshot' ? { cursor: viewRequest.cursor, limit: viewRequest.limit ?? 50 } : viewRequest) } });
    if (source !== requestSource) return;
    if (loaded.isError || !loaded._meta?.view) { status('Analysis could not be loaded. Open this result in the app.', true); return; }
    data = loaded._meta.view;
  }
  initialRows = source.kind === 'search_snapshot' ? data.data ?? [] : unique([...(data.unfiltered?.data ?? []), ...(data.filtered?.data ?? [])]);
  initialMatches = data.filtered?.data ?? [];
  resultMode = hasEngineFilter() ? 'matches' : 'all';
  status(''); render();
  if (restored?.mode === 'studio' && restored.selected) { await restoreStudioSelection(restored.selected); return; }
  if (source.kind === 'search_snapshot') return;
  const first = (resultMode === 'matches' ? initialMatches[0] : undefined) ?? initialRows[0];
  if (first) await choose(first);
  else if (viewRequest.video_id) await preload(viewRequest.video_id);
}
app.ontoolresult = async result => {
  const value = result._meta?.analysis ?? result._meta?.import ?? result.structuredContent;
  if (!result.isError && (value?.analysis_id || value?.import_id)) {
    if (activeAnalysisId !== value.analysis_id || activeImportId !== value.import_id) {
      uploadController?.abort(); byId('submit').disabled = false; byId('files').disabled = false;
      activeImportId = value.import_id; activeAnalysisId = value.analysis_id; progressSnapshot = undefined; originalPlayer = undefined; searchResults = []; pendingRestoreSelected = undefined;
      uploadGrant = undefined; uploadFiles = []; uploadedFiles.clear(); byId('files').value = ''; byId('selection').textContent = ''; byId('upload-message').textContent = '';
      clearSelection(); videoViews.clear(); source = undefined; data = undefined;
      initialRows = []; initialMatches = []; visibleRows = [];
      for (const id of ['toolbar', 'rows', 'next', 'empty']) byId(id).hidden = true;
    }
    uploadGrant = result._meta?.upload ?? uploadGrant;
    byId('upload-form').hidden = !(uploadGrant && (value.stage === 'awaiting_upload' || value.status === 'awaiting_upload'));
    if (uploadGrant) byId('files').accept = uploadGrant.accept;
    showAnalysisProgress(value); status('');
    try { if (document.visibilityState !== 'hidden') await applyAnalysisSnapshot(value, beginAnalysisRead()); } catch (error) { if (error.name !== 'AbortError') status(error.message, true); }
    analysisProgress.start(value);
    return;
  }
  uploadController?.abort(); analysisProgress.reset(); analysisLoadController?.abort(); activeAnalysisId = undefined; activeImportId = undefined;
  byId('analysis-progress').hidden = true; byId('upload-form').hidden = true;
  await receiveResult(result);
};
byId('files').addEventListener('change', () => {
  uploadFiles = Array.from(byId('files').files ?? [], file => ({ file, file_id: crypto.randomUUID() }));
  uploadedFiles.clear();
  byId('selection').textContent = `${uploadFiles.length} files selected`;
});
byId('upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!uploadGrant || !uploadFiles.length) return;
  const grant = uploadGrant, taskId = activeAnalysisId ?? activeImportId;
  if (uploadController && !uploadController.signal.aborted) return;
  const controller = new AbortController(); uploadController = controller;
  if (uploadFiles.length > grant.max_files) { uploadController = undefined; byId('upload-message').textContent = `Choose no more than ${grant.max_files} files.`; return; }
  const send = async (url, body) => {
    const target = new URL(url), origin = new URL(grant.url);
    if (target.protocol !== 'https:' || target.origin !== origin.origin || target.username || target.password) throw new Error('The upload destination is unavailable.');
    const response = await fetch(target.href, { method: 'POST', credentials: 'omit', redirect: 'error',
      signal: controller.signal, headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? 'This upload session expired. Refresh this analysis to continue.' : 'Upload did not finish. Try again to resume the selected files.');
    return response.json();
  };
  byId('submit').disabled = true; byId('files').disabled = true;
  try {
    await uploadAttachmentBatch(uploadFiles.filter(entry => !uploadedFiles.has(entry.file_id)), async entry => {
      byId('upload-message').textContent = `Uploading: ${entry.file.name} (${uploadedFiles.size} of ${uploadFiles.length} received)`;
      const descriptor = await describeAttachmentFile(entry.file);
      const initialized = await send(grant.url, { file_id: entry.file_id, ...descriptor, restart_expired: false });
      if (initialized.upload) await transferAttachmentFile(entry.file, initialized.upload, controller.signal, confirmed => {
        if (!disposed && (activeAnalysisId ?? activeImportId) === taskId) byId('upload-message').textContent = `Uploading: ${entry.file.name} (${Math.floor(100 * confirmed / entry.file.size)}% received)`;
      });
      await send(`${grant.url}/complete`, { file_id: entry.file_id });
      uploadedFiles.add(entry.file_id);
      byId('upload-message').textContent = `${uploadedFiles.size} of ${uploadFiles.length} files received`;
    });
    await send(grant.complete_url, { file_ids: uploadFiles.map(entry => entry.file_id) });
    if ((activeAnalysisId ?? activeImportId) !== taskId || disposed) return;
    uploadGrant = undefined; byId('upload-form').hidden = true;
    byId('analysis-message').textContent = activeImportId ? 'Files received. Importing media…' : 'Files received. Preparing the analysis…';
    void analysisProgress.refresh();
  } catch (error) { if (!disposed && (activeAnalysisId ?? activeImportId) === taskId) byId('upload-message').textContent = error.message; }
  finally { if (uploadController === controller) uploadController = undefined; if (!disposed && (activeAnalysisId ?? activeImportId) === taskId) { byId('submit').disabled = false; byId('files').disabled = false; } }
});
byId('next').addEventListener('click', async () => {
  const requestSource = source;
  try {
    const view = currentView(); if (view) view.error = null;
    if (moreAuthoredResults() && viewComplete(view)) {
      const scope = resultMode === 'matches' && data.filtered?.pagination?.has_more ? 'filtered' : 'unfiltered';
      const cursor = data[scope]?.pagination?.next_cursor;
      if (!cursor) throw new Error('The next result page is unavailable. Open this result in the app.');
      const result = await app.callServerTool({ name: 'view_workflow_results', arguments: { source_kind: source.kind, source_id: source.id, result_level: viewRequest.result_level ?? data.result_level ?? 'segment', view: scope, [`${scope}_cursor`]: cursor, limit: PAGE_LIMIT } });
      if (source !== requestSource) return;
      const page = result._meta?.view?.[scope];
      if (result.isError || !page || page.pagination?.has_more && page.pagination.next_cursor === cursor) throw new Error('The next result page is unavailable. Open this result in the app.');
      data[scope] = page;
      initialRows = unique([...initialRows, ...page.data]);
      if (scope === 'filtered') initialMatches = unique([...initialMatches, ...page.data]);
      reconcile();
    } else await preload(selected?.video_id ?? viewRequest.video_id, true);
  } catch (error) { if (source === requestSource) status(error.message, true); }
});
byId('analysis-reconnect').addEventListener('click', () => { byId('analysis-reconnect').hidden = true; void analysisProgress.refresh(); });
byId('back-results').addEventListener('click', showSearch);
byId('open-app').addEventListener('click', () => open(selected?.links?.play ?? data?.links?.open_in_app));
player.addEventListener('loadedmetadata', seekSelected);
player.addEventListener('durationchange', updateTimeline);
player.addEventListener('timeupdate', () => {
  if (player.hidden) return;
  const end = selected?.result_type === 'video' ? undefined : selected?.end_time ?? selected?.preview_end_time;
  if (typeof end === 'number' && player.currentTime >= end) player.pause();
  updateTimeline();
});
player.addEventListener('play', () => {
  const end = selected?.result_type === 'video' ? undefined : selected?.end_time ?? selected?.preview_end_time;
  if (typeof end === 'number' && player.currentTime >= end) seekSelected();
});
player.addEventListener('error', () => { if (!player.hidden && player.getAttribute('src')) recoverMedia('Playback'); });
imagePreview.addEventListener('error', () => { if (!imagePreview.hidden && imagePreview.getAttribute('src')) recoverMedia('Image'); });
const pauseAnalysisReads = () => { if (document.visibilityState === 'hidden') analysisLoadController?.abort(); };
document.addEventListener?.('visibilitychange', pauseAnalysisReads);
app.onteardown = async () => { disposed = true; uploadController?.abort(); analysisLoadController?.abort(); document.removeEventListener?.('visibilitychange', pauseAnalysisReads); analysisProgress.stop(); persistStudio(); studioHost.unmount(); source = undefined; clearSelection(); videoViews.clear(); mediaGrants.clear(); return {}; };
await app.connect();
