import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalysisProgressController, analysisResultView, readAnalysisVideo, processingView } from '../ui/analysis-progress';

const snapshot = (version = 'v1', idle = false) => ({ analysis_id: 'a', version, idle, records: [] });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness() {
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const pending: Array<{ resolve: (value: any) => void; signal: AbortSignal }> = [];
  const read = vi.fn((_id, _version, signal: AbortSignal) => new Promise((resolve, reject) => {
    pending.push({ resolve, signal });
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const apply = vi.fn(), unavailable = vi.fn();
  const controller = createAnalysisProgressController({ read, apply, unavailable, visibility });
  const visible = (value: string) => { visibility.visibilityState = value; visibility.dispatchEvent(new Event('visibilitychange')); };
  return { controller, read, apply, unavailable, pending, visible };
}
afterEach(() => vi.useRealTimers());
describe('visible native processing observation', () => {
  it('bootstraps once, waits on the exact version, and observes enrichment after main completion', async () => {
    const h = harness(); h.controller.start({ analysis_id: 'a', results: { final: true } });
    expect(h.read).toHaveBeenCalledExactlyOnceWith('a', undefined, expect.any(AbortSignal));
    h.pending[0].resolve({ ...snapshot(), records: [{ kind: 'run', state: { status: 'completed' } }] }); await flush();
    expect(h.read).toHaveBeenLastCalledWith('a', 'v1', expect.any(AbortSignal));
    expect(h.read).toHaveBeenCalledTimes(2);
    h.pending[1].resolve(snapshot('v2', true)); await flush();
    expect(h.apply).toHaveBeenLastCalledWith(snapshot('v2', true), expect.any(AbortSignal));
    h.visible('hidden'); h.visible('visible'); await flush(); expect(h.read).toHaveBeenCalledTimes(2);
    h.controller.stop();
  });
  it('aborts hidden observation and resumes without overlapping reads or losing the version', async () => {
    const h = harness(); h.controller.start({ import_id: 'imp-1' });
    h.pending[0].resolve(snapshot()); await flush();
    h.visible('hidden'); expect(h.pending[1].signal.aborted).toBe(true);
    h.visible('visible'); await flush(); expect(h.read).toHaveBeenLastCalledWith('imp-1', 'v1', expect.any(AbortSignal));
    h.controller.start({ analysis_id: 'other' }); await flush();
    expect(h.pending[2].signal.aborted).toBe(true);
    expect(h.read).toHaveBeenLastCalledWith('other', undefined, expect.any(AbortSignal));
    h.pending[2].resolve(snapshot('old')); await flush();
    expect(h.apply).toHaveBeenCalledTimes(1);
    h.controller.stop();
  });
  it('surfaces unavailable observation without a retry timer and allows an explicit reconnect', async () => {
    vi.useFakeTimers(); const h = harness(); h.read.mockRejectedValueOnce(new Error('host disconnected'));
    h.controller.start({ analysis_id: 'a' }); await flush();
    expect(h.unavailable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000); expect(h.read).toHaveBeenCalledTimes(1);
    void h.controller.refresh(); await flush(); expect(h.read).toHaveBeenCalledTimes(2);
    h.controller.stop();
  });
});

it('renders complete bundles without dropping nested metadata, transcription, video output or index identity', () => {
  const metadata = { objects: [{ colour: 'blue', attributes: { count: 5 } }], gcs_uri: 'user-authored field' };
  const view = analysisResultView({ analysis_id: 'older-run', status: 'processing', scope: { type: 'index', index_id: 'index-1' }, results: { data: [{
    video_id: 'v1', name: 'Clip', media_type: 'video', selection: { status: 'ready', matched_segment_ids: ['s1'], video_matched: false },
    video_level: { metadata: { summary: 'Full video' } }, segments: [{ segment_id: 's1', start_time: 0, end_time: 12, metadata, transcription: { text: 'hello' } }],
  }] } });
  expect(view.unfiltered.data).toHaveLength(2);
  expect(view.filtered?.data).toEqual([expect.objectContaining({ segment_id: 's1', metadata, transcription: { text: 'hello' }, run_id: 'older-run', source_index_id: 'index-1' })]);
  expect(view.unfiltered.pagination.has_more).toBe(false);
});


it('drains only one selected video, keeps its revision, and merges bounded segment pages', async () => {
  const call = vi.fn()
    .mockResolvedValueOnce({ _meta: { analysis: { analysis_id: 'a', results: { revision: 'fixed', data: [{ video_id: 'v1', video_level: { metadata: { title: 'Clip' } }, segments: [{ segment_id: 's1' }] }], pagination: { has_more: true, next_cursor: 'next' } } } } })
    .mockResolvedValueOnce({ _meta: { analysis: { analysis_id: 'a', results: { revision: 'fixed', data: [{ video_id: 'v1', segments: [{ segment_id: 's2' }] }], pagination: { has_more: false } } } } });
  const signal = new AbortController().signal;
  const result = await readAnalysisVideo(call, 'a', 'v1', signal);
  expect(call.mock.calls.map(call => call[1])).toEqual([
    { analysis_id: 'a', video_id: 'v1', detail: 'full' }, { analysis_id: 'a', video_id: 'v1', detail: 'full', cursor: 'next' },
  ]);
  expect(result.results.data).toEqual([{ video_id: 'v1', video_level: { metadata: { title: 'Clip' } }, segments: [{ segment_id: 's1' }, { segment_id: 's2' }] }]);
});

it('does not read more selected-video pages after the selection is cancelled', async () => {
  const controller = new AbortController();
  const call = vi.fn(async () => { controller.abort(); return { _meta: { analysis: { results: { data: [], pagination: { has_more: true, next_cursor: 'next' } } } } }; });
  await expect(readAnalysisVideo(call, 'a', 'v1', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(call).toHaveBeenCalledTimes(1);
});

it('does not describe an idle upload waiting for files as completed processing', () => {
  expect(processingView({ ...snapshot('idle', true), run_id: null,
    records: [{ kind: 'import_job', state: { status: 'awaiting_upload', progress: { total_files: 2, imported: 0 } } }],
  })).toMatchObject({ stage: 'awaiting_upload', counts: '0 of 2 received', message: 'Waiting for the selected files to upload.' });
});

it('shows a blocked analysis preparation while its native capture remains active', () => {
  const view = processingView({ ...snapshot(), run_id: null,
    records: [{ kind: 'import_job', state: { status: 'running', phase: 'capturing',
      execution: { status: 'blocked', error_code: 'prompt_generation_failed', error: 'Prompt preparation failed.' } } }],
  });
  expect(view).toMatchObject({ stage: 'capturing', message: 'Prompt preparation failed.' });
});
