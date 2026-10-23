import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { VideoVectorClient } from '../src/client/index.js';
import { executeTool, getToolDefinitions, getToolRequiredScope } from '../src/tools/index.js';
import { artifactLink, appOrigin, projectWorkflowPayload, resultLink } from '../src/tools/workflow-result-projection.js';
import { WORKFLOW_RESULT_TOOLS, WORKFLOW_DETAIL_TOOLS, RESULTS_CARD_URI } from '../src/tools/workflow-result-contract.js';
import * as resultView from '../ui/results-view';
import { createAnalysisProgressController, analysisResultView, readCompletedAnalysisVideo } from '../ui/analysis-progress';
import { createStudioTransport, normalizeStudioResult } from '../ui/results-search';
import { getSearchResultKey } from '../ui/utils/searchResultIdentity';
import { uploadAttachmentBatch } from '../src/attachments/upload-batch.js';

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
  const views = { ...resultView, uploadAttachmentBatch, createAnalysisProgressController: (options: any) => createAnalysisProgressController({ ...options, visibility: document }), analysisResultView, readCompletedAnalysisVideo, createStudioTransport, normalizeStudioResult, getSearchResultKey, readStudioState: () => restored, saveStudioState: vi.fn(), createStudioSearchHost: () => ({ update: (props: any) => {
    studioProps = props; const p = props.segmentProps;
    views.renderSegments(document.getElementById('rows'), p.rows, p.selected, p.onSelect, p.label, p.range, p.downloadMedia, p.downloadMetadata);
  }, unmount: vi.fn() }), renderMetadata: vi.fn(), renderSegments: vi.fn(), renderTimeline: vi.fn(), renderToolbar: vi.fn(), renderDownloads: vi.fn() };
  class App {
    callServerTool = callServerTool;
    connect = vi.fn().mockResolvedValue(undefined);
    openLink = vi.fn().mockResolvedValue({});
    getHostCapabilities = vi.fn().mockReturnValue({ downloadFile: {} });
    downloadFile = vi.fn().mockResolvedValue({});
  }
  const source = readFileSync(new URL('../ui/results-card.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const app = await new AsyncFunction('App', 'document', ...Object.keys(views), `${source}\nreturn app;`)(App, document, ...Object.values(views));
  const receive = (value: any = cardPage, request: any = { video_id: 'video-1', view: 'both' }) => app.ontoolresult({ structuredContent: { ...value, source_kind: 'prompt_run', source_id: 'run-1' }, _meta: { view: value, viewRequest: request } });
  return { app, receive, callServerTool, defaultResponse, ...views, studio: () => studioProps, control: document.getElementById,
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

it('keeps an import-only task in the same progress widget and never requests an analysis bundle', async () => {
  vi.useFakeTimers();
  const card = await cardHarness();
  try {
    const importing = { import_id: 'imp-current', status: 'importing', stage: 'importing', scope: { type: 'index', index_id: 'index-1' },
      progress: { imported: 1, parts_completed: 1 }, files: { items: [{ file_name: 'clip.mp4', status: 'importing' }] }, results: { final: false } };
    const completed = { ...importing, status: 'completed', stage: 'completed', results: { final: true }, progress: { imported: 2, parts_completed: 2 } };
    card.callServerTool.mockResolvedValue({ _meta: { import: completed } });
    await card.app.ontoolresult({ _meta: { import: { ...importing, status: 'awaiting_upload', stage: 'uploading' },
      upload: { url: 'https://api.example/uploads', complete_url: 'https://api.example/complete', token: 'test-grant', accept: 'video/*', max_files: 8 } } });
    expect(card.control('upload-form').hidden).toBe(false);
    await card.app.ontoolresult({ structuredContent: importing, _meta: { import: importing } });
    expect(card.control('upload-form').hidden).toBe(true);
    expect(card.control('analysis-stage').textContent).toBe('importing');
    expect(card.control('analysis-files').textContent).toContain('clip.mp4');
    await vi.advanceTimersByTimeAsync(5000);
    expect(card.callServerTool).toHaveBeenCalledExactlyOnceWith({ name: 'read_analysis', arguments: { import_id: 'imp-current' } }, expect.any(Object));
    expect(card.control('analysis-stage').textContent).toBe('completed');
    expect(card.control('analysis-counts').textContent).toContain('2 complete');
    await vi.advanceTimersByTimeAsync(20000);
    expect(card.callServerTool).toHaveBeenCalledTimes(1);
    expect(card.viewCalls()).toHaveLength(0);
    expect(card.mediaCalls()).toHaveLength(0);
  } finally { await card.app.onteardown(); vi.useRealTimers(); }
});
describe('analysis widget lifecycle', () => {
  it('runs import through terminal through the private adapter, pausing hidden reads without changing index or playback', async () => {
    vi.useFakeTimers();
    const card = await cardHarness();
    const empty = { revision: 'intake', included_videos: 0, final: false, videos: [], data: [] };
    let current = liveAnalysis('intake', { status: 'importing', stage: 'importing', message: 'Receiving three videos.',
      progress: { total: 3, imported: 1, completed: 0, processing: 0 }, results: empty });
    const client = {
      getAnalysis: vi.fn(async (_identity, options) => {
        const value = structuredClone(current);
        if (options.detail !== 'full') delete value.results.data;
        return value;
      }),
      getVideosInIndex: vi.fn().mockResolvedValue({ data: [{ video_id: 'video-1', title: 'Launch' }], pagination: {} }),
      getPlaygroundVideos: vi.fn(),
      workflowSearchScope: vi.fn().mockResolvedValue({ runs: [], browse_targets: [{ run_id: 'anl-current', video_id: 'video-1' }], fields: [] }),
    } as unknown as VideoVectorClient;
    card.callServerTool.mockImplementation(async request => ['read_analysis', 'list_studio_scope'].includes(request.name)
      ? executeTool(request.name, request.arguments, client) : card.defaultResponse(request));
    try {
      await card.app.ontoolresult({ structuredContent: current, _meta: { analysis: current } });
      expect(card.control('analysis-stage').textContent).toBe('importing');
      await vi.advanceTimersByTimeAsync(4999);
      expect(client.getAnalysis).not.toHaveBeenCalled();
      current = liveAnalysis('queued', { status: 'processing', stage: 'processing', message: 'All videos received; analysis is running.',
        progress: { total: 3, imported: 3, completed: 0, processing: 3 }, results: { ...empty, revision: 'queued' } });
      await vi.advanceTimersByTimeAsync(1);
      expect(card.control('analysis-stage').textContent).toBe('processing');
      expect(card.control('analysis-counts').textContent).toBe('3 received · 0 complete · 3 processing');

      current = liveAnalysis('partial');
      current.results.videos = [{ video_id: 'video-1', name: 'Launch' }];
      current.results.data[0].segments.push({ segment_id: 'seg-2', start_time: 9, end_time: 14, metadata: { scene: 'Second scene' } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(card.control('analysis-counts').textContent).toContain('1 complete');
      expect(card.tiles()).toHaveLength(2);
      await card.studio().segmentProps.onSelect(card.tiles()[1]);
      card.control('player').currentTime = 12;
      const selectedKey = card.studio().segmentProps.selected.result_id;
      const mediaCalls = card.mediaCalls().length;
      await card.studio().transport.catalog({});
      expect(client.getVideosInIndex).toHaveBeenCalledWith('index-1', 100, undefined);
      expect(client.getPlaygroundVideos).not.toHaveBeenCalled();
      expect(client.workflowSearchScope).toHaveBeenCalledWith({ video_ids: ['video-1'], latest_only: true, container_index_id: 'index-1' });

      card.setVisibility('hidden');
      const readsBeforeHidden = vi.mocked(client.getAnalysis).mock.calls.length;
      await vi.advanceTimersByTimeAsync(30000);
      expect(client.getAnalysis).toHaveBeenCalledTimes(readsBeforeHidden);
      current = liveAnalysis('final', { status: 'completed', stage: 'completed', message: 'All three videos are complete.',
        progress: { total: 3, imported: 3, completed: 3, processing: 0 },
        results: { ...current.results, revision: 'final', final: true, included_videos: 3 }, next_action: { type: 'download_and_answer' } });
      card.setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
      expect(card.control('analysis-stage').textContent).toBe('completed');
      expect(card.control('analysis-counts').textContent).toBe('3 received · 3 complete');
      expect(card.studio().segmentProps.selected.result_id).toBe(selectedKey);
      expect(card.studio().segmentProps.selected.source_index_id).toBe('index-1');
      expect(card.control('player').currentTime).toBe(12);
      expect(card.mediaCalls()).toHaveLength(mediaCalls);
      await vi.advanceTimersByTimeAsync(30000);
      expect(client.getAnalysis).toHaveBeenCalledTimes(readsBeforeHidden + 1);
      expect(vi.mocked(client.getAnalysis).mock.calls.every(([, options]) => options?.include_download === false)).toBe(true);
      expect(card.callServerTool.mock.calls.every(([request]) => request.arguments.intent !== 'download')).toBe(true);
      expect(card.viewCalls()).toHaveLength(0);
    } finally { await card.app.onteardown(); vi.useRealTimers(); }
  });

  it('opens a complete video while its siblings process, refreshes progress, and preserves playback', async () => {
    vi.useFakeTimers();
    const card = await cardHarness();
    try {
      const value = liveAnalysis('rev-1');
      card.callServerTool.mockImplementation(async request => request.name === 'read_analysis' ? { _meta: { analysis: value } } : card.defaultResponse(request));
      await card.app.ontoolresult({ structuredContent: value, _meta: { analysis: value } });
      expect(card.tiles()).toEqual([expect.objectContaining({ metadata: { scene: 'Ready segment' }, run_id: 'anl-current' })]);
      expect(card.viewCalls()).toHaveLength(0);
      expect(card.control('analysis-counts').textContent).toContain('3 received');
      expect(card.control('analysis-files').textContent).toContain('Launch: completed');
      card.control('player').currentTime = 7;
      const mediaCalls = card.mediaCalls().length;
      card.callServerTool.mockImplementation(async request => request.name === 'read_analysis'
        ? { _meta: { analysis: liveAnalysis('rev-2', { progress: { total: 3, imported: 3, completed: 2, processing: 1 } }) } }
        : card.defaultResponse(request));
      await vi.advanceTimersByTimeAsync(5000);
      expect(card.callServerTool).toHaveBeenCalledWith({ name: 'read_analysis', arguments: { analysis_id: 'anl-current' } }, expect.any(Object));
      expect(card.control('analysis-counts').textContent).toContain('2 complete');
      expect(card.control('player').currentTime).toBe(7);
      expect(card.mediaCalls()).toHaveLength(mediaCalls);
      expect(card.viewCalls()).toHaveLength(0);
    } finally { await card.app.onteardown(); vi.useRealTimers(); }
  });

  it('renews the included JSON download only when the user clicks download', async () => {
    const card = await cardHarness();
    const value = liveAnalysis('rev-1', { status: 'completed', next_action: { type: 'download_and_answer' } });
    try {
      card.callServerTool.mockImplementation(async request => request.name === 'read_analysis' ? { _meta: { analysis: value } } : card.defaultResponse(request));
      await card.app.ontoolresult({ structuredContent: value, _meta: { analysis: value } });
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
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetch);
  try {
    const initial = liveAnalysis('empty', { stage: 'awaiting_upload', status: 'awaiting_upload', results: { revision: 'empty', included_videos: 0, final: false }, next_action: { type: 'request_input' } });
    const importing = { ...initial, stage: 'importing', status: 'importing', message: 'Files received.', progress: { total: 1, imported: 1, completed: 0, processing: 1 }, next_action: { type: 'continue_polling' } };
    card.callServerTool.mockImplementation(async () => ({ _meta: { analysis: importing } }));
    await card.app.ontoolresult({ structuredContent: initial, _meta: { analysis: initial, upload: { url: 'https://api.example/upload', complete_url: 'https://api.example/complete', token: 'upload-token', max_files: 5, accept: 'video/*' } } });
    card.control('files').files = [new File(['video'], 'launch.mp4', { type: 'video/mp4' })];
    await card.control('files').fire('change');
    await card.control('upload-form').fire('submit');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(card.control('upload-form').hidden).toBe(true);
    expect(card.control('analysis-stage').textContent).toBe('importing');
    expect(card.callServerTool).toHaveBeenLastCalledWith({ name: 'read_analysis', arguments: { analysis_id: 'anl-current' } }, expect.any(Object));
    card.callServerTool.mockResolvedValue({ _meta: { analysis: { ...importing, stage: 'processing', status: 'processing', message: 'Video analysis is running.' } } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(card.control('analysis-stage').textContent).toBe('processing');
    expect(card.control('analysis-message').textContent).toBe('Video analysis is running.');
    expect(card.callServerTool.mock.calls.every(([request]) => request.name === 'read_analysis')).toBe(true);
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
    const hit = { ...cardRow, run_id: 'run-old', result_id: 'segment:seg-1:run-old' };
    await card.studio().onSelectResult(hit, [hit]);
    card.control('player').currentTime = 6;
    await vi.advanceTimersByTimeAsync(5000);
    expect(card.studio().segmentProps.selected.run_id).toBe('run-old');
    expect(card.control('player').currentTime).toBe(6);
    expect(card.studio().mode).toBe('result');
  } finally { await card.app.onteardown(); vi.useRealTimers(); }
});

describe('unified picker batch recovery', () => {
  const active: any[] = [];
  afterEach(async () => { for (const card of active.splice(0)) await card.app.onteardown(); vi.unstubAllGlobals(); });
  async function unifiedPicker(count: number) {
    const card = await cardHarness(); active.push(card);
    const initial = liveAnalysis('empty', { stage: 'awaiting_upload', status: 'awaiting_upload', results: { revision: 'empty', included_videos: 0, final: false }, next_action: { type: 'request_input' } });
    card.callServerTool.mockResolvedValue({ _meta: { analysis: { ...initial, stage: 'importing', next_action: { type: 'continue_polling' } } } });
    await card.app.ontoolresult({ _meta: { analysis: initial, upload: { url: 'https://api.example/files', complete_url: 'https://api.example/complete', token: 'grant', max_files: 8 } } });
    card.control('files').files = Array.from({ length: count }, (_, index) => new File(['video'], `${index}.mp4`));
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
    const fetch = vi.fn().mockImplementation(async (url: string) => new Response('{}', { status: url.endsWith('/complete') ? 401 : 200 }));
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
      const uploadedIds = fetch.mock.calls.filter(([url]) => url.endsWith('/files')).map(([, init]) => init.body.get('file_id'));
      expect(uploadedIds).toHaveLength(2);
      expect(JSON.parse(fetch.mock.calls.at(-1)![1].body).file_ids).toEqual(uploadedIds);

      await vi.advanceTimersByTimeAsync(5000);
      expect(backend.getAnalysis).toHaveBeenCalledExactlyOnceWith('anl-current', { detail: 'summary', include_download: false });
      expect(backend.mcpTool).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(3);
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
      expect(fetch).toHaveBeenCalledTimes(4); // Received bytes are retained; only finalization is retried.
      expect(fetch.mock.calls.at(-1)).toEqual([renewedGrant.complete_url, expect.objectContaining({
        credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${renewedGrant.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ file_ids: uploadedIds }),
      })]);
      expect(ui.card.control('upload-form').hidden).toBe(true);
      expect(ui.card.control('analysis-stage').textContent).toBe('importing');
      await vi.advanceTimersByTimeAsync(5000);
      expect(backend.getAnalysis).toHaveBeenCalledTimes(3);
      expect(vi.mocked(backend.getAnalysis).mock.calls.every(([, options]) => options?.include_download === false && !('include_upload' in options))).toBe(true);
      expect(backend.mcpTool).toHaveBeenCalledTimes(1);
      expect(ui.card.callServerTool.mock.calls.every(([request]) => request.name === 'read_analysis' && request.arguments.analysis_id === 'anl-current')).toBe(true);
    } finally { await ui.card.app.onteardown(); vi.useRealTimers(); }
  });

  it('settles started uploads, retains successes and completes the same ordered IDs on retry', async () => {
    let fail!: (response: Response) => void;
    let finish!: (response: Response) => void;
    const first = new Promise<Response>(resolve => { fail = resolve; });
    const second = new Promise<Response>(resolve => { finish = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    vi.stubGlobal('fetch', fetch);
    const ui = await unifiedPicker(8);
    const pending = ui.submit();
    expect(fetch).toHaveBeenCalledTimes(2);
    const ids = fetch.mock.calls.map(([, init]) => init.body.get('file_id'));
    fail(new Response('{}', { status: 500 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.card.control('submit').disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    finish(new Response('{}', { status: 200 }));
    await pending;
    expect(ui.card.control('submit').disabled).toBe(false);
    expect(ui.card.callServerTool).not.toHaveBeenCalled();
    fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/complete') ? { job_id: 'batch', status: 'pending' } : {}
    ), { status: 200 }));
    await ui.submit();
    const retried = fetch.mock.calls.slice(2).filter(([url]) => url.endsWith('/files')).map(([, init]) => init.body.get('file_id'));
    expect(retried).toHaveLength(7);
    expect(retried[0]).toBe(ids[0]);
    expect(retried).not.toContain(ids[1]);
    const completion = fetch.mock.calls.filter(([url]) => url.endsWith('/complete'));
    expect(completion).toHaveLength(1);
    expect(JSON.parse(completion[0]![1].body).file_ids).toEqual([ids[0], ids[1], ...retried.slice(1)]);
    expect(ui.card.callServerTool).toHaveBeenCalledExactlyOnceWith({ name: 'read_analysis', arguments: { analysis_id: 'anl-current' } }, expect.any(Object));
  });
});
