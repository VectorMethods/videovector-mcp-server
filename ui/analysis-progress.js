const taskIdentity = value => value.analysis_id ?? value.import_id;

/** One host-mediated native watch request owns visible processing observation. */
export function createAnalysisProgressController({ read, apply, unavailable, visibility = document }) {
  let identity, controller, version, generation = 0, stopped = false, idle = false;
  const visible = () => visibility.visibilityState !== 'hidden';
  const interrupt = () => { ++generation; controller?.abort(); controller = undefined; };
  async function refresh() {
    if (stopped || !identity || !visible() || controller) return;
    idle = false;
    const current = generation;
    const request = new AbortController(); controller = request;
    try {
      while (!stopped && visible() && !idle && current === generation) {
        const value = await read(identity, version, request.signal);
        if (current !== generation || request.signal.aborted) return;
        if (typeof value.version !== 'string' || typeof value.idle !== 'boolean' || !Array.isArray(value.records)) {
          throw new Error('The processing observation is unavailable.');
        }
        version = value.version;
        idle = value.idle;
        await apply(value, request.signal);
      }
    } catch (error) {
      if (current === generation && !request.signal.aborted) unavailable(error);
    } finally {
      if (controller === request) controller = undefined;
    }
  }
  const visibilityChanged = () => {
    if (!visible()) interrupt();
    else if (!idle) void refresh();
  };
  visibility.addEventListener?.('visibilitychange', visibilityChanged);
  return {
    start(value) {
      const next = taskIdentity(value);
      if (identity !== next) { interrupt(); identity = next; version = undefined; idle = false; }
      stopped = false;
      if (!idle) void refresh();
    },
    refresh,
    reset() { interrupt(); identity = undefined; version = undefined; idle = false; },
    stop() { stopped = true; interrupt(); visibility.removeEventListener?.('visibilitychange', visibilityChanged); },
  };
}

/** Preserve the backend's independent extraction and enrichment state. */
export function processingView(snapshot) {
  const videos = snapshot.records.filter(row => row.kind === 'video').map(row => row.state);
  const run = snapshot.records.find(row => row.kind === 'run' && row.id === snapshot.run_id)?.state;
  const intake = snapshot.records.find(row => row.kind === 'import_job')?.state;
  const entries = videos.map(video => ({ video, entry: video.processing_status?.find(row => row.run_id === snapshot.run_id) }));
  const progress = intake?.progress ?? {};
  return { videos, run, intake, entries, stage: run?.status ?? intake?.phase ?? intake?.status ?? 'preparing',
    counts: run ? `${entries.filter(({ entry }) => entry?.readiness?.metadata_available).length} of ${videos.length} with metadata`
      : typeof progress.total_files === 'number' ? `${progress.imported ?? 0} of ${progress.total_files} received` : '',
    message: intake?.execution?.status === 'blocked' && !run ? (intake.execution.error || 'Analysis preparation failed. Upload progress is shown separately.')
      : intake?.status === 'awaiting_upload' && !run ? 'Waiting for the selected files to upload.'
      : intake?.error_message && !run ? intake.error_message
      : snapshot.idle ? 'Processing updates complete.' : run && ['completed', 'completed_with_failures', 'failed', 'cancelled'].includes(run.status)
      ? 'Extraction finished. Media and search updates are continuing.' : 'Processing updates are live.',
  };
}

export function metadataRevision(entry) {
  const revisions = entry?.result_revisions;
  return revisions ? JSON.stringify([revisions.metadata, revisions.segments, revisions.video_level]) : undefined;
}

/** Canonical accepted-result bundles are the metadata source for this view. */
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

/** A selected video can span bounded pages; cursors pin its accepted revision. */
export async function readAnalysisVideo(callTool, analysisId, videoId, signal) {
  const videos = new Map(), seen = new Set();
  let cursor, snapshot;
  do {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const response = await callTool('read_analysis', { analysis_id: analysisId, video_id: videoId, detail: 'full', ...(cursor ? { cursor } : {}) }, signal);
    const page = response._meta?.analysis;
    if (response.isError || !Array.isArray(page?.results?.data)) throw new Error('This analysis is unavailable.');
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
