#!/usr/bin/env node

/**
 * VideoVector MCP Server
 *
 * Supports two runtime transport modes:
 * - stdio (default): local MCP client integrations
 * - http: stateless Streamable HTTP for horizontally scaled deployments
 *
 * HTTP mode environment variables:
 *   PORT - Optional: HTTP port (default: 8080)
 *   MCP_HTTP_HOST - Optional: bind host (default: 0.0.0.0)
 *   MCP_HTTP_ALLOWED_HOSTS - Optional: comma-separated allowed hostnames
 *   MCP_HTTP_ALLOWED_ORIGINS - Optional: comma-separated allowed origins
 *   MCP_HTTP_ENABLE_JSON_RESPONSE - Optional: true|false (default: false)
 *   MCP_HTTP_SHUTDOWN_DRAIN_SECONDS - Optional: graceful drain timeout (default: 25)
 */

import { randomUUID } from 'node:crypto';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  Server as HttpServer,
  ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
} from '@modelcontextprotocol/sdk/types.js';

import { VideoVectorClient } from './client/index.js';
import { ApiKeyVerifier } from './http/api-key-verifier.js';
import { TOOL_DEFINITIONS, executeTool } from './tools/index.js';
import { PACKAGE_VERSION } from './version.js';

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
  enableJsonResponse: boolean;
  shutdownDrainTimeoutMs: number;
}

interface ActiveRequestContext {
  requestId: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  done: Promise<void>;
  close: (reason?: string) => Promise<void>;
}

export interface HttpAppContext {
  app: ReturnType<typeof createMcpExpressApp>;
  activeRequests: Map<string, ActiveRequestContext>;
  startDraining: () => void;
  drainActiveRequests: (timeoutMs?: number) => Promise<void>;
}

type HttpRequest = IncomingMessage & {
  body?: unknown;
  headers: IncomingHttpHeaders;
};
type HttpResponse = ServerResponse<IncomingMessage> & {
  status: (code: number) => HttpResponse;
  json: (body: unknown) => HttpResponse;
};
type HttpNext = () => void;

