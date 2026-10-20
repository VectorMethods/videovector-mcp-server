import { InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  FIREBASE_UID_CLAIM,
  WorkOSOAuthTokenVerifier,
} from '../src/http/oauth-token-verifier.js';

const ISSUER = 'https://issuer.example.com';
const JWKS_URL = `${ISSUER}/oauth2/jwks`;
const RESOURCE = 'https://api.example.com/mcp';
const NOW_SECONDS = 1_800_000_000;

let privateKey: CryptoKey;
let publicJwk: JWK;
let alternatePrivateKey: CryptoKey;
let alternatePublicJwk: JWK;

beforeAll(async () => {
  const primary = await generateKeyPair('RS256');
  const alternate = await generateKeyPair('RS256');
  privateKey = primary.privateKey;
  alternatePrivateKey = alternate.privateKey;
  publicJwk = {
    ...(await exportJWK(primary.publicKey)),
    alg: 'RS256',
    kid: 'primary',
    use: 'sig',
  };
  alternatePublicJwk = {
    ...(await exportJWK(alternate.publicKey)),
    alg: 'RS256',
    kid: 'alternate',
    use: 'sig',
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: RESOURCE,
    sub: 'user_01abc',
    sid: 'session_01abc',
    jti: 'jwt_01abc',
    iat: NOW_SECONDS - 30,
    nbf: NOW_SECONDS - 30,
    exp: NOW_SECONDS + 300,
    [FIREBASE_UID_CLAIM]: 'firebase-user-1',
    ...overrides,
  };
}

async function signToken(
  overrides: Record<string, unknown> = {},
  options: { key?: CryptoKey; kid?: string | null } = {}
): Promise<string> {
  const kid = options.kid === null ? undefined : options.kid ?? 'primary';
  return new SignJWT(claims(overrides))
    .setProtectedHeader({ alg: 'RS256', ...(kid === undefined ? {} : { kid }) })
    .sign(options.key ?? privateKey);
}

function verifier(jwks: JWK[] = [publicJwk]): WorkOSOAuthTokenVerifier {
  return new WorkOSOAuthTokenVerifier(
    {
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      resource: RESOURCE,
      clockSkewSeconds: 60,
    },
    {
      now: () => NOW_SECONDS * 1_000,
      keyResolver: createLocalJWKSet({ keys: jwks }),
    }
  );
}

describe('WorkOS OAuth token verifier', () => {
  it('accepts the signed full-account identity and ignores scope claims', async () => {
    const token = await signToken({ scope: { future: 'shape' } });
    const authInfo = await verifier().verifyAccessToken(token);

    expect(authInfo).toMatchObject({
      token,
      clientId: 'user_01abc',
      scopes: [],
      expiresAt: NOW_SECONDS + 360,
      extra: {
        authenticationKind: 'oauth',
        firebaseUid: 'firebase-user-1',
        issuer: ISSUER,
        jwtId: 'jwt_01abc',
        subject: 'user_01abc',
        sessionId: 'session_01abc',
        resource: RESOURCE,
      },
    });
    expect(authInfo.resource?.href).toBe(RESOURCE);
  });

  it('exposes the jose-validated clock-tolerance deadline to SDK middleware', async () => {
    const authInfo = await verifier().verifyAccessToken(
      await signToken({
        iat: NOW_SECONDS - 300,
        nbf: NOW_SECONDS - 300,
        exp: NOW_SECONDS - 30,
      })
    );

    expect(authInfo.expiresAt).toBe(NOW_SECONDS + 30);
  });

  it('accepts an audience array only when it contains the resource exactly once', async () => {
    await expect(
      verifier().verifyAccessToken(await signToken({ aud: [RESOURCE] }))
    ).resolves.toMatchObject({ scopes: [], resource: new URL(RESOURCE) });
  });

  it.each([
    ['issuer', { iss: 'https://other.example.com' }],
    ['audience', { aud: 'https://api.example.com/other' }],
    ['multiple audiences', { aud: [RESOURCE, 'https://api.example.com/other'] }],
    ['expired token', { exp: NOW_SECONDS - 61 }],
    ['not-before time', { nbf: NOW_SECONDS + 61 }],
    ['future issued-at time', { iat: NOW_SECONDS + 61, exp: NOW_SECONDS + 600 }],
    ['non-integer issued-at time', { iat: NOW_SECONDS - 0.5 }],
    ['expiration before issue', { exp: NOW_SECONDS - 31 }],
    ['subject', { sub: '' }],
    ['long subject', { sub: 's'.repeat(513) }],
    ['session identity', { sid: '' }],
    ['long session identity', { sid: 's'.repeat(513) }],
    ['JWT identity', { jti: '' }],
    ['long JWT identity', { jti: 'j'.repeat(257) }],
    ['Firebase identity', { [FIREBASE_UID_CLAIM]: '' }],
    ['long Firebase identity', { [FIREBASE_UID_CLAIM]: 'u'.repeat(65) }],
  ])('rejects an invalid %s', async (_label, overrides) => {
    await expect(
      verifier().verifyAccessToken(await signToken(overrides))
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a signature from a different key', async () => {
    const token = await signToken({}, { key: alternatePrivateKey, kid: 'primary' });
    await expect(verifier().verifyAccessToken(token)).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it.each([
    ['missing key ID', null],
    ['long key ID', 'k'.repeat(257)],
  ])('rejects a %s', async (_label, kid) => {
    await expect(
      verifier().verifyAccessToken(await signToken({}, { kid }))
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects oversized access tokens before cryptographic work', async () => {
    await expect(verifier().verifyAccessToken('x'.repeat(32_769))).rejects.toBeInstanceOf(
      InvalidTokenError
    );
  });

  it('classifies JWKS network failures as server failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));
    const remoteVerifier = new WorkOSOAuthTokenVerifier(
      {
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        clockSkewSeconds: 60,
      },
      { now: () => NOW_SECONDS * 1_000 }
    );

    await expect(
      remoteVerifier.verifyAccessToken(await signToken())
    ).rejects.toBeInstanceOf(ServerError);
  });

  it('classifies unexpected verifier failures as server failures', async () => {
    const unavailable = new WorkOSOAuthTokenVerifier(
      {
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        clockSkewSeconds: 60,
      },
      {
        now: () => NOW_SECONDS * 1_000,
        keyResolver: async () => {
          throw new Error('unexpected verifier failure');
        },
      }
    );

    await expect(
      unavailable.verifyAccessToken(await signToken())
    ).rejects.toBeInstanceOf(ServerError);
  });

  it('does not refetch JWKS for repeated unknown key IDs during cooldown', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [alternatePublicJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const remoteVerifier = new WorkOSOAuthTokenVerifier(
      {
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        clockSkewSeconds: 60,
      },
      { now: () => NOW_SECONDS * 1_000 }
    );
    const token = await signToken({}, { kid: 'unknown' });

    await expect(remoteVerifier.verifyAccessToken(token)).rejects.toBeInstanceOf(
      InvalidTokenError
    );
    await expect(remoteVerifier.verifyAccessToken(token)).rejects.toBeInstanceOf(
      InvalidTokenError
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fails configuration when JWKS is outside the issuer origin', () => {
    expect(
      () => new WorkOSOAuthTokenVerifier({
        issuer: ISSUER,
        jwksUrl: 'https://keys.example.net/oauth2/jwks',
        resource: RESOURCE,
        clockSkewSeconds: 60,
      })
    ).toThrow('/oauth2/jwks');
  });

  it('fails configuration when issuer is not a canonical origin', () => {
    expect(
      () => new WorkOSOAuthTokenVerifier({
        issuer: `${ISSUER}?tenant=1`,
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        clockSkewSeconds: 60,
      })
    ).toThrow('canonical HTTPS origin');
    expect(
      () => new WorkOSOAuthTokenVerifier({
        issuer: `${ISSUER}/tenant`,
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        clockSkewSeconds: 60,
      })
    ).toThrow('canonical HTTPS origin');
  });

  it('requires the exact issuer JWKS path without a query', () => {
    for (const jwksUrl of [
      `${ISSUER}/keys`,
      `${JWKS_URL}?tenant=1`,
    ]) {
      expect(
        () => new WorkOSOAuthTokenVerifier({
          issuer: ISSUER,
          jwksUrl,
          resource: RESOURCE,
          clockSkewSeconds: 60,
        })
      ).toThrow('/oauth2/jwks');
    }
  });

  it('requires a canonical resource with a path and no query', () => {
    expect(
      () => new WorkOSOAuthTokenVerifier({
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: `${RESOURCE}?tenant=1`,
        clockSkewSeconds: 60,
      })
    ).toThrow('canonical HTTPS URL with a path');
    expect(
      () => new WorkOSOAuthTokenVerifier({
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: 'https://api.example.com',
        clockSkewSeconds: 60,
      })
    ).toThrow('canonical HTTPS URL with a path');
  });

  it('bounds clock skew in the verifier constructor', () => {
    expect(
      () => new WorkOSOAuthTokenVerifier({
        issuer: ISSUER,
        jwksUrl: JWKS_URL,
        resource: RESOURCE,
        clockSkewSeconds: 301,
      })
    ).toThrow('0 through 300');
  });
});
