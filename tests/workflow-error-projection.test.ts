import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { VideoVectorClient } from '../src/client/index.js';
import { executeTool } from '../src/tools/index.js';
import { WORKFLOW_RESULT_SCHEMA } from '../src/tools/workflow-result-contract.js';
import { projectWorkflowPayload, projectWorkflowResult } from '../src/tools/workflow-result-projection.js';

const privateDiagnostic = 'ProviderError: https://user:password@storage.googleapis.com/private-bucket/scene.mp4?X-Goog-Signature=secret-signature at /internal/worker.ts:42 reservation=private-reservation';
const validate = new AjvJsonSchemaValidator().getValidator(WORKFLOW_RESULT_SCHEMA);
const client = { workflowDelivery: vi.fn().mockResolvedValue({ artifacts: [] }) } as unknown as VideoVectorClient;

describe('workflow billing and import issue projection', () => {
  it.each(['summary', 'full'] as const)('keeps actionable billing state without provider exceptions in %s results', detail => {
    for (const tool of ['process_media', 'get_prompt_run_status']) {
      for (const [billingStatus, expectedMessage] of [
        ['pending_confirmation', 'Billing confirmation is pending. Open this run in the app to review billing before starting another run.'],
        ['pending_release', 'Billing release is pending. Open this run in the app to review the reserved credits.'],
        ['unknown', 'Billing settlement requires attention. Open this run in the app to review billing.'],
      ]) {
        const run = { run_id: 'run-1', status: 'completed', billing_status: billingStatus, billing_error: privateDiagnostic, error_message: privateDiagnostic };
        const payload = projectWorkflowPayload(tool, tool === 'process_media' ? { run_id: run.run_id, run } : run, detail);
        expect(payload.billing_status).toBe(billingStatus);
        expect(payload.billing_error).toBe(expectedMessage);
        expect(payload.error_message).toBe('This run needs attention. Open the run in the app to review its status before retrying.');
        expect(payload.status).toBe('completed');
        expect(JSON.stringify(payload)).not.toMatch(/secret-signature|private-bucket|password|private-reservation|internal\/worker/);
        expect(validate(payload).valid).toBe(true);
      }
    }
  });

  it('preserves absent and null billing diagnostics without inventing a billing failure', () => {
    const base = { run_id: 'run-1', status: 'completed', billing_status: 'confirmed' };
    expect(projectWorkflowPayload('get_prompt_run_status', base, 'summary')).not.toHaveProperty('billing_error');
    for (const billingError of [null, '']) {
      const payload = projectWorkflowPayload('get_prompt_run_status', { ...base, billing_error: billingError, error_message: billingError }, 'full');
      expect(payload.billing_error).toBeNull();
      expect(payload.error_message).toBeNull();
    }
  });

  it.each(['find', 'upload_media', 'get_import_job', 'retry_import_job'])('bounds %s per-file issues and reports omitted records', tool => {
    const payload = projectWorkflowPayload(tool, {
      job_id: 'job-1', status: 'completed', run_id: 'run-1', video_ids: ['video-1'],
      failed_files: Array.from({ length: 102 }, (_, i) => ({ path: `gs://private-bucket/group-${i}/scene.mp4`, file_id: `file-${i}`, video_id: `video-${i}`, error: privateDiagnostic })),
      skipped_files: Array.from({ length: 103 }, (_, i) => ({ path: `private/group-${i}/scene.mp4`, reason: 'duplicate' })),
      failed_files_count: 102, progress: { failed: 125, skipped: 103 }, error_message: privateDiagnostic,
    }, 'summary');
    expect(payload.failed_files).toHaveLength(100);
    expect(payload.skipped_files).toHaveLength(100);
    expect(payload).toMatchObject({ failed_files_count: 125, failed_files_omitted_count: 25, skipped_files_count: 103, skipped_files_omitted_count: 3 });
    expect((payload.failed_files as any[]).slice(0, 2)).toEqual([
      { path: 'scene.mp4', file_id: 'file-0', video_id: 'video-0', error_code: 'import_failed', error: 'Import failed. Open the job to review this file before retrying the failed import.' },
      { path: 'scene.mp4', file_id: 'file-1', video_id: 'video-1', error_code: 'import_failed', error: 'Import failed. Open the job to review this file before retrying the failed import.' },
    ]);
    expect((payload.links as any).import_job).toBe('https://app.vectormethods.com/jobs?tab=imports&job=job-1');
    expect((payload.links as any).open_in_app).toContain('video=video-1');
    expect(JSON.stringify(payload)).not.toMatch(/secret-signature|private-bucket|password|private-reservation|group-/);
    expect(validate(payload).valid).toBe(true);
  });

  it('reports counts without claiming unavailable issue records were returned', () => {
    const payload = projectWorkflowPayload('find', { job_id: 'job-1', status: 'failed', failed_files_count: 0, progress: { failed: 4, skipped: 2 } }, 'summary');
    expect(payload).toMatchObject({ failed_files: [], failed_files_count: 4, failed_files_omitted_count: 4, skipped_files: [], skipped_files_count: 2, skipped_files_omitted_count: 2 });
  });

  it('retains basenames while removing provider locations and download capabilities', () => {
    const payload = projectWorkflowPayload('get_import_job', {
      job_id: 'job-1', status: 'failed', failed_files: [
        { path: 'https://user:password@storage.googleapis.com/private-bucket/scene%20one.mp4?X-Goog-Signature=secret#fragment' },
        { path: 'C:\\private\\folder\\scene.mp4' },
        { path: 'gs://private-bucket/folder/scene.mp4?token=secret' },
        { path: 'https://user:password@storage.googleapis.com', file_id: privateDiagnostic },
        { file_name: 'display.mp4', path: privateDiagnostic },
      ],
    }, 'summary');
    expect((payload.failed_files as any[]).map(row => row.path)).toEqual(['scene one.mp4', 'scene.mp4', 'scene.mp4', 'File 4', 'display.mp4']);
    expect((payload.failed_files as any[])[3]).not.toHaveProperty('file_id');
    expect(JSON.stringify(payload)).not.toMatch(/storage\.googleapis|private-bucket|private\\|password|secret|fragment/);
  });

  it('uses only supported structured failure codes and skip reasons', () => {
    const payload = projectWorkflowPayload('retry_import_job', {
      job_id: 'job-1', status: 'failed', failed_files: [
        { path: 'a.mp4', error_code: 'authorization_denied', error: privateDiagnostic },
        { path: 'b.mp4', code: 'validation_source_changed', error: privateDiagnostic },
        { path: 'c.mp4', error_code: 'provider_private_failure', error: privateDiagnostic },
        { path: 'd.mp4', error_code: 'toString', error: privateDiagnostic },
        { path: 'e.mp4', error: 'Import source size changed before transfer.' },
      ], skipped_files: ['too_large', 'unsupported_format', 'duplicate', privateDiagnostic, '__proto__'].map(reason => ({ path: 'scene.mp4', reason })),
    }, 'summary');
    expect((payload.failed_files as any[]).map(row => row.error_code)).toEqual(['authorization_denied', 'validation_source_changed', 'import_failed', 'import_failed', 'import_failed']);
    expect((payload.failed_files as any[])[0].error).toContain('Check connector access');
    expect((payload.failed_files as any[])[1].error).toContain('Retry with the current file');
    expect((payload.skipped_files as any[]).map(row => row.reason)).toEqual(['too_large', 'unsupported_format', 'duplicate', 'not_imported', 'not_imported']);
    expect(JSON.stringify(payload)).not.toMatch(/provider_private_failure|secret-signature|__proto__|toString/);
    expect(validate(payload).valid).toBe(true);
  });

  it.each(['api-key', 'oauth'] as const)('mirrors safe import details through the real %s tool handler', async authenticationKind => {
    const backend = {
      getImportJob: vi.fn().mockResolvedValue({
        job_id: 'job-1', status: 'failed', progress: { total_files: 2, imported: 0, failed: 1, skipped: 1, bytes_transferred: 0 },
        video_ids: [], error_message: privateDiagnostic,
        failed_files: [{ path: 'gs://private-bucket/scene.mp4', error: privateDiagnostic }],
        skipped_files: [{ path: 'gs://private-bucket/large.mp4', reason: 'too_large' }],
      }),
    } as unknown as VideoVectorClient;
    const result = await executeTool('get_import_job', { job_id: 'job-1' }, backend, { authenticationKind });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(JSON.parse(result.content[0]!.text));
    expect(result.structuredContent).toMatchObject({ failed_files: [{ path: 'scene.mp4', error_code: 'import_failed' }], skipped_files: [], skipped_files_count: 1 });
    expect(result.content[0]!.text).not.toMatch(/private-bucket|secret-signature|password/);
    expect(validate(result.structuredContent).valid).toBe(true);
  });

  it('rejects malformed issue collections without reflecting raw diagnostics', async () => {
    for (const failedFiles of [privateDiagnostic, [null]]) {
      const payload = { job_id: 'job-1', status: 'failed', failed_files: failedFiles };
      const result = await projectWorkflowResult('get_import_job', { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }, 'summary', client);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]!.text).not.toContain('secret-signature');
    }
  });
});
