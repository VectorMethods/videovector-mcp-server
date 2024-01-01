const taskIdentity = value => value.analysis_id ?? value.import_id;
const taskIsTerminal = value => value.results?.final === true
  || ['download_and_answer', 'review_error'].includes(value.next_action?.type)
  || (Boolean(value.import_id) && ['completed', 'partial_completed', 'failed', 'cancelled'].includes(value.status));

/** The visible widget owns one sequential status read, independently of model turns. */
export function createAnalysisProgressController({ read, apply, unavailable, visibility = document, interval = 5000 }) {
  let identity, timer, controller, generation = 0, stopped = false, terminal = false;
  const visible = () => visibility.visibilityState !== 'hidden';
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clear();
    if (!stopped && identity && !terminal && visible()) timer = setTimeout(() => { void refresh(); }, interval);
  };
  async function refresh() {
    if (stopped || !identity || !visible() || controller) return;
    const current = generation;
    const request = new AbortController(); controller = request;
    try {
      const value = await read(identity, request.signal);
      if (current !== generation || request.signal.aborted) return;
      terminal = taskIsTerminal(value);
      await apply(value, request.signal);
    } catch (error) {
      if (current === generation && !request.signal.aborted) unavailable(error);
    } finally {
      if (controller === request) controller = undefined;
      if (current === generation) schedule();
    }
  }
  const visibilityChanged = () => {
    clear();
    if (!visible()) { controller?.abort(); controller = undefined; ++generation; }
    else if (!terminal) void refresh();
  };
  visibility.addEventListener?.('visibilitychange', visibilityChanged);
  return {
    start(value) {
      if (identity !== taskIdentity(value)) {
        ++generation; controller?.abort(); controller = undefined; clear();
        identity = taskIdentity(value);
      }
      stopped = false;
      terminal = taskIsTerminal(value);
      schedule();
    },
    refresh,
    reset() {
      ++generation; clear(); controller?.abort(); controller = undefined; identity = undefined;
    },
    stop() {
      stopped = true; ++generation; clear(); controller?.abort(); controller = undefined;
      visibility.removeEventListener?.('visibilitychange', visibilityChanged);
    },
  };
}

/** Complete-video bundles are the sole analysis data source for this view. */
export function analysisResultView(analysis) {
  const rows = [], matches = [], videos = [];
  const runId = analysis.analysis_id;
  const indexId = analysis.scope?.type === 'index' ? analysis.scope.index_id : undefined;
  for (const video of analysis.results?.data ?? []) {
    const common = { run_id: runId, video_id: video.video_id, video_name: video.name,
      media_type: video.media_type, ...(indexId ? { source_index_id: indexId } : {}) };
    const matched = new Set(video.selection?.matched_segment_ids ?? []);
    const segments = (video.segments ?? []).map(segment => ({ ...common, ...segment,
      result_id: `segment:${segment.segment_id}:${runId}`, result_type: 'segment', metadata: segment.metadata ?? {},
    }));
    const videoRows = video.video_level ? [{ ...common, ...video.video_level,
      result_id: `video:${video.video_id}:${runId}`, result_type: 'video', metadata: video.video_level.metadata ?? {},
    }] : [];
    rows.push(...segments, ...videoRows);
    matches.push(...segments.filter(segment => matched.has(segment.segment_id)), ...(video.selection?.video_matched ? videoRows : []));
    videos.push({ ...video, rows: segments, videoRows });
  }
  const page = data => ({ data, pagination: { has_more: false, next_cursor: null } });
  const hasSelection = (analysis.results?.data ?? []).some(video => video.selection?.status && video.selection.status !== 'not_applicable');
  return { run_id: runId, status: analysis.status, result_level: 'segment',
    destination: analysis.scope, links: analysis.links,
    selection_summary: { status: hasSelection ? 'ready' : 'not_applicable' },
    unfiltered: page(rows), filtered: hasSelection ? page(matches) : null, videos,
  };
}

/** A selected video can span bounded pages; cursors pin the completed revision. */
export async function readCompletedAnalysisVideo(callTool, analysisId, videoId, signal) {
  const videos = new Map(), seen = new Set();
  let cursor, snapshot;
  do {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = await callTool('read_analysis', { analysis_id: analysisId, video_id: videoId, detail: 'full', ...(cursor ? { cursor } : {}) }, signal);
    const page = response._meta?.analysis;
    if (response.isError || !Array.isArray(page?.results?.data)) throw new Error('This completed analysis is unavailable.');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (snapshot && snapshot.results.revision !== page.results.revision) throw new Error('The analysis changed while loading. Select the video again to refresh it.');
    snapshot = page;
    for (const video of page.results.data) {
      if (video.video_id !== videoId) throw new Error('The analysis page does not match this video.');
      const prior = videos.get(video.video_id);
      videos.set(video.video_id, { ...prior, ...video, segments: Array.from(new Map([...(prior?.segments ?? []), ...(video.segments ?? [])].map(segment => [segment.segment_id, segment])).values()) });
    }
    cursor = page.results.pagination?.has_more ? page.results.pagination.next_cursor : undefined;
    if (page.results.pagination?.has_more && (!cursor || seen.has(cursor))) throw new Error('The analysis page could not be continued. Select the video again to retry.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { ...snapshot, results: { ...snapshot.results, data: [...videos.values()] } };
}
