import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { VideoVectorClient } from '../src/client/index.js';
import { executeTool, getToolDefinitions, getToolRequiredScope } from '../src/tools/index.js';
import { artifactLink, appOrigin, projectWorkflowPayload, resultLink } from '../src/tools/workflow-result-projection.js';
import { WORKFLOW_RESULT_TOOLS, WORKFLOW_DETAIL_TOOLS, RESULTS_CARD_URI } from '../src/tools/workflow-result-contract.js';
import * as resultView from '../ui/results-view';
import { createAnalysisProgressController, analysisResultView, readAnalysisVideo, processingView, metadataRevision } from '../ui/analysis-progress';
import { createStudioTransport, normalizeStudioResult, readStudioState as readHostState, saveStudioState as saveHostState } from '../ui/results-search';
import { getSearchResultKey } from '../ui/utils/searchResultIdentity';
import { uploadAttachmentBatch } from '../src/attachments/upload-batch.js';
import { describeAttachmentFile, transferAttachmentFile } from '../src/attachments/resumable-file.js';

const secret = 'https://storage.googleapis.com/private/clip.mp4?X-Goog-Signature=private-capability';
const row = { result_id: 'segment:seg-1:run-1', result_type: 'segment', run_id: 'run-1', video_id: 'video-1', segment_id: 'seg-1', video_name: 'Launch', start_time: 4, end_time: 9, metadata: { scene: 'x'.repeat(200000), gcs_uri: 'customer field' }, video_uri: secret, segment_uri: secret, raw_llm_response: 'private raw output', source_index_id: 'index-1' };
const cursor = 'opaque/'.repeat(100);
const runPage = { run_id: 'run-1', status: 'completed', result_level: 'segment', destination: { type: 'index', index_id: 'index-1' }, selection_summary: { status: 'ready', selected_segment_count: 1, selected_media_count: 1, selected_video_count: 1 }, filtered: { data: [row], pagination: { limit: 10, has_more: true, next_cursor: cursor } }, unfiltered: { data: [row], pagination: { limit: 10, has_more: false, next_cursor: null } } };
function client(overrides = {}): VideoVectorClient {
  return {
    workflowRunResults: vi.fn().mockResolvedValue(runPage),
    workflowDelivery: vi.fn().mockResolvedValue({ source_kind: 'prompt_run', source_id: 'run-1', artifacts: [
      { scope: 'all', state: 'ready', export_id: 'export-1', format_version: 2, download_path: '/private/raw', href: secret, raw: 'private' },
      { scope: 'matches', state: 'preparing', format_version: 2 },
      { scope: 'invalid', state: 'ready', href: secret },
    ] }),
    ...overrides,
  } as unknown as VideoVectorClient;
}

describe('workflow result contract v2', () => {

  it('budgets useful summary previews across both pages, including multi-byte metadata', () => {
    const data = Array.from({ length: 50 }, (_, index) => ({ ...row, result_id: String(index), metadata: { scene: 'Visible café 🚀 '.repeat(200) }, text_content: 'Scene details '.repeat(80) }));
    const projected = projectWorkflowPayload('analysis_results', { ...runPage, filtered: { data, pagination: runPage.filtered.pagination }, unfiltered: { data, pagination: runPage.unfiltered.pagination } }, 'summary');
    const rows = [...(projected.filtered as any).data, ...(projected.unfiltered as any).data];
    expect(rows[0].metadata_preview).toContain('Visible café');
    expect(rows[0].metadata_preview.length).toBeLessThanOrEqual(512);
    expect(rows.reduce((sum, item) => sum + Buffer.byteLength(item.metadata_preview ?? '') + Buffer.byteLength(item.content ?? ''), 0)).toBeLessThanOrEqual(8192);
    expect(rows.at(-1)).toMatchObject({ metadata_preview: '', metadata_omitted: true, content_omitted: true });
  });

  it('preserves complete canonical public fields in full mode and uses a valid landing without a video', () => {
    const raw = { ...row, text_content: 'complete '.repeat(4000), content_preview: 'short', metadata_text: 'metadata text', raw_llm_response: 'full generated response', field_scores: { scene: 0.9 } };
    const projected = projectWorkflowPayload('search_results', { data: [raw], pagination: {} }, 'full');
    expect((projected.data as any)[0]).toMatchObject({ content: raw.text_content, text_content: raw.text_content, content_preview: 'short', metadata_text: 'metadata text', raw_llm_response: 'full generated response', field_scores: { scene: 0.9 } });
    expect((projected.data as any)[0]).not.toHaveProperty('segment_uri');
    expect(resultLink({ video_id: 'video-1', result_type: 'video', preview_segment_id: 'seg-1' }, 'run-1', 'all', appOrigin())).toContain('output=video');
  });

  it.each(['summary', 'full'] as const)('retains canonical search scope and coverage in %s', detail => {
    const coverage = { prompt_run_count: 2, searchable_video_count: 3, partial_prompt_run_count: 1, requested_video_count: 4, covered_video_count: 3 };
    const scope = { type: 'videos', video_ids: ['video-1', 'video-2', 'video-3', 'video-4'] };
    const projected = projectWorkflowPayload('search_results', { data: [], pagination: {}, scope: { ...scope, physical_run_id: 'private' }, coverage }, detail);
    expect(projected.coverage).toEqual(coverage);
    expect(projected.scope).toEqual(scope);
  });

  it('keeps Studio destinations and identifiers exact, with a separate whole-video link', () => {
    const videoId = 'v'.repeat(256);
    const segmentId = 's'.repeat(256);
    const payload = projectWorkflowPayload('search_results', { data: [{ ...row, video_id: videoId, segment_id: segmentId }], pagination: {} }, 'summary');
    const result = (payload.data as any[])[0];
    expect(result.video_id).toBe(videoId);
    expect(result.segment_id).toBe(segmentId);
    expect(new URL(result.links.play).searchParams.get('segment')).toBe(segmentId);
    const videoLink = new URL(result.links.watch_video);
    expect(videoLink.searchParams.get('video')).toBe(videoId);
    expect(videoLink.searchParams.has('segment')).toBe(false);
    expect(videoLink.searchParams.has('t')).toBe(false);
    expect(videoLink.searchParams.has('output')).toBe(false);
    expect(videoLink.searchParams.get('playback')).toBe('video');
  });

  it('routes the canonical Playground search sentinel and run destination into Studio', () => {
    const search = projectWorkflowPayload('search_results', { data: [{ ...row, source_index_id: 'playground' }], pagination: {} }, 'summary');
    const results = projectWorkflowPayload('analysis_results', { ...runPage, destination: { type: 'playground' } }, 'summary');
    for (const result of [(search.data as any[])[0], ...(results.filtered as any).data, ...(results.unfiltered as any).data]) {
      for (const href of Object.values(result.links)) {
        const url = new URL(href as string);
        expect(url.pathname).toBe('/playground');
        expect(url.searchParams.get('step')).toBe('studio');
        expect(url.searchParams.has('index')).toBe(false);
      }
    }
  });

  it('supports the frontend navigation contract and rejects non-origin configuration', () => {
    const fixtures = JSON.parse(readFileSync(new URL('./fixtures/workflow-links.json', import.meta.url), 'utf8'));
    for (const item of fixtures.artifact_links) {
      const url = new URL(artifactLink(item.source_kind, item.source_id, item.scope, item.export_id, appOrigin()));
      const expected = new URL(item.pathname + item.search, appOrigin());
      expected.searchParams.delete('action');
      expect(url.pathname).toBe(expected.pathname);
      expect(Object.fromEntries(url.searchParams)).toEqual(Object.fromEntries(expected.searchParams));
    }
    const url = new URL(resultLink({ video_id: 'video-2', source_index_id: 'index-1', result_type: 'video' }, 'run-2', 'matches', appOrigin()));
    expect(Object.fromEntries(url.searchParams)).toEqual(Object.fromEntries(new URL(fixtures.result_links[1].pathname + fixtures.result_links[1].search, appOrigin()).searchParams));
    expect(() => appOrigin('https://user:secret@evil.example')).toThrow();
    expect(() => appOrigin('javascript:alert(1)')).toThrow();
    expect(() => appOrigin('https://app.example/path?token=secret')).toThrow();
  });
});

