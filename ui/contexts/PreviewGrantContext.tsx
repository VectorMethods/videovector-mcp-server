import React, { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import type { PreviewGrantItem, PreviewGrantRequestItem } from '../services/api';

export interface PreviewGrantProjection {
  identity: PreviewGrantRequestItem;
  thumbnailGcsUri: string | null;
  gifGcsUri: string | null;
}

interface PreviewGrantCacheEntry {
  grant: PreviewGrantItem;
  freshUntilMs: number;
}

interface PendingPreviewGrantRequest {
  key: string;
  identityKey: string;
  projection: PreviewGrantProjection;
  waiters: Array<{
    resolve: (grant: PreviewGrantItem | null) => void;
    reject: (error: unknown) => void;
  }>;
}

export type PreviewGrantLoader = (
  items: PreviewGrantRequestItem[], signal: AbortSignal,
) => Promise<{ items: PreviewGrantItem[] }>;
export type PreviewGrantRequester = (
  projection: PreviewGrantProjection, options?: { forceRefresh?: boolean },
) => Promise<PreviewGrantItem | null>;

const MAX_PREVIEW_GRANTS = 256;
const MAX_PREVIEW_GRANT_BATCH_SIZE = 24;
const PREVIEW_GRANT_EXPIRY_SKEW_MS = 30_000;
export const PREVIEW_GRANT_NEGATIVE_TTL_MS = 15_000;

const trimOldestEntries = <Key, Value>(map: Map<Key, Value>, maximum: number) => {
  while (map.size > maximum) {
    const oldestKey = map.keys().next().value as Key | undefined;
    if (oldestKey === undefined) return;
    map.delete(oldestKey);
  }
};

const normalizeDurablePreviewUri = (value: string | null | undefined): string | null => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
};

export const getPreviewGrantIdentityKey = (identity: PreviewGrantRequestItem): string => (
  identity.kind === 'video'
    ? `video:${identity.video_id}`
    : `segment:${identity.video_id}:${identity.segment_id}`
);

export const getPreviewGrantProjectionKey = (projection: PreviewGrantProjection): string => (
  [
    getPreviewGrantIdentityKey(projection.identity),
    normalizeDurablePreviewUri(projection.thumbnailGcsUri) || '',
    normalizeDurablePreviewUri(projection.gifGcsUri) || '',
  ].join('\u0000')
);

const previewGrantMatchesProjection = (
  grant: PreviewGrantItem,
  projection: PreviewGrantProjection,
): boolean => (
  getPreviewGrantIdentityKey(grant.kind === 'video'
    ? { kind: 'video', video_id: grant.video_id }
    : { kind: 'segment', video_id: grant.video_id, segment_id: grant.segment_id || '' })
    === getPreviewGrantIdentityKey(projection.identity)
  && normalizeDurablePreviewUri(grant.thumbnail_gcs_uri)
    === normalizeDurablePreviewUri(projection.thumbnailGcsUri)
  && normalizeDurablePreviewUri(grant.gif_gcs_uri)
    === normalizeDurablePreviewUri(projection.gifGcsUri)
);

