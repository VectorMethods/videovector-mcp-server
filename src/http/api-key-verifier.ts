import { createHmac, randomBytes } from 'node:crypto';

import { VideoVectorClient } from '../client/index.js';
import { VideoVectorApiError } from '../types/index.js';

const DEFAULT_POSITIVE_CACHE_TTL_MS = 60_000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_TRANSIENT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_CONCURRENT_VALIDATIONS = 16;
const DEFAULT_MAX_QUEUED_VALIDATIONS = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CACHE_ENTRIES = 50_000;

export interface ApiKeyVerifierClientConfig {
  baseUrl: string;
  timeout: number;
  maxRetries: number;
}

export interface ApiKeyVerifierOptions {
  positiveCacheTtlMs?: number;
  negativeCacheTtlMs?: number;
  transientCacheTtlMs?: number;
  maxConcurrentValidations?: number;
  maxQueuedValidations?: number;
  queueTimeoutMs?: number;
  maxCacheEntries?: number;
  now?: () => number;
  validate?: (apiKey: string) => Promise<void>;
}

export type ApiKeyVerificationSuccess = { ok: true };

export interface ApiKeyVerificationFailure {
  ok: false;
  status: number;
  error: string;
  message: string;
  retryAfterSeconds?: number;
}

export type ApiKeyVerificationResult =
  | ApiKeyVerificationSuccess
  | ApiKeyVerificationFailure;

interface CachedVerification {
  expiresAtMs: number;
  result: ApiKeyVerificationResult;
}

interface QueuedValidation {
  start: () => void;
  expire: () => void;
  timer: NodeJS.Timeout;
}

const API_KEY_FINGERPRINT_SECRET = randomBytes(32);

function cacheKeyForApiKey(apiKey: string): string {
  return createHmac('sha256', API_KEY_FINGERPRINT_SECRET)
    .update(apiKey)
    .digest('hex');
}

function invalidApiKeyResult(): ApiKeyVerificationFailure {
  return {
    ok: false,
    status: 401,
    error: 'invalid_api_key',
    message: 'API key is invalid or revoked.',
  };
}

function busyResult(): ApiKeyVerificationFailure {
  return {
    ok: false,
    status: 503,
    error: 'api_key_verification_busy',
    message: 'API key verification is at capacity. Retry shortly.',
    retryAfterSeconds: 5,
  };
}

function transientFailureResult(): ApiKeyVerificationFailure {
  return {
    ok: false,
    status: 502,
    error: 'api_key_verification_failed',
    message: 'Unable to verify API key at this time.',
    retryAfterSeconds: 5,
  };
}

/**
 * Validates API keys without allowing one tenant or network peer to consume
 * another tenant's admission budget.
 *
 * Cache and in-flight maps are keyed only by a process-secret HMAC. The raw
 * credential is retained solely by the promise closure while an uncached
 * validation is running or queued.
 */
export class ApiKeyVerifier {
  private readonly positiveCacheTtlMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly transientCacheTtlMs: number;
  private readonly maxConcurrentValidations: number;
  private readonly maxQueuedValidations: number;
  private readonly queueTimeoutMs: number;
  private readonly maxCacheEntries: number;
  private readonly now: () => number;
  private readonly validateApiKey: (apiKey: string) => Promise<void>;

  private readonly cache = new Map<string, CachedVerification>();
  private readonly inFlight = new Map<string, Promise<ApiKeyVerificationResult>>();
  private readonly queue: QueuedValidation[] = [];
  private activeValidations = 0;

  constructor(
    clientConfig: ApiKeyVerifierClientConfig,
    options: ApiKeyVerifierOptions = {}
  ) {
    this.positiveCacheTtlMs =
      options.positiveCacheTtlMs ?? DEFAULT_POSITIVE_CACHE_TTL_MS;
    this.negativeCacheTtlMs =
      options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS;
    this.transientCacheTtlMs =
      options.transientCacheTtlMs ?? DEFAULT_TRANSIENT_CACHE_TTL_MS;
    this.maxConcurrentValidations =
      options.maxConcurrentValidations ?? DEFAULT_MAX_CONCURRENT_VALIDATIONS;
    this.maxQueuedValidations =
      options.maxQueuedValidations ?? DEFAULT_MAX_QUEUED_VALIDATIONS;
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.now = options.now ?? Date.now;
    this.validateApiKey =
      options.validate ??
      (async (apiKey: string): Promise<void> => {
        const client = new VideoVectorClient({
          apiKey,
          baseUrl: clientConfig.baseUrl,
          timeout: clientConfig.timeout,
          // Authentication probes are deliberately single-shot. Retrying a
          // rejected credential would amplify backend abuse protections.
          maxRetries: 0,
        });
        await client.validateApiKey();
      });

    if (
      !Number.isInteger(this.maxConcurrentValidations) ||
      this.maxConcurrentValidations < 1
    ) {
      throw new Error('maxConcurrentValidations must be a positive integer');
    }
    if (
      !Number.isInteger(this.maxQueuedValidations) ||
      this.maxQueuedValidations < 0
    ) {
      throw new Error('maxQueuedValidations must be a non-negative integer');
    }
    if (!Number.isFinite(this.queueTimeoutMs) || this.queueTimeoutMs <= 0) {
      throw new Error('queueTimeoutMs must be positive');
    }
    if (!Number.isInteger(this.maxCacheEntries) || this.maxCacheEntries < 1) {
      throw new Error('maxCacheEntries must be a positive integer');
    }
  }

