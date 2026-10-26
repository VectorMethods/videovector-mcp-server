import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import StudioSearchWorkspace, { StudioSearchResultCarousel } from './components/studio-search/StudioSearchWorkspace';
import { PreviewGrantProvider, usePreviewGrantClient } from './contexts/PreviewGrantContext';
import { TabActivityProvider } from './contexts/TabActivityContext';
import { normalizeStudioSearchState } from './features/studio-search/types';
import type { StudioSearchTransport } from './features/studio-search/types';
import { getSearchResultKey } from './utils/searchResultIdentity';
import StudioVideoRail from './components/studio-search/StudioVideoRail';
import { ResultSegments } from './results-view';
import { analysisResultView } from './analysis-progress';

export function normalizeStudioResult(row: any) {
  return {
    ...row,
    result_type: row.result_type || (row.segment_id ? 'segment' : 'video'),
    video_uri: row.video_uri ?? null, segment_uri: row.segment_uri ?? null,
    start_time: row.start_time ?? null, end_time: row.end_time ?? null,
    run_id: row.run_id ?? row.prompt_run_id ?? row.source_run_id,
    text_content: row.text_content ?? row.content ?? '', content_preview: row.content_preview ?? '',
    extracted_metadata: row.extracted_metadata ?? row.metadata ?? {}, metadata: row.metadata ?? row.extracted_metadata ?? {},
    similarity_score: typeof row.similarity_score === 'number' ? row.similarity_score : typeof row.score === 'number' ? row.score : null,
  };
}

