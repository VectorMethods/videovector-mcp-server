import request from 'supertest';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  authenticateRequestHeaders,
  createHttpApp,
  loadBaseConfig,
  loadHttpConfig,
  loadStdioConfig,
  type BaseConfig,
  type HttpConfig,
} from '../src/index.js';
import { ApiKeyVerifier } from '../src/http/api-key-verifier.js';
import { VideoVectorApiError } from '../src/types/index.js';

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

function listToolsRequest(id: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: {},
  };
}

function callToolRequest(id: string, name: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: {},
    },
  };
}

function successfulValidation(): Response {
  return new Response(null, { status: 204 });
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
  enableJsonResponse: true,
  shutdownDrainTimeoutMs: 25_000,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('stateless HTTP transport authentication', () => {
  it('returns readiness without exposing process-local session state', async () => {
    const { app } = createHttpApp(httpConfig);
    const response = await request(app as any).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      transport: 'http',
      active_requests: 0,
    });
  });

  it('requires a canonical API key on every POST', async () => {
    const { app } = createHttpApp(httpConfig);
    const response = await request(app as any).post('/mcp').send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('missing_api_key');
  });

  it.each([
    `sk_live_${'a'.repeat(47)}`,
    `sk_live_${'A'.repeat(48)}`,
    `sk_test_${'a'.repeat(48)}`,
    `sk_live_${'g'.repeat(48)}`,
  ])('rejects malformed key %s before backend verification', async (candidate) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(httpConfig);

    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', candidate)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('format-check'));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_api_key');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain(candidate);
  });

  it('gives explicit X-API-Key precedence over an ambient bearer token', () => {
    const apiKey = publicApiKey(43);
    const auth = authenticateRequestHeaders({
      authorization: 'Bearer firebase-jwt-from-browser-session',
      'x-api-key': apiKey,
    });

    expect(auth).toEqual({ apiKey });
  });

  it('accepts canonical bearer authentication on a stateless POST', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulValidation()));
    const { app } = createHttpApp(httpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${publicApiKey(44)}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('bearer-auth'));

    expect(response.status).toBe(200);
    expect(response.headers['mcp-session-id']).toBeUndefined();
  });

  it('validates against the side-effect-free auth endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(successfulValidation());
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(httpConfig);

    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(1))
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('validate-path'));

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v2/auth/validate');
    expect(init.method).toBe('GET');
  });

  it('rejects invalid credentials before allocating request state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Invalid API key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    const context = createHttpApp(httpConfig);

    const response = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(2))
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('invalid-key'));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_api_key');
    expect(context.activeRequests.size).toBe(0);
  });

  it('preserves backend authentication rate limiting without allocation', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'slow down' }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '7',
        },
      })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const context = createHttpApp(httpConfig);
    const apiKey = publicApiKey(45);

    const first = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('rate-limited-1'));
    const cached = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('rate-limited-2'));

    expect(first.status).toBe(429);
    expect(first.body.error).toBe('api_key_verification_rate_limited');
    expect(first.headers['retry-after']).toBe('5');
    expect(cached.status).toBe(429);
    expect(cached.headers['retry-after']).toBe('5');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(context.activeRequests.size).toBe(0);
  });

  it('rejects protocol-incompatible requests before backend verification', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(httpConfig);

    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(3))
      .set('Accept', 'application/json')
      .send(initializeRequest('bad-accept'));

    expect(response.status).toBe(406);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not write API keys or backend response text to logs', async () => {
    const apiKey = publicApiKey(4);
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
      .send(initializeRequest('sanitized-log'));

    expect(response.status).toBe(502);
    const logs = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logs).toContain('authentication_service_unavailable');
    expect(logs).not.toContain(apiKey);
    expect(logs).not.toContain('backend rejected');
  });

  it('singleflights and negative-caches the same invalid credential', async () => {
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
    const apiKey = publicApiKey(5);

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
    const pending = Promise.all([first.then((value) => value), second.then((value) => value)]);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    releaseBackend();

    expect((await pending).map((response) => response.status)).toEqual([401, 401]);
    const cached = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('negative-cache'));
    expect(cached.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('positive-caches validation across independent stateless requests', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(successfulValidation());
    vi.stubGlobal('fetch', fetchSpy);
    const context = createHttpApp(httpConfig);
    const apiKey = publicApiKey(6);

    const initialized = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('positive-cache-1'));
    const listed = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('positive-cache-2'));

    expect(initialized.status).toBe(200);
    expect(listed.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(context.activeRequests.size).toBe(0));
  });

  it('admits more than ten valid tenants behind one direct peer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(successfulValidation());
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(httpConfig);

    for (let seed = 20; seed < 32; seed += 1) {
      const response = await request(app as any)
        .post('/mcp')
        .set('X-API-Key', publicApiKey(seed))
        .set('Accept', 'application/json, text/event-stream')
        .send(initializeRequest(`tenant-${seed}`));
      expect(response.status).toBe(200);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(12);
  });
});

