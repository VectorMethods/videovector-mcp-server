import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, Plus, Search, X } from 'lucide-react';
import type { SearchResult } from '../../services/api';
import type { StudioBrowseTarget, StudioSearchCatalog, StudioSearchState, StudioSearchTransport } from '../../features/studio-search/types';
import { normalizeStudioSearchState } from '../../features/studio-search/types';
import { applyFilters } from '../../utils/filterUtils';
import { normalizeConditionFilters } from '../../utils/conditionSearchState';
import { validateConditions, MAX_CONDITIONS } from '../../utils/conditionSearchFilters';
import { getSearchResultKey, getSearchSegmentPreviewProjection } from '../../utils/searchResultIdentity';
import SearchQueryInput from '../search-workspace/SearchQueryInput';
import SearchConfigurationPanel from '../search-workspace/SearchConfigurationPanel';
import SearchConditionEditor from '../search-workspace/SearchConditionEditor';
import SearchTileSizeControlView from '../search-workspace/SearchTileSizeControlView';
import { TabActivityProvider, useTabActivity } from '../../contexts/TabActivityContext';
import { SEARCH_TILE_SIZE_DEFAULT } from '../../features/search-workspace/tileSize';
import ScopeSelectionCard from '../ScopeSelectionCard';
import SearchResultCardView from '../SearchResultCardView';
import { DeferredPreviewTile, PreviewViewportProvider } from '../GrantedPreviewImage';
import '../SearchTab.css';
import './StudioSearchWorkspace.css';

export type StudioResultRenderer = (result: SearchResult, onSelect: () => void, selected: boolean) => React.ReactNode;
const renderDefaultResult: StudioResultRenderer = (result, onSelect, selected) => (
  <SearchResultCardView previewProjection={getSearchSegmentPreviewProjection(result)} result={result} onResultClick={onSelect} isActiveInSidebar={selected} isVectorSearchTile={Boolean(result.field_scores || result.field_instance_scores)} />
);
const targetKey = (target: StudioBrowseTarget) => `${target.video_id}:${target.run_id}`;
const mergeResults = (previous: SearchResult[], incoming: SearchResult[]) => Array.from(new Map(
  [...previous, ...incoming].map((result) => [getSearchResultKey(result), result]),
).values());
const errorMessage = (error: any) => error?.response?.data?.error?.message || error?.message || 'Could not load search results.';

export const StudioSearchResultCarousel: React.FC<{
  results: SearchResult[];
  selectedResultKey: string | null;
  onSelectResult: (result: SearchResult) => void;
  renderResult?: StudioResultRenderer;
  isActive?: boolean;
}> = ({ results, selectedResultKey, onSelectResult, renderResult = renderDefaultResult, isActive = true }) => {
  const parentActivity = useTabActivity();
  return <TabActivityProvider isActive={isActive && parentActivity.isActive}><PreviewViewportProvider>
    <div className="studio-search-carousel search-run-strip" role="group" aria-label="Search results">
      {results.map((result) => <DeferredPreviewTile key={getSearchResultKey(result)}>
        {renderResult(result, () => onSelectResult(result), selectedResultKey === getSearchResultKey(result))}
      </DeferredPreviewTile>)}
    </div>
  </PreviewViewportProvider></TabActivityProvider>;
};

export interface StudioSearchWorkspaceProps {
  transport: StudioSearchTransport;
  state?: StudioSearchState;
  onStateChange?: (state: StudioSearchState) => void;
  onSelectResult: (result: SearchResult, results: SearchResult[]) => void;
  onResultsChange?: (results: SearchResult[]) => void;
  onExit: () => void;
  isActive?: boolean;
  refreshKey?: string | number;
  renderResult?: StudioResultRenderer;
}