export function createStudioTransport(callTool: (name: string, args: any, signal?: AbortSignal) => Promise<any>, container: { type?: string; index_id?: string } = { type: 'playground' }): StudioSearchTransport {
  const indexId = container.index_id && container.index_id !== 'playground' ? container.index_id : undefined;
  let library: any = null;
  let libraryRequest: Promise<any> | null = null;
  let catalogGeneration = 0;
  let observedVideos: any[] = [];
  let observedCatalogKey = '';
  const searchAttempts = new Map<string, string>();
  const catalogPage = async (args: any, signal?: AbortSignal) => {
    const response = await callTool('list_studio_scope', { ...args, ...(indexId ? { index_id: indexId } : {}) }, signal);
    if (!response._meta?.catalog) throw new Error('The Studio video scope is unavailable.');
    return response._meta.catalog;
  };
  const searchPage = (response: any) => {
    const view = response._meta?.view;
    if (!view || !Array.isArray(view.data)) throw new Error('The search result page is unavailable.');
    return { results: view.data.map(normalizeStudioResult), snapshotId: view.snapshot_id ?? view.source_id, nextCursor: view.pagination?.next_cursor || null, truncated: Boolean(view.pagination?.truncated), warnings: view.warnings ?? [] };
  };
  return {
    updateProgress(videos: any[]) {
      observedVideos = videos;
      const key = JSON.stringify(videos.map(video => [video.video_id, ...(video.processing_status ?? []).map((entry: any) =>
        [entry.run_id, entry.status, entry.readiness?.metadata_available, entry.readiness?.text_search_ready, entry.readiness?.image_search_ready])]));
      const changed = key !== observedCatalogKey;
      if (changed) { observedCatalogKey = key; library = null; libraryRequest = null; ++catalogGeneration; }
      return changed;
    },
    invalidateCatalog() { if (library) { library = null; libraryRequest = null; ++catalogGeneration; } },
    async catalog({ videoIds, cursor, signal }) {
      if (cursor) {
        const generation = catalogGeneration;
        const next = await catalogPage({ cursor, limit: 100 }, signal);
        if (signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
        const merge = (key: string, identity: (item: any) => string) => Array.from(new Map([...(library?.[key] ?? []), ...(next[key] ?? [])].map(item => [identity(item), item])).values());
        const continued = { ...next, videos: merge('videos', item => item.video_id),
          runs: merge('runs', item => item.run_id).map(run => ({ ...run, video_ids: [...new Set([...(library?.runs ?? []), ...(next.runs ?? [])].filter(item => item.run_id === run.run_id).flatMap(item => item.video_ids ?? []))] })), browse_targets: merge('browse_targets', item => `${item.run_id}:${item.video_id}`),
          fields: merge('fields', item => item.name), warnings: [...new Set([...(library?.warnings ?? []), ...(next.warnings ?? [])])] };
        continued.scope_error = next.scope_error || (continued.videos.length > 100 ? 'Search supports up to 100 selected videos. Narrow the video scope to continue.' : undefined);
        if (catalogGeneration === generation) library = continued;
        return { ...continued, videos: next.videos, nextCursor: next.nextCursor, scopeError: continued.scope_error };
      }
      let activeLibrary = library;
      if (!activeLibrary) {
        if (!libraryRequest) {
          const generation = catalogGeneration;
          // Rail and search share this bounded read; cancelling one consumer
          // must not cancel the other consumer's catalog request.
          const request = catalogPage({ limit: 100 }).then(value => {
            if (catalogGeneration === generation) library = value;
            return value;
          }).finally(() => { if (libraryRequest === request) libraryRequest = null; });
          libraryRequest = request;
        }
        activeLibrary = await libraryRequest;
        if (signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      }
      activeLibrary = { ...activeLibrary, videos: Array.from(new Map([
        ...(activeLibrary.videos ?? []).map((video: any) => [video.video_id, video]),
        ...observedVideos.map(video => [video.video_id, { ...(activeLibrary.videos ?? []).find((row: any) => row.video_id === video.video_id), ...video }]),
      ]).values()) };
      const scoped = videoIds === undefined ? activeLibrary : videoIds.length
        ? await catalogPage({ video_ids: videoIds }, signal)
        : { browse_targets: [], fields: [], warnings: [] };
      return { ...scoped, videos: activeLibrary.videos, runs: activeLibrary.runs ?? [], nextCursor: activeLibrary.nextCursor,
        scopeError: scoped.scope_error || (videoIds === undefined && activeLibrary.videos.length > 100 ? 'Search supports up to 100 selected videos. Narrow the video scope to continue.' : undefined), fields: scoped.fields ?? [], browse_targets: scoped.browse_targets ?? [] };
    },
    async browse({ targets, signal }) {
      const pages: any[] = [];
      let offset = 0;
      await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (offset < targets.length && !signal?.aborted) {
          const index = offset++;
          const target = targets[index];
          const response = await callTool('read_analysis', { analysis_id: target.run_id, video_id: target.video_id, detail: 'full', ...(target.cursor ? { cursor: target.cursor } : {}) }, signal);
          const analysis = response._meta?.analysis;
          if (!Array.isArray(analysis?.results?.data)) throw new Error('This completed analysis is unavailable.');
          const view = analysisResultView(analysis);
          pages[index] = { video_id: target.video_id, run_id: target.run_id,
            results: view.unfiltered.data.filter((row: any) => row.result_type === 'segment').map(normalizeStudioResult), nextCursor: analysis.results.pagination?.next_cursor ?? null };

        }
      }));
      return pages;
    },
    async search({ videoIds, query, filters, signal }) {
      const args = {
        video_ids: [...videoIds].sort(), result_level: 'segment', limit: 50,
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(filters.length ? { filters: filters.map(({ field, operator, value }) => ({ field, operator, ...(value === undefined ? {} : { value }) })) } : {}),
      };
      const signature = JSON.stringify(args);
      const key = searchAttempts.get(signature) ?? crypto.randomUUID();
      searchAttempts.set(signature, key);
      const page = searchPage(await callTool('view_workflow_results', { action: 'search', ...args,
        container_index_id: indexId ?? 'playground', idempotency_key: key }, signal));
      searchAttempts.delete(signature);
      return page;
    },

    async page({ snapshotId, cursor, signal }) {
      return searchPage(await callTool('view_workflow_results', { source_kind: 'search_snapshot', source_id: snapshotId, limit: 50, ...(cursor ? { cursor } : {}) }, signal));
    },
  };
}

