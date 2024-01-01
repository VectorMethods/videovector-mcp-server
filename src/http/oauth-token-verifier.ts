import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { JWTPayload, JWTVerifyGetKey, JWTVerifyResult } from 'jose';

export const FIREBASE_UID_CLAIM = 'https://vectormethods.com/claims/firebase_uid';

const MAX_ACCESS_TOKEN_BYTES = 32_768;
const MAX_CLOCK_SKEW_SECONDS = 300;
const MAX_FIREBASE_UID_LENGTH = 64;
const MAX_KEY_ID_LENGTH = 256;
const MAX_SUBJECT_LENGTH = 512;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_JWT_ID_LENGTH = 256;
const JWKS_TIMEOUT_MS = 3_000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
const INVALID_TOKEN_JOSE_ERROR_CODES = new Set([
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWE_DECRYPTION_FAILED',
  'ERR_JWE_INVALID',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
]);

export interface WorkOSOAuthTokenVerifierConfig {
  issuer: string;
  jwksUrl: string;
  resource: string;
  clockSkewSeconds: number;
}

export interface WorkOSOAuthTokenVerifierOptions {
  now?: () => number;
  keyResolver?: JWTVerifyGetKey;
}

interface OAuthPrincipalExtra extends Record<string, unknown> {
  authenticationKind: 'oauth';
  firebaseUid: string;
  issuer: string;
  jwtId: string;
  subject: string;
  sessionId: string;
  resource: string;
}

function isBoundedIdentity(value: unknown, maximumLength: number): value is string {
  const containsControlCharacter = typeof value === 'string'
    && Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && value.trim() === value
    && !containsControlCharacter
  );
}

function hasExactAudience(audience: JWTPayload['aud'], resource: string): boolean {
  return audience === resource
    || (Array.isArray(audience) && audience.length === 1 && audience[0] === resource);
}

function isJwksAvailabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }
  const code = (error as Error & { code?: unknown }).code;
  if (
    code === 'ERR_JWKS_TIMEOUT'
    || code === 'ERR_JWKS_INVALID'
    || code === 'ERR_JOSE_GENERIC'
  ) {
    return true;
  }
  return (
    error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || error.name === 'TypeError'
  );
}

function isJoseInvalidTokenError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && INVALID_TOKEN_JOSE_ERROR_CODES.has(code);
}

