/** Browser picker transport: JSON capability control, direct storage bytes. */
export interface UploadFile {
  name: string;
  type: string;
  size: number;
  lastModified: number;
  slice(start: number, end: number): Blob;
}

export interface ResumableFileSession {
  transport: 'resumable';
  url: string;
  offset: number;
  total_bytes: number;
  chunk_size: number;
}

export async function describeAttachmentFile(file: UploadFile) {
  const sampleSize = 64 * 1024;
  const last = Math.max(0, file.size - sampleSize);
  const samples = new Blob([...new Set([0, Math.floor(last / 2), last])]
    .map(start => file.slice(start, start + sampleSize)));
  const hash = await crypto.subtle.digest('SHA-256', await samples.arrayBuffer());
  return {
    file_name: file.name, content_type: file.type || 'application/octet-stream',
    size_bytes: file.size, last_modified: file.lastModified,
    sample_sha256: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''),
  };
}

export async function transferAttachmentFile(file: UploadFile, session: ResumableFileSession,
  signal: AbortSignal, onProgress: (confirmedBytes: number) => void): Promise<void> {
  const url = new URL(session.url);
  if (session.transport !== 'resumable' || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !(url.hostname === 'storage.googleapis.com' || url.hostname.endsWith('.storage.googleapis.com'))
    || session.total_bytes !== file.size || !Number.isSafeInteger(session.offset) || session.offset < 0 || session.offset > file.size
    || !Number.isSafeInteger(session.chunk_size) || session.chunk_size <= 0) {
    throw new Error('The storage upload session is invalid.');
  }
  let offset = session.offset;
  onProgress(offset);
  while (offset < file.size) {
    signal.throwIfAborted();
    const end = Math.min(file.size, offset + Math.min(session.chunk_size, 8 * 1024 * 1024));
    const response = await fetch(url.href, {
      method: 'PUT', credentials: 'omit', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5 * 60 * 1000)]),
      headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${file.size}` },
      body: file.slice(offset, end),
    });
    let confirmed: number;
    if (response.status === 200 || response.status === 201) {
      confirmed = file.size;
    } else if (response.status === 308) {
      const match = response.headers.get('Range')?.match(/^bytes=0-(\d+)$/);
      confirmed = match ? Number(match[1]) + 1 : 0;
    } else {
      throw new Error('Storage upload did not finish. Try again to resume the selected files.');
    }
    if (!Number.isSafeInteger(confirmed) || confirmed <= offset || confirmed > end) {
      throw new Error('Storage did not confirm the uploaded bytes. Try again to resume the selected files.');
    }
    offset = confirmed;
    onProgress(offset);
  }
}
