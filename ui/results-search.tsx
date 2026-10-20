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

export function createStudioTransport(callTool: (name: string, args: any, signal?: AbortSignal) => Promise<any>): StudioSearchTransport {
  let library: any = null;
  let libraryRequest: Promise<any> | null = null;
  let catalogGeneration = 0;
  const searchAttempts = new Map<string, string>();
  const catalogPage = async (args: any, signal?: AbortSignal) => {
    const response = await callTool('list_studio_scope', args, signal);
    if (!response._meta?.catalog) throw new Error('The Studio video scope is unavailable.');
    return response._meta.catalog;
  };
  const searchPage = (response: any) => {
    const view = response._meta?.view;
    if (!view || !Array.isArray(view.data)) throw new Error('The search result page is unavailable.');
    return { results: view.data.map(normalizeStudioResult), snapshotId: view.snapshot_id ?? view.source_id, nextCursor: view.pagination?.next_cursor || null, truncated: Boolean(view.pagination?.truncated), warnings: view.warnings ?? [] };
  };
  return {
    invalidateCatalog() { library = null; libraryRequest = null; ++catalogGeneration; },
    async catalog({ videoIds, cursor, signal }) {
      if (cursor) {
        const generation = catalogGeneration;
        const next = await catalogPage({ cursor, limit: 100 }, signal);
        if (signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
        const continued = { ...library, videos: Array.from(new Map([...(library?.videos ?? []), ...next.videos].map(video => [video.video_id, video])).values()), nextCursor: next.nextCursor };
        if (catalogGeneration === generation) library = continued;
        return { ...continued, videos: next.videos, nextCursor: next.nextCursor };
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
      const scoped = videoIds === undefined ? activeLibrary : videoIds.length
        ? await catalogPage({ video_ids: videoIds }, signal)
        : { browse_targets: [], fields: [], warnings: [] };
      return { ...scoped, videos: activeLibrary.videos, runs: activeLibrary.runs ?? [], nextCursor: activeLibrary.nextCursor,
        scopeError: scoped.scope_error, fields: scoped.fields ?? [], browse_targets: scoped.browse_targets ?? [] };
    },
    async browse({ targets, signal }) {
      const pages: any[] = [];
      let offset = 0;
      await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (offset < targets.length && !signal?.aborted) {
          const index = offset++;
          const target = targets[index];
          const response = await callTool('view_workflow_results', { source_kind: 'prompt_run', source_id: target.run_id,
            video_id: target.video_id, result_level: 'segment', view: 'unfiltered', limit: target.limit ?? 12,
            ...(target.cursor ? { unfiltered_cursor: target.cursor } : {}),
          }, signal);
          const page = response._meta?.view?.unfiltered;
          if (!page) throw new Error('This execution result page is unavailable.');
          pages[index] = { video_id: target.video_id, run_id: target.run_id, results: page.data.map(normalizeStudioResult), nextCursor: page.pagination?.next_cursor || null };
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
      const page = searchPage(await callTool('search_media', { ...args, idempotency_key: key }, signal));
      searchAttempts.delete(signature);
      return page;
    },

    async page({ snapshotId, cursor, signal }) {
      return searchPage(await callTool('view_workflow_results', { source_kind: 'search_snapshot', source_id: snapshotId, limit: 50, ...(cursor ? { cursor } : {}) }, signal));
    },
  };
}

type HostProps = {
  sessionKey: string; refreshKey: number; mode: 'studio' | 'results' | 'result'; searchMounted: boolean;
  transport: StudioSearchTransport; callTool: (name: string, args: any, signal?: AbortSignal) => Promise<any>;
  state: any; onStateChange: (state: any) => void; onResultsChange: (results: any[]) => void;
  onSelectVideo: (video: any) => Promise<void>; onSearch: () => void;
  onSelectResult: (result: any, results: any[]) => void; onExit: () => void;
  searchResults: any[]; segmentProps: React.ComponentProps<typeof ResultSegments>;
};
function StudioMediaNavigation({ transport, onSelectVideo, onSearch, mode, refreshKey, segmentProps }: Pick<HostProps, 'transport' | 'onSelectVideo' | 'onSearch' | 'mode' | 'refreshKey' | 'segmentProps'>) {
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
    {createPortal(<StudioMediaNavigation {...props} />, document.getElementById('studio-video-rail')!)}
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
