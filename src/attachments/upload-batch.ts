/** Stop dispatching after a failure, but settle both owned uploads before returning. */
export async function uploadAttachmentBatch<T>(
  files: readonly T[],
  upload: (file: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!failed && next < files.length) {
      const index = next++;
      try {
        await upload(files[index]!, index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, files.length) }, worker));
  if (failed) throw firstError;
}
