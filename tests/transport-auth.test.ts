import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHttpApp,
  fingerprintApiKey,
  loadBaseConfig,
  loadStdioConfig,
  authenticateRequestHeaders,
  type BaseConfig,
  type HttpConfig,
} from '../src/index.js';

function publicApiKey(seed: number): string {
  return `sk_live_${seed.toString(16).padStart(48, '0')}`;
}

function initializeRequest(id: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  };
}

async function closeAllSessions(context: ReturnType<typeof createHttpApp>): Promise<void> {
  await Promise.all(
    Array.from(context.sessions.values()).map((session) =>
      session.close({ reason: 'test_cleanup' })
    )
  );
}

const baseConfig: BaseConfig = {
  baseUrl: 'https://api.vectormethods.com/api/v2',
  timeout: 30_000,
  maxRetries: 3,
};

const httpConfig: HttpConfig = {
  ...baseConfig,
  mode: 'http',
  port: 0,
  host: '127.0.0.1',
  allowedHosts: [],
  allowedOrigins: [],
  maxSessions: 10,
  maxSessionsPerKey: 5,
  sessionIdleTtlMs: 30 * 60_000,
  sessionAbsoluteTtlMs: 8 * 60 * 60_000,
  apiKeyCandidatesPerPeer: 5,
  enableJsonResponse: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('API-key fingerprints', () => {
  it('is deterministic within one process and separates distinct API keys', () => {
    const firstKey = publicApiKey(1);
    const secondKey = publicApiKey(2);

    const firstFingerprint = fingerprintApiKey(firstKey);
    const repeatedFingerprint = fingerprintApiKey(firstKey);
    const secondFingerprint = fingerprintApiKey(secondKey);

    expect(firstFingerprint).toHaveLength(32);
    expect(firstFingerprint.equals(repeatedFingerprint)).toBe(true);
    expect(firstFingerprint.equals(secondFingerprint)).toBe(false);
  });
});

describe('http transport auth and readiness', () => {
  it('health endpoint returns 200 for Cloud Run probes', async () => {
    const { app } = createHttpApp(httpConfig);
    const response = await request(app as any).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', transport: 'http' });
  });

  it('rejects /mcp requests without per-request API key', async () => {
    const { app } = createHttpApp(httpConfig);
    const response = await request(app as any).post('/mcp').send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('missing_api_key');
  });

  it('rejects malformed API keys and never echoes key material', async () => {
    const { app } = createHttpApp(httpConfig);
    const leakedCandidate = 'totally-secret-key';

    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', leakedCandidate)
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_api_key');
    expect(JSON.stringify(response.body)).not.toContain(leakedCandidate);
  });

  it.each([
    `sk_live_${'a'.repeat(47)}`,
    `sk_live_${'A'.repeat(48)}`,
    `sk_test_${'a'.repeat(48)}`,
    `sk_live_${'g'.repeat(48)}`,
  ])('rejects non-canonical public key candidate %s before backend verification', async (candidate) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(httpConfig);

    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', candidate)
      .send(initializeRequest('format-check'));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_api_key');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain(candidate);
  });

  it('extracts bearer and x-api-key headers for per-request auth', () => {
    const bearerKey = publicApiKey(1);
    const xApiKeyValue = publicApiKey(2);
    const bearer = authenticateRequestHeaders({ authorization: `Bearer ${bearerKey}` });
    const xApiKey = authenticateRequestHeaders({ 'x-api-key': xApiKeyValue });

    expect('apiKey' in bearer && bearer.apiKey).toBe(bearerKey);
    expect('apiKey' in xApiKey && xApiKey.apiKey).toBe(xApiKeyValue);
  });

  it('gives explicit x-api-key precedence over an ambient bearer token', () => {
    const xApiKeyValue = publicApiKey(43);
    const auth = authenticateRequestHeaders({
      authorization: 'Bearer firebase-jwt-from-browser-session',
      'x-api-key': xApiKeyValue,
    });

    expect(auth).toEqual({ apiKey: xApiKeyValue });
  });

  it('rejects initialize when API key cannot be verified', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Invalid API key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const { app, sessions } = createHttpApp(httpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(3))
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('init-1'));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_api_key');
    expect(sessions.size).toBe(0);
  });

  it('rejects protocol-incompatible initialization before backend verification', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(httpConfig);

    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(8))
      .set('Accept', 'application/json')
      .send(initializeRequest('missing-event-stream-accept'));

    expect(response.status).toBe(406);
    expect(response.body.error).toBe('not_acceptable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never writes backend authentication response text or key material to logs', async () => {
    const apiKey = publicApiKey(9);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'authentication_service_unavailable',
              message: `backend rejected ${apiKey}`,
            },
          }),
          {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = createHttpApp(httpConfig);

    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('sanitized-auth-log'));

    expect(response.status).toBe(502);
    const renderedLogs = errorSpy.mock.calls
      .flat()
      .map((value) => String(value))
      .join(' ');
    expect(renderedLogs).toContain('authentication_service_unavailable');
    expect(renderedLogs).not.toContain(apiKey);
    expect(renderedLogs).not.toContain('backend rejected');
  });

  it('singleflights and negative-caches repeated invalid key candidates by hash', async () => {
    let releaseBackend!: () => void;
    const backendGate = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    const fetchSpy = vi.fn(async () => {
      await backendGate;
      return new Response(JSON.stringify({ detail: 'Invalid API key' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(httpConfig);
    const apiKey = publicApiKey(7);

    const first = request(app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('singleflight-1'));
    const second = request(app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('singleflight-2'));
    const pendingResponses = Promise.all([first.then((response) => response), second.then((response) => response)]);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    releaseBackend();

    const responses = await pendingResponses;
    expect(responses.map((response) => response.status)).toEqual([401, 401]);

    const cached = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('negative-cache'));
    expect(cached.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caps distinct uncached candidates from one direct peer before backend calls', async () => {
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'Invalid API key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(httpConfig);
    const agent = request.agent(app as any);

    for (let seed = 10; seed < 15; seed += 1) {
      const response = await agent
        .post('/mcp')
        .set('X-API-Key', publicApiKey(seed))
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeRequest(`peer-${seed}`));
      expect(response.status).toBe(401);
    }

    const limited = await agent
      .post('/mcp')
      .set('X-API-Key', publicApiKey(15))
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('peer-limited'));
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('api_key_candidate_rate_limited');
    expect(limited.headers['retry-after']).toBe('60');
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('opens the process candidate guard before an eleventh distinct backend check', async () => {
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ detail: 'Invalid API key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchSpy);
    const globalGuardConfig: HttpConfig = {
      ...httpConfig,
      apiKeyCandidatesPerPeer: 11,
    };
    const { app } = createHttpApp(globalGuardConfig);

    for (let seed = 20; seed < 30; seed += 1) {
      const response = await request(app as any)
        .post('/mcp')
        .set('X-API-Key', publicApiKey(seed))
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeRequest(`global-${seed}`));
      expect(response.status).toBe(401);
    }

    const guarded = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(30))
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('global-guarded'));
    expect(guarded.status).toBe(503);
    expect(guarded.body.error).toBe('api_key_verification_guard_open');
    expect(guarded.headers['retry-after']).toBe('60');
    expect(fetchSpy).toHaveBeenCalledTimes(10);
  });

  it('returns capacity error before creating new sessions when max is reached', async () => {
    const limitedConfig: HttpConfig = { ...httpConfig, maxSessions: 1 };
    const { app, sessions } = createHttpApp(limitedConfig);
    const existingKey = publicApiKey(4);

    sessions.set('existing', {
      sessionId: 'existing',
      transport: { handleRequest: vi.fn() } as any,
      server: { close: vi.fn().mockResolvedValue(undefined) } as any,
      keyHash: fingerprintApiKey(existingKey),
      createdAtMs: Date.now(),
      lastActivityAtMs: Date.now(),
      absoluteExpiresAtMs: Date.now() + 60_000,
      touch: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(5))
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('init-2'));

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('session_capacity_reached');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('briefly caches verified key hashes for normal reconnects', async () => {
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchSpy);
    const context = createHttpApp(httpConfig);
    const apiKey = publicApiKey(40);

    const first = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('positive-cache-1'));
    const second = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('positive-cache-2'));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(context.sessions.size).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await closeAllSessions(context);
  });

  it('enforces per-key session capacity atomically across concurrent initialization', async () => {
    let releaseBackend!: () => void;
    const backendGate = new Promise<void>((resolve) => {
      releaseBackend = resolve;
    });
    const fetchSpy = vi.fn(async () => {
      await backendGate;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const context = createHttpApp({
      ...httpConfig,
      maxSessionsPerKey: 1,
    });
    const apiKey = publicApiKey(41);

    const first = request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('per-key-race-1'));
    const second = request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('per-key-race-2'));
    const pendingResponses = Promise.all([first.then((response) => response), second.then((response) => response)]);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    releaseBackend();

    const responses = await pendingResponses;
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
    expect(
      responses.find((response) => response.status === 429)?.body.error
    ).toBe('session_key_capacity_reached');
    expect(context.sessions.size).toBe(1);
    await closeAllSessions(context);
  });

  it.each([
    {
      name: 'idle',
      sessionIdleTtlMs: 1_000,
      sessionAbsoluteTtlMs: 10_000,
      elapsedMs: 1_001,
    },
    {
      name: 'absolute',
      sessionIdleTtlMs: 10_000,
      sessionAbsoluteTtlMs: 1_000,
      elapsedMs: 1_001,
    },
  ])('reclaims abandoned sessions at the $name TTL and restores key capacity', async ({
    sessionIdleTtlMs,
    sessionAbsoluteTtlMs,
    elapsedMs,
  }) => {
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchSpy);
    const context = createHttpApp({
      ...httpConfig,
      maxSessionsPerKey: 1,
      sessionIdleTtlMs,
      sessionAbsoluteTtlMs,
    });
    const apiKey = publicApiKey(42);

    const initialized = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest(`ttl-${sessionIdleTtlMs}`));
    expect(initialized.status).toBe(200);
    expect(context.sessions.size).toBe(1);
    const session = Array.from(context.sessions.values())[0];
    expect(session).toBeDefined();

    expect(
      await context.cleanupExpiredSessions((session?.createdAtMs ?? 0) + elapsedMs)
    ).toBe(1);
    expect(context.sessions.size).toBe(0);

    const replacement = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest(`ttl-replacement-${sessionIdleTtlMs}`));
    expect(replacement.status).toBe(200);
    expect(context.sessions.size).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await closeAllSessions(context);
  });

  it.each([
    { method: 'post', hasBody: true },
    { method: 'get', hasBody: false },
    { method: 'delete', hasBody: false },
  ] as const)(
    'returns controlled error when existing-session transport %s fails',
    async ({ method, hasBody }) => {
      const { app, sessions } = createHttpApp(httpConfig);
      const apiKey = publicApiKey(6);
      const sessionId = 'session-failure-test';

      const transport = {
        handleRequest: vi.fn().mockRejectedValue(new Error('transport exploded')),
      };
      const server = {
        close: vi.fn().mockResolvedValue(undefined),
      };

      sessions.set(sessionId, {
        sessionId,
        transport: transport as any,
        server: server as any,
        keyHash: fingerprintApiKey(apiKey),
        createdAtMs: Date.now(),
        lastActivityAtMs: Date.now(),
        absoluteExpiresAtMs: Date.now() + 60_000,
        touch: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      });

      let req = (request(app as any) as any)[method]('/mcp')
        .set('X-API-Key', apiKey)
        .set('MCP-Session-Id', sessionId);

      if (hasBody) {
        req = req.send({});
      }

      const response = await req;
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'http_session_request_failed',
        message: 'Failed to process MCP session request.',
      });
      expect(transport.handleRequest).toHaveBeenCalledTimes(1);
    }
  );
});

