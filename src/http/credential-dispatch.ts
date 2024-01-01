import type { IncomingHttpHeaders } from 'node:http';

export type HttpCredential =
  | {
      kind: 'api-key';
      apiKey: string;
      source: 'x-api-key' | 'bearer';
    }
  | {
      kind: 'oauth';
      token: string;
    };

export interface CredentialDispatchError {
  kind: 'error';
  status: 400 | 401;
  error: string;
  message: string;
  oauthChallenge: boolean;
}

export type CredentialDispatchResult = HttpCredential | CredentialDispatchError;

export interface CredentialDispatchOptions {
  oauthEnabled: boolean;
  oauthMetadataEnabled: boolean;
  isValidApiKey: (candidate: string) => boolean;
}

function singleHeaderValue(
  value: string | string[] | undefined
): { present: false } | { present: true; value?: string; duplicate: boolean } {
  if (value === undefined) {
    return { present: false };
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      return { present: true, duplicate: true };
    }
    return { present: true, value: value[0], duplicate: false };
  }
  return { present: true, value, duplicate: false };
}

function error(
  status: 400 | 401,
  code: string,
  message: string,
  oauthChallenge: boolean = false
): CredentialDispatchError {
  return {
    kind: 'error',
    status,
    error: code,
    message,
    oauthChallenge,
  };
}

/**
 * Classifies one HTTP credential without performing network or cryptographic
 * work. Mixed credential schemes are rejected instead of assigning precedence.
 */
export function dispatchHttpCredential(
  headers: IncomingHttpHeaders,
  options: CredentialDispatchOptions
): CredentialDispatchResult {
  const apiKeyHeader = singleHeaderValue(headers['x-api-key']);
  const authorizationHeader = singleHeaderValue(headers.authorization);

  if (apiKeyHeader.present && authorizationHeader.present) {
    return error(
      400,
      'ambiguous_credentials',
      'Send exactly one credential: X-API-Key or Authorization bearer.'
    );
  }

  if (apiKeyHeader.present) {
    if (apiKeyHeader.duplicate) {
      return error(400, 'ambiguous_credentials', 'Send exactly one X-API-Key header.');
    }
    const apiKey = apiKeyHeader.value?.trim() ?? '';
    if (!options.isValidApiKey(apiKey)) {
      return error(
        401,
        'invalid_api_key',
        'API key must use the canonical public sk_live_ format.'
      );
    }
    return { kind: 'api-key', apiKey, source: 'x-api-key' };
  }

  if (authorizationHeader.present) {
    if (authorizationHeader.duplicate) {
      return error(
        400,
        'ambiguous_credentials',
        'Send exactly one Authorization header.'
      );
    }
    const authorization = authorizationHeader.value ?? '';
    const match = authorization.match(/^Bearer[ \t]+([^\s,]+)$/i);
    if (!match?.[1]) {
      return error(
        401,
        options.oauthMetadataEnabled ? 'invalid_token' : 'invalid_api_key',
        'Authorization must use the Bearer scheme with exactly one credential.',
        options.oauthMetadataEnabled
      );
    }

    const token = match[1];
    if (token.startsWith('sk_live_')) {
      if (!options.isValidApiKey(token)) {
        return error(
          401,
          'invalid_api_key',
          'API key must use the canonical public sk_live_ format.'
        );
      }
      return { kind: 'api-key', apiKey: token, source: 'bearer' };
    }

    if (!options.oauthEnabled) {
      return error(
        401,
        'invalid_api_key',
        'API key must use the canonical public sk_live_ format.'
      );
    }
    return { kind: 'oauth', token };
  }

  if (options.oauthMetadataEnabled) {
    return error(
      401,
      'invalid_token',
      'Provide an OAuth bearer token.',
      true
    );
  }
  return error(
    401,
    'missing_api_key',
    'Provide Authorization: Bearer <key> or X-API-Key header.'
  );
}