  private prune(nowMs: number): void {
    for (const [keyHash, cached] of this.cache) {
      if (cached.expiresAtMs <= nowMs) {
        this.cache.delete(keyHash);
      }
    }
  }

  private releasePermit(): void {
    this.activeValidations = Math.max(0, this.activeValidations - 1);
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.start();
    }
  }

  private cacheResult(
    keyHash: string,
    result: ApiKeyVerificationResult,
    expiresAtMs: number
  ): void {
    // Map preserves insertion order, which is sufficient for this short-lived
    // process-local LRU. Refreshing a key moves it to the newest position.
    this.cache.delete(keyHash);
    this.cache.set(keyHash, { expiresAtMs, result });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
  }

  private async runWithPermit(
    operation: () => Promise<ApiKeyVerificationResult>
  ): Promise<ApiKeyVerificationResult> {
    if (this.activeValidations < this.maxConcurrentValidations) {
      this.activeValidations += 1;
      try {
        return await operation();
      } finally {
        this.releasePermit();
      }
    }

    if (this.queue.length >= this.maxQueuedValidations) {
      return busyResult();
    }

    return new Promise<ApiKeyVerificationResult>((resolve) => {
      let settled = false;
      const start = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.activeValidations += 1;
        void operation()
          .then(resolve, () => resolve(transientFailureResult()))
          .finally(() => this.releasePermit());
      };
      const expire = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        const entryIndex = this.queue.indexOf(entry);
        if (entryIndex >= 0) {
          this.queue.splice(entryIndex, 1);
        }
        resolve(busyResult());
      };
      const entry: QueuedValidation = {
        start,
        expire,
        timer: setTimeout(expire, this.queueTimeoutMs),
      };
      entry.timer.unref();
      this.queue.push(entry);
    });
  }

  private async validateUncached(apiKey: string): Promise<ApiKeyVerificationResult> {
    try {
      await this.validateApiKey(apiKey);
      return { ok: true };
    } catch (error) {
      if (error instanceof VideoVectorApiError) {
        if (error.isAuthError()) {
          return invalidApiKeyResult();
        }
        if (error.statusCode === 429) {
          return {
            ok: false,
            status: 429,
            error: 'api_key_verification_rate_limited',
            message: 'API key verification is rate limited. Retry shortly.',
            retryAfterSeconds: 5,
          };
        }
      }

      // Never log backend response text. Authentication errors can include
      // caller-controlled content, and credentials must not be recoverable
      // from logs or cache diagnostics.
      const failureLabel =
        error instanceof VideoVectorApiError
          ? `${error.code} (HTTP ${error.statusCode})`
          : error instanceof Error
            ? error.name
            : 'unknown_error';
      console.error('[videovector-mcp] API key verification failed:', failureLabel);
      return transientFailureResult();
    }
  }

  async verify(
    apiKey: string,
    nowMs: number = this.now()
  ): Promise<ApiKeyVerificationResult> {
    const keyHash = cacheKeyForApiKey(apiKey);
    const cached = this.cache.get(keyHash);
    if (cached && cached.expiresAtMs > nowMs) {
      // Refresh insertion order on access so hot valid tenants are not evicted
      // by a stream of one-off invalid candidates.
      this.cache.delete(keyHash);
      this.cache.set(keyHash, cached);
      return cached.result;
    }
    if (cached) {
      this.cache.delete(keyHash);
    }

    const existing = this.inFlight.get(keyHash);
    if (existing) {
      return existing;
    }

    const verification = this.runWithPermit(() => this.validateUncached(apiKey));
    this.inFlight.set(keyHash, verification);
    try {
      const result = await verification;
      const completedAtMs = this.now();
      const ttlMs = result.ok
        ? this.positiveCacheTtlMs
        : result.error === 'invalid_api_key'
          ? this.negativeCacheTtlMs
          : this.transientCacheTtlMs;
      this.cacheResult(keyHash, result, completedAtMs + ttlMs);
      return result;
    } finally {
      if (this.inFlight.get(keyHash) === verification) {
        this.inFlight.delete(keyHash);
      }
    }
  }

  getStats(): {
    active: number;
    queued: number;
    inFlight: number;
    cached: number;
  } {
    this.prune(this.now());
    return {
      active: this.activeValidations,
      queued: this.queue.length,
      inFlight: this.inFlight.size,
      cached: this.cache.size,
    };
  }
}
