import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnalysisProgressController, analysisResultView, readCompletedAnalysisVideo } from '../ui/analysis-progress';

const snapshot = (analysis_id = 'a', status = 'processing') => ({ analysis_id, status, next_action: { type: status === 'processing' ? 'continue_polling' : 'download_and_answer' } });
function harness() {
  vi.useFakeTimers();
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const read = vi.fn().mockResolvedValue(snapshot()), apply = vi.fn(), unavailable = vi.fn();
  const controller = createAnalysisProgressController({ read, apply, unavailable, visibility });
  const hide = () => { visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange')); };
  const show = () => { visibility.visibilityState = 'visible'; visibility.dispatchEvent(new Event('visibilitychange')); };
  return { controller, read, apply, unavailable, hide, show };
}
afterEach(() => vi.useRealTimers());
describe('visible analysis progress', () => {
  it('polls an import-only task with its own identity and stops at terminal without inventing analysis results', async () => {
    const h = harness();
    const importing = { import_id: 'imp-1', status: 'importing', progress: { imported: 0, total: 2 } };
    h.read.mockResolvedValueOnce({ ...importing, progress: { imported: 1, total: 2 } })
      .mockResolvedValueOnce({ ...importing, status: 'completed', progress: { imported: 2, total: 2 } });
    h.controller.start(importing);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.read).toHaveBeenCalledWith('imp-1', expect.any(AbortSignal));
    h.hide(); await vi.advanceTimersByTimeAsync(15000); expect(h.read).toHaveBeenCalledTimes(1);
    h.show(); await vi.advanceTimersByTimeAsync(0);
    expect(h.apply).toHaveBeenLastCalledWith(expect.objectContaining({ import_id: 'imp-1', status: 'completed' }), expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(20000); expect(h.read).toHaveBeenCalledTimes(2);
    h.controller.stop();
  });
  it('reads every five seconds, pauses while hidden, resumes immediately, and stops on completion', async () => {
    const h = harness(); h.controller.start(snapshot());
    await vi.advanceTimersByTimeAsync(4999); expect(h.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(h.read).toHaveBeenCalledTimes(1);
    h.hide(); await vi.advanceTimersByTimeAsync(20000); expect(h.read).toHaveBeenCalledTimes(1);
    h.show(); await vi.advanceTimersByTimeAsync(0); expect(h.read).toHaveBeenCalledTimes(2);
    h.read.mockResolvedValueOnce(snapshot('a', 'completed'));
    await vi.advanceTimersByTimeAsync(5000); expect(h.apply).toHaveBeenLastCalledWith(snapshot('a', 'completed'), expect.any(AbortSignal));
    await vi.advanceTimersByTimeAsync(20000); expect(h.read).toHaveBeenCalledTimes(3);
    h.controller.stop();
  });
  it('discards a late response after changing analysis and never overlaps reads', async () => {
    const h = harness(); let finish!: (value: any) => void;
    h.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.controller.start(snapshot()); await vi.advanceTimersByTimeAsync(5000);
    const signal = h.read.mock.calls[0][1];
    await vi.advanceTimersByTimeAsync(20000); expect(h.read).toHaveBeenCalledTimes(1);
    h.controller.start(snapshot('b')); expect(signal.aborted).toBe(true);
    finish(snapshot()); await vi.advanceTimersByTimeAsync(0); expect(h.apply).not.toHaveBeenCalled();
    h.read.mockResolvedValue(snapshot('b')); await vi.advanceTimersByTimeAsync(5000);
    expect(h.apply).toHaveBeenCalledExactlyOnceWith(snapshot('b'), expect.any(AbortSignal)); h.controller.stop();
  });
  it('reports unavailable updates and retries without inventing a stopped processing state', async () => {
    const h = harness(); h.read.mockRejectedValueOnce(new Error('offline'));
    h.controller.start(snapshot()); await vi.advanceTimersByTimeAsync(5000);
    expect(h.unavailable).toHaveBeenCalledTimes(1); expect(h.apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000); expect(h.apply).toHaveBeenCalledWith(snapshot(), expect.any(AbortSignal)); h.controller.stop();
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
  const result = await readCompletedAnalysisVideo(call, 'a', 'v1', signal);
  expect(call.mock.calls.map(call => call[1])).toEqual([
    { analysis_id: 'a', video_id: 'v1', detail: 'full' }, { analysis_id: 'a', video_id: 'v1', detail: 'full', cursor: 'next' },
  ]);
  expect(result.results.data).toEqual([{ video_id: 'v1', video_level: { metadata: { title: 'Clip' } }, segments: [{ segment_id: 's1' }, { segment_id: 's2' }] }]);
});

it('does not read more selected-video pages after the selection is cancelled', async () => {
  const controller = new AbortController();
  const call = vi.fn(async () => { controller.abort(); return { _meta: { analysis: { results: { data: [], pagination: { has_more: true, next_cursor: 'next' } } } } }; });
  await expect(readCompletedAnalysisVideo(call, 'a', 'v1', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(call).toHaveBeenCalledTimes(1);
});