describe('http transport origin policy and preflight', () => {
  const corsConfig: HttpConfig = {
    ...httpConfig,
    allowedOrigins: ['https://allowed.example'],
  };

  it('sets CORS headers for allowed origins', async () => {
    const { app } = createHttpApp(corsConfig);
    const response = await request(app as any)
      .get('/health')
      .set('Origin', 'https://allowed.example');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://allowed.example');
    expect(response.headers['access-control-expose-headers']).toContain('Mcp-Session-Id');
    expect(response.headers['access-control-expose-headers']).toContain('MCP-Session-Id');
    expect(response.headers['access-control-expose-headers']).toContain('Mcp-Protocol-Version');
    expect(response.headers.vary).toContain('Origin');
  });

  it('handles CORS preflight for auth/session headers', async () => {
    const { app } = createHttpApp(corsConfig);
    const response = await request(app as any)
      .options('/mcp')
      .set('Origin', 'https://allowed.example')
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'authorization,x-api-key,mcp-protocol-version,mcp-session-id,last-event-id,content-type'
      );

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://allowed.example');
    const allowedHeaders = response.headers['access-control-allow-headers'];
    expect(allowedHeaders).toContain('Authorization');
    expect(allowedHeaders).toContain('Mcp-Protocol-Version');
    expect(allowedHeaders).toContain('Mcp-Session-Id');
    expect(allowedHeaders).toContain('Last-Event-ID');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
  });

  it('rejects disallowed origins', async () => {
    const { app } = createHttpApp(corsConfig);
    const response = await request(app as any)
      .get('/health')
      .set('Origin', 'https://blocked.example');

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('forbidden_origin');
  });
});

