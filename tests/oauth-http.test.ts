import { generateKeyPair, SignJWT, exportJWK, type CryptoKey, type JWK } from 'jose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createHttpApp, type HttpConfig } from '../src/index.js';
import { FIREBASE_UID_CLAIM } from '../src/http/oauth-token-verifier.js';

const ISSUER = 'https://issuer.example.com';
const JWKS_URL = `${ISSUER}/oauth2/jwks`;
const RESOURCE = 'https://api.example.com/mcp';
const RESOURCE_METADATA_URL =
  'https://api.example.com/.well-known/oauth-protected-resource/mcp';
const OAUTH_UNPUBLISHED_TOOLS = [
  'create_gcs_connector',
  'create_s3_connector',
  'create_azure_connector',
  'list_connectors',
  'test_connector',
  'browse_connector_files',
  'create_import_job',
  'list_import_jobs',
  'retry_import_job',
  'create_webhook',
  'list_webhooks',
  'get_webhook',
  'update_webhook',
  'list_webhook_events',
  'test_webhook',
  'list_webhook_deliveries',
];

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: 'RS256',
    kid: 'stage-key',
    use: 'sig',
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const oauthHttpConfig: HttpConfig = {
  mode: 'http',
  baseUrl: 'https://api.example.com/api/v2',
  timeout: 30_000,
  maxRetries: 0,
  port: 0,
  host: '127.0.0.1',
  allowedHosts: [],
  allowedOrigins: [],
  enableJsonResponse: true,
  shutdownDrainTimeoutMs: 25_000,
  oauthEnabled: true,
  oauthMetadataEnabled: true,
  oauthIssuer: ISSUER,
  oauthJwksUrl: JWKS_URL,
  oauthResource: RESOURCE,
  oauthClockSkewSeconds: 60,
};

function initializeRequest(id: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'oauth-test-client', version: '1.0.0' },
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
    params: { name, arguments: name === 'browse' ? {resource:'indexes'} : {} },
  };
}

async function oauthToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    iss: ISSUER,
    aud: RESOURCE,
    sub: 'user_01abc',
    sid: 'session_01abc',
    jti: `jwt_${now}`,
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
    [FIREBASE_UID_CLAIM]: 'firebase-user-1',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'stage-key' })
    .sign(privateKey);
}

