import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { VideoVectorClient } from '../src/client/index.js';

const baseUrl = 'https://example.com/api/v2';
const storage = 'https://storage.googleapis.com/upload/private-session';
const grant = { url: `${baseUrl}/workflow/attachments/job/files`, complete_url: `${baseUrl}/workflow/attachments/job/complete`,
  token: 'private-grant', expires_at: '2030-01-01T00:00:00Z', max_files: 8, accept: 'video/*' };
const directories: string[] = [];
async function source() {
  const root = await mkdtemp(join(tmpdir(), 'mcp-resumable-')); directories.push(root);
  const path = join(root, 'clip.mp4'); await writeFile(path, 'abcdefghijkl');
  const info = await stat(path);
  return { path, identity: { device: info.dev, inode: info.ino, size: info.size, modifiedMs: info.mtimeMs } };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const session = (offset = 0, url = storage) => json({ job: { job_id: 'job' }, upload: {
  transport: 'resumable', url, offset, total_bytes: 12, chunk_size: 4 } });
async function bytes(body: RequestInit['body']) {
  const chunks = []; for await (const chunk of body as unknown as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('recovers a lost chunk acknowledgement from storage-confirmed offset and finalizes one source', async () => {
  const file = await source(); const sent: string[] = []; const ranges: string[] = []; const descriptors: unknown[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === grant.url) { descriptors.push(JSON.parse(init.body as string)); return session(descriptors.length === 1 ? 0 : 8); }
    if (url === `${grant.url}/complete`) { expect(JSON.parse(init.body as string)).toEqual({ file_id: 'file' }); return json({ job_id: 'job', status: 'awaiting_upload' }); }
    expect(url).toBe(storage); expect(init.method).toBe('PUT'); expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.redirect).toBe('error'); expect(init.body).not.toBeInstanceOf(Buffer);
    sent.push(await bytes(init.body)); ranges.push((init.headers as Record<string, string>)['Content-Range']!);
    if (sent.length === 2) throw new Error('lost acknowledgement');
    return sent.length === 1 ? new Response(null, { status: 308, headers: { Range: 'bytes=0-3' } }) : new Response(null, { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  const client = new VideoVectorClient({ apiKey: 'key', baseUrl, maxRetries: 1 });
  await expect(client.workflowUploadAttachment('job', grant, file.path, 'file', file.identity)).resolves.toMatchObject({ status: 'awaiting_upload' });
  expect(sent).toEqual(['abcd', 'efgh', 'ijkl']);
  expect(ranges).toEqual(['bytes 0-3/12', 'bytes 4-7/12', 'bytes 8-11/12']);
  expect(descriptors).toHaveLength(2); expect(descriptors[0]).toEqual(descriptors[1]);
  expect(descriptors[0]).toMatchObject({ file_id: 'file', file_name: 'clip.mp4', size_bytes: 12,
    sample_sha256: createHash('sha256').update('abcdefghijkl').digest('hex') });
  expect(fetch.mock.calls.filter(([url]) => url === `${grant.url}/complete`)).toHaveLength(1);
  expect(fetch.mock.calls.some(([url]) => url === grant.complete_url)).toBe(false);
});

it.each(['https://untrusted.example/upload', 'https://storage.googleapis.com.evil.example/upload', 'http://storage.googleapis.com/upload'])('rejects a non-storage session before sending file bytes: %s', async url => {
  const file = await source(); const fetch = vi.fn(async () => session(0, url)); vi.stubGlobal('fetch', fetch);
  const client = new VideoVectorClient({ apiKey: 'key', baseUrl, maxRetries: 0 });
  await expect(client.workflowUploadAttachment('job', grant, file.path, 'file', file.identity)).rejects.toMatchObject({ code: 'invalid_upload_session' });
  expect(fetch).toHaveBeenCalledOnce();
});

it('checks the opened file identity before every chunk and never finalizes changed bytes', async () => {
  const file = await source();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === grant.url) return session();
    expect(await bytes(init.body)).toBe('abcd'); await writeFile(file.path, 'changed length');
    return new Response(null, { status: 308, headers: { Range: 'bytes=0-3' } });
  });
  vi.stubGlobal('fetch', fetch);
  const client = new VideoVectorClient({ apiKey: 'key', baseUrl, maxRetries: 1 });
  await expect(client.workflowUploadAttachment('job', grant, file.path, 'file', file.identity)).rejects.toMatchObject({ code: 'upload_source_error' });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not trust an acknowledgement beyond the bytes sent', async () => {
  const file = await source();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === grant.url) return session();
    await bytes(init.body); return new Response(null, { status: 308, headers: { Range: 'bytes=0-11' } });
  });
  vi.stubGlobal('fetch', fetch);
  const client = new VideoVectorClient({ apiKey: 'key', baseUrl, maxRetries: 0 });
  await expect(client.workflowUploadAttachment('job', grant, file.path, 'file', file.identity)).rejects.toMatchObject({ code: 'storage_upload_failed' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
