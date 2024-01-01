import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  createHttpApp,
  loadStdioConfig,
  authenticateRequestHeaders,
  type BaseConfig,
  type HttpConfig,
} from '../src/index.js';

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
  enableJsonResponse: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it('extracts bearer and x-api-key headers for per-request auth', () => {
    const bearer = authenticateRequestHeaders({ authorization: 'Bearer sk_test_123' });
    const xApiKey = authenticateRequestHeaders({ 'x-api-key': 'sk_live_456' });

    expect('apiKey' in bearer && bearer.apiKey).toBe('sk_test_123');
    expect('apiKey' in xApiKey && xApiKey.apiKey).toBe('sk_live_456');
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
      .set('X-API-Key', 'sk_live_x')
      .send({
        jsonrpc: '2.0',
        id: 'init-1',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_api_key');
    expect(sessions.size).toBe(0);
  });

  it('returns capacity error before creating new sessions when max is reached', async () => {
    const limitedConfig: HttpConfig = { ...httpConfig, maxSessions: 1 };
    const { app, sessions } = createHttpApp(limitedConfig);

    sessions.set('existing', {
      transport: { handleRequest: vi.fn() } as any,
      server: { close: vi.fn().mockResolvedValue(undefined) } as any,
      keyHash: createHash('sha256').update('sk_live_e').digest(),
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', 'sk_live_n')
      .send({
        jsonrpc: '2.0',
        id: 'init-2',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      });

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('session_capacity_reached');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'post', hasBody: true },
    { method: 'get', hasBody: false },
    { method: 'delete', hasBody: false },
  ] as const)(
    'returns controlled error when existing-session transport %s fails',
    async ({ method, hasBody }) => {
      const { app, sessions } = createHttpApp(httpConfig);
      const apiKey = 'sk_test_t';
      const sessionId = 'session-failure-test';

      const transport = {
        handleRequest: vi.fn().mockRejectedValue(new Error('transport exploded')),
      };
      const server = {
        close: vi.fn().mockResolvedValue(undefined),
      };

      sessions.set(sessionId, {
        transport: transport as any,
        server: server as any,
        keyHash: createHash('sha256').update(apiKey).digest(),
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
    const originalLegacy = process.env.VIDEOSEARCH_API_KEY;
    delete process.env.VIDEOVECTOR_API_KEY;
    delete process.env.VIDEOSEARCH_API_KEY;

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
    if (originalLegacy === undefined) {
      delete process.env.VIDEOSEARCH_API_KEY;
    } else {
      process.env.VIDEOSEARCH_API_KEY = originalLegacy;
    }
  });

  it('accepts valid API key format for stdio mode', () => {
    const original = process.env.VIDEOVECTOR_API_KEY;
    const originalLegacy = process.env.VIDEOSEARCH_API_KEY;
    process.env.VIDEOVECTOR_API_KEY = 'sk_live_v';
    delete process.env.VIDEOSEARCH_API_KEY;

    const config = loadStdioConfig(baseConfig);
    expect(config.apiKey).toBe('sk_live_v');

    if (original === undefined) {
      delete process.env.VIDEOVECTOR_API_KEY;
    } else {
      process.env.VIDEOVECTOR_API_KEY = original;
    }
    if (originalLegacy === undefined) {
      delete process.env.VIDEOSEARCH_API_KEY;
    } else {
      process.env.VIDEOSEARCH_API_KEY = originalLegacy;
    }
  });

  it('accepts legacy VIDEOSEARCH_API_KEY during migration', () => {
    const original = process.env.VIDEOVECTOR_API_KEY;
    const originalLegacy = process.env.VIDEOSEARCH_API_KEY;
    delete process.env.VIDEOVECTOR_API_KEY;
    process.env.VIDEOSEARCH_API_KEY = 'sk_test_l';

    const config = loadStdioConfig(baseConfig);
    expect(config.apiKey).toBe('sk_test_l');

    if (original === undefined) {
      delete process.env.VIDEOVECTOR_API_KEY;
    } else {
      process.env.VIDEOVECTOR_API_KEY = original;
    }
    if (originalLegacy === undefined) {
      delete process.env.VIDEOSEARCH_API_KEY;
    } else {
      process.env.VIDEOSEARCH_API_KEY = originalLegacy;
    }
  });
});
