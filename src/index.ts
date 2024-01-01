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
  enableJsonResponse: boolean;
}

interface SessionContext {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  keyHash: Buffer;
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
}

type HttpRequest = IncomingMessage & { body?: unknown; headers: IncomingHttpHeaders };
type HttpResponse = ServerResponse<IncomingMessage> & {
  status: (code: number) => HttpResponse;
  json: (body: unknown) => HttpResponse;
};
type HttpNext = () => void;

const DEFAULT_BASE_URL = 'https://api.vectormethods.com/api/v2';

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
  return apiKey.startsWith('sk_live_') || apiKey.startsWith('sk_test_');
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
    console.error('Error: Invalid API key format. Keys must start with sk_live_ or sk_test_');
    process.exit(1);
  }

  return {
    mode: 'stdio',
    apiKey,
    ...baseConfig,
  };
}

export function loadHttpConfig(baseConfig: BaseConfig): HttpConfig {
  return {
    mode: 'http',
    port: readPositiveInteger('PORT', 8080),
    host: process.env.MCP_HTTP_HOST ?? '0.0.0.0',
    allowedHosts: readCsv('MCP_HTTP_ALLOWED_HOSTS'),
    allowedOrigins: readCsv('MCP_HTTP_ALLOWED_ORIGINS'),
    maxSessions: readPositiveInteger('MCP_HTTP_MAX_SESSIONS', 200),
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
  const authorization = headers.authorization;
  const authValue = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof authValue === 'string') {
    const match = authValue.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  const xApiKey = headers['x-api-key'];
  const headerValue = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
    return headerValue.trim();
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

function hashApiKey(apiKey: string): Buffer {
  return createHash('sha256').update(apiKey).digest();
}

function apiKeyMatchesHash(apiKey: string, expectedHash: Buffer): boolean {
  const receivedHash = hashApiKey(apiKey);
  return receivedHash.length === expectedHash.length && timingSafeEqual(receivedHash, expectedHash);
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
  | { status: number; error: string; message: string };

async function verifyApiKeyForHttpSession(
  apiKey: string,
  config: BaseConfig
): Promise<HttpSessionAuthCheckResult> {
  const client = createClient(apiKey, config);

  try {
    // Verify API key validity before allocating session/server objects.
    await client.listIndexes(false);
    return { client };
  } catch (error) {
    if (error instanceof VideoVectorApiError) {
      if (error.isAuthError()) {
        return {
          status: 401,
          error: 'invalid_api_key',
          message: 'API key is invalid or revoked.',
        };
      }

      if (error.statusCode === 429) {
        return {
          status: 429,
          error: 'api_key_verification_rate_limited',
          message: 'API key verification is rate limited. Retry shortly.',
        };
      }
    }

    console.error(
      '[videovector-mcp] API key verification failed:',
      error instanceof Error ? error.message : String(error)
    );

    return {
      status: 502,
      error: 'api_key_verification_failed',
      message: 'Unable to verify API key at this time.',
    };
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
      version: '2.0.0',
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

  if (!isValidApiKeyFormat(apiKey)) {
    return {
      error: 'invalid_api_key',
      message: 'API key must start with sk_live_ or sk_test_.',
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

    if (sessions.size >= config.maxSessions) {
      res.status(503).json({
        error: 'session_capacity_reached',
        message: 'MCP session capacity reached. Retry later.',
      });
      return;
    }

    const authCheck = await verifyApiKeyForHttpSession(auth.apiKey, config);
    if ('error' in authCheck) {
      res.status(authCheck.status).json({
        error: authCheck.error,
        message: authCheck.message,
      });
      return;
    }

    const client = authCheck.client;
    const server = createMcpServer(client);
    let initializedSessionId: string | null = null;
    let closePromise: Promise<void> | null = null;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: config.enableJsonResponse,
      onsessioninitialized: (newSessionId) => {
        initializedSessionId = newSessionId;
        const keyHash = hashApiKey(auth.apiKey);
        const closeSession = async (options: SessionCloseOptions = {}): Promise<void> => {
          const {
            closeTransport = true,
            closeServer = true,
            reason = 'session_close',
          } = options;

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

        sessions.set(newSessionId, {
          sessionId: newSessionId,
          transport,
          server,
          keyHash,
          close: closeSession,
        });
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
    }
  });

  app.get('/mcp', async (req: HttpRequest, res: HttpResponse) => {
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

    await handleExistingSessionRequest(existing.transport, req, res);
  });

  app.delete('/mcp', async (req: HttpRequest, res: HttpResponse) => {
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

    await handleExistingSessionRequest(existing.transport, req, res);
  });

  return { app, sessions };
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