describe('stdio transport configuration', () => {
  it('requires VIDEOVECTOR_API_KEY in stdio mode', () => {
    const original = process.env.VIDEOVECTOR_API_KEY;
    delete process.env.VIDEOVECTOR_API_KEY;

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code ?? 0}`);
      }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => loadStdioConfig(baseConfig)).toThrow('process.exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();

    if (original === undefined) {
      delete process.env.VIDEOVECTOR_API_KEY;
    } else {
      process.env.VIDEOVECTOR_API_KEY = original;
    }
  });

  it('accepts valid API key format for stdio mode', () => {
    const original = process.env.VIDEOVECTOR_API_KEY;
    const apiKey = publicApiKey(100);
    process.env.VIDEOVECTOR_API_KEY = apiKey;

    const config = loadStdioConfig(baseConfig);
    expect(config.apiKey).toBe(apiKey);

    if (original === undefined) {
      delete process.env.VIDEOVECTOR_API_KEY;
    } else {
      process.env.VIDEOVECTOR_API_KEY = original;
    }
  });

  it.each([
    `sk_live_${'a'.repeat(47)}`,
    `sk_live_${'A'.repeat(48)}`,
    `sk_test_${'a'.repeat(48)}`,
    'sk_live_short',
  ])('rejects backend-invalid stdio API key %s before startup', (candidate) => {
    const original = process.env.VIDEOVECTOR_API_KEY;
    process.env.VIDEOVECTOR_API_KEY = candidate;
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code ?? 0}`);
      }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => loadStdioConfig(baseConfig)).toThrow('process.exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'Error: Invalid API key format. Expected sk_live_ followed by 48 lowercase hexadecimal characters'
    );

    if (original === undefined) {
      delete process.env.VIDEOVECTOR_API_KEY;
    } else {
      process.env.VIDEOVECTOR_API_KEY = original;
    }
  });

  it('ignores obsolete API key environment aliases', () => {
    const original = process.env.VIDEOVECTOR_API_KEY;
    const obsoleteApiKeyEnv = 'VIDEO' + 'SEARCH_API_KEY';
    const originalObsolete = process.env[obsoleteApiKeyEnv];
    delete process.env.VIDEOVECTOR_API_KEY;
    process.env[obsoleteApiKeyEnv] = 'sk_test_l';

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code ?? 0}`);
      }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => loadStdioConfig(baseConfig)).toThrow('process.exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith('Error: VIDEOVECTOR_API_KEY environment variable is required in stdio mode');

    if (original === undefined) {
      delete process.env.VIDEOVECTOR_API_KEY;
    } else {
      process.env.VIDEOVECTOR_API_KEY = original;
    }
    if (originalObsolete === undefined) {
      delete process.env[obsoleteApiKeyEnv];
    } else {
      process.env[obsoleteApiKeyEnv] = originalObsolete;
    }
  });

  it('ignores obsolete base URL environment aliases', () => {
    const original = process.env.VIDEOVECTOR_BASE_URL;
    const obsoleteBaseUrlEnv = 'VIDEO' + 'SEARCH_BASE_URL';
    const originalObsolete = process.env[obsoleteBaseUrlEnv];
    delete process.env.VIDEOVECTOR_BASE_URL;
    process.env[obsoleteBaseUrlEnv] = 'https://obsolete.example/api/v2';

    const config = loadBaseConfig();
    expect(config.baseUrl).toBe(baseConfig.baseUrl);

    if (original === undefined) {
      delete process.env.VIDEOVECTOR_BASE_URL;
    } else {
      process.env.VIDEOVECTOR_BASE_URL = original;
    }
    if (originalObsolete === undefined) {
      delete process.env[obsoleteBaseUrlEnv];
    } else {
      process.env[obsoleteBaseUrlEnv] = originalObsolete;
    }
  });
});
