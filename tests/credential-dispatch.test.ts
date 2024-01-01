import { describe, expect, it } from 'vitest';

import { dispatchHttpCredential } from '../src/http/credential-dispatch.js';
import { isValidPublicApiKeyFormat } from '../src/index.js';

function publicApiKey(seed: number): string {
  return `sk_live_${seed.toString(16).padStart(48, '0')}`;
}

const oauthOptions = {
  oauthEnabled: true,
  oauthMetadataEnabled: true,
  isValidApiKey: isValidPublicApiKeyFormat,
};

describe('HTTP credential dispatch', () => {
  it('rejects mixed credentials without assigning precedence', () => {
    expect(
      dispatchHttpCredential(
        {
          authorization: 'Bearer oauth-token',
          'x-api-key': publicApiKey(1),
        },
        oauthOptions
      )
    ).toMatchObject({
      kind: 'error',
      status: 400,
      error: 'ambiguous_credentials',
      oauthChallenge: false,
    });
  });

  it('routes X-API-Key and sk_live bearer credentials through legacy auth', () => {
    const apiKey = publicApiKey(2);
    expect(
      dispatchHttpCredential({ 'x-api-key': apiKey }, oauthOptions)
    ).toEqual({ kind: 'api-key', apiKey, source: 'x-api-key' });
    expect(
      dispatchHttpCredential({ authorization: `Bearer ${apiKey}` }, oauthOptions)
    ).toEqual({ kind: 'api-key', apiKey, source: 'bearer' });
  });

  it('never treats a malformed sk_live bearer as OAuth', () => {
    expect(
      dispatchHttpCredential(
        { authorization: `Bearer sk_live_${'a'.repeat(47)}` },
        oauthOptions
      )
    ).toMatchObject({
      kind: 'error',
      error: 'invalid_api_key',
      oauthChallenge: false,
    });
  });

  it('routes every other strict bearer token through OAuth when enabled', () => {
    expect(
      dispatchHttpCredential(
        { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature' },
        oauthOptions
      )
    ).toEqual({
      kind: 'oauth',
      token: 'eyJhbGciOiJSUzI1NiJ9.payload.signature',
    });
  });

  it('preserves API-key-only behavior while OAuth is disabled', () => {
    expect(
      dispatchHttpCredential(
        { authorization: 'Bearer firebase-browser-token' },
        {
          ...oauthOptions,
          oauthEnabled: false,
          oauthMetadataEnabled: false,
        }
      )
    ).toMatchObject({
      kind: 'error',
      error: 'invalid_api_key',
      oauthChallenge: false,
    });
  });

  it('challenges missing and malformed bearer credentials only when advertised', () => {
    expect(dispatchHttpCredential({}, oauthOptions)).toMatchObject({
      kind: 'error',
      error: 'invalid_token',
      oauthChallenge: true,
    });
    expect(
      dispatchHttpCredential({ authorization: 'Basic abc' }, oauthOptions)
    ).toMatchObject({
      kind: 'error',
      error: 'invalid_token',
      oauthChallenge: true,
    });
    expect(
      dispatchHttpCredential(
        {},
        { ...oauthOptions, oauthMetadataEnabled: false }
      )
    ).toMatchObject({
      kind: 'error',
      error: 'missing_api_key',
      oauthChallenge: false,
    });
  });

  it('rejects duplicate header values', () => {
    expect(
      dispatchHttpCredential(
        { authorization: ['Bearer one', 'Bearer two'] },
        oauthOptions
      )
    ).toMatchObject({
      kind: 'error',
      status: 400,
      error: 'ambiguous_credentials',
    });
  });
});