describe('results app tools', () => {

  it('publishes app-only helpers and attaches the results card only to result tools', () => {
    const tools = getToolDefinitions({ includeAppTools: true });
    for (const name of ['view_workflow_results', 'play_workflow_media']) {
      const tool = tools.find(tool => tool.name === name)!;
      expect(tool._meta).toMatchObject({ ui: { visibility: ['app'] }, 'openai/visibility': 'private' });
      expect(getToolRequiredScope(name)).toBe('read');
    }
    expect(RESULTS_CARD_URI).toBe('ui://videovector/results-card-v2.html');
    expect(tools.filter(tool => (tool._meta?.ui as any)?.resourceUri === RESULTS_CARD_URI).map(tool => tool.name)).toEqual(['analyze', 'get_analysis', 'search', 'import_media']);
  });

  it('loads full run pages only in private metadata', async () => {
    const backend = client();
    const result = await executeTool('view_workflow_results', { source_kind: 'prompt_run', source_id: 'run-1', filtered_cursor: 'next', view: 'filtered' }, backend, { authenticationKind: 'oauth' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain(row.metadata.scene);
    expect((result._meta!.view as any).filtered.data[0].metadata).toEqual(row.metadata);
    expect(JSON.stringify(result._meta!.view)).not.toContain('private-capability');
    expect(backend.workflowRunResults).toHaveBeenCalledWith('run-1', expect.objectContaining({ filtered_cursor: 'next', view: 'filtered' }));
  });

  it('reads an existing snapshot without creating a new search', async () => {
    const backend = client({ workflowSnapshotResults: vi.fn().mockResolvedValue({ snapshot_id: 'snapshot-1', data: [row], pagination: { next_cursor: 'next' } }), workflowSearchMedia: vi.fn() });
    const result = await executeTool('view_workflow_results', { source_kind: 'search_snapshot', source_id: 'snapshot-1', cursor: 'next', limit: 10 }, backend);
    expect(result.isError).not.toBe(true);
    expect(backend.workflowSnapshotResults).toHaveBeenCalledWith('snapshot-1', { cursor: 'next', limit: 10, include_download: false });
    expect(backend.workflowSearchMedia).not.toHaveBeenCalled();
  });

  it('returns only a private, ID-scoped playback grant and requires run membership for clips', async () => {
    const backend = client({ workflowMediaGrant: vi.fn().mockResolvedValue({ url: secret, expires_at: '2030-01-01T00:00:00Z', mime_type: 'video/mp4', start_time: 0, end_time: 5 }) });
    const result = await executeTool('play_workflow_media', { video_id: 'video-1', run_id: 'run-1', segment_id: 'seg-1' }, backend);
    expect(result._meta!.media).toMatchObject({ url: secret, start_time: 0, end_time: 5 });
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).not.toContain(secret);
    expect(backend.workflowMediaGrant).toHaveBeenCalledWith({ video_id: 'video-1', run_id: 'run-1', segment_id: 'seg-1' });
    const invalid = await executeTool('play_workflow_media', { video_id: 'video-1', segment_id: 'seg-1' }, backend);
    expect(invalid.isError).toBe(true);
    expect(backend.workflowMediaGrant).toHaveBeenCalledTimes(1);
  });
});

// Exercise the shipped handlers and canonical filtering without a browser.
const completePage = (rows: any[]) => ({ data: rows, pagination: { has_more: false, next_cursor: null } });
const cardRow = { ...row, metadata: { scene: 'Street', score: 7, vehicles: { visible: true } }, field_extraction_succeeded: true,
  links: { json: 'https://app.example/playground?video=video-1&run=run-1&metadata=json' } };
const laterRow = { ...cardRow, result_id: 'segment:seg-2:run-1', segment_id: 'seg-2', start_time: 9, end_time: 14, metadata: { scene: 'Park', score: 2, vehicles: { visible: false } } };
const videoRow = { ...cardRow, result_id: 'video:video-1:run-1', result_type: 'video', segment_id: undefined, metadata: { summary: 'City scenes', score: 8 } };
const cardPage = { ...runPage, selection_filter: { segment: { logic: 'and', conditions: [{ field: 'vehicles.visible', type: 'boolean', operator: 'equals', value: true }] } },
  filtered: completePage([cardRow]), unfiltered: completePage([cardRow, laterRow]) };
async function cardHarness(restored: any = null) {
  const elements = new Map<string, any>();
  function element() {
    const listeners = new Map<string, (...args: any[]) => unknown>();
    return {
      hidden: false, disabled: false, textContent: '', className: '', readyState: 1, currentTime: 0, duration: 20, src: '',
      addEventListener: (name: string, callback: (...args: any[]) => unknown) => listeners.set(name, callback),
      fire: async (name: string, event: any = { preventDefault() {} }) => listeners.get(name)?.(event),
      removeAttribute(name: string) { if (name === 'src') this.src = ''; }, getAttribute(name: string) { return name === 'src' ? this.src : undefined; },
      pause: vi.fn(), play: vi.fn(), load: vi.fn(),
    };
  }
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible',
    getElementById(id: string) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } });
  const defaultResponse = async (request: any): Promise<any> => request.name === 'play_workflow_media'
    ? request.arguments.intent === 'download'
      ? { _meta: { file: { url: secret, name: 'media.mp4', mimeType: 'video/mp4' } } }
      : { _meta: { media: { url: secret, expires_at: '2030-01-01T00:00:00Z' } } }
    : request.arguments.result_level === 'video'
      ? { _meta: { view: { ...cardPage, result_level: 'video', filtered: completePage([videoRow]), unfiltered: completePage([videoRow]) },
        context: { run: { run_id: 'run-1', status: 'completed', prompt_name: 'Scene engine' }, video: { video_id: 'video-1', title: 'Launch' }, video_level_output: { video_id: 'video-1', run_id: 'run-1', status: 'successful', metadata: videoRow.metadata } } } }
      : { _meta: { view: cardPage } };
  const callServerTool = vi.fn(defaultResponse);
  let studioProps: any;
  const views = { ...resultView, uploadAttachmentBatch, describeAttachmentFile, transferAttachmentFile, createAnalysisProgressController: (options: any) => createAnalysisProgressController({ ...options, visibility: document }), analysisResultView, readAnalysisVideo, processingView, metadataRevision, createStudioTransport, normalizeStudioResult, getSearchResultKey, readStudioState: () => restored, saveStudioState: vi.fn(), createStudioSearchHost: () => ({ update: (props: any) => {
    studioProps = props; const p = props.segmentProps;
    views.renderSegments(document.getElementById('rows'), p.rows, p.selected, p.onSelect, p.label, p.range, p.downloadMedia, p.downloadMetadata);
  }, unmount: vi.fn() }), renderMetadata: vi.fn(), renderSegments: vi.fn(), renderTimeline: vi.fn(), renderToolbar: vi.fn(), renderDownloads: vi.fn() };
  const pendingObservations: Array<{ resolve: (value: any) => void; signal?: AbortSignal }> = [];
  const observeCalls = vi.fn((_request: any, options: any) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    const pending = { resolve, signal }; pendingObservations.push(pending);
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  class App {
    callServerTool = (...args: any[]) => args[0].arguments?.observe ? observeCalls(args[0], args[1]) : callServerTool(...args);
    connect = vi.fn().mockResolvedValue(undefined);
    openLink = vi.fn().mockResolvedValue({});
    getHostCapabilities = vi.fn().mockReturnValue({ downloadFile: {} });
    downloadFile = vi.fn().mockResolvedValue({});
  }
  const source = readFileSync(new URL('../ui/results-card.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const app = await new AsyncFunction('App', 'document', ...Object.keys(views), `${source}\nreturn app;`)(App, document, ...Object.values(views));
  const receive = (value: any = cardPage, request: any = { video_id: 'video-1', view: 'both' }) => app.ontoolresult({ structuredContent: { ...value, source_kind: 'prompt_run', source_id: 'run-1' }, _meta: { view: value, viewRequest: request } });
  return { app, receive, callServerTool, observeCalls,
    emitProgress: async (value: any) => {
      const pending = pendingObservations.find(item => !item.signal?.aborted);
      if (!pending) throw new Error('No native observation is pending');
      pendingObservations.splice(pendingObservations.indexOf(pending), 1);
      pending.resolve({ _meta: { progress: value } });
      for (let i = 0; i < 80; i++) await Promise.resolve();
    },
    defaultResponse, ...views, studio: () => studioProps, control: document.getElementById,
    setVisibility: (value: string) => { document.visibilityState = value; document.dispatchEvent(new Event('visibilitychange')); },
    mediaCalls: () => callServerTool.mock.calls.filter(([request]) => request.name === 'play_workflow_media'),
    viewCalls: () => callServerTool.mock.calls.filter(([request]) => request.name === 'view_workflow_results'),
    toolbar: () => views.renderToolbar.mock.lastCall![1], tiles: () => views.renderSegments.mock.lastCall![1] };
}

describe('results card Studio behavior', () => {
  it('keeps the frozen search carousel while loading the exact hit execution and returning to Studio', async () => {
    const card = await cardHarness();
    await card.receive();
    card.studio().onSearch();
    expect(card.studio().mode).toBe('results');
    const hit = { ...laterRow, run_id: 'run-2', result_id: 'segment:seg-2:run-2', field_scores: { scene: 0.8 }, similarity_score: 0.8 };
    const sibling = { ...cardRow, run_id: 'run-2', result_id: 'segment:seg-1:run-2' };
    card.callServerTool.mockImplementation(async request => request.name === 'view_workflow_results' && request.arguments.source_id === 'run-2'
      ? { _meta: { view: { ...cardPage, run_id: 'run-2', selection_filter: null, selection_summary: { status: 'not_applicable' }, unfiltered: completePage(request.arguments.result_level === 'video' ? [] : [sibling, hit]), filtered: null }, context: { run: { run_id: 'run-2' }, video: { video_id: 'video-1' } } } }
      : card.defaultResponse(request));
    await card.studio().onSelectResult(hit, [cardRow, hit]);
    expect(card.studio().mode).toBe('result');
    expect(card.tiles()).toEqual([sibling, expect.objectContaining({ result_id: hit.result_id, field_scores: { scene: 0.8 } })]);
    expect(card.control('toolbar').hidden).toBe(true);
    expect(card.studio().state.selectedResultKey).toBe(getSearchResultKey(hit));
    await card.control('back-results').fire('click');
    expect(card.studio().mode).toBe('results');
    expect(card.studio().searchResults).toEqual([cardRow, hit]);
    card.studio().onExit();
    expect(card.studio().mode).toBe('studio');
    expect(card.studio().segmentProps.selected.result_id).toBe(cardRow.result_id);
  });

  it('opens search tool snapshots as a grid without requesting playback or starting another search', async () => {
    const card = await cardHarness();
    const value = { snapshot_id: 'snap', source_kind: 'search_snapshot', source_id: 'snap', data: [cardRow], pagination: {} };
    await card.app.ontoolresult({ structuredContent: value, _meta: { view: value, viewRequest: { query: 'street', video_ids: ['video-1'], filters: [{ field: 'score', operator: 'greater_than', value: 3 }] } } });
    expect(card.studio()).toMatchObject({ mode: 'results', searchMounted: true, state: { snapshotId: 'snap', query: 'street', semanticWindowFiltered: true } });
    expect(card.mediaCalls()).toHaveLength(0);
    expect(card.callServerTool).not.toHaveBeenCalled();
  });

  it('restores the exact ordinary Studio segment after host remount without changing the search snapshot', async () => {
    const restored = { mode: 'studio', selected: { video_id: 'video-1', run_id: 'run-1', segment_id: 'seg-2', result_id: laterRow.result_id }, search: { videoIds: ['video-1'], query: 'park', filters: [], snapshotId: 'saved-search', loadedPageCursors: [null] } };
    const card = await cardHarness(restored);
    await card.receive();
    expect(card.studio()).toMatchObject({ mode: 'studio', state: restored.search, segmentProps: { selected: laterRow } });
    expect(card.control('player').currentTime).toBe(9);
    expect(card.mediaCalls()).toHaveLength(1);
    expect(card.callServerTool.mock.calls.every(([request]) => request.name !== 'search_results')).toBe(true);
  });

  it('restores unprocessed media by video identity without inventing an execution', async () => {
    const card = await cardHarness({ mode: 'studio', selected: { video_id: 'fresh-video', result_id: 'media:fresh-video', media_type: 'video' }, search: { videoIds: null, query: '', filters: [] } });
    await card.receive();
    expect(card.studio().segmentProps.selected.video_id).toBe('fresh-video');
    expect(card.mediaCalls()[0][0].arguments).toEqual({ video_id: 'fresh-video' });
    expect(card.viewCalls()).toHaveLength(0);
  });

  it('preloads paused playback and video analysis, defaults engine matches on, and removes superseded controls', async () => {
    const card = await cardHarness();
    await card.receive();
    expect(card.control('player')).toMatchObject({ hidden: false, src: secret, currentTime: 4 });
    expect(card.control('player').play).not.toHaveBeenCalled();
    expect(card.toolbar()).toMatchObject({ mode: 'matches', visibleCount: 1, complete: true });
    expect(card.tiles()).toEqual([cardRow]);
    expect(card.viewCalls()).toEqual([[{ name: 'view_workflow_results', arguments: { source_kind: 'prompt_run', source_id: 'run-1', video_id: 'video-1', result_level: 'video', view: 'both', limit: 50, include_context: true } }]]);
    expect(card.renderMetadata).toHaveBeenCalledWith(card.control('video-analysis'), videoRow.metadata, videoRow.result_id, 'Video analysis');
    const html = readFileSync(new URL('../ui/results-card.html', import.meta.url), 'utf8');
    expect(html).toContain('id="studio-video-rail"');
    expect(html).not.toContain('video-picker');
    expect(html).not.toMatch(/id="(?:options|refresh|scope|level|play|artifacts)"|Retry playback|Metadata JSON/);
  });

  it('applies canonical text and nested conditions locally and preserves AND/OR semantics', async () => {
    const card = await cardHarness();
    await card.receive();
    const calls = card.callServerTool.mock.calls.length;
    card.toolbar().onModeChange('all');
    expect(card.tiles()).toEqual([cardRow, laterRow]);
    card.toolbar().onChange({ resultSearchTerm: 'park' });
    expect(card.tiles()).toEqual([laterRow]);
    card.toolbar().onChange({ resultSearchTerm: '', resultFilter: { segment: { logic: 'or', conditions: [
      { field: 'vehicles.visible', type: 'boolean', operator: 'equals', value: true },
      { field: 'score', type: 'number', operator: 'less_than', value: 3 },
    ] } } });
    expect(card.tiles()).toEqual([cardRow, laterRow]);
    card.toolbar().onChange({ resultFilter: { segment: { logic: 'and', conditions: [
      { field: 'vehicles.visible', type: 'boolean', operator: 'equals', value: true },
      { field: 'score', type: 'number', operator: 'less_than', value: 3 },
    ] } } });
    expect(card.tiles()).toEqual([]);
    expect(card.control('empty').hidden).toBe(false);
    expect(card.callServerTool).toHaveBeenCalledTimes(calls);
  });

  it('keeps zero matches truthful while loading the original media and allowing engine filtering to be disabled', async () => {
    const card = await cardHarness();
    const page = { ...cardPage, selection_summary: { status: 'ready', selected_segment_count: 0 }, filtered: completePage([]) };
    await card.receive(page);
    expect(card.toolbar().mode).toBe('matches');
    expect(card.tiles()).toEqual([]);
    expect(card.control('player').hidden).toBe(false);
    card.toolbar().onModeChange('all');
    expect(card.tiles()).toEqual([cardRow, laterRow]);
  });

  it('preloads all current-video pages from filtered-only input in canonical order without fetching other videos', async () => {
    const card = await cardHarness();
    const first = { ...cardRow, result_id: 'first', segment_id: 'seg-0', start_time: 0, end_time: 4 };
    const last = { ...laterRow, result_id: 'last', segment_id: 'seg-3', start_time: 14, end_time: 20 };
    const initial = { ...cardPage, unfiltered: null, filtered: completePage([cardRow]) };
    card.callServerTool.mockImplementation(async request => {
      if (request.name !== 'view_workflow_results' || request.arguments.result_level === 'video') return card.defaultResponse(request);
      return { _meta: { view: { ...cardPage, unfiltered: request.arguments.unfiltered_cursor
        ? completePage([laterRow, last]) : { data: [first, cardRow], pagination: { has_more: true, next_cursor: 'next-all' } } } } };
    });
    await card.receive(initial, { video_id: 'video-1', view: 'filtered' });
    card.toolbar().onModeChange('all');
    expect(card.tiles()).toEqual([first, cardRow, laterRow, last]);
    expect(card.viewCalls().every(([request]) => request.arguments.video_id === 'video-1')).toBe(true);
    expect(card.viewCalls().some(([request]) => request.arguments.unfiltered_cursor === 'next-all')).toBe(true);
    expect(card.toolbar().complete).toBe(true);
  });

  it('preserves authored multi-video tiles and loads another video only when selected', async () => {
    const card = await cardHarness();
    const other = { ...laterRow, video_id: 'video-2', result_id: 'other' };
    card.callServerTool.mockImplementation(async request => {
      if (request.arguments.video_id !== 'video-2' || request.name !== 'view_workflow_results') return card.defaultResponse(request);
      return { _meta: { view: { ...cardPage, result_level: 'video', filtered: completePage([]), unfiltered: completePage([]) }, context: { run: { run_id: 'run-1' }, video: { video_id: 'video-2', title: 'Other' }, video_level_output: null } } };
    });
    await card.receive({ ...cardPage, filtered: completePage([cardRow, other]), unfiltered: completePage([cardRow, other]) }, { view: 'both' });
    expect(card.tiles()).toContainEqual(other);
    expect(card.viewCalls().every(([request]) => request.arguments.video_id === 'video-1')).toBe(true);
    await card.renderSegments.mock.lastCall![3](other);
    expect(card.viewCalls().some(([request]) => request.arguments.video_id === 'video-2')).toBe(true);
  });

  it('retains a rapid same-row timeline seek while its one media grant is pending', async () => {
    const card = await cardHarness();
    let resolveMedia!: (value: unknown) => void;
    const pending = new Promise(resolve => { resolveMedia = resolve; });
    card.callServerTool.mockImplementation(request => request.name === 'play_workflow_media' ? pending : card.defaultResponse(request));
    const initial = card.receive();
    const first = card.renderTimeline.mock.lastCall![4](cardRow, 5.25);
    const last = card.renderTimeline.mock.lastCall![4](cardRow, 7.75);
    resolveMedia({ _meta: { media: { url: secret, expires_at: '2030-01-01T00:00:00Z' } } });
    await Promise.all([initial, first, last]);
    expect(card.mediaCalls()).toHaveLength(1);
    expect(card.control('player').currentTime).toBe(7.75);
    expect(card.control('player').play).not.toHaveBeenCalled();
  });

  it('uses canonical timeline clamping so filtered gaps never seek before the selected segment', () => {
    const later = { ...laterRow, start_time: 20, end_time: 25 };
    expect(resultView.resolveTimelineSelection([cardRow, later], 0)).toEqual({ row: cardRow, time: 4 });
    expect(resultView.resolveTimelineSelection([cardRow, later], 15)).toEqual({ row: cardRow, time: 9 });
    expect(resultView.resolveTimelineSelection([cardRow, later], 20)).toEqual({ row: later, time: 20 });
  });

  it.each(['image', undefined])('renders images from media type or grant MIME without video playback (%s)', async mediaType => {
    const card = await cardHarness();
    const image = { ...cardRow, media_type: mediaType };
    card.callServerTool.mockImplementation(request => request.name === 'play_workflow_media'
      ? Promise.resolve({ _meta: { media: { url: secret, mime_type: 'image/png', expires_at: '2030-01-01T00:00:00Z' } } }) : card.defaultResponse(request));
    await card.receive({ ...cardPage, filtered: completePage([image]), unfiltered: completePage([image]) });
    expect(card.control('image-preview')).toMatchObject({ hidden: false, src: secret });
    expect(card.control('player').hidden).toBe(true);
    expect(card.control('timeline').hidden).toBe(true);
    await card.app.onteardown();
    expect(card.control('image-preview')).toMatchObject({ hidden: true, src: '' });
  });

  it('automatically refreshes a failed media grant once, then exposes a real error without retry controls', async () => {
    const card = await cardHarness();
    await card.receive();
    await card.control('player').fire('error');
    await Promise.resolve(); await Promise.resolve();
    expect(card.mediaCalls()).toHaveLength(2);
    await card.control('player').fire('error');
    expect(card.mediaCalls()).toHaveLength(2);
    expect(card.control('status').textContent).toContain('could not load');
  });

  it('downloads selected clip, full video and tile metadata through user-clicked native host actions', async () => {
    const card = await cardHarness();
    await card.receive();
    await card.renderSegments.mock.lastCall![6](cardRow);
    expect(card.mediaCalls().at(-1)![0].arguments).toMatchObject({ video_id: 'video-1', run_id: 'run-1', segment_id: 'seg-1', intent: 'download' });
    await card.renderDownloads.mock.lastCall![1]();
    expect(card.mediaCalls().at(-1)![0].arguments).toEqual({ video_id: 'video-1', run_id: 'run-1', intent: 'download' });
    await card.renderSegments.mock.lastCall![7](cardRow);
    const resource = card.app.downloadFile.mock.lastCall![0].contents[0].resource;
    const output = JSON.parse(resource.text);
    expect(output.segment.metadata).toEqual(cardRow.metadata);
    expect(output.segment.segment_index).toBe(1);
    expect(resource.text).not.toContain('private-capability');
    expect(card.app.openLink).not.toHaveBeenCalled();
  });

  it('downloads all analysis and video synthesis independently of current filters and automatic artifact readiness', async () => {
    const card = await cardHarness();
    await card.receive({ ...cardPage, artifacts: [{ scope: 'all', state: 'unavailable' }] });
    card.toolbar().onChange({ resultSearchTerm: 'does not match' });
    const calls = card.callServerTool.mock.calls.length;
    await card.renderDownloads.mock.lastCall![2]();
    const resource = card.app.downloadFile.mock.lastCall![0].contents[0].resource;
    const output = JSON.parse(resource.text);
    expect(output.prompt_runs[0].segments.map((item: any) => item.segment_id)).toEqual(['seg-1', 'seg-2']);
    expect(output.prompt_runs[0].video_level_output.metadata).toEqual(videoRow.metadata);
    expect(output.export_info).toMatchObject({ result_scope: 'all', source_kind: 'prompt_run', source_id: 'run-1' });
    expect(card.callServerTool).toHaveBeenCalledTimes(calls);
    expect(resource.text).not.toContain('private-capability');
  });

  it('restores exact snapshot continuation through the shared transport without rerunning search', async () => {
    const page = { source_kind: 'search_snapshot', source_id: 'snapshot-1', data: [cardRow], warnings: ['limited'], pagination: { has_more: false, next_cursor: null, result_window: 2, truncated: true } };
    const call = vi.fn().mockResolvedValue({ _meta: { view: page } });
    const transport = createStudioTransport(call);
    const restored = await transport.page({ snapshotId: 'snapshot-1', cursor: 'snapshot-next' });
    expect(call).toHaveBeenCalledExactlyOnceWith('view_workflow_results', { source_kind: 'search_snapshot', source_id: 'snapshot-1', cursor: 'snapshot-next', limit: 50 }, undefined);
    expect(restored).toMatchObject({ results: [normalizeStudioResult(cardRow)], snapshotId: 'snapshot-1', truncated: true, warnings: ['limited'], nextCursor: null });
  });

  it('shares the rail and search catalog read without cancelling the other consumer', async () => {
    let complete!: (value: any) => void;
    const call = vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const transport = createStudioTransport(call);
    const controller = new AbortController();
    const first = transport.catalog({ signal: controller.signal });
    const second = transport.catalog({});
    controller.abort();
    complete({ _meta: { catalog: { videos: [{ video_id: 'v1' }], runs: [], fields: [], browse_targets: [] } } });
    const settled = await Promise.allSettled([first, second]);
    expect(settled[0].status).toBe('rejected');
    expect(settled[1]).toMatchObject({ status: 'fulfilled', value: { videos: [{ video_id: 'v1' }] } });
    expect(call).toHaveBeenCalledExactlyOnceWith('list_studio_scope', { limit: 100 }, undefined);
  });

  it('keeps one catalog read through rail/search invalidation and ignores image-only progress', async () => {
    let complete!: (value: any) => void;
    const call = vi.fn().mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const transport = createStudioTransport(call);
    const videos = [{ video_id: 'v1', processing_status: [{ run_id: 'r1', status: 'processing',
      readiness: { metadata_available: true, image_search_ready: false }, enrichment: { image: { completed: 0 } } }] }];
    expect(transport.updateProgress?.(videos as any)).toBe(true);
    const rail = transport.catalog({});
    transport.invalidateCatalog?.();
    const search = transport.catalog({});
    complete({ _meta: { catalog: { videos: [], runs: [], fields: [], browse_targets: [] } } });
    await Promise.all([rail, search]);
    expect(call).toHaveBeenCalledTimes(1);
    const images = structuredClone(videos);
    images[0].processing_status[0].enrichment.image.completed = 1;
    expect(transport.updateProgress?.(images as any)).toBe(false);
    expect(transport.updateProgress?.(images as any)).toBe(false);
    await transport.catalog({});
    expect(call).toHaveBeenCalledTimes(1);
    images[0].processing_status[0].readiness.image_search_ready = true;
    expect(transport.updateProgress?.(images as any)).toBe(true);
    const ready = transport.catalog({});
    complete({ _meta: { catalog: { videos: [], runs: [], fields: [], browse_targets: [] } } });
    await ready;
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('reuses an uncertain semantic attempt key, then assigns a new key after success', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValue({ _meta: { view: { snapshot_id: 'snapshot-1', data: [], pagination: {} } } });
    const transport = createStudioTransport(call);
    const request = { videoIds: ['v2', 'v1'], query: 'scene', filters: [] };
    await expect(transport.search(request)).rejects.toThrow('disconnected');
    await transport.search(request);
    await transport.search(request);
    expect(call.mock.calls[0][1]).toEqual(call.mock.calls[1][1]);
    expect(call.mock.calls[2][1].idempotency_key).not.toBe(call.mock.calls[1][1].idempotency_key);
    expect(call.mock.calls[1][1]).toMatchObject({ video_ids: ['v1', 'v2'], query: 'scene', limit: 50 });
  });

  it('caps eager paging, reports partial loaded counts, and reads the remainder only for all-metadata download', async () => {
    const card = await cardHarness();
    let pageNumber = 0;
    const initial = { ...cardPage, filtered: null, unfiltered: null, selection_filter: null, selection_summary: { status: 'not_applicable' } };
    card.callServerTool.mockImplementation(async request => {
      if (request.name !== 'view_workflow_results') return card.defaultResponse(request);
      if (request.arguments.result_level === 'video') {
        const response = await card.defaultResponse(request);
        response._meta.view.selection_filter = null;
        response._meta.view.selection_summary = { status: 'not_applicable' };
        return response;
      }
      const item = { ...cardRow, result_id: `item-${++pageNumber}`, segment_id: `loaded-seg-${pageNumber}` };
      const page = { data: [item], pagination: { has_more: pageNumber < 22, next_cursor: pageNumber < 22 ? `page-${pageNumber}` : null } };
      return Promise.resolve({ _meta: { view: { ...initial, unfiltered: page } } });
    });
    await card.receive({ ...initial, unfiltered: { data: [cardRow], pagination: { has_more: true, next_cursor: 'initial' } } });
    expect(card.viewCalls()).toHaveLength(20);
    expect(card.toolbar().complete).toBe(false);
    await card.renderDownloads.mock.lastCall![2]();
    const output = JSON.parse(card.app.downloadFile.mock.lastCall![0].contents[0].resource.text);
    expect(output.prompt_runs[0].segments).toHaveLength(23);
    expect(card.toolbar().complete).toBe(true);
  });

  it('does not label failed or repeating pagination as a complete metadata download', async () => {
    const card = await cardHarness();
    const initial = { ...cardPage, unfiltered: { data: [cardRow], pagination: { has_more: true, next_cursor: 'same' } } };
    card.callServerTool.mockImplementation(request => request.name === 'play_workflow_media' ? card.defaultResponse(request)
      : Promise.resolve({ _meta: { view: initial } }));
    await card.receive(initial);
    await card.renderDownloads.mock.lastCall![2]();
    expect(card.app.downloadFile).not.toHaveBeenCalled();
    expect(card.control('status').className).toBe('error');
    expect(card.toolbar().complete).toBe(false);
  });

  it('opens the existing metadata destination on unsupported hosts and never auto-falls back after native cancellation', async () => {
    const card = await cardHarness();
    await card.receive();
    card.app.getHostCapabilities.mockReturnValue({});
    await card.renderDownloads.mock.lastCall![2]();
    expect(card.app.openLink).toHaveBeenCalledExactlyOnceWith({ url: cardRow.links.json });
    card.app.openLink.mockClear(); card.app.getHostCapabilities.mockReturnValue({ downloadFile: {} });
    card.app.downloadFile.mockResolvedValueOnce({ isError: true });
    await card.renderDownloads.mock.lastCall![2]();
    expect(card.app.openLink).not.toHaveBeenCalled();
    expect(card.control('status').textContent).toContain('cancelled');
  });
});

const liveAnalysis = (revision: string, options: any = {}) => ({
  analysis_id: 'anl-current', status: 'processing', stage: 'processing', message: 'One video is ready; two are processing.',
  scope: { type: 'index', index_id: 'index-1' }, progress: { total: 3, imported: 3, completed: 1, failed: 0, processing: 2 },
  files: [{ name: 'Launch', status: 'completed' }], next_action: { type: 'continue_polling', after_seconds: 15 },
  results: { revision, included_videos: 1, final: false, download_url: null, data: [{
    video_id: 'video-1', name: 'Launch', media_type: 'video', selection: { status: 'not_applicable' },
    video_level: { metadata: { summary: 'Ready output' } }, segments: [{ segment_id: 'seg-1', start_time: 4, end_time: 9, metadata: { scene: 'Ready segment' } }],
  }] }, ...options,
});

const nativeProgress = (version: string, options: any = {}) => ({
  analysis_id: 'anl-current', import_id: null, run_id: 'anl-current', version, idle: false,
  scope: { type: 'index', index_id: 'index-1', video_ids: ['video-1'] },
  records: [
    { kind: 'run', id: 'anl-current', version, state: { run_id: 'anl-current', status: 'processing' } },
    { kind: 'video', id: 'video-1', version, state: { video_id: 'video-1', title: 'Launch', media_type: 'video',
      processing_status: [{ run_id: 'anl-current', status: 'processing', activity: { phase: 'extracting' },
        total_parts: 2, completed_parts: 1, failed_parts: 0,
        result_revisions: { metadata: version, segments: version },
        readiness: { metadata_available: true, assets_available: false, text_search_ready: false, image_search_ready: false },
        enrichment: { image: { status: 'pending', completed: 0, total: 2, failed: 0 } }, segments: [],
      }] } },
  ], ...options,
});

it('observes import-only work through the native adapter without requesting analysis metadata', async () => {
  const card = await cardHarness();
  try {
    const importing = { import_id: 'imp-current', status: 'importing', stage: 'importing', progress: { imported: 0 } };
    await card.app.ontoolresult({ _meta: { import: importing } });
    expect(card.observeCalls).toHaveBeenCalledWith({ name: 'read_analysis', arguments: { import_id: 'imp-current', observe: true, wait_seconds: 25 } }, expect.any(Object));
    await card.emitProgress({ analysis_id: 'imp-current', import_id: 'imp-current', run_id: null, version: '1', idle: true, scope: { type: 'playground', video_ids: [] },
      records: [{ kind: 'import_job', id: 'imp-current', version: '1', state: { phase: 'completed', status: 'completed', progress: { imported: 2, total_files: 2 } } }] });
    expect(card.control('analysis-stage').textContent).toBe('completed');
    expect(card.control('analysis-counts').textContent).toBe('2 of 2 received');
    expect(card.callServerTool).not.toHaveBeenCalled();
    expect(card.observeCalls).toHaveBeenCalledTimes(1);
  } finally { await card.app.onteardown(); }
});
describe('analysis widget native lifecycle', () => {
  it('adds later accepted parts and summary without resetting playback, then keeps observing independent enrichment', async () => {
    const card = await cardHarness(); let current = liveAnalysis('partial');
    card.callServerTool.mockImplementation(async request => request.name === 'read_analysis' ? { _meta: { analysis: current } } : card.defaultResponse(request));
    try {
      await card.app.ontoolresult({ _meta: { analysis: current } });
      await card.emitProgress(nativeProgress('part-1'));
      expect(card.tiles()).toHaveLength(1);
      expect(card.control('analysis-files').textContent).toContain('1/2 parts');
      card.control('player').currentTime = 7;
      const selected = card.studio().segmentProps.selected.result_id;
      const mediaCalls = card.mediaCalls().length;
      current = liveAnalysis('complete');
      current.results.data[0].segments.push({ segment_id: 'seg-2', start_time: 9, end_time: 14, metadata: { scene: 'Later part' } });
      current.results.data[0].video_level.metadata = { summary: 'Final summary' };
      const finishing = nativeProgress('part-2'); finishing.records[0].state.status = 'completed';
      finishing.records[1].state.processing_status[0].completed_parts = 2;
      await card.emitProgress(finishing);
      expect(card.tiles()).toHaveLength(2);
      expect(card.control('player').currentTime).toBe(7);
      expect(card.studio().segmentProps.selected.result_id).toBe(selected);
      expect(card.mediaCalls()).toHaveLength(mediaCalls);
      expect(card.renderMetadata.mock.calls.some(call => call[3] === 'Video analysis' && call[1].summary === 'Final summary')).toBe(true);
      expect(card.control('analysis-message').textContent).toContain('Media and search updates are continuing');
      const reads = card.callServerTool.mock.calls.filter(([request]) => request.name === 'read_analysis').length;
      const assets = structuredClone(finishing); assets.version = 'assets';
      assets.records[1].state.processing_status[0].readiness.assets_available = true;
      assets.records[1].state.processing_status[0].result_revisions.assets = 'poster-1';
      assets.records[1].state.processing_status[0].enrichment.image.completed = 1;
      await card.emitProgress(assets);
      expect(card.control('analysis-files').textContent).toContain('images 1/2');
      expect(card.tiles().every(row => row.assets_revision === 'poster-1')).toBe(true);
      expect(card.callServerTool.mock.calls.filter(([request]) => request.name === 'read_analysis')).toHaveLength(reads);
      const final = structuredClone(assets); final.version = 'settled'; final.idle = true;
      final.records[1].state.processing_status[0].enrichment.image.completed = 2;
      await card.emitProgress(final);
      const observations = card.observeCalls.mock.calls.length;
      card.setVisibility('hidden'); card.setVisibility('visible');
      expect(card.observeCalls).toHaveBeenCalledTimes(observations);
      expect(card.control('analysis-message').textContent).toBe('Processing updates complete.');
    } finally { await card.app.onteardown(); }
  });

  it('repaints native progress without invalidating Search on timeouts, heartbeats or asset/image changes', async () => {
    const card = await cardHarness();
    card.callServerTool.mockImplementation(async request => request.name === 'read_analysis'
      ? { _meta: { analysis: liveAnalysis('accepted') } } : card.defaultResponse(request));
    try {
      await card.app.ontoolresult({ _meta: { analysis: liveAnalysis('accepted') } });
      const first = nativeProgress('accepted');
      await card.emitProgress(first);
      const key = card.studio().refreshKey;
      await card.emitProgress(structuredClone(first));
      expect(card.studio().refreshKey).toBe(key);
      const heartbeat = structuredClone(first); heartbeat.version = 'heartbeat';
      await card.emitProgress(heartbeat);
      expect(card.studio().refreshKey).toBe(key);
      expect(card.studio().railRefreshKey).toBe('heartbeat');
      const image = structuredClone(heartbeat); image.version = 'image';
      image.records[1].state.processing_status[0].result_revisions.assets = 'poster';
      image.records[1].state.processing_status[0].enrichment.image.completed = 1;
      await card.emitProgress(image);
      expect(card.studio().refreshKey).toBe(key);
      expect(card.callServerTool.mock.calls.filter(([request]) => request.name === 'read_analysis')).toHaveLength(1);
      const ready = structuredClone(image); ready.version = 'search-ready';
      ready.records[1].state.processing_status[0].readiness.image_search_ready = true;
      await card.emitProgress(ready);
      expect(card.studio().refreshKey).toBe(key + 1);
    } finally { await card.app.onteardown(); }
  });

  it('reuses exact-revision complete metadata on A to B to A, but refreshes changed metadata and isolates runs', async () => {
    const card = await cardHarness();
    card.callServerTool.mockImplementation(async request => request.name === 'read_analysis'
      ? { _meta: { analysis: { ...liveAnalysis('body'), analysis_id: request.arguments.analysis_id,
        results: { ...liveAnalysis('body').results, data: [{ ...liveAnalysis('body').results.data[0], video_id: request.arguments.video_id }] } } } }
      : card.defaultResponse(request));
    const reads = () => card.callServerTool.mock.calls.filter(([request]) => request.name === 'read_analysis');
    try {
      await card.app.ontoolresult({ _meta: { analysis: liveAnalysis('accepted') } });
      const first = nativeProgress('accepted'); first.scope.video_ids.push('video-2');
      const second = structuredClone(first.records[1]); second.id = 'video-2'; second.state.video_id = 'video-2'; first.records.push(second);
      await card.emitProgress(first);
      await card.studio().onSelectVideo({ video_id: 'video-2', title: 'B' });
      const assets = structuredClone(first); assets.version = 'assets';
      assets.records[1].state.processing_status[0].result_revisions.assets = 'poster-ready';
      await card.emitProgress(assets);
      await card.studio().onSelectVideo({ video_id: 'video-1', title: 'A' });
      expect(reads()).toHaveLength(2);
      expect(card.tiles().find(row => row.video_id === 'video-1').assets_revision).toBe('poster-ready');
      await card.studio().onSelectVideo({ video_id: 'video-2', title: 'B' });
      const newer = structuredClone(first); newer.version = 'later';
      newer.records[1].state.processing_status[0].result_revisions.metadata = 'accepted-later';
      await card.emitProgress(newer);
      expect(reads()).toHaveLength(2);
      await card.studio().onSelectVideo({ video_id: 'video-1', title: 'A' });
      expect(reads()).toHaveLength(3);
      const old = { ...cardRow, run_id: 'run-old', result_id: 'segment:seg-1:run-old' };
      await card.studio().onSelectResult(old, [old]);
      expect(reads()).toHaveLength(4);
      expect(reads().at(-1)![0].arguments.analysis_id).toBe('run-old');
      await card.studio().onSelectVideo({ video_id: 'video-1', title: 'A' });
      expect(reads()).toHaveLength(4);
      expect(card.studio().segmentProps.selected.run_id).toBe('anl-current');
    } finally { await card.app.onteardown(); }
  });

  it('hydrates the known asset revision when selecting another video after native observation is idle', async () => {
    const card = await cardHarness();
    card.callServerTool.mockImplementation(async request => request.name === 'read_analysis'
      ? { _meta: { analysis: { ...liveAnalysis('settled'), results: { ...liveAnalysis('settled').results,
        data: [{ ...liveAnalysis('settled').results.data[0], video_id: request.arguments.video_id, segments: [{ segment_id: `${request.arguments.video_id}-segment`, start_time: 0, end_time: 5, metadata: { scene: 'Scene' } }] }] } } } }
      : card.defaultResponse(request));
    try {
      await card.app.ontoolresult({ _meta: { analysis: liveAnalysis('settled') } });
      const final = nativeProgress('settled', { idle: true });
      final.scope.video_ids.push('video-2');
      final.records[1].state.processing_status[0].result_revisions.assets = 'assets-ready';
      const second = structuredClone(final.records[1]); second.id = 'video-2'; second.state.video_id = 'video-2'; final.records.push(second);
      await card.emitProgress(final);
      expect(card.observeCalls).toHaveBeenCalledTimes(1);
      await card.studio().onSelectVideo({ video_id: 'video-2', title: 'Second' });
      expect(card.studio().segmentProps.selected.video_id).toBe('video-2');
      expect(card.tiles().find(row => row.video_id === 'video-2').assets_revision).toBe('assets-ready');
      expect(card.observeCalls).toHaveBeenCalledTimes(1);
    } finally { await card.app.onteardown(); }
  });

  it('restores the same accepted segment in a mounted analysis view without relying on a host-specific API', async () => {
    const restored = { mode: 'studio', selected: { video_id: 'video-1', run_id: 'anl-current', segment_id: 'seg-2', result_id: 'segment:seg-2:anl-current' }, search: { videoIds: null, query: '', filters: [] } };
    const card = await cardHarness(restored);
    const current = liveAnalysis('ready');
    current.results.data[0].segments.push({ segment_id: 'seg-2', start_time: 9, end_time: 14, metadata: { scene: 'Selected later part' } });
    card.callServerTool.mockImplementation(async request => request.name === 'read_analysis' ? { _meta: { analysis: current } } : card.defaultResponse(request));
    try {
      await card.app.ontoolresult({ _meta: { analysis: current } });
      await card.emitProgress(nativeProgress('ready'));
      expect(card.studio().segmentProps.selected).toMatchObject({ segment_id: 'seg-2', run_id: 'anl-current' });
      expect(card.callServerTool.mock.calls.filter(([request]) => request.name === 'read_analysis')).toHaveLength(1);
    } finally { await card.app.onteardown(); }
  });

  it('opens the original before metadata and pins an active video instead of selecting an older completed run', async () => {
    const card = await cardHarness();
    try {
      await card.app.ontoolresult({ _meta: { analysis: liveAnalysis('empty', { results: { included_videos: 0 } }) } });
      const active = nativeProgress('preparing'); active.records[1].state.processing_status[0].readiness.metadata_available = false;
      await card.emitProgress(active);
      expect(card.mediaCalls()).toHaveLength(1);
      expect(card.callServerTool.mock.calls.some(([request]) => request.name === 'read_analysis')).toBe(false);
      expect(card.studio().segmentProps.selected.run_id).toBe('anl-current');
      await card.studio().onSelectVideo({ video_id: 'video-1', title: 'Launch' });
      expect(card.callServerTool.mock.calls.some(([request]) => request.name === 'list_studio_scope')).toBe(false);
      expect(card.studio().segmentProps.selected.run_id).toBe('anl-current');
    } finally { await card.app.onteardown(); }
  });

  it('renews the included JSON download only when the user clicks download', async () => {
    const card = await cardHarness();
    const value = liveAnalysis('rev-1', { status: 'completed', next_action: { type: 'download_and_answer' } });
    try {
      card.callServerTool.mockImplementation(async request => request.name === 'read_analysis' ? { _meta: { analysis: value } } : card.defaultResponse(request));
      await card.app.ontoolresult({ structuredContent: value, _meta: { analysis: value } });
      await card.emitProgress(nativeProgress('ready'));
      expect(card.callServerTool.mock.calls.some(([request]) => request.arguments.intent === 'download')).toBe(false);
      card.callServerTool.mockImplementation(async request => request.name === 'read_analysis'
        ? { _meta: { analysis: { results: { download_url: 'https://api.example/analyses/anl-current/results.json?token=grant' } } } }
        : card.defaultResponse(request));
      const downloadAll = card.renderDownloads.mock.lastCall![2];
      await downloadAll();
      expect(card.callServerTool).toHaveBeenLastCalledWith({ name: 'read_analysis', arguments: { analysis_id: 'anl-current', video_id: 'video-1', intent: 'download' } }, undefined);
      expect(card.app.downloadFile).toHaveBeenCalledWith({ contents: [expect.objectContaining({ type: 'resource_link', uri: expect.stringContaining('/results.json?token=grant') })] });
    } finally { await card.app.onteardown(); }
  });

  it('uses the scoped index in host searches and reads published bundles for gallery browsing', async () => {
    const call = vi.fn(async (name: string, args: any) => name === 'list_studio_scope'
      ? { _meta: { catalog: { videos: [{ video_id: 'video-1' }], runs: [], browse_targets: [{ run_id: 'anl-current', video_id: 'video-1' }], fields: [] } } }
      : name === 'read_analysis' ? { _meta: { analysis: liveAnalysis('r1') } }
      : { _meta: { view: { snapshot_id: 'snap', data: [], pagination: {} } } });
    const transport = createStudioTransport(call, { type: 'index', index_id: 'index-a' });
    await transport.catalog({});
    expect(call).toHaveBeenCalledWith('list_studio_scope', { limit: 100, index_id: 'index-a' }, undefined);
    const pages = await transport.browse({ targets: [{ run_id: 'anl-current', video_id: 'video-1' }] });
    expect(pages[0].results).toHaveLength(1);
    expect(call).toHaveBeenCalledWith('read_analysis', { analysis_id: 'anl-current', video_id: 'video-1', detail: 'full' }, undefined);
    await transport.search({ videoIds: ['video-1'], query: 'street', filters: [{ field: 'colour', type: 'string', operator: 'equals', value: 'blue' }] });
    expect(call).toHaveBeenLastCalledWith('view_workflow_results', expect.objectContaining({ action: 'search', container_index_id: 'index-a', query: 'street', filters: [{ field: 'colour', operator: 'equals', value: 'blue' }] }), undefined);
  });
});


it('keeps native upload and import-to-processing updates in the same analysis widget', async () => {
  vi.useFakeTimers();
  const card = await cardHarness();
  const fetch = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    if (url === 'https://api.example/upload') { const body=JSON.parse(String(init.body)); return Response.json({job:{job_id:'batch'},upload:{transport:'resumable',url:'https://storage.googleapis.com/upload/one',offset:0,total_bytes:body.size_bytes,chunk_size:8388608}}); }
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const initial = liveAnalysis('empty', { stage: 'awaiting_upload', status: 'awaiting_upload', results: { revision: 'empty', included_videos: 0, final: false }, next_action: { type: 'request_input' } });
    const importing = { ...initial, stage: 'importing', status: 'importing', message: 'Files received.', progress: { total: 1, imported: 1, completed: 0, processing: 1 }, next_action: { type: 'continue_polling' } };
    card.callServerTool.mockImplementation(async () => ({ _meta: { analysis: importing } }));
    await card.app.ontoolresult({ structuredContent: initial, _meta: { analysis: initial, upload: { url: 'https://api.example/upload', complete_url: 'https://api.example/complete', token: 'upload-token', max_files: 5, accept: 'video/*' } } });
    card.control('files').files = [new File(['video'], 'launch.mp4', { type: 'video/mp4' })];
    await card.control('files').fire('change');
    await card.control('upload-form').fire('submit');
    expect(fetch).toHaveBeenCalledTimes(4);
    const storageRequest=fetch.mock.calls.find(([url]) => url.startsWith('https://storage.googleapis.com/'))![1];
    expect(storageRequest.headers).toEqual({'Content-Range':'bytes 0-4/5'});
    expect(storageRequest.credentials).toBe('omit');
    expect(await (storageRequest.body as Blob).text()).toBe('video');
    expect(card.control('upload-form').hidden).toBe(true);
    await card.emitProgress({ ...nativeProgress('importing'), run_id: null, records: [{ kind: 'import_job', id: 'anl-current', version: 'importing', state: { status: 'importing', phase: 'importing', progress: { imported: 1, total_files: 1 } } }] });
    expect(card.control('analysis-stage').textContent).toBe('importing');
    const processing = nativeProgress('processing'); processing.records[1].state.processing_status[0].readiness.metadata_available = false;
    await card.emitProgress(processing);
    expect(card.control('analysis-stage').textContent).toBe('processing');
    expect(card.observeCalls).toHaveBeenLastCalledWith({ name: 'read_analysis', arguments: { analysis_id: 'anl-current', observe: true, wait_seconds: 25, after_version: 'processing' } }, expect.any(Object));
  } finally { await card.app.onteardown(); vi.unstubAllGlobals(); vi.useRealTimers(); }
});

it('preserves an explicit older execution when the active analysis progresses', async () => {
  vi.useFakeTimers();
  const card = await cardHarness();
  try {
    const current = liveAnalysis('current');
    const older = { ...liveAnalysis('older'), analysis_id: 'run-old', status: 'completed' };
    card.callServerTool.mockImplementation(async request => request.name === 'read_analysis' ? { _meta: { analysis: request.arguments.analysis_id === 'run-old' ? older : current } } : card.defaultResponse(request));
    await card.app.ontoolresult({ structuredContent: current, _meta: { analysis: current } });
    await card.emitProgress(nativeProgress('current'));
    const hit = { ...cardRow, run_id: 'run-old', result_id: 'segment:seg-1:run-old' };
    await card.studio().onSelectResult(hit, [hit]);
    card.control('player').currentTime = 6;
    await card.emitProgress(nativeProgress('later'));
    expect(card.studio().segmentProps.selected.run_id).toBe('run-old');
    expect(card.control('player').currentTime).toBe(6);
    expect(card.studio().mode).toBe('result');
  } finally { await card.app.onteardown(); vi.useRealTimers(); }
});

describe('unified picker batch recovery', () => {
  const active: any[] = [];
  afterEach(async () => { for (const card of active.splice(0)) await card.app.onteardown(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function unifiedPicker(count: number) {
    const card = await cardHarness(); active.push(card);
    const initial = liveAnalysis('empty', { stage: 'awaiting_upload', status: 'awaiting_upload', results: { revision: 'empty', included_videos: 0, final: false }, next_action: { type: 'request_input' } });
    card.callServerTool.mockResolvedValue({ _meta: { analysis: { ...initial, stage: 'importing', next_action: { type: 'continue_polling' } } } });
    await card.app.ontoolresult({ _meta: { analysis: initial, upload: { url: 'https://api.example/files', complete_url: 'https://api.example/complete', token: 'grant', max_files: 8 } } });
    card.control('files').files = Array.from({ length: count }, (_, index) => new File([`video-${index}`], `${index}.mp4`));
    await card.control('files').fire('change');
    return { card, submit: () => card.control('upload-form').fire('submit') };
  }
  it('rejects a ninth selection without sending bytes', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const ui = await unifiedPicker(9);
    await ui.submit();
    expect(fetch).not.toHaveBeenCalled();
    expect(ui.card.control('upload-message').textContent).toBe('Choose no more than 8 files.');
  });

  it('resumes expired finalization with a public get_analysis grant and keeps private refresh grant-free', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async (url: string) => Response.json(url.endsWith('/files') ? {job:{job_id:'batch'},upload:null} : {}, {status:url === 'https://api.example/complete' ? 401 : 200}));
    vi.stubGlobal('fetch', fetch);
    const ui = await unifiedPicker(2);
    const awaiting = liveAnalysis('empty', { stage: 'awaiting_upload', status: 'awaiting_upload', results: { revision: 'empty', included_videos: 0, final: false }, next_action: { type: 'request_input' } });
    const renewedGrant = { url: 'https://api.example/files', complete_url: 'https://api.example/complete', token: 'renewed-private-grant', max_files: 8, accept: 'video/*' };
    const publicAnalysis = { ...awaiting, results: { included_videos: 0, final: false } };
    const backend = client({
      mcpTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(publicAnalysis) }], structuredContent: publicAnalysis, _meta: { analysis: awaiting, upload: renewedGrant } }),
      getAnalysis: vi.fn().mockResolvedValue(awaiting),
    });
    ui.card.callServerTool.mockImplementation(request => executeTool(request.name, request.arguments, backend));
    try {
      await ui.submit();
      expect(ui.card.control('upload-message').textContent).toBe('This upload session expired. Refresh this analysis to continue.');
      expect(ui.card.control('upload-form').hidden).toBe(false);
      const initializedFiles = new Map(fetch.mock.calls.filter(([url]) => url.endsWith('/files')).map(([, init]) => {
        const descriptor = JSON.parse(init.body); return [descriptor.file_name, descriptor.file_id];
      }));
      const uploadedIds = ['0.mp4', '1.mp4'].map(name => initializedFiles.get(name));
      expect(uploadedIds).toHaveLength(2);
      expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).file_ids).toEqual(uploadedIds);

      expect(backend.getAnalysis).not.toHaveBeenCalled();
      expect(ui.card.observeCalls).toHaveBeenCalledTimes(1);
      expect(backend.mcpTool).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(ui.card.control('upload-form').hidden).toBe(false);

      const renewal = await executeTool('get_analysis', { analysis_id: 'anl-current', wait_seconds: 0 }, backend, { transportMode: 'http', authenticationKind: 'oauth' });
      expect(renewal.isError).not.toBe(true);
      expect(renewal._meta?.upload).toEqual(renewedGrant);
      expect(renewal._meta?.analysis).not.toHaveProperty('upload');
      expect(JSON.stringify(renewal.content) + JSON.stringify(renewal.structuredContent)).not.toContain(renewedGrant.token);
      await ui.card.app.ontoolresult(renewal);
      expect(ui.card.control('selection').textContent).toBe('2 files selected');
      expect(ui.card.control('files').accept).toBe('video/*');

      const importing = { ...awaiting, stage: 'importing', status: 'importing', next_action: { type: 'continue_polling' } };
      vi.mocked(backend.getAnalysis).mockResolvedValue(importing);
      fetch.mockResolvedValue(new Response('{}', { status: 200 }));
      await ui.submit();
      expect(fetch).toHaveBeenCalledTimes(6); // Received bytes are retained; only batch finalization is retried.
      expect(fetch.mock.calls.at(-1)).toEqual([renewedGrant.complete_url, expect.objectContaining({
        credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${renewedGrant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ file_ids: uploadedIds }),
      })]);
      expect(ui.card.control('upload-form').hidden).toBe(true);
      await ui.card.emitProgress({ ...nativeProgress('importing'), run_id: null, records: [{ kind: 'import_job', id: 'anl-current', version: 'importing', state: { status: 'importing', phase: 'importing' } }] });
      expect(ui.card.control('analysis-stage').textContent).toBe('importing');
      expect(backend.getAnalysis).not.toHaveBeenCalled();
      expect(vi.mocked(backend.getAnalysis).mock.calls.every(([, options]) => options?.include_download === false && !('include_upload' in options))).toBe(true);
      expect(backend.mcpTool).toHaveBeenCalledTimes(1);
      expect(ui.card.callServerTool.mock.calls.every(([request]) => request.name === 'read_analysis' && request.arguments.analysis_id === 'anl-current')).toBe(true);
    } finally { await ui.card.app.onteardown(); vi.useRealTimers(); }
  });

  it.each([false, true])('settles started uploads and completes selection-ordered IDs on retry (reversed hashes: %s)', async reverseHashes => {
    let fail!: (response: Response) => void;
    let finish!: (response: Response) => void;
    const first = new Promise<Response>(resolve => { fail = resolve; });
    const second = new Promise<Response>(resolve => { finish = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockImplementation(async () => Response.json({job:{job_id:'batch'},upload:null}));
    vi.stubGlobal('fetch', fetch);
    const ui = await unifiedPicker(8);
    let releaseFirstHash!: () => void;
    if (reverseHashes) {
      const gate = new Promise<void>(resolve => { releaseFirstHash = resolve; });
      const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
        if (new TextDecoder().decode(data) === 'video-0') await gate;
        return nativeDigest(algorithm, data);
      });
    }
    const pending = ui.submit();
    if (reverseHashes) {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(JSON.parse(fetch.mock.calls[0]![1].body).file_name).toBe('1.mp4');
      releaseFirstHash();
    }
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const ids = fetch.mock.calls.map(([, init]) => JSON.parse(init.body).file_id);
    fail(new Response('{}', { status: 500 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.card.control('submit').disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    finish(Response.json({job:{job_id:'batch'},upload:null}));
    await pending;
    expect(ui.card.control('submit').disabled).toBe(false);
    expect(ui.card.callServerTool).not.toHaveBeenCalled();
    fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/complete') ? { job_id: 'batch', status: 'pending' } : {job:{job_id:'batch'},upload:null}
    ), { status: 200 }));
    await ui.submit();
    const retried = fetch.mock.calls.slice(2).filter(([url]) => url.endsWith('/files')).map(([, init]) => JSON.parse(init.body).file_id);
    expect(retried).toHaveLength(7);
    expect(retried).toContain(ids[0]);
    expect(retried).not.toContain(ids[1]);
    const completion = fetch.mock.calls.filter(([url]) => url === 'https://api.example/complete');
    expect(completion).toHaveLength(1);
    const selectedIds = new Map<string, string>();
    for (const [, init] of fetch.mock.calls.filter(([url]) => url.endsWith('/files'))) {
      const descriptor = JSON.parse(init.body);
      if (selectedIds.has(descriptor.file_name)) expect(descriptor.file_id).toBe(selectedIds.get(descriptor.file_name));
      selectedIds.set(descriptor.file_name, descriptor.file_id);
    }
    expect(selectedIds.size).toBe(8);
    expect(JSON.parse(completion[0]![1].body).file_ids).toEqual(
      Array.from({length:8}, (_, index) => selectedIds.get(`${index}.mp4`)),
    );
    expect(ui.card.observeCalls).toHaveBeenCalledExactlyOnceWith({ name: 'read_analysis', arguments: { analysis_id: 'anl-current', observe: true, wait_seconds: 25 } }, expect.any(Object));
    expect(ui.card.callServerTool).not.toHaveBeenCalled();
  });
});