type HostProps = {
  sessionKey: string; refreshKey: number; railRefreshKey: string | number; mode: 'studio' | 'results' | 'result'; searchMounted: boolean;
  transport: StudioSearchTransport; callTool: (name: string, args: any, signal?: AbortSignal) => Promise<any>;
  state: any; onStateChange: (state: any) => void; onResultsChange: (results: any[]) => void;
  onSelectVideo: (video: any) => Promise<void>; onSearch: () => void;
  onSelectResult: (result: any, results: any[]) => void; onExit: () => void;
  searchResults: any[]; segmentProps: React.ComponentProps<typeof ResultSegments>;
};
function StudioMediaNavigation({ transport, onSelectVideo, onSearch, mode, refreshKey, segmentProps }: Pick<HostProps, 'transport' | 'onSelectVideo' | 'onSearch' | 'mode' | 'segmentProps'> & { refreshKey: string | number }) {
  const [catalog, setCatalog] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const load = useCallback(async (cursor?: string) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true); setError('');
    try {
      const next = await transport.catalog({ cursor, signal: controller.signal });
      if (controller.signal.aborted) return;
      setCatalog((prior: any) => ({ ...next, videos: cursor
        ? Array.from(new Map([...(prior?.videos ?? []), ...next.videos].map(video => [video.video_id, video])).values())
        : next.videos }));
    } catch (failure) { if (!controller.signal.aborted) setError((failure as Error).message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }, [transport]);
  useEffect(() => {
    void load();
    return () => requestRef.current?.abort();
  }, [load, refreshKey, retry]);
  return <StudioVideoRail videos={catalog?.videos ?? []} selectedVideoId={segmentProps.selected?.video_id}
    searchActive={mode === 'results'} onSearch={onSearch} onSelectVideo={video => { void onSelectVideo(video); }}
    isLoading={busy} isLoadingMore={busy} hasMore={Boolean(catalog?.nextCursor)} error={error}
    onLoadMore={() => void load(catalog.nextCursor)}
    onRefresh={() => { transport.invalidateCatalog?.(); setRetry(value => value + 1); }} />;
}
function StudioSearchHost(props: HostProps) {
  const loadGrants = useCallback(async (items: any[], signal: AbortSignal) => {
    const response = await props.callTool('get_studio_previews', { items }, signal);
    if (!response._meta?.previews) throw new Error('Preview grants are unavailable.');
    return response._meta.previews;
  }, [props.callTool]);
  const requestPreviewGrant = usePreviewGrantClient(props.sessionKey, loadGrants);
  return <PreviewGrantProvider requestPreviewGrant={requestPreviewGrant}>
    {createPortal(<StudioMediaNavigation {...props} refreshKey={props.railRefreshKey} />, document.getElementById('studio-video-rail')!)}
    {props.searchMounted && <TabActivityProvider isActive={props.mode === 'results'}>
      <div hidden={props.mode !== 'results'}><StudioSearchWorkspace transport={props.transport} state={props.state}
        onStateChange={props.onStateChange} onResultsChange={props.onResultsChange} onSelectResult={props.onSelectResult}
        onExit={props.onExit} isActive={props.mode === 'results'} refreshKey={props.refreshKey} /></div>
    </TabActivityProvider>}
    {createPortal(<TabActivityProvider isActive={props.mode === 'result'}>
      {props.mode === 'result' && <StudioSearchResultCarousel results={props.searchResults}
        selectedResultKey={props.segmentProps.selected ? getSearchResultKey(props.segmentProps.selected as any) : null}
        onSelectResult={(row) => props.onSelectResult(row, props.searchResults)} />}
    </TabActivityProvider>, document.getElementById('search-carousel')!)}
    {createPortal(<TabActivityProvider isActive={props.mode !== 'results'}><ResultSegments {...props.segmentProps} /></TabActivityProvider>, document.getElementById('rows')!)}
  </PreviewGrantProvider>;
}
export function createStudioSearchHost(element: HTMLElement) {
  const root = createRoot(element);
  return { update: (props: HostProps) => root.render(<StudioSearchHost key={props.sessionKey} {...props} />), unmount: () => root.unmount() };
}

/** Host persistence contains decisions and frozen-page identities, never media capabilities. */
export function readStudioState(sessionKey: string): any {
  const state = (window as any).openai?.widgetState?.privateContent?.studio;
  if (!state || state.version !== 1 || state.sessionKey !== sessionKey) return null;
  const selected = state.selected;
  return {
    mode: ['studio', 'results', 'result'].includes(state.mode) ? state.mode : 'studio',
    search: normalizeStudioSearchState(state.search),
    selected: selected && typeof selected.video_id === 'string' && (selected.run_id === undefined || typeof selected.run_id === 'string')
      ? { video_id: selected.video_id, run_id: selected.run_id, segment_id: typeof selected.segment_id === 'string' ? selected.segment_id : undefined, result_id: typeof selected.result_id === 'string' ? selected.result_id : undefined, media_type: ['video', 'audio', 'image'].includes(selected.media_type) ? selected.media_type : undefined } : undefined,
  };
}
export function saveStudioState(sessionKey: string, mode: string, search: any, selected: any) {
  const bridge = (window as any).openai;
  if (typeof bridge?.setWidgetState !== 'function') return;
  try { bridge.setWidgetState({ privateContent: { studio: {
    version: 1, sessionKey, mode, search: normalizeStudioSearchState(search),
    selected: selected ? { video_id: selected.video_id, run_id: selected.run_id ?? selected.prompt_run_id ?? selected.source_run_id, segment_id: selected.segment_id, result_id: selected.result_id, media_type: selected.media_type } : undefined,
  } } }); } catch { /* Hosts without available persistence still retain the mounted workspace. */ }
}
