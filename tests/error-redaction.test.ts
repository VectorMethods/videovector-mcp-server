import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { getToolDefinitions } from '../src/tools/definitions.js';

import { VideoVectorApiError } from '../src/types/index.js';
import { formatError, ToolInputError } from '../src/utils/helpers.js';


function payloadFor(error: VideoVectorApiError, authenticationKind?: 'api-key' | 'oauth') {
  const result = formatError(error, { authenticationKind });
  return {
    result,
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}


describe('model-visible backend error redaction', () => {
  it.each([
    ['authentication_invalid_token', 401, 'request_input'],
    ['authorization_denied', 403, 'request_input'],
    ['billing_insufficient_credits', 402, 'request_input'],
    ['resource_quota_exceeded', 409, 'request_input'],
    ['resource_rate_quota_exceeded', 429, 'request_input'],
    ['llm_daily_budget_exceeded', 429, 'request_input'],
    ['validation_error', 400, 'correct_arguments'],
    ['validation_error', 422, 'correct_arguments'],
    ['resource_video_not_found', 404, 'correct_arguments'],
    ['idempotency_key_reused', 409, 'correct_arguments'],
    ['rate_limit_exceeded', 429, 'review_error'],
    ['network_error', 0, 'review_error'],
    ['timeout_error', 408, 'review_error'],
    ['authentication_service_unavailable', 503, 'review_error'],
    ['billing_unavailable', 503, 'review_error'],
    ['unreviewed_backend_error', 500, 'review_error'],
  ])('gives %s a typed action without authorizing mutation retry', (code, status, action) => {
    const { payload } = payloadFor(new VideoVectorApiError('private diagnostic', code, status));
    expect(payload.next_action).toEqual({ type: action });
    expect(payload.next_action).not.toHaveProperty('idempotency_key');
  });

  it.each([
    ['published_search_vectors_unavailable', 'saved text or image vectors', 'Do not automatically resubmit analysis'],
    ['scope_too_large', 'supported by one search', 'Narrow scope.video_ids'],
    ['index_name_ambiguous', 'Multiple accessible libraries', 'browse with resource=indexes'],
    ['validation_search_snapshot_too_large', 'too large to capture', 'more selective metadata filters'],
    ['validation_search_snapshot_result_too_large', 'saved-search size limit', 'Changing page_size alone'],
  ])('retains safe actionable search guidance for %s', (code, message, suggestion) => {
    const { payload } = payloadFor(new VideoVectorApiError('private backend diagnostic', code, 422, { secret: 'private-value' }));
    expect(payload.code).toBe(code);
    expect(payload.message).toContain(message);
    expect(payload.suggestion).toContain(suggestion);
    expect(payload.next_action).toEqual({ type: 'correct_arguments' });
    expect(JSON.stringify(payload)).not.toContain('private');
  });
  it.each([
    ['resource_prompt_run_not_found', 'Use browse with resource=analyses'],
    ['analysis_not_found', 'Use browse with resource=analyses'],
    ['resource_prompt_not_found', 'Use browse with resource=prompts'],
    ['resource_connector_not_found', 'VideoVector app'],
    ['resource_import_job_not_found', 'Use browse with resource=imports'],
    ['resource_export_not_found', 'Do not start new work'],
  ])('uses current recovery guidance for %s on every authentication surface', (code, suggestion) => {
    for (const authenticationKind of [undefined, 'api-key', 'oauth'] as const) {
      const { payload } = payloadFor(new VideoVectorApiError('private diagnostic', code, 404), authenticationKind);
      expect(payload.suggestion).toContain(suggestion);
      expect(payload.next_action).toEqual({type:'correct_arguments'});
      expect(payload.suggestion).not.toMatch(/list_analyses|list_prompts|get_prompt|list_connectors|list_import_jobs|upload_media|export_index_metadata|export_prompt_run|job_id/);
    }
  });
  it('recommends browse argument combinations accepted by the current schema', () => {
    const validator = new AjvJsonSchemaValidator();
    for (const advertiseOAuth of [false,true]) {
      const definition = getToolDefinitions({advertiseOAuth,includeLocalUpload:false}).find(tool=>tool.name==='browse')!;
      const validate = validator.getValidator(definition.inputSchema);
      for (const args of [{resource:'analyses'}, {resource:'imports'}, {resource:'prompts',ids:['prompt-1']}, {resource:'indexes',name:'Library'}]) {
        expect(validate(args).valid).toBe(true);
      }
    }
    const {payload}=payloadFor(new VideoVectorApiError('private diagnostic','index_name_ambiguous',422));
    expect(payload.suggestion).toContain('resource=indexes and name');
    expect(payload.suggestion).not.toContain('with index_name');
  });

  it('keeps an allowlisted code and fixed message without diagnostic fields', () => {
    const { payload } = payloadFor(
      new VideoVectorApiError(
        'quota failed for tenant_internal_42 at /srv/private/path',
        'resource_quota_exceeded',
        409,
        {
          request_id: 'req_private_42',
          stack: 'Error: secret stack',
          debug: { credential: 'do-not-expose' },
        },
        'req_private_42'
      )
    );

    expect(payload).toMatchObject({
      error: true,
      code: 'resource_quota_exceeded',
      message: 'The account resource quota has been reached.',
      recoverable: true,
    });
    expect(payload.details).toBeUndefined();
    expect(payload.request_id).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('tenant_internal_42');
    expect(JSON.stringify(payload)).not.toContain('req_private_42');
    expect(JSON.stringify(payload)).not.toContain('do-not-expose');
    expect(JSON.stringify(payload)).not.toContain('/srv/private/path');
  });

  it('collapses unreviewed backend codes and messages to one safe service error', () => {
    const { payload } = payloadFor(
      new VideoVectorApiError(
        'DatabaseError collection=users key=internal-user-77',
        'database_replica_debug_failure',
        500,
        { stack: 'private-stack', raw_response: 'private-response' },
        'req_internal_77'
      )
    );

    expect(payload).toMatchObject({
      error: true,
      code: 'service_error',
      message: 'The VideoVector service could not complete the request.',
      recoverable: true,
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /database_replica|internal-user|private-stack|private-response|req_internal/
    );
  });

  it('retains OAuth relinking for allowlisted token failures only', () => {
    const relinkable = payloadFor(
      new VideoVectorApiError(
        'raw token parser diagnostic',
        'authentication_invalid_oauth_token',
        401,
        { debug: 'private' },
        'req_auth_private'
      ),
      'oauth'
    );
    const unavailable = payloadFor(
      new VideoVectorApiError(
        'provider trace identifier',
        'authentication_service_unavailable',
        503,
        { provider_request_id: 'private-provider-id' }
      ),
      'oauth'
    );

    expect(relinkable.result.oauthAuthenticationFailure).toBe(true);
    expect(relinkable.payload).toMatchObject({
      code: 'authentication_invalid_oauth_token',
      message: 'The VideoVector authorization is no longer valid.',
      recoverable: false,
    });
    expect(unavailable.result.oauthAuthenticationFailure).toBe(false);
    expect(unavailable.payload.code).toBe('authentication_service_unavailable');
    expect(JSON.stringify(unavailable.payload)).not.toContain('private-provider-id');
  });

  it('preserves a safe billing result without turning it into OAuth relinking', () => {
    const { result, payload } = payloadFor(
      new VideoVectorApiError(
        'customer=internal_customer_1 payment_intent=private',
        'billing_payment_required',
        402,
        { stripe_customer_id: 'cus_private' },
        'req_billing_private'
      ),
      'oauth'
    );

    expect(result.oauthAuthenticationFailure).toBe(false);
    expect(payload).toMatchObject({
      code: 'billing_payment_required',
      message: 'The account requires billing attention before this operation can continue.',
      recoverable: true,
    });
    expect(String(payload.suggestion)).toContain('billing status');
    expect(JSON.stringify(payload)).not.toMatch(/internal_customer|cus_private|req_billing/);
  });

  it('never reflects arbitrary Error or thrown values into model-visible output', () => {
    for (const authenticationKind of [undefined, 'api-key', 'oauth'] as const) {
      for (const unsafeError of [
        new Error('credential=secret-value path=/srv/private request=req_private'),
        'raw provider failure with token=secret-value',
      ]) {
        const result = formatError(unsafeError, { authenticationKind });
        const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

        expect(payload).toEqual({
          error: true,
          code: 'tool_error',
          message: 'The tool could not complete the request.',
          recoverable: true,
          next_action: { type: 'review_error' },
        });
        expect(JSON.stringify(payload)).not.toMatch(/secret-value|srv\/private|req_private/);
      }
    }
  });

  it('preserves only explicitly typed local input guidance for OAuth callers', () => {
    const result = formatError(
      new ToolInputError("Required parameter 'video_id' is missing"),
      { authenticationKind: 'oauth' }
    );
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(result.oauthAuthenticationFailure).toBeUndefined();
    expect(payload).toEqual({
      error: true,
      code: 'invalid_tool_input',
      message: "Required parameter 'video_id' is missing",
      recoverable: true,
      next_action: { type: 'correct_arguments' },
    });
  });

  it('does not treat backend validation diagnostics as trusted local input guidance', () => {
    const { payload } = payloadFor(
      new VideoVectorApiError(
        'invalid field at /srv/private/tenant-42; token=secret-value',
        'validation_error',
        400,
        { raw: 'private backend detail' }
      ),
      'oauth'
    );

    expect(payload).toMatchObject({
      error: true,
      code: 'validation_error',
      message: 'The request did not pass validation.',
      recoverable: true,
    });
    expect(JSON.stringify(payload)).not.toMatch(/srv\/private|tenant-42|secret-value|backend detail/);
  });

  it('uses neutral account-limit guidance instead of promoting an upgrade', () => {
    const { payload } = payloadFor(
      new VideoVectorApiError(
        'raw quota diagnostic',
        'resource_quota_exceeded',
        409
      ),
      'oauth'
    );

    expect(String(payload.suggestion)).toContain('review the account limits');
    expect(String(payload.suggestion).toLowerCase()).not.toContain('upgrade');
  });
});