describe('stateless HTTP lifecycle', () => {
  it('does not issue a session header and closes per-request state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successfulValidation()));
    const closeSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');
    const context = createHttpApp(httpConfig);

    const response = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(40))
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('stateless'));

    expect(response.status).toBe(200);
    expect(response.headers['mcp-session-id']).toBeUndefined();
    await vi.waitFor(() => expect(context.activeRequests.size).toBe(0));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('closes request state exactly once when the client aborts', async () => {
    let releaseBackend!: () => void;
    const blockedBackend = new Promise<Response>((resolve) => {
      releaseBackend = () =>
        resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(successfulValidation())
        .mockImplementationOnce(() => blockedBackend)
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const closeSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');
    const context = createHttpApp(httpConfig);
    const pending = request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(46))
      .set('Accept', 'application/json, text/event-stream')
      .send(callToolRequest('abort-request', 'list_indexes'));
    pending.end(() => {});

    await vi.waitFor(() => expect(context.activeRequests.size).toBe(1));
    pending.abort();
    await vi.waitFor(() => expect(context.activeRequests.size).toBe(0));
    expect(closeSpy).toHaveBeenCalledTimes(1);

    releaseBackend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain(publicApiKey(46));
  });

  it('force-closes only active contexts after the graceful drain bound', async () => {
    let releaseBackend!: () => void;
    const blockedBackend = new Promise<Response>((resolve) => {
      releaseBackend = () =>
        resolve(
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        );
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(successfulValidation())
        .mockImplementationOnce(() => blockedBackend)
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const closeSpy = vi.spyOn(StreamableHTTPServerTransport.prototype, 'close');
    const context = createHttpApp(httpConfig);
    const pending = request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(47))
      .set('Accept', 'application/json, text/event-stream')
      .send(callToolRequest('drain-request', 'list_indexes'));
    pending.end(() => {});

    await vi.waitFor(() => expect(context.activeRequests.size).toBe(1));
    await context.drainActiveRequests(10);
    expect(context.activeRequests.size).toBe(0);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    pending.abort();
    releaseBackend();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('handles a follow-up request on another instance without affinity', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(successfulValidation());
    vi.stubGlobal('fetch', fetchSpy);
    const firstInstance = createHttpApp(httpConfig);
    const restartedInstance = createHttpApp(httpConfig);
    const apiKey = publicApiKey(41);

    const initialized = await request(firstInstance.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('instance-one'));
    const listed = await request(restartedInstance.app as any)
      .post('/mcp')
      .set('X-API-Key', apiKey)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('instance-two'));

    expect(initialized.status).toBe(200);
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects stale stateful client headers explicitly', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { app } = createHttpApp(httpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(42))
      .set('MCP-Session-Id', 'obsolete-session')
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('stale-session'));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('session_state_not_supported');
  });

  it.each(['get', 'delete'] as const)(
    'returns protocol-shaped 405 for %s /mcp',
    async (method) => {
      const { app } = createHttpApp(httpConfig);
      const response = await (request(app as any) as any)[method]('/mcp');

      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe('POST, OPTIONS');
      expect(response.body).toEqual({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
    }
  );

  it('stops admission and reports draining readiness', async () => {
    const context = createHttpApp(httpConfig);
    context.startDraining();

    const health = await request(context.app as any).get('/health');
    const rejected = await request(context.app as any)
      .post('/mcp')
      .set('X-API-Key', publicApiKey(43))
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('during-drain'));

    expect(health.status).toBe(503);
    expect(health.body.status).toBe('draining');
    expect(rejected.status).toBe(503);
    expect(rejected.headers['retry-after']).toBe('5');
    expect(rejected.body.error.code).toBe(-32001);
  });
});

describe('bounded API-key verifier', () => {
  it('limits backend validation concurrency while preserving queued tenants', async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const validate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          releases.push(() => {
            active -= 1;
            resolve();
          });
        })
    );
    const verifier = new ApiKeyVerifier(baseConfig, {
      validate,
      maxConcurrentValidations: 2,
      maxQueuedValidations: 4,
      queueTimeoutMs: 5_000,
    });

    const pending = Array.from({ length: 6 }, (_, index) =>
      verifier.verify(publicApiKey(100 + index))
    );
    await vi.waitFor(() => expect(verifier.getStats()).toMatchObject({
      active: 2,
      queued: 4,
    }));

    while (releases.length > 0 || verifier.getStats().queued > 0) {
      releases.splice(0).forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 6 }, () => ({ ok: true }))
    );
    expect(maxActive).toBe(2);
  });

  it('fails excess queue admission without starting backend work', async () => {
    let release!: () => void;
    const validate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const verifier = new ApiKeyVerifier(baseConfig, {
      validate,
      maxConcurrentValidations: 1,
      maxQueuedValidations: 1,
      queueTimeoutMs: 5_000,
    });

    const active = verifier.verify(publicApiKey(200));
    const queued = verifier.verify(publicApiKey(201));
    await vi.waitFor(() => expect(verifier.getStats().queued).toBe(1));
    const rejected = await verifier.verify(publicApiKey(202));

    expect(rejected).toMatchObject({
      ok: false,
      status: 503,
      error: 'api_key_verification_busy',
    });
    expect(validate).toHaveBeenCalledTimes(1);
    release();
    await active;
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(2));
    release();
    await queued;
  });

  it('times out queued validation without leaking a queue slot', async () => {
    let release!: () => void;
    const validate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const verifier = new ApiKeyVerifier(baseConfig, {
      validate,
      maxConcurrentValidations: 1,
      maxQueuedValidations: 1,
      queueTimeoutMs: 10,
    });

    const active = verifier.verify(publicApiKey(210));
    const timedOut = await verifier.verify(publicApiKey(211));
    expect(timedOut).toMatchObject({
      ok: false,
      error: 'api_key_verification_busy',
    });
    expect(verifier.getStats().queued).toBe(0);
    release();
    await active;
  });

  it('transient-caches backend failures separately from invalid credentials', async () => {
    let nowMs = 1_000;
    const validate = vi.fn().mockRejectedValue(
      new VideoVectorApiError('unavailable', 'backend_unavailable', 503)
    );
    const verifier = new ApiKeyVerifier(baseConfig, {
      validate,
      now: () => nowMs,
      transientCacheTtlMs: 5_000,
    });
    const key = publicApiKey(220);

    expect(await verifier.verify(key)).toMatchObject({
      ok: false,
      status: 502,
    });
    expect(await verifier.verify(key)).toMatchObject({
      ok: false,
      status: 502,
    });
    expect(validate).toHaveBeenCalledTimes(1);

    nowMs += 5_001;
    await verifier.verify(key);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('expires the positive cache at its configured boundary', async () => {
    let nowMs = 5_000;
    const validate = vi.fn().mockResolvedValue(undefined);
    const verifier = new ApiKeyVerifier(baseConfig, {
      validate,
      now: () => nowMs,
      positiveCacheTtlMs: 100,
    });
    const key = publicApiKey(230);

    expect(await verifier.verify(key)).toEqual({ ok: true });
    nowMs += 99;
    expect(await verifier.verify(key)).toEqual({ ok: true });
    expect(validate).toHaveBeenCalledTimes(1);
    nowMs += 1;
    expect(await verifier.verify(key)).toEqual({ ok: true });
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('expires confirmed-invalid cache entries independently', async () => {
    let nowMs = 10_000;
    const validate = vi.fn().mockRejectedValue(
      new VideoVectorApiError('invalid', 'http_401', 401)
    );
    const verifier = new ApiKeyVerifier(baseConfig, {
      validate,
      now: () => nowMs,
      negativeCacheTtlMs: 100,
    });
    const key = publicApiKey(231);

    expect(await verifier.verify(key)).toMatchObject({
      ok: false,
      error: 'invalid_api_key',
    });
    nowMs += 99;
    await verifier.verify(key);
    expect(validate).toHaveBeenCalledTimes(1);
    nowMs += 1;
    await verifier.verify(key);
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('bounds cache cardinality under sustained distinct invalid keys', async () => {
    const validate = vi.fn().mockRejectedValue(
      new VideoVectorApiError('invalid', 'http_401', 401)
    );
    const verifier = new ApiKeyVerifier(baseConfig, {
      validate,
      maxCacheEntries: 2,
    });

    await verifier.verify(publicApiKey(240));
    await verifier.verify(publicApiKey(241));
    await verifier.verify(publicApiKey(242));

    expect(verifier.getStats().cached).toBe(2);
    await verifier.verify(publicApiKey(240));
    expect(validate).toHaveBeenCalledTimes(4);
  });

  it('retains recently used entries when bounded cache eviction runs', async () => {
    const validate = vi.fn().mockRejectedValue(
      new VideoVectorApiError('invalid', 'http_401', 401)
    );
    const verifier = new ApiKeyVerifier(baseConfig, {
      validate,
      maxCacheEntries: 2,
    });
    const hotKey = publicApiKey(250);
    const coldKey = publicApiKey(251);

    await verifier.verify(hotKey);
    await verifier.verify(coldKey);
    await verifier.verify(hotKey);
    await verifier.verify(publicApiKey(252));
    await verifier.verify(hotKey);
    expect(validate).toHaveBeenCalledTimes(3);

    await verifier.verify(coldKey);
    expect(validate).toHaveBeenCalledTimes(4);
  });
});

describe('stateless HTTP configuration', () => {
  it('ignores obsolete session controls instead of retaining hidden state', () => {
    const obsolete = {
      MCP_HTTP_MAX_SESSIONS: process.env.MCP_HTTP_MAX_SESSIONS,
      MCP_HTTP_SESSION_IDLE_TTL_SECONDS:
        process.env.MCP_HTTP_SESSION_IDLE_TTL_SECONDS,
    };
    process.env.MCP_HTTP_MAX_SESSIONS = '1';
    process.env.MCP_HTTP_SESSION_IDLE_TTL_SECONDS = '1';
    try {
      const config = loadHttpConfig(baseConfig);
      expect('maxSessions' in config).toBe(false);
      expect('sessionIdleTtlMs' in config).toBe(false);
      expect(config.shutdownDrainTimeoutMs).toBe(25_000);
    } finally {
      if (obsolete.MCP_HTTP_MAX_SESSIONS === undefined) {
        delete process.env.MCP_HTTP_MAX_SESSIONS;
      } else {
        process.env.MCP_HTTP_MAX_SESSIONS = obsolete.MCP_HTTP_MAX_SESSIONS;
      }
      if (obsolete.MCP_HTTP_SESSION_IDLE_TTL_SECONDS === undefined) {
        delete process.env.MCP_HTTP_SESSION_IDLE_TTL_SECONDS;
      } else {
        process.env.MCP_HTTP_SESSION_IDLE_TTL_SECONDS =
          obsolete.MCP_HTTP_SESSION_IDLE_TTL_SECONDS;
      }
    }
  });
});

describe('HTTP CORS policy', () => {
  const corsConfig: HttpConfig = {
    ...httpConfig,
    allowedOrigins: ['https://allowed.example'],
  };

  it('exposes protocol headers without advertising session state', async () => {
    const { app } = createHttpApp(corsConfig);
    const response = await request(app as any)
      .get('/health')
      .set('Origin', 'https://allowed.example');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(
      'https://allowed.example'
    );
    expect(response.headers['access-control-expose-headers']).toBe(
      'Mcp-Protocol-Version'
    );
    expect(response.headers['access-control-expose-headers']).not.toContain(
      'Session'
    );
  });

  it('handles POST-only preflight without session headers', async () => {
    const { app } = createHttpApp(corsConfig);
    const response = await request(app as any)
      .options('/mcp')
      .set('Origin', 'https://allowed.example')
      .set('Access-Control-Request-Method', 'POST')
      .set(
        'Access-Control-Request-Headers',
        'authorization,x-api-key,mcp-protocol-version,content-type'
      );

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-methods']).toBe('POST, OPTIONS');
    expect(response.headers['access-control-allow-headers']).not.toContain(
      'Session'
    );
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
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => loadStdioConfig(baseConfig)).toThrow('process.exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    if (original === undefined) delete process.env.VIDEOVECTOR_API_KEY;
    else process.env.VIDEOVECTOR_API_KEY = original;
  });

  it('accepts valid API key format for stdio mode', () => {
    const original = process.env.VIDEOVECTOR_API_KEY;
    const apiKey = publicApiKey(300);
    process.env.VIDEOVECTOR_API_KEY = apiKey;

    expect(loadStdioConfig(baseConfig).apiKey).toBe(apiKey);
    if (original === undefined) delete process.env.VIDEOVECTOR_API_KEY;
    else process.env.VIDEOVECTOR_API_KEY = original;
  });

  it('ignores obsolete base URL aliases', () => {
    const original = process.env.VIDEOVECTOR_BASE_URL;
    const obsoleteName = 'VIDEO' + 'SEARCH_BASE_URL';
    const originalObsolete = process.env[obsoleteName];
    delete process.env.VIDEOVECTOR_BASE_URL;
    process.env[obsoleteName] = 'https://obsolete.example/api/v2';

    expect(loadBaseConfig().baseUrl).toBe(baseConfig.baseUrl);
    if (original === undefined) delete process.env.VIDEOVECTOR_BASE_URL;
    else process.env.VIDEOVECTOR_BASE_URL = original;
    if (originalObsolete === undefined) delete process.env[obsoleteName];
    else process.env[obsoleteName] = originalObsolete;
  });
});
