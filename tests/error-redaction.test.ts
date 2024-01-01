import { describe, expect, it } from 'vitest';

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