const DEFAULT_BASE_URL = 'https://api.vectormethods.com/api/v2';
const PUBLIC_API_KEY_PATTERN = /^sk_live_[0-9a-f]{48}$/;

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
    timeout: readPositiveInteger('VIDEOVECTOR_TIMEOUT', 90_000),
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
  return {
    mode: 'http',
    port: readPositiveInteger('PORT', 8080),
    host: process.env.MCP_HTTP_HOST ?? '0.0.0.0',
    allowedHosts: readCsv('MCP_HTTP_ALLOWED_HOSTS'),
    allowedOrigins: readCsv('MCP_HTTP_ALLOWED_ORIGINS'),
    enableJsonResponse: readBoolean('MCP_HTTP_ENABLE_JSON_RESPONSE', false),
    shutdownDrainTimeoutMs:
      readPositiveInteger('MCP_HTTP_SHUTDOWN_DRAIN_SECONDS', 25) * 1_000,
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
  // Match backend authentication precedence: an explicit API key wins over an
  // ambient browser bearer token.
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

function writeProtocolError(
  res: HttpResponse,
  status: number,
  code: number,
  message: string
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
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

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;
      console.error(`[videovector-mcp] Tool called: ${name}`);
      const result = await executeTool(
        name,
        (args ?? {}) as Record<string, unknown>,
        client
      );
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError,
      };
    }
  );

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
      console.error(
        '[videovector-mcp] Error during shutdown:',
        error instanceof Error ? error.message : String(error)
      );
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
  const verifier = new ApiKeyVerifier(config);
  const activeRequests = new Map<string, ActiveRequestContext>();
  let isDraining = false;

  const startDraining = (): void => {
    isDraining = true;
  };

  const drainActiveRequests = async (
    timeoutMs: number = config.shutdownDrainTimeoutMs
  ): Promise<void> => {
    startDraining();
    const contexts = Array.from(activeRequests.values());
    if (contexts.length === 0) {
      return;
    }

    let timeout: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.all(contexts.map((context) => context.done)).then(() => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(true), timeoutMs);
        timeout.unref();
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (timedOut) {
      await Promise.all(
        Array.from(activeRequests.values()).map((context) =>
          context.close('shutdown_timeout')
        )
      );
    }
  };

  if (config.allowedOrigins.length > 0) {
    const allowedHeaders = [
      'Accept',
      'Authorization',
      'Content-Type',
      'Mcp-Protocol-Version',
      'X-API-Key',
    ].join(', ');
    const allowedMethods = 'POST, OPTIONS';

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
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Protocol-Version');
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
    res.status(isDraining ? 503 : 200).json({
      status: isDraining ? 'draining' : 'ok',
      transport: 'http',
      active_requests: activeRequests.size,
    });
  });

  app.post('/mcp', async (req: HttpRequest, res: HttpResponse) => {
    if (isDraining) {
      res.setHeader('Retry-After', '5');
      writeProtocolError(res, 503, -32001, 'Server is draining.');
      return;
    }

    const auth = authenticateRequestHeaders(req.headers);
    if ('error' in auth) {
      res.status(401).json(auth);
      return;
    }
    if (!acceptsStreamableHttpResponse(req.headers)) {
      res.status(406).json({
        error: 'not_acceptable',
        message: 'Client must accept both application/json and text/event-stream.',
      });
      return;
    }
    if (req.headers['mcp-session-id'] !== undefined) {
      res.status(400).json({
        error: 'session_state_not_supported',
        message: 'This endpoint is stateless; omit MCP-Session-Id.',
      });
      return;
    }

    const authCheck = await verifier.verify(auth.apiKey);
    if (!authCheck.ok) {
      if (authCheck.retryAfterSeconds !== undefined) {
        res.setHeader('Retry-After', String(authCheck.retryAfterSeconds));
      }
      res.status(authCheck.status).json({
        error: authCheck.error,
        message: authCheck.message,
      });
      return;
    }
    if (isDraining) {
      res.setHeader('Retry-After', '5');
      writeProtocolError(res, 503, -32001, 'Server is draining.');
      return;
    }

    const requestId = randomUUID();
    const client = createClient(auth.apiKey, config);
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: config.enableJsonResponse,
    });

    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let closePromise: Promise<void> | null = null;
    const close = (reason: string = 'request_complete'): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }
      closePromise = Promise.resolve()
        .then(async () => {
          activeRequests.delete(requestId);
          // Server owns the transport after connect(). Closing both objects
          // would invoke StreamableHTTPServerTransport.close() twice.
          await server.close().catch((error) => {
            console.error(
              `[videovector-mcp] Failed to close HTTP request context (${reason}):`,
              error instanceof Error ? error.message : String(error)
            );
          });
        })
        .finally(resolveDone);
      return closePromise;
    };

    const context: ActiveRequestContext = {
      requestId,
      transport,
      server,
      done,
      close,
    };
    activeRequests.set(requestId, context);
    res.once('finish', () => void close('response_finish'));
    res.once('close', () => void close('response_close'));
    req.once('aborted', () => void close('request_aborted'));
    transport.onclose = () => {
      void close('transport_close');
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(
        '[videovector-mcp] Failed to handle stateless HTTP request:',
        error instanceof Error ? error.message : String(error)
      );
      if (!res.headersSent) {
        writeProtocolError(res, 500, -32603, 'Internal server error.');
      }
      await close('request_error');
    } finally {
      if (res.writableEnded || res.destroyed) {
        await close('request_settled');
      }
    }
  });

  const methodNotAllowed = (_req: HttpRequest, res: HttpResponse): void => {
    res.setHeader('Allow', 'POST, OPTIONS');
    writeProtocolError(res, 405, -32000, 'Method not allowed.');
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return {
    app,
    activeRequests,
    startDraining,
    drainActiveRequests,
  };
}

export async function runHttpServer(config: HttpConfig): Promise<void> {
  const context = createHttpApp(config);
  let listener: HttpServer | null = null;
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) {
      console.error(`[videovector-mcp] Already shutting down, ignoring ${signal}`);
      return;
    }
    isShuttingDown = true;
    console.error(`[videovector-mcp] Received ${signal}, draining...`);
    context.startDraining();
    listener?.close();
    await context.drainActiveRequests(config.shutdownDrainTimeoutMs);
    listener?.closeAllConnections?.();
    console.error('[videovector-mcp] HTTP server drained');
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await new Promise<void>((resolve, reject) => {
    const startedListener = context.app.listen(config.port, config.host, () => {
      console.error('[videovector-mcp] Server started successfully');
      console.error('[videovector-mcp] Transport: stateless-http');
      console.error(`[videovector-mcp] API: ${config.baseUrl}`);
      console.error(
        `[videovector-mcp] HTTP endpoint: http://${config.host}:${config.port}/mcp`
      );
      console.error(`[videovector-mcp] Tools available: ${TOOL_DEFINITIONS.length}`);
      resolve();
    });
    listener = startedListener;
    startedListener.on('error', (error: Error) => reject(error));
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
  return (
    typeof require !== 'undefined' &&
    typeof module !== 'undefined' &&
    require.main === module
  );
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
  exitTimer.unref();
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