const StudioSearchWorkspace: React.FC<StudioSearchWorkspaceProps> = ({
  transport, state: initialState, onStateChange, onSelectResult, onResultsChange, onExit,
  isActive = true, refreshKey, renderResult = renderDefaultResult,
}) => {
  const parentActivity = useTabActivity();
  const active = isActive && parentActivity.isActive;
  const [state, setState] = useState(() => normalizeStudioSearchState(initialState));
  const stateRef = useRef(state);
  stateRef.current = state;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const [library, setLibrary] = useState<StudioSearchCatalog | null>(null);
  const [catalog, setCatalog] = useState<StudioSearchCatalog | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [dataset, setDataset] = useState<'browse' | 'vector' | 'condition'>('browse');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [browseCursors, setBrowseCursors] = useState<Map<string, string | null>>(new Map());
  const [pending, setPending] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const scopeGeneration = useRef(0);
  const previousScopeKey = useRef<string | null>(null);
  const previousRefreshKey = useRef(refreshKey);
  const libraryRef = useRef<StudioSearchCatalog | null>(null);
  const [truncated, setTruncated] = useState(false);
  const attemptedRestore = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);
  const update = useCallback((patch: Partial<StudioSearchState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
    onStateChangeRef.current?.(next);
  }, []);
  useEffect(() => {
    const selectedResultKey = initialState?.selectedResultKey ?? null;
    if (selectedResultKey === stateRef.current.selectedResultKey) return;
    const next = { ...stateRef.current, selectedResultKey };
    stateRef.current = next;
    setState(next);
  }, [initialState?.selectedResultKey]);
  const scopeKey = JSON.stringify(state.videoIds === null ? null : [...state.videoIds].sort());
  const selectedIds = useMemo(() => new Set(state.videoIds ?? library?.videos.map((video) => video.video_id) ?? []), [library, state.videoIds]);
  const visibleResults = useMemo(() => dataset === 'vector' && !state.semanticWindowFiltered ? applyFilters(results, state.filters) : results, [dataset, results, state.filters, state.semanticWindowFiltered]);
  const browseGroups = useMemo(() => {
    const groups = new Map<string, { title: string; results: SearchResult[] }>();
    const titles = new Map(library?.videos.map(video => [video.video_id, video.title]));
    for (const result of visibleResults) {
      const group = groups.get(result.video_id) || { title: titles.get(result.video_id) || result.video_name || 'Video', results: [] };
      group.results.push(result);
      groups.set(result.video_id, group);
    }
    return Array.from(groups, ([videoId, group]) => ({ videoId, ...group }));
  }, [visibleResults, library]);
  useEffect(() => {
    if (!isActive || !parentActivity.isActive) { setScopeOpen(false); return; }
    if (!scopeOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !scopeRef.current?.contains(event.target as Node)) setScopeOpen(false);
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', close); };
  }, [isActive, parentActivity.isActive, scopeOpen]);
  const resultsChangeRef = useRef(onResultsChange);
  resultsChangeRef.current = onResultsChange;
  useEffect(() => { resultsChangeRef.current?.(visibleResults); }, [visibleResults]);

  useEffect(() => {
    if (!active) return;
    const changedScope = previousScopeKey.current !== scopeKey;
    if (!changedScope && previousRefreshKey.current === refreshKey && libraryRef.current && !loadingCatalog) return;
    const controller = new AbortController();
    previousScopeKey.current = scopeKey;
    if (changedScope) {
      ++scopeGeneration.current;
      controllerRef.current?.abort();
      setPending(false);
      setResults([]);
      setDataset('browse');
      setBrowseCursors(new Map());
      setNextCursor(null);
      setTruncated(false);
      restoredScroll.current = false;
    }
    if (previousRefreshKey.current !== refreshKey) {
      previousRefreshKey.current = refreshKey;
      transport.invalidateCatalog?.();
      libraryRef.current = null;
    }
    setLoadingCatalog(true);
    setError(null);
    void (async () => {
      let all = libraryRef.current;
      if (!all) {
        all = await transport.catalog({ signal: controller.signal });
        const seenCursors = new Set<string>();
        while (all.nextCursor && !controller.signal.aborted) {
          if (seenCursors.has(all.nextCursor)) throw new Error('Video listing returned a repeated page. Please refresh the scope.');
          seenCursors.add(all.nextCursor);
          const page: StudioSearchCatalog = await transport.catalog({ cursor: all.nextCursor, signal: controller.signal });
          all = { ...all, ...page, videos: Array.from(new Map([...all.videos, ...page.videos].map(video => [video.video_id, video])).values()), nextCursor: page.nextCursor };
        }
        if (controller.signal.aborted) return;
        libraryRef.current = all;
      }
      setLibrary(all);
      const ids = stateRef.current.videoIds;
      const scoped = ids === null ? all : ids.length
        ? await transport.catalog({ videoIds: ids, signal: controller.signal })
        : { ...all, runs: [], browse_targets: [], fields: [], warnings: [], scopeError: undefined };
      if (controller.signal.aborted) return;
      setCatalog(scoped);
      if (scoped.scopeError) setError(scoped.scopeError);
      const normalizedFilters = normalizeConditionFilters(stateRef.current.filters, { availableFields: scoped.fields });
      if (JSON.stringify(normalizedFilters) !== JSON.stringify(stateRef.current.filters)) update({ filters: normalizedFilters });
    })().catch((failure) => { if (!controller.signal.aborted) setError(errorMessage(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoadingCatalog(false); });
    return () => controller.abort();
  }, [transport, scopeKey, catalogRetry, refreshKey, update, active]);

  const loadBrowse = useCallback(async (targets: StudioBrowseTarget[], reset = false) => {
    if (!targets.length) {
      if (reset) { setResults([]); setBrowseCursors(new Map()); }
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = scopeGeneration.current;
    setPending(true);
    setError(null);
    try {
      const pages = await transport.browse({ targets: targets.slice(0, 12).map((target) => ({ ...target, limit: 12 })), signal: controller.signal });
      if (controller.signal.aborted || generation !== scopeGeneration.current) return;
      setResults((prior) => mergeResults(reset ? [] : prior, pages.flatMap((page) => page.results)));
      setBrowseCursors((prior) => {
        const next = reset ? new Map<string, string | null>() : new Map(prior);
        pages.forEach((page) => next.set(targetKey(page), page.nextCursor || null));
        return next;
      });
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (controllerRef.current === controller) setPending(false); }
  }, [transport]);

  useEffect(() => {
    if (loadingCatalog || !catalog) return;
    if (!attemptedRestore.current && stateRef.current.snapshotId) {
      const controller = new AbortController();
      controllerRef.current = controller;
      setPending(true);
      void (async () => {
        let restored: SearchResult[] = [];
        const saved = stateRef.current;
        const cursors = saved.loadedPageCursors?.length ? [...saved.loadedPageCursors] : [null];
        for (let index = 0; index < cursors.length; index += 1) {
          const cursor = cursors[index];
          const page = await transport.page({ snapshotId: saved.snapshotId!, cursor: cursor || undefined, signal: controller.signal });
          if (controller.signal.aborted) return;
          restored = mergeResults(restored, page.results);
          setNextCursor(page.nextCursor || null);
          setTruncated(Boolean(page.truncated));
          // Restored interactive semantic searches need the entire ranked window
          // for local filtering, including searches interrupted after page one.
          if (saved.submittedQuery && !saved.semanticWindowFiltered && page.nextCursor && !cursors.includes(page.nextCursor)) cursors.push(page.nextCursor);
        }
        update({ loadedPageCursors: cursors });
        attemptedRestore.current = true;
        setResults(restored);
        setDataset(stateRef.current.submittedQuery ? 'vector' : 'condition');
      })().catch((failure) => { if (!controller.signal.aborted) { attemptedRestore.current = true; setError(`${errorMessage(failure)} Run Search again to refresh this result set.`); } })
        .finally(() => { if (!controller.signal.aborted) setPending(false); });
      return () => controller.abort();
    }
    if (stateRef.current.snapshotId || catalog.scopeError) return;
    void loadBrowse(catalog.browse_targets, true);
  }, [catalog, loadingCatalog, loadBrowse, transport, update]);

  useEffect(() => () => controllerRef.current?.abort(), []);
  useEffect(() => {
    if (isActive && !restoredScroll.current && results.length && canvasRef.current) {
      canvasRef.current.scrollTop = stateRef.current.scrollTop;
      restoredScroll.current = true;
    }
  }, [isActive, results.length]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loadingCatalog || !catalog || !selectedIds.size) return;
    if (catalog.scopeError) { setError(catalog.scopeError); return; }
    if (selectedIds.size > 100) { setError('Search supports up to 100 selected videos. Narrow the video scope to continue.'); return; }
    setScopeOpen(false);
    const query = state.query.trim();
    if (state.filters.length) {
      const validation = validateConditions(state.filters, catalog.fields);
      if (!validation.ok) { setError(validation.message || 'Please complete your filters.'); return; }
    }
    if (!query && !state.filters.length) {
      update({ snapshotId: undefined, loadedPageCursors: undefined, submittedQuery: undefined, selectedResultKey: null });
      setDataset('browse');
      setNextCursor(null);
      await loadBrowse(catalog.browse_targets, true);
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    setError(null);
    try {
      const page = await transport.search({ videoIds: Array.from(selectedIds), query, filters: state.filters, signal: controller.signal });
      if (controller.signal.aborted) return;
      let candidates = page.results;
      let cursor = page.nextCursor;
      let loadedPageCursors: Array<string | null> = [null];
      attemptedRestore.current = true;
      setResults(candidates);
      setDataset(query ? 'vector' : 'condition');
      setNextCursor(cursor || null);
      setTruncated(Boolean(page.truncated));
      // Save the billed search before subsequent reads, so a page failure can resume it.
      update({ snapshotId: page.snapshotId, loadedPageCursors, submittedQuery: query, semanticWindowFiltered: true, selectedResultKey: null, scrollTop: 0 });
      // Continue the frozen result set without submitting another search.
      while (query && cursor && !controller.signal.aborted) {
        const next = await transport.page({ snapshotId: page.snapshotId, cursor, signal: controller.signal });
        if (controller.signal.aborted) return;
        loadedPageCursors = [...loadedPageCursors, cursor];
        candidates = mergeResults(candidates, next.results);
        cursor = next.nextCursor;
        setResults(candidates);
        setNextCursor(cursor || null);
        update({ loadedPageCursors: [...loadedPageCursors] });
      }
      if (canvasRef.current) canvasRef.current.scrollTop = 0;
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (controllerRef.current === controller) setPending(false); }
  };
  const loadMore = async () => {
    if (pending) return;
    if (dataset === 'browse') {
      const targets = catalog?.browse_targets || [];
      const unvisited = targets.filter((target) => !browseCursors.has(targetKey(target)));
      const continuations = targets.flatMap((target) => {
        const cursor = browseCursors.get(targetKey(target));
        return cursor ? [{ ...target, cursor }] : [];
      });
      await loadBrowse([...unvisited, ...continuations]);
      return;
    }
    if (!nextCursor || !state.snapshotId) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    setError(null);
    try {
      const cursor = nextCursor;
      const page = await transport.page({ snapshotId: state.snapshotId, cursor, signal: controller.signal });
      if (controller.signal.aborted) return;
      setResults((prior) => mergeResults(prior, page.results));
      setNextCursor(page.nextCursor || null);
      update({ loadedPageCursors: [...(stateRef.current.loadedPageCursors || [null]), cursor] });
    } catch (failure) { if (!controller.signal.aborted) setError(errorMessage(failure)); }
    finally { if (controllerRef.current === controller) setPending(false); }
  };
  const clearResults = () => {
    controllerRef.current?.abort();
    ++scopeGeneration.current;
    attemptedRestore.current = true;
    setScopeOpen(false);
    setResults([]);
    setDataset('browse');
    setNextCursor(null);
    setBrowseCursors(new Map());
    setTruncated(false);
    setError(null);
    update({ query: '', filters: [], snapshotId: undefined, loadedPageCursors: undefined, submittedQuery: undefined, semanticWindowFiltered: false, selectedResultKey: null, scrollTop: 0 });
    if (canvasRef.current) canvasRef.current.scrollTop = 0;
    if (catalog && !catalog.scopeError) void loadBrowse(catalog.browse_targets, true);
    else setPending(false);
  };
  const selectVideos = (ids: Set<string> | null) => {
    const currentIds = stateRef.current.videoIds;
    const unchanged = ids === null ? currentIds === null
      : currentIds !== null && ids.size === currentIds.length && currentIds.every(id => ids.has(id));
    if (unchanged) return;
    controllerRef.current?.abort();
    setCatalog(null);
    setPending(false);
    update({ videoIds: ids === null ? null : Array.from(ids), snapshotId: undefined, loadedPageCursors: undefined, submittedQuery: undefined, selectedResultKey: null, scrollTop: 0 });
  };
  const openResult = (result: SearchResult) => {
    update({ selectedResultKey: getSearchResultKey(result), scrollTop: canvasRef.current?.scrollTop || 0 });
    onSelectResult(result, visibleResults);
  };
  const hasMore = dataset === 'browse'
    ? catalog?.browse_targets.some((target) => !browseCursors.has(targetKey(target)) || Boolean(browseCursors.get(targetKey(target))))
    : Boolean(nextCursor);

  const gridStyle = { gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${state.tileSize || SEARCH_TILE_SIZE_DEFAULT}px), 1fr))` };
  const renderTiles = (items: SearchResult[]) => items.map((result) => <DeferredPreviewTile key={getSearchResultKey(result)}>
    {renderResult(result, () => openResult(result), state.selectedResultKey === getSearchResultKey(result))}
  </DeferredPreviewTile>);
  const canClear = Boolean(state.query || state.filters.length || state.snapshotId || dataset !== 'browse');

  return <TabActivityProvider isActive={isActive && parentActivity.isActive}><section className="studio-search-workspace" aria-label={library?.container?.type === 'index' ? 'Search index videos' : 'Search Playground videos'}>
    <SearchConfigurationPanel>
      <header className="studio-search-header">
        <button type="button" className="studio-search-back-link" onClick={onExit}><ArrowLeft size={14} /><span>Back to Studio</span></button>
      </header>
      <form className="search-form search-configuration-form studio-search-form" onSubmit={submit}>
        <div className="form-group">
          <label className="form-label" id="studio-search-scope-label">Videos</label>
          <div className="custom-select-container studio-search-scope" ref={scopeRef}>
            <button type="button" className="custom-select-trigger" onClick={() => setScopeOpen(!scopeOpen)} aria-expanded={scopeOpen}>
              <span>{state.videoIds === null ? (library?.container?.type === 'index' ? 'All index videos' : 'All Playground videos') : `${selectedIds.size} videos selected`}</span><ChevronDown size={14} />
            </button>
            {scopeOpen && <div className="custom-dropdown search-index-dropdown studio-search-scope-menu" aria-labelledby="studio-search-scope-label">
              <div className="dropdown-header"><span>Select videos</span><button type="button" className="clear-selection-btn" onClick={() => selectVideos(null)}>All</button><button type="button" className="clear-selection-btn" onClick={() => selectVideos(new Set())}>None</button></div>
              <details className="studio-search-executions"><summary>Select by execution</summary>
                {library?.runs.map((run) => {
                  const ids = run.video_ids.filter((id) => library.videos.some((video) => video.video_id === id));
                  const selected = ids.filter((id) => selectedIds.has(id)).length;
                  if (!ids.length) return null;
                  return <button key={run.run_id} type="button" role="checkbox" aria-checked={selected === ids.length ? true : selected ? 'mixed' : false} className="dropdown-item studio-search-execution" onClick={() => {
                    const next = new Set(selectedIds); ids.forEach((id) => selected === ids.length ? next.delete(id) : next.add(id)); selectVideos(next);
                  }}><span className="studio-search-execution-caption">{run.prompt_name}<small>{run.executed_at ? `${new Date(run.executed_at).toLocaleDateString()} · ` : ''}{ids.length} {ids.length === 1 ? 'video' : 'videos'}</small></span><span className="scope-selection-toggle" aria-hidden="true" /></button>;
                })}
              </details>
              <PreviewViewportProvider><div className="index-gallery" role="group" aria-label="Choose videos">
                {library?.videos.map((video) => <ScopeSelectionCard key={video.video_id} title={video.title} selected={selectedIds.has(video.video_id)} multiple onSelect={() => {
                  const next = new Set(selectedIds); next.has(video.video_id) ? next.delete(video.video_id) : next.add(video.video_id); selectVideos(next);
                }} projection={video.thumbnail_gcs_uri || video.gif_gcs_uri ? { identity: { kind: 'video', video_id: video.video_id }, thumbnailGcsUri: video.thumbnail_gcs_uri || null, gifGcsUri: video.gif_gcs_uri || null } : null} />)}
              </div></PreviewViewportProvider>
            </div>}
          </div>
        </div>
        <SearchQueryInput label="Semantic search" value={state.query} onChange={(query) => update({ query })} placeholder="Search video content…" maxLength={2000} />
        <SearchConditionEditor filters={state.filters} fieldDefinitions={catalog?.fields || []} onChange={(filters) => update({ filters })} disabled={loadingCatalog} />
        <div className="search-action-row studio-search-actions">
          <button type="submit" className="search-button" disabled={pending || loadingCatalog || !selectedIds.size}><Search size={14} /><span>{pending ? 'Loading…' : 'Search'}</span></button>
          <button type="button" className="add-filter-btn" disabled={!catalog?.fields.length || state.filters.length >= MAX_CONDITIONS} onClick={() => update({ filters: [...state.filters, { field: '', operator: 'equals', value: '', type: 'string' }] })}><Plus size={14} /><span>Filter</span></button>
        </div>
      </form>
    </SearchConfigurationPanel>
    <div className="studio-search-results">
      <header className="studio-search-results-header">
        <div className="search-candidate-summary" role="status">{loadingCatalog ? 'Loading videos…' : dataset === 'vector' && visibleResults.length !== results.length ? `${visibleResults.length} of ${results.length} results` : `${visibleResults.length} ${dataset === 'browse' ? 'segments' : 'results'}`}</div>
        <div className="studio-search-result-controls">
          {canClear && <button type="button" className="studio-search-back-link" onClick={clearResults}><X size={13} /><span>Clear results</span></button>}
          <SearchTileSizeControlView tileSize={state.tileSize || SEARCH_TILE_SIZE_DEFAULT} setTileSize={(tileSize) => update({ tileSize })} />
        </div>
      </header>
      {error && <div role="alert" className="error-message"><span>{error}</span>{(!catalog || catalog.scopeError) && <button type="button" onClick={() => {
        transport.invalidateCatalog?.(); libraryRef.current = null; setCatalogRetry((value) => value + 1);
      }}>Retry</button>}</div>}
      {truncated && <p className="studio-search-notice">Showing the top 100 results. Narrow your search for more specific matches.</p>}
      <div className="studio-search-canvas" ref={canvasRef} onScroll={(event) => update({ scrollTop: event.currentTarget.scrollTop })} aria-busy={pending || loadingCatalog}>
        <PreviewViewportProvider>
          {dataset === 'browse' ? browseGroups.map(group => <section className="studio-search-video-group" key={group.videoId} aria-label={group.title}>
            <h3 className="studio-search-video-heading">{group.title}</h3>
            <div className="studio-search-grid" style={gridStyle}>{renderTiles(group.results)}</div>
          </section>) : <div className="studio-search-grid" style={gridStyle}>{renderTiles(visibleResults)}</div>}
        </PreviewViewportProvider>
        {!pending && !loadingCatalog && !visibleResults.length && <div className="search-gallery-empty">{selectedIds.size ? 'No segments match this scope or search.' : 'Select videos to browse their segments.'}</div>}
        {(hasMore || (error && catalog)) && <div className="load-more-container"><button type="button" className="load-more-btn" disabled={pending || loadingCatalog} onClick={loadMore}>{pending ? 'Loading…' : 'Load more segments'}</button></div>}
      </div>
    </div>
  </section></TabActivityProvider>;
};
export default StudioSearchWorkspace;
