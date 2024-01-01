import { describe, expect, it } from 'vitest';
import { uploadAttachmentBatch } from '../src/attachments/upload-batch.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('bounded attachment uploads', () => {
  it('runs exactly two uploads and waits for every file', async () => {
    const pending = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const work = uploadAttachmentBatch(pending, async (entry, index) => {
      started.push(index);
      peak = Math.max(peak, ++active);
      await entry.promise;
      active--;
    });
    expect(started).toEqual([0, 1]);
    for (const index of [1, 0, 2, 3, 4]) {
      pending[index]!.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    await work;
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('stops dispatch on failure and settles the other started upload before rejecting', async () => {
    const pending = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let returned = false;
    const failure = new Error('upload failed');
    const work = uploadAttachmentBatch(pending, async (entry, index) => {
      started.push(index);
      await entry.promise;
    });
    const outcome = work.catch(error => { returned = true; return error; });
    pending[0]!.reject(failure);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(returned).toBe(false);
    pending[1]!.resolve();
    expect(await outcome).toBe(failure);
    expect(started).toEqual([0, 1]);
  });
});
