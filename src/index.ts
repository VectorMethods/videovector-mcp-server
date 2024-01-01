#!/usr/bin/env node

/**
 * VideoVector MCP Server
 *
 * Production MCP server for the VideoVector video understanding platform.
 *
 * Supports two runtime transport modes:
 * - stdio (default): local MCP client integrations (Claude Desktop, Cursor, etc.)
 * - http: Streamable HTTP mode for remote deployment (for example, Cloud Run)
 *
 * Usage:
 *   VIDEOVECTOR_API_KEY=sk_live_xxx videovector-mcp
 *
 * Configuration (environment variables):
 *   MCP_TRANSPORT_MODE - Optional: stdio|http (default: stdio)
 *   VIDEOVECTOR_API_KEY - Required in stdio mode
 *   VIDEOVECTOR_BASE_URL - Optional: API base URL (default: https://api.vectormethods.com/api/v2)
 *   VIDEOVECTOR_TIMEOUT - Optional: Request timeout in ms (default: 90000)
 *   VIDEOVECTOR_MAX_RETRIES - Optional: Max retry attempts (default: 3)
 *
 * HTTP mode environment variables:
 *   PORT - Optional: HTTP port (default: 8080)
 *   MCP_HTTP_HOST - Optional: bind host (default: 0.0.0.0)
 *   MCP_HTTP_ALLOWED_HOSTS - Optional: comma-separated allowed hostnames
 *   MCP_HTTP_ALLOWED_ORIGINS - Optional: comma-separated allowed origins
 *   MCP_HTTP_MAX_SESSIONS - Optional: max in-memory HTTP sessions (default: 200)
 *   MCP_HTTP_MAX_SESSIONS_PER_KEY - Optional: per-key session cap (default: 5)
 *   MCP_HTTP_SESSION_IDLE_TTL_SECONDS - Optional: idle session TTL (default: 1800)
 *   MCP_HTTP_SESSION_ABSOLUTE_TTL_SECONDS - Optional: absolute session TTL (default: 28800)
 *   MCP_HTTP_API_KEY_CANDIDATES_PER_PEER - Optional: uncached candidates/minute
 *     from the direct network peer (default: 5, hard-capped at 11)
 *   MCP_HTTP_ENABLE_JSON_RESPONSE - Optional: true|false (default: false)
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type CallToolRequest,
  type ListToolsRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { VideoVectorClient } from './client/index.js';
import { VideoVectorApiError } from './types/index.js';
import { TOOL_DEFINITIONS, executeTool } from './tools/index.js';
import { PACKAGE_VERSION } from './version.js';

// ============================================================================
// Configuration
// ============================================================================

type TransportMode = 'stdio' | 'http';

export interface BaseConfig {
  baseUrl: string;
  timeout: number;
  maxRetries: number;
}

export interface StdioConfig extends BaseConfig {
  mode: 'stdio';
  apiKey: string;
}

export interface HttpConfig extends BaseConfig {
  mode: 'http';
  port: number;
  host: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxSessions: number;
  maxSessionsPerKey: number;
  sessionIdleTtlMs: number;
  sessionAbsoluteTtlMs: number;
  apiKeyCandidatesPerPeer: number;
  enableJsonResponse: boolean;
}

interface SessionContext {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  keyHash: Buffer;
  createdAtMs: number;
  lastActivityAtMs: number;
  absoluteExpiresAtMs: number;
  touch: (nowMs?: number) => void;
  close: (options?: SessionCloseOptions) => Promise<void>;
}

interface SessionCloseOptions {
  closeTransport?: boolean;
  closeServer?: boolean;
  reason?: string;
}

export interface HttpAppContext {
  app: ReturnType<typeof createMcpExpressApp>;
  sessions: Map<string, SessionContext>;
  cleanupExpiredSessions: (nowMs?: number) => Promise<number>;
}

type HttpRequest = IncomingMessage & { body?: unknown; headers: IncomingHttpHeaders };
type HttpResponse = ServerResponse<IncomingMessage> & {
  status: (code: number) => HttpResponse;
  json: (body: unknown) => HttpResponse;
};
type HttpNext = () => void;

const DEFAULT_BASE_URL = 'https://api.vectormethods.com/api/v2';
const PUBLIC_API_KEY_PATTERN = /^sk_live_[0-9a-f]{48}$/;
const API_KEY_CANDIDATE_WINDOW_MS = 60_000;
const API_KEY_GLOBAL_CANDIDATE_LIMIT = 10;
const API_KEY_NEGATIVE_CACHE_TTL_MS = 10 * 60_000;
const API_KEY_POSITIVE_CACHE_TTL_MS = 60_000;
const API_KEY_TRANSIENT_CACHE_TTL_MS = 5_000;
const API_KEY_PEER_CACHE_LIMIT = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export function readTransportMode(): TransportMode {
  const mode = (process.env.MCP_TRANSPORT_MODE ?? 'stdio').trim().toLowerCase();

  if (mode === 'stdio' || mode === 'http') {
    return mode;
  }

  console.error(`Error: MCP_TRANSPORT_MODE must be "stdio" or "http", got "${mode}"`);
  process.exit(1);
}

export function readPositiveInteger(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`Error: ${name} must be a positive integer, got "${raw}"`);
    process.exit(1);
  }

  return parsed;
}

export function readNonNegativeInteger(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.error(`Error: ${name} must be a non-negative integer, got "${raw}"`);
    process.exit(1);
  }

  return parsed;
}

export function readBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  console.error(`Error: ${name} must be "true" or "false", got "${raw}"`);
  process.exit(1);
}

export function readCsv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function loadBaseConfig(): BaseConfig {
  return {
    baseUrl: process.env.VIDEOVECTOR_BASE_URL ?? DEFAULT_BASE_URL,
    timeout: readPositiveInteger('VIDEOVECTOR_TIMEOUT', 90000),
    maxRetries: readNonNegativeInteger('VIDEOVECTOR_MAX_RETRIES', 3),
  };
}

export function isValidApiKeyFormat(apiKey: string): boolean {
  return isValidPublicApiKeyFormat(apiKey);
}

export function isValidPublicApiKeyFormat(apiKey: string): boolean {
  return PUBLIC_API_KEY_PATTERN.test(apiKey);
}

export function loadStdioConfig(baseConfig: BaseConfig): StdioConfig {
  const apiKey = process.env.VIDEOVECTOR_API_KEY;
  if (!apiKey) {
    console.error('Error: VIDEOVECTOR_API_KEY environment variable is required in stdio mode');
    console.error('');
    console.error('Usage:');
    console.error('  VIDEOVECTOR_API_KEY=sk_live_xxx videovector-mcp');
    process.exit(1);
  }

  if (!isValidApiKeyFormat(apiKey)) {
    console.error(
      'Error: Invalid API key format. Expected sk_live_ followed by 48 lowercase hexadecimal characters'
    );
    process.exit(1);
  }

  return {
    mode: 'stdio',
    apiKey,
    ...baseConfig,
  };
}

export function loadHttpConfig(baseConfig: BaseConfig): HttpConfig {
  const maxSessions = readPositiveInteger('MCP_HTTP_MAX_SESSIONS', 200);
  return {
    mode: 'http',
    port: readPositiveInteger('PORT', 8080),
    host: process.env.MCP_HTTP_HOST ?? '0.0.0.0',
    allowedHosts: readCsv('MCP_HTTP_ALLOWED_HOSTS'),
    allowedOrigins: readCsv('MCP_HTTP_ALLOWED_ORIGINS'),
    maxSessions,
    maxSessionsPerKey: Math.min(
      readPositiveInteger('MCP_HTTP_MAX_SESSIONS_PER_KEY', 5),
      maxSessions
    ),
    sessionIdleTtlMs:
      readPositiveInteger('MCP_HTTP_SESSION_IDLE_TTL_SECONDS', 1_800) * 1_000,
    sessionAbsoluteTtlMs:
      readPositiveInteger('MCP_HTTP_SESSION_ABSOLUTE_TTL_SECONDS', 28_800) * 1_000,
    apiKeyCandidatesPerPeer: Math.min(
      readPositiveInteger('MCP_HTTP_API_KEY_CANDIDATES_PER_PEER', 5),
      API_KEY_GLOBAL_CANDIDATE_LIMIT + 1
    ),
    enableJsonResponse: readBoolean('MCP_HTTP_ENABLE_JSON_RESPONSE', false),
    ...baseConfig,
  };
}

function createClient(apiKey: string, config: BaseConfig): VideoVectorClient {
  return new VideoVectorClient({
    apiKey,
    baseUrl: config.baseUrl,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
  });
}

export function extractApiKeyFromHeaders(headers: IncomingHttpHeaders): string | null {
  // Match the API's canonical authentication precedence. Browser clients can
  // carry an ambient Firebase bearer while explicitly selecting a tenant API
  // key for MCP; the explicit X-API-Key must remain authoritative.
  const xApiKey = headers['x-api-key'];
  const headerValue = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
    return headerValue.trim();
  }

  const authorization = headers.authorization;
  const authValue = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof authValue === 'string') {
    const match = authValue.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function readSessionId(headers: IncomingHttpHeaders): string | null {
  const value = headers['mcp-session-id'];
  const sessionId = Array.isArray(value) ? value[0] : value;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return null;
  }
  return sessionId.trim();
}

function acceptsStreamableHttpResponse(headers: IncomingHttpHeaders): boolean {
  const rawAccept = headers.accept;
  const accept = Array.isArray(rawAccept) ? rawAccept.join(',') : rawAccept;
  if (typeof accept !== 'string') {
    return false;
  }

  const mediaTypes = new Set(
    accept
      .split(',')
      .map((value) => value.split(';', 1)[0]?.trim().toLowerCase())
      .filter((value): value is string => Boolean(value))
  );
  return mediaTypes.has('application/json') && mediaTypes.has('text/event-stream');
}

function hashApiKey(apiKey: string): Buffer {
  return createHash('sha256').update(apiKey).digest();
}

function hashApiKeyForCache(apiKey: string): string {
  return hashApiKey(apiKey).toString('hex');
}

function apiKeyMatchesHash(apiKey: string, expectedHash: Buffer): boolean {
  const receivedHash = hashApiKey(apiKey);
  return receivedHash.length === expectedHash.length && timingSafeEqual(receivedHash, expectedHash);
}

function hashDirectPeer(req: HttpRequest): string {
  // Never trust client-controlled forwarding headers here. The direct socket
  // peer is the only identity available without an explicitly configured,
  // verifiable proxy chain.
  const directPeer = req.socket.remoteAddress ?? 'unknown-direct-peer';
  return createHash('sha256').update(`peer:${directPeer}`).digest('hex');
}

function appendVaryHeader(res: HttpResponse, value: string): void {
  const existing = res.getHeader('Vary');
  if (typeof existing === 'string') {
    const values = existing
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.length > 0);
    if (!values.includes(value.toLowerCase())) {
      res.setHeader('Vary', `${existing}, ${value}`);
    }
    return;
  }
  res.setHeader('Vary', value);
}

type HttpSessionAuthCheckResult =
  | { client: VideoVectorClient }
  | {
      status: number;
      error: string;
      message: string;
      retryAfterSeconds?: number;
    };

type HttpSessionAuthFailure = Exclude<HttpSessionAuthCheckResult, { client: VideoVectorClient }>;

function invalidApiKeyResult(): HttpSessionAuthFailure {
  return {
    status: 401,
    error: 'invalid_api_key',
    message: 'API key is invalid or revoked.',
  };
}

function peerCandidateLimitResult(): HttpSessionAuthFailure {
  return {
    status: 429,
    error: 'api_key_candidate_rate_limited',
    message: 'Too many distinct API key candidates from this network peer. Retry shortly.',
    retryAfterSeconds: 60,
  };
}

function globalCandidateGuardResult(): HttpSessionAuthFailure {
  return {
    status: 503,
    error: 'api_key_verification_guard_open',
    message: 'API key verification is temporarily unavailable. Retry shortly.',
    retryAfterSeconds: 60,
  };
}

async function verifyApiKeyAgainstBackend(
  apiKey: string,
  config: BaseConfig
): Promise<HttpSessionAuthCheckResult> {
  // Verification is deliberately single-shot. Retrying a rejected candidate
  // would amplify the backend's shared-IP invalid-key circuit.
  const verificationClient = new VideoVectorClient({
    apiKey,
    baseUrl: config.baseUrl,
    timeout: config.timeout,
    maxRetries: 0,
  });

  try {
    // Verify API key validity before allocating session/server objects.
    await verificationClient.listIndexes(false);
    return { client: createClient(apiKey, config) };
  } catch (error) {
    if (error instanceof VideoVectorApiError) {
      if (error.isAuthError()) {
        return invalidApiKeyResult();
      }

      if (error.statusCode === 429) {
        return {
          status: 429,
          error: 'api_key_verification_rate_limited',
          message: 'API key verification is rate limited. Retry shortly.',
        };
      }
    }

    // Do not log backend response text here. Authentication failures can carry
    // caller-controlled content, while API keys must never be recoverable from
    // verification logs or cache diagnostics.
    const failureLabel =
      error instanceof VideoVectorApiError
        ? `${error.code} (HTTP ${error.statusCode})`
        : error instanceof Error
          ? error.name
          : 'unknown_error';
    console.error('[videovector-mcp] API key verification failed:', failureLabel);

    return {
      status: 502,
      error: 'api_key_verification_failed',
      message: 'Unable to verify API key at this time.',
    };
  }
}

interface CachedAuthFailure {
  expiresAtMs: number;
  result: HttpSessionAuthFailure;
}

class HttpApiKeyCandidateVerifier {
  private readonly positiveCache = new Map<string, number>();
  private readonly negativeCache = new Map<string, number>();
  private readonly transientFailureCache = new Map<string, CachedAuthFailure>();
  private readonly inFlight = new Map<string, Promise<HttpSessionAuthCheckResult>>();
  private readonly globalCandidates = new Map<string, number>();
  private readonly peerCandidates = new Map<string, Map<string, number>>();

  constructor(
    private readonly config: BaseConfig,
    private readonly perPeerLimit: number
  ) {}

  private prune(nowMs: number): void {
    for (const [keyHash, expiresAtMs] of this.positiveCache) {
      if (expiresAtMs <= nowMs) this.positiveCache.delete(keyHash);
    }
    for (const [keyHash, expiresAtMs] of this.negativeCache) {
      if (expiresAtMs <= nowMs) this.negativeCache.delete(keyHash);
    }
    for (const [keyHash, cached] of this.transientFailureCache) {
      if (cached.expiresAtMs <= nowMs) this.transientFailureCache.delete(keyHash);
    }
    for (const [keyHash, expiresAtMs] of this.globalCandidates) {
      if (expiresAtMs <= nowMs) this.globalCandidates.delete(keyHash);
    }
    for (const [peerHash, candidates] of this.peerCandidates) {
      for (const [keyHash, expiresAtMs] of candidates) {
        if (expiresAtMs <= nowMs) candidates.delete(keyHash);
      }
      if (candidates.size === 0) this.peerCandidates.delete(peerHash);
    }
  }

  async verify(
    apiKey: string,
    peerHash: string,
    nowMs: number = Date.now()
  ): Promise<HttpSessionAuthCheckResult> {
    this.prune(nowMs);
    const keyHash = hashApiKeyForCache(apiKey);

    if ((this.positiveCache.get(keyHash) ?? 0) > nowMs) {
      return { client: createClient(apiKey, this.config) };
    }
    if ((this.negativeCache.get(keyHash) ?? 0) > nowMs) {
      return invalidApiKeyResult();
    }
    const transient = this.transientFailureCache.get(keyHash);
    if (transient && transient.expiresAtMs > nowMs) {
      return transient.result;
    }
    const existingFlight = this.inFlight.get(keyHash);
    if (existingFlight) {
      return existingFlight;
    }

    const existingPeerCandidates = this.peerCandidates.get(peerHash);
    const peerAlreadyCounted = existingPeerCandidates?.has(keyHash) ?? false;
    if (!peerAlreadyCounted && (existingPeerCandidates?.size ?? 0) >= this.perPeerLimit) {
      return peerCandidateLimitResult();
    }
    if (!existingPeerCandidates && this.peerCandidates.size >= API_KEY_PEER_CACHE_LIMIT) {
      return peerCandidateLimitResult();
    }

    const globallyCounted = this.globalCandidates.has(keyHash);
    if (!globallyCounted && this.globalCandidates.size >= API_KEY_GLOBAL_CANDIDATE_LIMIT) {
      return globalCandidateGuardResult();
    }

    const expiresAtMs = nowMs + API_KEY_CANDIDATE_WINDOW_MS;
    if (!globallyCounted) {
      this.globalCandidates.set(keyHash, expiresAtMs);
    }
    if (!peerAlreadyCounted) {
      const candidates = existingPeerCandidates ?? new Map<string, number>();
      candidates.set(keyHash, expiresAtMs);
      this.peerCandidates.set(peerHash, candidates);
    }

    const verification = verifyApiKeyAgainstBackend(apiKey, this.config);
    this.inFlight.set(keyHash, verification);
    try {
      const result = await verification;
      const completedAtMs = Date.now();
      if ('client' in result) {
        this.positiveCache.set(keyHash, completedAtMs + API_KEY_POSITIVE_CACHE_TTL_MS);
      } else if (result.error === 'invalid_api_key') {
        this.negativeCache.set(keyHash, completedAtMs + API_KEY_NEGATIVE_CACHE_TTL_MS);
      } else {
        this.transientFailureCache.set(keyHash, {
          expiresAtMs: completedAtMs + API_KEY_TRANSIENT_CACHE_TTL_MS,
          result,
        });
      }
      return result;
    } finally {
      if (this.inFlight.get(keyHash) === verification) {
        this.inFlight.delete(keyHash);
      }
    }
  }
}

async function handleExistingSessionRequest(
  transport: StreamableHTTPServerTransport,
  req: HttpRequest,
  res: HttpResponse,
  body?: unknown
): Promise<void> {
  try {
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error(
      '[videovector-mcp] Failed to handle existing MCP session request:',
      error instanceof Error ? error.message : String(error)
    );
    if (!res.headersSent) {
      res.status(500).json({
        error: 'http_session_request_failed',
        message: 'Failed to process MCP session request.',
      });
    }
  }
}

function createMcpServer(client: VideoVectorClient): Server {
  const server = new Server(
    {
      name: 'videovector',
      version: PACKAGE_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    console.error(`[videovector-mcp] Tool called: ${name}`);

    const result = await executeTool(name, (args ?? {}) as Record<string, unknown>, client);
    return {
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError,
    };
  });

  server.onerror = (error: Error) => {
    console.error('[videovector-mcp] Server error:', error.message);
  };

  return server;
}

async function runStdioServer(config: StdioConfig): Promise<void> {
  const client = createClient(config.apiKey, config);
  const server = createMcpServer(client);

  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
      console.error(`[videovector-mcp] Already shutting down, ignoring ${signal}`);
      return;
    }
    isShuttingDown = true;
    console.error(`[videovector-mcp] Received ${signal}, shutting down...`);

    try {
      await server.close();
      console.error('[videovector-mcp] Server closed gracefully');
      process.exit(0);
    } catch (error) {
      console.error('[videovector-mcp] Error during shutdown:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[videovector-mcp] Server started successfully');
  console.error('[videovector-mcp] Transport: stdio');
  console.error(`[videovector-mcp] API: ${config.baseUrl}`);
  console.error(`[videovector-mcp] Tools available: ${TOOL_DEFINITIONS.length}`);
}

export function authenticateRequestHeaders(
  headers: IncomingHttpHeaders
): { apiKey: string } | { error: string; message: string } {
  const apiKey = extractApiKeyFromHeaders(headers);
  if (!apiKey) {
    return {
      error: 'missing_api_key',
      message: 'Provide Authorization: Bearer <key> or X-API-Key header.',
    };
  }

  if (!isValidPublicApiKeyFormat(apiKey)) {
    return {
      error: 'invalid_api_key',
      message: 'API key must use the canonical public sk_live_ format.',
    };
  }

  return { apiKey };
}

export function createHttpApp(config: HttpConfig): HttpAppContext {
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: config.allowedHosts.length > 0 ? config.allowedHosts : undefined,
  });

  const sessions = new Map<string, SessionContext>();
  const apiKeyVerifier = new HttpApiKeyCandidateVerifier(
    config,
    config.apiKeyCandidatesPerPeer
  );
  const pendingSessionsByKey = new Map<string, number>();
  let pendingSessionCount = 0;

  const activeSessionCountForKey = (keyHash: Buffer): number => {
    let count = 0;
    for (const session of sessions.values()) {
      if (
        session.keyHash.length === keyHash.length &&
        timingSafeEqual(session.keyHash, keyHash)
      ) {
        count += 1;
      }
    }
    return count;
  };

  const sessionLoadForKey = (keyHash: Buffer, keyHashHex: string): number =>
    activeSessionCountForKey(keyHash) + (pendingSessionsByKey.get(keyHashHex) ?? 0);

  const releasePendingSession = (keyHashHex: string): void => {
    pendingSessionCount = Math.max(0, pendingSessionCount - 1);
    const remaining = (pendingSessionsByKey.get(keyHashHex) ?? 1) - 1;
    if (remaining <= 0) {
      pendingSessionsByKey.delete(keyHashHex);
    } else {
      pendingSessionsByKey.set(keyHashHex, remaining);
    }
  };

  const cleanupExpiredSessions = async (nowMs: number = Date.now()): Promise<number> => {
    const expired = Array.from(sessions.values()).filter(
      (session) =>
        session.absoluteExpiresAtMs <= nowMs ||
        session.lastActivityAtMs + config.sessionIdleTtlMs <= nowMs
    );
    await Promise.all(
      expired.map((session) =>
        session.close({
          closeTransport: true,
          closeServer: true,
          reason: 'session_expired',
        })
      )
    );
    return expired.length;
  };

  if (config.allowedOrigins.length > 0) {
    const allowedHeaders = [
      'Accept',
      'Authorization',
      'Content-Type',
      'Last-Event-ID',
      'Mcp-Protocol-Version',
      'Mcp-Session-Id',
      'X-API-Key',
    ].join(', ');
    const allowedMethods = 'GET, POST, DELETE, OPTIONS';

    app.use((req: HttpRequest, res: HttpResponse, next: HttpNext) => {
      const origin = req.headers.origin;
      if (typeof origin !== 'string') {
        next();
        return;
      }

      if (!config.allowedOrigins.includes(origin)) {
        res.status(403).json({
          error: 'forbidden_origin',
          message: 'Request origin is not allowed',
        });
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
      res.setHeader('Access-Control-Allow-Methods', allowedMethods);
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Mcp-Session-Id, MCP-Session-Id, Mcp-Protocol-Version, MCP-Protocol-Version'
      );
      res.setHeader('Access-Control-Max-Age', '600');
      appendVaryHeader(res, 'Origin');

      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }

      next();
    });
  }

  app.get('/health', (_req: HttpRequest, res: HttpResponse) => {
    res.status(200).json({ status: 'ok', transport: 'http' });
  });

  app.post('/mcp', async (req: HttpRequest, res: HttpResponse) => {
    await cleanupExpiredSessions();
    const auth = authenticateRequestHeaders(req.headers);
    if ('error' in auth) {
      res.status(401).json(auth);
      return;
    }

    const sessionId = readSessionId(req.headers);

    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        res.status(404).json({
          error: 'session_not_found',
          message: 'Unknown MCP session id.',
        });
        return;
      }

      if (!apiKeyMatchesHash(auth.apiKey, existing.keyHash)) {
        res.status(403).json({
          error: 'api_key_mismatch',
          message: 'Provided API key does not match the session owner.',
        });
        return;
      }

      existing.touch();
      await handleExistingSessionRequest(existing.transport, req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        error: 'invalid_initialize_request',
        message: 'Initialization request is required when no MCP session id is provided.',
      });
      return;
    }

    // Reject protocol-incompatible requests before a caller-controlled key can
    // consume a backend verification attempt.
    if (!acceptsStreamableHttpResponse(req.headers)) {
      res.status(406).json({
        error: 'not_acceptable',
        message: 'Client must accept both application/json and text/event-stream.',
      });
      return;
    }

    const requestedKeyHash = hashApiKey(auth.apiKey);
    const requestedKeyHashHex = requestedKeyHash.toString('hex');

    if (sessions.size + pendingSessionCount >= config.maxSessions) {
      res.status(503).json({
        error: 'session_capacity_reached',
        message: 'MCP session capacity reached. Retry later.',
      });
      return;
    }

    if (
      sessionLoadForKey(requestedKeyHash, requestedKeyHashHex) >=
      config.maxSessionsPerKey
    ) {
      res.status(429).json({
        error: 'session_key_capacity_reached',
        message: 'This API key has reached its concurrent MCP session limit.',
      });
      return;
    }

    const authCheck = await apiKeyVerifier.verify(
      auth.apiKey,
      hashDirectPeer(req)
    );
    if ('error' in authCheck) {
      if (authCheck.retryAfterSeconds) {
        res.setHeader('Retry-After', String(authCheck.retryAfterSeconds));
      }
      res.status(authCheck.status).json({
        error: authCheck.error,
        message: authCheck.message,
      });
      return;
    }

    await cleanupExpiredSessions();
    if (sessions.size + pendingSessionCount >= config.maxSessions) {
      res.status(503).json({
        error: 'session_capacity_reached',
        message: 'MCP session capacity reached. Retry later.',
      });
      return;
    }
    if (
      sessionLoadForKey(requestedKeyHash, requestedKeyHashHex) >=
      config.maxSessionsPerKey
    ) {
      res.status(429).json({
        error: 'session_key_capacity_reached',
        message: 'This API key has reached its concurrent MCP session limit.',
      });
      return;
    }

    pendingSessionCount += 1;
    pendingSessionsByKey.set(
      requestedKeyHashHex,
      (pendingSessionsByKey.get(requestedKeyHashHex) ?? 0) + 1
    );
    let pendingReservationReleased = false;
    const releasePendingReservation = (): void => {
      if (pendingReservationReleased) {
        return;
      }
      pendingReservationReleased = true;
      releasePendingSession(requestedKeyHashHex);
    };
    res.once('finish', releasePendingReservation);
    res.once('close', releasePendingReservation);

    const client = authCheck.client;
    const server = createMcpServer(client);
    let initializedSessionId: string | null = null;
    let closePromise: Promise<void> | null = null;
    let expirationTimer: NodeJS.Timeout | null = null;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: config.enableJsonResponse,
      onsessioninitialized: (newSessionId) => {
        initializedSessionId = newSessionId;
        const createdAtMs = Date.now();
        const scheduleExpiration = (): void => {
          if (expirationTimer) {
            clearTimeout(expirationTimer);
          }
          const nowMs = Date.now();
          const expiresAtMs = Math.min(
            context.lastActivityAtMs + config.sessionIdleTtlMs,
            context.absoluteExpiresAtMs
          );
          const delayMs = Math.min(
            Math.max(1, expiresAtMs - nowMs),
            MAX_TIMER_DELAY_MS
          );
          expirationTimer = setTimeout(() => {
            const current = sessions.get(newSessionId);
            if (current !== context) {
              return;
            }
            const currentTimeMs = Date.now();
            if (
              context.absoluteExpiresAtMs <= currentTimeMs ||
              context.lastActivityAtMs + config.sessionIdleTtlMs <= currentTimeMs
            ) {
              void context
                .close({
                  closeTransport: true,
                  closeServer: true,
                  reason: 'session_expired',
                })
                .catch(() => undefined);
              return;
            }
            scheduleExpiration();
          }, delayMs);
          expirationTimer.unref();
        };

        const closeSession = async (options: SessionCloseOptions = {}): Promise<void> => {
          const {
            closeTransport = true,
            closeServer = true,
            reason = 'session_close',
          } = options;

          if (expirationTimer) {
            clearTimeout(expirationTimer);
            expirationTimer = null;
          }
          if (closePromise) {
            return closePromise;
          }

          // Important: schedule close work in a microtask so the guard is set
          // before transport/server close callbacks can re-enter onclose.
          closePromise = Promise.resolve().then(async () => {
            const sid = transport.sessionId ?? initializedSessionId ?? newSessionId;
            if (sid) {
              const existing = sessions.get(sid);
              if (existing?.transport === transport) {
                sessions.delete(sid);
              }
            }

            if (closeTransport) {
              await transport.close().catch((error) => {
                console.error(
                  `[videovector-mcp] Failed to close transport (${reason}):`,
                  error instanceof Error ? error.message : String(error)
                );
              });
            }

            if (closeServer) {
              await server.close().catch((error) => {
                console.error(
                  `[videovector-mcp] Failed to close server (${reason}):`,
                  error instanceof Error ? error.message : String(error)
                );
              });
            }
          });

          return closePromise;
        };

        const context: SessionContext = {
          sessionId: newSessionId,
          transport,
          server,
          keyHash: requestedKeyHash,
          createdAtMs,
          lastActivityAtMs: createdAtMs,
          absoluteExpiresAtMs: createdAtMs + config.sessionAbsoluteTtlMs,
          touch: (nowMs: number = Date.now()) => {
            if (closePromise) {
              return;
            }
            context.lastActivityAtMs = Math.max(context.lastActivityAtMs, nowMs);
            scheduleExpiration();
          },
          close: closeSession,
        };
        sessions.set(newSessionId, context);
        scheduleExpiration();
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId ?? initializedSessionId;
      if (sid) {
        const existing = sessions.get(sid);
        if (existing?.transport === transport) {
          void existing
            .close({
              closeTransport: false,
              closeServer: true,
              reason: 'transport_onclose',
            })
            .catch(() => undefined);
          return;
        }
      }

      // Session may not have completed initialization yet.
      if (!closePromise) {
        // Defer close so closePromise is assigned before onclose can recurse.
        closePromise = Promise.resolve()
          .then(() => server.close())
          .catch(() => undefined);
      }
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[videovector-mcp] Failed to initialize HTTP session:', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        res.status(500).json({
          error: 'http_initialize_failed',
          message: 'Failed to initialize MCP session.',
        });
      }
      const sid = transport.sessionId ?? initializedSessionId;
      if (sid) {
        const existing = sessions.get(sid);
        if (existing?.transport === transport) {
          await existing.close({
            closeTransport: true,
            closeServer: true,
            reason: 'http_initialize_failed',
          });
          return;
        }
      }
      if (!closePromise) {
        // Defer close so closePromise is assigned before onclose can recurse.
        closePromise = Promise.resolve().then(async () => {
          await transport.close().catch(() => undefined);
          await server.close().catch(() => undefined);
        });
      }
      await closePromise;
    } finally {
      releasePendingReservation();
    }
  });

  app.get('/mcp', async (req: HttpRequest, res: HttpResponse) => {
    await cleanupExpiredSessions();
    const auth = authenticateRequestHeaders(req.headers);
    if ('error' in auth) {
      res.status(401).json(auth);
      return;
    }

    const sessionId = readSessionId(req.headers);
    if (!sessionId) {
      res.status(400).json({
        error: 'missing_session_id',
        message: 'MCP-Session-Id header is required.',
      });
      return;
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      res.status(404).json({
        error: 'session_not_found',
        message: 'Unknown MCP session id.',
      });
      return;
    }

    if (!apiKeyMatchesHash(auth.apiKey, existing.keyHash)) {
      res.status(403).json({
        error: 'api_key_mismatch',
        message: 'Provided API key does not match the session owner.',
      });
      return;
    }

    existing.touch();
    await handleExistingSessionRequest(existing.transport, req, res);
  });

  app.delete('/mcp', async (req: HttpRequest, res: HttpResponse) => {
    await cleanupExpiredSessions();
    const auth = authenticateRequestHeaders(req.headers);
    if ('error' in auth) {
      res.status(401).json(auth);
      return;
    }

    const sessionId = readSessionId(req.headers);
    if (!sessionId) {
      res.status(400).json({
        error: 'missing_session_id',
        message: 'MCP-Session-Id header is required.',
      });
      return;
    }

    const existing = sessions.get(sessionId);
    if (!existing) {
      res.status(404).json({
        error: 'session_not_found',
        message: 'Unknown MCP session id.',
      });
      return;
    }

    if (!apiKeyMatchesHash(auth.apiKey, existing.keyHash)) {
      res.status(403).json({
        error: 'api_key_mismatch',
        message: 'Provided API key does not match the session owner.',
      });
      return;
    }

    existing.touch();
    await handleExistingSessionRequest(existing.transport, req, res);
  });

  return { app, sessions, cleanupExpiredSessions };
}

export async function runHttpServer(config: HttpConfig): Promise<void> {
  const { app, sessions } = createHttpApp(config);

  let isShuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
      console.error(`[videovector-mcp] Already shutting down, ignoring ${signal}`);
      return;
    }
    isShuttingDown = true;
    console.error(`[videovector-mcp] Received ${signal}, shutting down...`);

    const closeOperations = Array.from(sessions.values()).map((context) =>
      context.close({
        closeTransport: true,
        closeServer: true,
        reason: `shutdown_${signal.toLowerCase()}`,
      })
    );
    await Promise.all(closeOperations);
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await new Promise<void>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => {
      console.error('[videovector-mcp] Server started successfully');
      console.error('[videovector-mcp] Transport: http');
      console.error(`[videovector-mcp] API: ${config.baseUrl}`);
      console.error(`[videovector-mcp] HTTP endpoint: http://${config.host}:${config.port}/mcp`);
      console.error(`[videovector-mcp] Tools available: ${TOOL_DEFINITIONS.length}`);
      resolve();
    });

    server.on('error', (error: Error) => {
      reject(error);
    });
  });
}

export async function main(): Promise<void> {
  const mode = readTransportMode();
  const baseConfig = loadBaseConfig();

  if (mode === 'stdio') {
    await runStdioServer(loadStdioConfig(baseConfig));
    return;
  }

  await runHttpServer(loadHttpConfig(baseConfig));
}

function isDirectExecution(): boolean {
  return typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
}

function formatUnknownError(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function handleUncaughtException(error: Error): void {
  console.error('[videovector-mcp] Uncaught exception:', error.stack ?? error.message);
  process.exitCode = 1;
  const exitTimer = setTimeout(() => process.exit(1), 0);
  if (typeof (exitTimer as NodeJS.Timeout).unref === 'function') {
    (exitTimer as NodeJS.Timeout).unref();
  }
}

export function handleUnhandledRejection(reason: unknown): void {
  console.error('[videovector-mcp] Unhandled rejection:', formatUnknownError(reason));
  if (reason instanceof Error) {
    handleUncaughtException(reason);
    return;
  }
  handleUncaughtException(new Error(formatUnknownError(reason)));
}

function registerProcessErrorHandlers(): void {
  process.on('unhandledRejection', (reason) => {
    handleUnhandledRejection(reason);
  });

  process.on('uncaughtException', (error) => {
    handleUncaughtException(error);
  });
}

if (isDirectExecution()) {
  registerProcessErrorHandlers();
  main().catch((error: Error) => {
    console.error('[videovector-mcp] Fatal error:', error.message);
    process.exit(1);
  });
}