const parsePreviewGrantExpiry = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** One bounded, identity-scoped preview cache for both browser and embedded Studio. */
export const usePreviewGrantClient = (
  authScope: string, loadGrants: PreviewGrantLoader,
): PreviewGrantRequester => {
  // The bounded LRU is fenced by the explicit authenticated scope from App
  // and never enters storage.
  const previewGrantCacheRef = useRef(new Map<string, PreviewGrantCacheEntry>());
  const pendingPreviewGrantsRef = useRef(new Map<string, PendingPreviewGrantRequest>());
  const previewGrantQueueRef = useRef<string[]>([]);
  const previewGrantFlushScheduledRef = useRef(false);
  const previewGrantFlushRunningRef = useRef(false);
  const previewGrantBatchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const previewGrantCache = previewGrantCacheRef.current;
    const pendingPreviewGrants = pendingPreviewGrantsRef.current;
    // Direct grants are authorized for exactly one authenticated scope. Drop
    // every URL and cancel/settle in-flight work before a different identity
    // can observe this provider's memory.
    previewGrantCache.clear();
    return () => {
      previewGrantBatchAbortRef.current?.abort();
      previewGrantBatchAbortRef.current = null;
      previewGrantCache.clear();
      const pendingRequests = Array.from(pendingPreviewGrants.values());
      pendingPreviewGrants.clear();
      previewGrantQueueRef.current = [];
      pendingRequests.forEach((pending) => {
        pending.waiters.forEach(({ resolve }) => resolve(null));
      });
    };
  }, [authScope]);

  const flushPreviewGrantQueue = useCallback(async (): Promise<void> => {
    if (previewGrantFlushRunningRef.current) return;
    previewGrantFlushRunningRef.current = true;
    try {
      while (previewGrantQueueRef.current.length > 0) {
        const selectedKeys: string[] = [];
        const requestItems: PreviewGrantRequestItem[] = [];
        const selectedIdentityKeys = new Set<string>();

        while (previewGrantQueueRef.current.length > 0) {
          const nextKey = previewGrantQueueRef.current[0];
          const pending = pendingPreviewGrantsRef.current.get(nextKey);
          if (!pending) {
            previewGrantQueueRef.current.shift();
            continue;
          }
          const isNewIdentity = !selectedIdentityKeys.has(pending.identityKey);
          if (isNewIdentity && selectedIdentityKeys.size >= MAX_PREVIEW_GRANT_BATCH_SIZE) {
            break;
          }
          previewGrantQueueRef.current.shift();
          selectedKeys.push(nextKey);
          if (isNewIdentity) {
            selectedIdentityKeys.add(pending.identityKey);
            requestItems.push(pending.projection.identity);
          }
        }

        if (requestItems.length === 0) continue;
        const batchAbortController = new AbortController();
        previewGrantBatchAbortRef.current = batchAbortController;
        try {
          const response = await loadGrants(requestItems, batchAbortController.signal);
          const grantsByIdentity = new Map(response.items.map((grant) => [
            getPreviewGrantIdentityKey(grant.kind === 'video'
              ? { kind: 'video', video_id: grant.video_id }
              : { kind: 'segment', video_id: grant.video_id, segment_id: grant.segment_id || '' }),
            grant,
          ]));
          selectedKeys.forEach((key) => {
            const pending = pendingPreviewGrantsRef.current.get(key);
            if (!pending) return;
            pendingPreviewGrantsRef.current.delete(key);
            const grant = grantsByIdentity.get(pending.identityKey) || null;
            const acceptedGrant = grant && previewGrantMatchesProjection(grant, pending.projection)
              ? grant
              : null;
            const expiresAtMs = acceptedGrant
              ? parsePreviewGrantExpiry(acceptedGrant.grant_expires_at)
              : null;
            const hasDirectGrant = Boolean(
              acceptedGrant?.thumbnail_uri || acceptedGrant?.gif_uri,
            );
            const hasFreshExpiry = expiresAtMs !== null
              && Date.now() < expiresAtMs - PREVIEW_GRANT_EXPIRY_SKEW_MS;
            const usableGrant = hasDirectGrant && !hasFreshExpiry
              ? null
              : acceptedGrant;
            const freshUntilMs = usableGrant
              ? hasDirectGrant && expiresAtMs !== null
                ? expiresAtMs - PREVIEW_GRANT_EXPIRY_SKEW_MS
                : Date.now() + PREVIEW_GRANT_NEGATIVE_TTL_MS
              : null;
            if (usableGrant && freshUntilMs !== null) {
              previewGrantCacheRef.current.delete(key);
              previewGrantCacheRef.current.set(key, {
                grant: usableGrant,
                freshUntilMs,
              });
              trimOldestEntries(previewGrantCacheRef.current, MAX_PREVIEW_GRANTS);
            }
            pending.waiters.forEach(({ resolve }) => resolve(usableGrant));
          });
        } catch (error) {
          selectedKeys.forEach((key) => {
            const pending = pendingPreviewGrantsRef.current.get(key);
            if (!pending) return;
            pendingPreviewGrantsRef.current.delete(key);
            pending.waiters.forEach(({ reject }) => reject(error));
          });
        } finally {
          if (previewGrantBatchAbortRef.current === batchAbortController) {
            previewGrantBatchAbortRef.current = null;
          }
        }
      }
    } finally {
      previewGrantFlushRunningRef.current = false;
    }
  }, [loadGrants]);

  const requestPreviewGrant = useCallback((
    projection: PreviewGrantProjection,
    options: { forceRefresh?: boolean } = {},
  ): Promise<PreviewGrantItem | null> => {
    const key = [
      authScope,
      getPreviewGrantProjectionKey(projection),
    ].join('\u0000');
    const nowMs = Date.now();
    const cached = previewGrantCacheRef.current.get(key);
    const cacheIsFresh = Boolean(
      cached
      && nowMs < cached.freshUntilMs
    );
    if (!options.forceRefresh && cached && cacheIsFresh) {
      previewGrantCacheRef.current.delete(key);
      previewGrantCacheRef.current.set(key, cached);
      return Promise.resolve(cached.grant);
    }
    if (cached) previewGrantCacheRef.current.delete(key);

    return new Promise<PreviewGrantItem | null>((resolve, reject) => {
      const pending = pendingPreviewGrantsRef.current.get(key);
      if (pending) {
        pending.waiters.push({ resolve, reject });
        return;
      }
      pendingPreviewGrantsRef.current.set(key, {
        key,
        identityKey: getPreviewGrantIdentityKey(projection.identity),
        projection,
        waiters: [{ resolve, reject }],
      });
      previewGrantQueueRef.current.push(key);
      if (previewGrantFlushScheduledRef.current || previewGrantFlushRunningRef.current) return;
      previewGrantFlushScheduledRef.current = true;
      Promise.resolve().then(() => {
        previewGrantFlushScheduledRef.current = false;
        void flushPreviewGrantQueue();
      });
    });
  }, [authScope, flushPreviewGrantQueue]);

  return requestPreviewGrant;
};

const PreviewGrantContext = createContext<PreviewGrantRequester | null>(null);

export const PreviewGrantProvider: React.FC<{
  requestPreviewGrant: PreviewGrantRequester;
  children: React.ReactNode;
}> = ({ requestPreviewGrant, children }) => (
  <PreviewGrantContext.Provider value={requestPreviewGrant}>{children}</PreviewGrantContext.Provider>
);

export const usePreviewGrants = (): PreviewGrantRequester => {
  const request = useContext(PreviewGrantContext);
  if (!request) throw new Error('Preview media requires PreviewGrantProvider');
  return request;
};