describe('hosted picker native storage acknowledgments', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('uses partial confirmed Range, bounds request size, and never sends the control bearer to storage', async () => {
    const size = 10 * 1024 * 1024;
    const file = new File([new Uint8Array(size)], 'lecture.mp4', {type:'video/mp4'});
    const progress: number[] = [];
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', {status:308,headers:{Range:'bytes=0-4194303'}}))
      .mockResolvedValueOnce(new Response('', {status:200}));
    vi.stubGlobal('fetch',fetch);
    await transferAttachmentFile(file,{transport:'resumable',url:'https://storage.googleapis.com/upload/session',offset:0,total_bytes:size,chunk_size:32*1024*1024},new AbortController().signal,value=>progress.push(value));
    expect(progress).toEqual([0,4194304,size]);
    expect(fetch.mock.calls.map(([,request])=>request.headers)).toEqual([
      {'Content-Range':`bytes 0-8388607/${size}`},{'Content-Range':`bytes 4194304-${size-1}/${size}`},
    ]);
    expect(fetch.mock.calls.map(([,request])=>request.body.size)).toEqual([8388608,6291456]);
    for(const [,request] of fetch.mock.calls) expect(request).toMatchObject({method:'PUT',credentials:'omit',redirect:'error'});
  });

  it.each([new Response('',{status:308}),new Response('',{status:200})])('does not assume unconfirmed or early-final bytes persisted',async response=>{
    const file=new File([new Uint8Array(9*1024*1024)],'lecture.mp4');
    const fetch=vi.fn().mockResolvedValue(response);vi.stubGlobal('fetch',fetch);
    await expect(transferAttachmentFile(file,{transport:'resumable',url:'https://storage.googleapis.com/upload/session',offset:0,total_bytes:file.size,chunk_size:8388608},new AbortController().signal,()=>{})).rejects.toThrow('did not confirm');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('identifies reselected files with a bounded middle sample as well as ends',async()=>{
    const content=new Uint8Array(5*65536);content.fill(7);
    const original=await describeAttachmentFile(new File([content],'lecture.mp4',{lastModified:1}));
    content[2*65536]=8;
    const changed=await describeAttachmentFile(new File([content],'lecture.mp4',{lastModified:1}));
    expect(changed.sample_sha256).not.toBe(original.sample_sha256);
    expect(original).toMatchObject({file_name:'lecture.mp4',size_bytes:5*65536,last_modified:1});
  });

  it('reopens the same file control session after interruption and resumes only server-confirmed bytes',async()=>{
    const card=await cardHarness();
    const initial=liveAnalysis('empty',{stage:'awaiting_upload',status:'awaiting_upload',results:{revision:'empty',included_videos:0,final:false},next_action:{type:'request_input'}});
    const grant={url:'https://api.example/files',complete_url:'https://api.example/complete',token:'private-control-token',max_files:8};
    await card.app.ontoolresult({_meta:{analysis:initial,upload:grant}});
    card.callServerTool.mockResolvedValue({_meta:{analysis:{...initial,stage:'importing',status:'importing',next_action:{type:'continue_polling'}}}});
    const file=new File([new Uint8Array(10*1024*1024)],'lecture.mp4',{type:'video/mp4'});
    card.control('files').files=[file];await card.control('files').fire('change');
    let initializations=0,puts=0;
    const fetch=vi.fn().mockImplementation(async(url:string, _request: RequestInit)=>{
      if(url===grant.url) return Response.json({job:{job_id:'batch'},upload:{transport:'resumable',url:'https://storage.googleapis.com/upload/session',offset:initializations++ ? 4194304:0,total_bytes:file.size,chunk_size:8388608}});
      if(url.startsWith('https://storage.googleapis.com/')) { puts++;return puts===1 ? new Response('',{status:308,headers:{Range:'bytes=0-4194303'}}) : new Response('',{status:puts===2 ? 503:200}); }
      return Response.json({});
    });vi.stubGlobal('fetch',fetch);
    try {
      await card.control('upload-form').fire('submit');
      expect(card.control('upload-message').textContent).toContain('Try again to resume');
      await card.control('upload-form').fire('submit');
      const controls=fetch.mock.calls.filter(([url])=>url===grant.url).map(([,request])=>JSON.parse(String(request.body)));
      expect(controls).toHaveLength(2);expect(controls[1]).toEqual(controls[0]);expect(controls[0].restart_expired).toBe(false);
      const storage=fetch.mock.calls.filter(([url])=>url.startsWith('https://storage.googleapis.com/'));
      expect(storage.at(-1)![1].headers).toEqual({'Content-Range':`bytes 4194304-${file.size-1}/${file.size}`});
      expect(fetch.mock.calls.filter(([url])=>url===`${grant.url}/complete`)).toHaveLength(1);
      expect(fetch.mock.calls.filter(([url])=>url===grant.complete_url)).toHaveLength(1);
      expect(card.control('upload-form').hidden).toBe(true);
    }finally{await card.app.onteardown();}
  });
});

it('supports standard MCP Apps hosts without the optional OpenAI persistence bridge', () => {
  vi.stubGlobal('window', {});
  try {
    expect(readHostState('analysis:a')).toBeNull();
    expect(() => saveHostState('analysis:a', 'studio', { query: 'lecture' }, { video_id: 'v1' })).not.toThrow();
  } finally { vi.unstubAllGlobals(); }
});