function jwksResponse(): Response {
  return new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('hosted MCP OAuth authentication', () => {
  it.each(['/health', '/mcp/health'])('keeps %s checks local and JWKS-free', async path => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(oauthHttpConfig);
    const response = await request(app as any).get(path);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exposes protocol initialization and OAuth tool metadata before first link', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const context = createHttpApp(oauthHttpConfig);

    const initialized = await request(context.app as any)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('anonymous-initialize'));
    expect(initialized.status).toBe(200);
    expect(initialized.body.result.serverInfo.name).toBe('videovector');
    expect(initialized.body.result.capabilities).not.toHaveProperty('resources');

    const listed = await request(context.app as any)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('anonymous-tools'));
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools).toHaveLength(6);
    const names = listed.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('get_analysis');
    for (const unpublishedTool of OAUTH_UNPUBLISHED_TOOLS) {
      expect(names).not.toContain(unpublishedTool);
    }
    for (const tool of listed.body.result.tools as Array<Record<string, any>>) {
      expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }]);
      expect(tool._meta?.securitySchemes).toEqual(tool.securitySchemes);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['browse', 'find', 'play_workflow_media'])('challenges anonymous %s at the HTTP boundary before backend access', async tool => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const context = createHttpApp(oauthHttpConfig);
    const response = await request(context.app as any)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(callToolRequest('anonymous-call', tool));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_token');
    const challenge = response.headers['www-authenticate'];
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('error_description=');
    expect(challenge).toContain(
      `resource_metadata="${RESOURCE_METADATA_URL}"`
    );
    expect(context.activeRequests.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['resources/list', 'resources/read', 'resources/subscribe'])('keeps a path-aware HTTP challenge for retired %s requests before first link', async method => {
    const context = createHttpApp(oauthHttpConfig);
    const response = await request(context.app as any)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 'anonymous-subscription', method, params: { uri: 'private://account' } });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_token');
    expect(response.headers['www-authenticate']).toContain(
      `resource_metadata="${RESOURCE_METADATA_URL}"`
    );
    expect(context.activeRequests.size).toBe(0);
  });

  it('rejects mixed credentials before JWT or API-key verification', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const context = createHttpApp(oauthHttpConfig);
    const response = await request(context.app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${await oauthToken()}`)
      .set('X-API-Key', `sk_live_${'a'.repeat(48)}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('ambiguous'));

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('ambiguous_credentials');
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never turns an explicit API-key rejection into an OAuth prompt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Invalid API key' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    const { app } = createHttpApp(oauthHttpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', `sk_live_${'a'.repeat(48)}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('invalid-api-key'));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_api_key');
    expect(response.headers['www-authenticate']).toBeUndefined();
  });

  it('accepts a full-account token without product scopes and advertises empty scopes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jwksResponse()));
    const { app } = createHttpApp(oauthHttpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${await oauthToken()}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('oauth-tools'));

    expect(response.status).toBe(200);
    expect(response.body.result.tools).toHaveLength(6);
    expect(response.body.result.tools.map((tool: { name: string }) => tool.name))
      .toContain('analyze');
    const names = response.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('get_analysis');
    for (const unpublishedTool of OAUTH_UNPUBLISHED_TOOLS) {
      expect(names).not.toContain(unpublishedTool);
    }
    for (const tool of response.body.result.tools as Array<Record<string, any>>) {
      expect(tool.securitySchemes).toEqual([{ type: 'oauth2', scopes: [] }]);
      expect(tool._meta?.securitySchemes).toEqual(tool.securitySchemes);
    }
  });

  it.each(OAUTH_UNPUBLISHED_TOOLS)('rejects OAuth calls to unpublished %s before backend dispatch', async (tool) => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(JWKS_URL);
      return jwksResponse();
    });
    vi.stubGlobal('fetch', fetchSpy);
    const context = createHttpApp(oauthHttpConfig);
    const response = await request(context.app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${await oauthToken()}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(callToolRequest(`unpublished-${tool}`, tool));

    expect(response.status).toBe(200);
    expect(response.body.result.isError).toBe(true);
    expect(JSON.parse(response.body.result.content[0].text)).toEqual({
      error: true,
      message: `Tool is not available in this transport: ${tool}`,
      next_action: { type: 'correct_arguments' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(context.activeRequests.size).toBe(0);
  });

  it('preserves the same six-name HTTP tool surface for API-key clients', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(oauthHttpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('X-API-Key', `sk_live_${'a'.repeat(48)}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('api-key-tools'));

    expect(response.status).toBe(200);
    const names = response.body.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toHaveLength(6);
    for (const retired of OAUTH_UNPUBLISHED_TOOLS) expect(names).not.toContain(retired);
    expect(names).toContain('analyze');
    for (const tool of response.body.result.tools as Array<Record<string, any>>) {
      expect(tool.securitySchemes).toBeUndefined();
      expect(tool._meta?.securitySchemes).toBeUndefined();
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts protocol initialization with a valid OAuth token', async () => {
    const token = await oauthToken();
    const fetchSpy = vi.fn().mockImplementation(async (url: string) =>
      url === JWKS_URL ? jwksResponse()
        : new Response(JSON.stringify({ accepted: true, wake_status: 'accepted' }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(oauthHttpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest('oauth-initialize'));

    expect(response.status).toBe(200);
    expect(response.body.result.serverInfo.name).toBe('videovector');
    const activity = fetchSpy.mock.calls.find(([url]) => url.endsWith('/auth/processing-activity'));
    expect(activity).toBeDefined();
    const init = activity![1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    expect(init.headers).not.toHaveProperty('X-API-Key');
    expect(JSON.parse(init.body as string)).toMatchObject({ surface: 'mcp', reason: 'authentication' });
  });

  it('honors configured expiration skew through the SDK bearer middleware', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jwksResponse()));
    const now = Math.floor(Date.now() / 1_000);
    const { app } = createHttpApp(oauthHttpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${await oauthToken({
        iat: now - 300,
        nbf: now - 300,
        exp: now - 30,
      })}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('oauth-expiration-skew'));

    expect(response.status).toBe(200);
  });

  it.each(['Bearer   %s', 'Bearer\t%s'])(
    'normalizes accepted bearer whitespace before SDK verification: %s',
    async (authorizationTemplate) => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => jwksResponse()));
      const { app } = createHttpApp(oauthHttpConfig);
      const token = await oauthToken();
      const response = await request(app as any)
        .post('/mcp')
        .set('Authorization', authorizationTemplate.replace('%s', token))
        .set('Accept', 'application/json, text/event-stream')
        .send(listToolsRequest('oauth-whitespace'));

      expect(response.status).toBe(200);
    }
  );

  it('keeps OAuth tool metadata hidden until its independent flag is enabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jwksResponse()));
    const { app } = createHttpApp({
      ...oauthHttpConfig,
      oauthMetadataEnabled: false,
    });
    const response = await request(app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${await oauthToken()}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(listToolsRequest('hidden-oauth-tools'));

    expect(response.status).toBe(200);
    for (const tool of response.body.result.tools as Array<Record<string, any>>) {
      expect(tool.securitySchemes).toBeUndefined();
      expect(tool._meta?.securitySchemes).toBeUndefined();
    }
  });

  it('forwards the same OAuth bearer token and never adds X-API-Key', async () => {
    const token = await oauthToken();
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.href === JWKS_URL) {
        return jwksResponse();
      }
      expect(url.pathname).toBe('/api/v2/workflow/mcp/browse');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${token}`);
      expect(headers['X-API-Key']).toBeUndefined();
      return new Response(JSON.stringify({content:[{type:'text',text:'{}'}],structuredContent:{items:[],next_action:{type:'select_resource'}}}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(oauthHttpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(callToolRequest('forward-token', 'browse'));

    expect(response.status).toBe(200);
    expect(response.body.result.isError).not.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    'authentication_invalid_token',
    'authentication_invalid_oauth_token',
    'authentication_expired_token',
  ])('turns backend %s into a runtime OAuth challenge', async (code) => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.href === JWKS_URL) {
        return jwksResponse();
      }
      return new Response(
        JSON.stringify({ error: { code, message: 'token rejected' } }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(oauthHttpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${await oauthToken()}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(callToolRequest(`backend-${code}`, 'browse'));

    expect(response.status).toBe(200);
    expect(response.body.result.isError).toBe(true);
    expect(response.body.result._meta?.['mcp/www_authenticate']).toContain(
      `resource_metadata="${RESOURCE_METADATA_URL}"`
    );
  });

  it.each([
    [403, 'authorization_denied'],
    [402, 'billing_payment_required'],
    [503, 'authentication_service_unavailable'],
  ])('does not turn HTTP %i %s into an OAuth prompt', async (status, code) => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.href === JWKS_URL) {
        return jwksResponse();
      }
      return new Response(
        JSON.stringify({ error: { code, message: 'request denied' } }),
        { status, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { app } = createHttpApp(oauthHttpConfig);
    const response = await request(app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${await oauthToken()}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(callToolRequest(`backend-${code}`, 'browse'));

    expect(response.status).toBe(200);
    expect(response.body.result.isError).toBe(true);
    expect(response.body.result._meta?.['mcp/www_authenticate']).toBeUndefined();
  });

  it.each([
    ['initialize', initializeRequest('invalid-oauth-initialize')],
    ['tools/list', listToolsRequest('invalid-oauth-list')],
    ['tools/call', callToolRequest('invalid-oauth-call', 'browse')],
  ])('returns an HTTP OAuth challenge for an invalid bearer on %s', async (_method, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ keys: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    const context = createHttpApp(oauthHttpConfig);
    const response = await request(context.app as any)
      .post('/mcp')
      .set('Authorization', `Bearer ${await oauthToken()}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(body);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('invalid_token');
    expect(response.headers['www-authenticate']).toContain(
      `resource_metadata="${RESOURCE_METADATA_URL}"`
    );
    expect(context.activeRequests.size).toBe(0);
  });
});