function assertHttpsUrl(name: string, value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.hash.length > 0
  ) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials or a fragment`);
  }
  return parsed;
}

/**
 * Offline WorkOS access-token verification. WorkOS is contacted only through
 * its bounded, process-cached JWKS endpoint; UserInfo and introspection are not
 * part of request authentication.
 */
export class WorkOSOAuthTokenVerifier implements OAuthTokenVerifier {
  private readonly issuer: string;
  private readonly jwksUrl: URL;
  private readonly resource: string;
  private readonly resourceUrl: URL;
  private readonly clockSkewSeconds: number;
  private readonly now: () => number;
  private keyResolver?: JWTVerifyGetKey;
  private joseModule?: Promise<typeof import('jose')>;

  constructor(
    config: WorkOSOAuthTokenVerifierConfig,
    options: WorkOSOAuthTokenVerifierOptions = {}
  ) {
    const issuerUrl = assertHttpsUrl('OAuth issuer', config.issuer);
    this.jwksUrl = assertHttpsUrl('OAuth JWKS URL', config.jwksUrl);
    this.resourceUrl = assertHttpsUrl('OAuth resource', config.resource);
    if (
      issuerUrl.pathname !== '/'
      || issuerUrl.search.length > 0
      || ![issuerUrl.origin, `${issuerUrl.origin}/`].includes(config.issuer)
    ) {
      throw new Error('OAuth issuer must be a canonical HTTPS origin');
    }
    if (
      this.resourceUrl.search.length > 0
      || this.resourceUrl.href !== config.resource
      || config.resource.slice(this.resourceUrl.origin.length).length === 0
    ) {
      throw new Error('OAuth resource must be a canonical HTTPS URL with a path');
    }
    if (this.jwksUrl.href !== `${issuerUrl.origin}/oauth2/jwks`) {
      throw new Error(
        'OAuth JWKS URL must be the issuer HTTPS /oauth2/jwks endpoint'
      );
    }
    if (
      !Number.isInteger(config.clockSkewSeconds)
      || config.clockSkewSeconds < 0
      || config.clockSkewSeconds > MAX_CLOCK_SKEW_SECONDS
    ) {
      throw new Error('OAuth clock skew must be an integer from 0 through 300');
    }
    this.issuer = issuerUrl.origin;
    this.resource = config.resource;
    this.clockSkewSeconds = config.clockSkewSeconds;
    this.now = options.now ?? Date.now;
    this.keyResolver = options.keyResolver;
  }

  private async jose(): Promise<typeof import('jose')> {
    this.joseModule ??= import('jose');
    return this.joseModule;
  }

  private async verifyJwt(token: string): Promise<JWTVerifyResult<JWTPayload>> {
    const jose = await this.jose();
    this.keyResolver ??= jose.createRemoteJWKSet(this.jwksUrl, {
      timeoutDuration: JWKS_TIMEOUT_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    });
    return jose.jwtVerify(token, this.keyResolver, {
      algorithms: ['RS256'],
      issuer: this.issuer,
      audience: this.resource,
      requiredClaims: ['exp', 'iat', 'sub'],
      clockTolerance: this.clockSkewSeconds,
      currentDate: new Date(this.now()),
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (
      typeof token !== 'string'
      || token.length === 0
      || Buffer.byteLength(token, 'utf8') > MAX_ACCESS_TOKEN_BYTES
    ) {
      throw new InvalidTokenError('Access token is malformed');
    }

    try {
      const { payload, protectedHeader } = await this.verifyJwt(token);
      if (!isBoundedIdentity(protectedHeader.kid, MAX_KEY_ID_LENGTH)) {
        throw new InvalidTokenError('Access token signing key is invalid');
      }
      if (!hasExactAudience(payload.aud, this.resource)) {
        throw new InvalidTokenError('Access token audience is invalid');
      }
      if (!isBoundedIdentity(payload.sub, MAX_SUBJECT_LENGTH)) {
        throw new InvalidTokenError('Access token subject is invalid');
      }
      if (
        !Number.isInteger(payload.iat)
        || Number(payload.iat) <= 0
        || Number(payload.iat) > Math.floor(this.now() / 1_000) + this.clockSkewSeconds
      ) {
        throw new InvalidTokenError('Access token issued-at time is invalid');
      }
      if (
        !Number.isInteger(payload.exp)
        || Number(payload.exp) <= Number(payload.iat)
      ) {
        throw new InvalidTokenError('Access token expiration is invalid');
      }
      const firebaseUid = payload[FIREBASE_UID_CLAIM];
      if (!isBoundedIdentity(firebaseUid, MAX_FIREBASE_UID_LENGTH)) {
        throw new InvalidTokenError('Access token account identity is invalid');
      }
      if (!isBoundedIdentity(payload.sid, MAX_SESSION_ID_LENGTH)) {
        throw new InvalidTokenError('Access token session identity is invalid');
      }
      if (!isBoundedIdentity(payload.jti, MAX_JWT_ID_LENGTH)) {
        throw new InvalidTokenError('Access token JWT identity is invalid');
      }
      const clientId = isBoundedIdentity(payload.client_id, MAX_SUBJECT_LENGTH)
        ? payload.client_id
        : isBoundedIdentity(payload.azp, MAX_SUBJECT_LENGTH)
          ? payload.azp
          : payload.sub;
      const extra: OAuthPrincipalExtra = {
        authenticationKind: 'oauth',
        firebaseUid,
        issuer: this.issuer,
        jwtId: payload.jti,
        subject: payload.sub,
        sessionId: payload.sid,
        resource: this.resource,
      };
      return {
        token,
        clientId,
        // OAuth represents the signed-in Firebase account, not legacy API-key
        // scope grants. Backend ownership, plan, and entitlement checks remain
        // authoritative for every operation.
        scopes: [],
        // The MCP SDK bearer middleware performs its own strict expiresAt
        // comparison after this verifier returns. Expose the same effective
        // admission deadline jose has already enforced so the configured clock
        // tolerance is not silently narrowed by that second check.
        expiresAt: Number(payload.exp) + this.clockSkewSeconds,
        resource: new URL(this.resourceUrl.href),
        extra,
      };
    } catch (error) {
      if (error instanceof InvalidTokenError || error instanceof ServerError) {
        throw error;
      }
      if (isJwksAvailabilityError(error)) {
        throw new ServerError('OAuth token verification is temporarily unavailable');
      }
      if (isJoseInvalidTokenError(error)) {
        throw new InvalidTokenError('Access token is invalid');
      }
      throw new ServerError('OAuth token verification is temporarily unavailable');
    }
  }
}
