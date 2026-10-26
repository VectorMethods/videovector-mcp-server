export interface PreviewMediaFields {
  thumbnail_data?: string | null;
  thumbnail_uri?: string | null;
  preview_thumbnail_uri?: string | null;
  thumbnail_gcs_uri?: string | null;
  gif_data?: string | null;
  gif_uri?: string | null;
  preview_gif_uri?: string | null;
  gif_gcs_uri?: string | null;
  matched_image_uri?: string | null;
  matched_image_gcs_uri?: string | null;
}

export interface SegmentMediaFields extends PreviewMediaFields {
  segment_uri?: string | null;
  gcs_uri?: string | null;
  playback_source_uri?: string | null;
  playback_start_time?: number | null;
  playback_end_time?: number | null;
}

const normalizeUri = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Accept only browser-loadable URLs granted by a page response. */
export const normalizeGrantedMediaUrl = (value: unknown): string | null => {
  const normalized = typeof value === 'string' ? normalizeUri(value) : null;
  if (!normalized || normalized.startsWith('//')) return null;
  return /^(?:https?:\/\/|\/)/i.test(normalized) ? normalized : null;
};

const PUBLIC_MEDIA_STREAM_PATH = '/api/v2/media/stream';
const MAX_PUBLIC_MEDIA_TOKEN_LENGTH = 4096;
const PUBLIC_MEDIA_TOKEN_PATTERN = /^pm2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const GCS_V4_ALGORITHM_PATTERN = /^GOOG4-(?:RSA|HMAC)-SHA256$/;
const GCS_V4_DATE_PATTERN = /^\d{8}T\d{6}Z$/;
const GCS_V4_SIGNATURE_PATTERN = /^[A-Fa-f0-9]{64,1024}$/;
const MAX_GCS_V4_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/**
 * Identify the short-lived media-grant URL shape returned by the API. This is
 * deliberately a persistence/lifetime classifier, not a trust or
 * authorization decision: Cloud Run tag hosts and other HTTPS origins can
 * carry a genuine grant during a rollout, while a lookalike grant on an
 * attacker-controlled host is still unsafe to retain as durable state.
 *
 * Token authenticity remains exclusively server-side. Requiring the exact
 * path, a single plain query parameter, an HTTP(S) transport (or same-origin
 * relative path), and the fixed HMAC segment shape prevents unrelated URLs or
 * credential-bearing URL variants from being reclassified.
 */
export const isBoundedPublicMediaUri = (uri?: string | null): boolean => {
  const normalized = normalizeUri(uri);
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith('//')) {
    return false;
  }
  const isRelative = normalized.startsWith('/');
  let parsed: URL;
  try {
    parsed = new URL(normalized, 'https://relative.invalid');
  } catch {
    return false;
  }

  if (!isRelative && !['http:', 'https:'].includes(parsed.protocol)) {
    return false;
  }
  if (
    parsed.pathname !== PUBLIC_MEDIA_STREAM_PATH
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    return false;
  }

  const rawQuery = parsed.search.startsWith('?')
    ? parsed.search.slice(1)
    : '';
  if (
    !rawQuery.startsWith('token=')
    || rawQuery.indexOf('&') !== -1
  ) {
    return false;
  }

  const token = rawQuery.slice('token='.length);
  return (
    token.length <= MAX_PUBLIC_MEDIA_TOKEN_LENGTH
    && PUBLIC_MEDIA_TOKEN_PATTERN.test(token)
  );
};

/**
 * Identify Google Cloud Storage V4 query-signed URLs.
 *
 * This is a lifetime classifier used to keep bearer URLs out of durable state;
 * it intentionally does not decide whether a host or signature is trusted.
 * Requiring the complete V4 credential shape avoids treating ordinary URLs
 * that happen to contain a single `X-Goog-*` query parameter as credentials.
 */
export const isGcsV4SignedMediaUri = (uri?: string | null): boolean => {
  const normalized = normalizeUri(uri);
  if (!normalized || normalized.startsWith('//')) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return false;
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
  ) {
    return false;
  }

  const algorithm = parsed.searchParams.get('X-Goog-Algorithm') || '';
  const credential = parsed.searchParams.get('X-Goog-Credential') || '';
  const signedAt = parsed.searchParams.get('X-Goog-Date') || '';
  const rawExpires = parsed.searchParams.get('X-Goog-Expires') || '';
  const signedHeaders = parsed.searchParams.get('X-Goog-SignedHeaders') || '';
  const signature = parsed.searchParams.get('X-Goog-Signature') || '';
  const expiresSeconds = Number(rawExpires);

  return (
    GCS_V4_ALGORITHM_PATTERN.test(algorithm)
    && /\/\d{8}\/[^/]+\/storage\/goog4_request$/.test(credential)
    && GCS_V4_DATE_PATTERN.test(signedAt)
    && /^\d+$/.test(rawExpires)
    && Number.isInteger(expiresSeconds)
    && expiresSeconds > 0
    && expiresSeconds <= MAX_GCS_V4_EXPIRY_SECONDS
    && signedHeaders.split(';').some((header) => header.trim().toLowerCase() === 'host')
    && GCS_V4_SIGNATURE_PATTERN.test(signature)
  );
};

export const isEphemeralMediaUri = (uri?: string | null): boolean => (
  isBoundedPublicMediaUri(uri) || isGcsV4SignedMediaUri(uri)
);

/** Return the encoded expiry when it is derivable from a GCS V4 URL. */
export const getGcsV4SignedMediaExpiryMs = (uri?: string | null): number | null => {
  if (!isGcsV4SignedMediaUri(uri)) {
    return null;
  }

  try {
    const parsed = new URL(String(uri).trim());
    const signedAt = parsed.searchParams.get('X-Goog-Date') || '';
    const expiresSeconds = Number(parsed.searchParams.get('X-Goog-Expires'));
    const signedAtMs = Date.UTC(
      Number(signedAt.slice(0, 4)),
      Number(signedAt.slice(4, 6)) - 1,
      Number(signedAt.slice(6, 8)),
      Number(signedAt.slice(9, 11)),
      Number(signedAt.slice(11, 13)),
      Number(signedAt.slice(13, 15)),
    );
    const expiresAt = signedAtMs + (expiresSeconds * 1000);
    return Number.isFinite(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
};

export const GRANTED_MEDIA_EXPIRY_SKEW_MS = 30_000;

export const isGrantedMediaUriFresh = (
  uri?: string | null,
  nowMs: number = Date.now(),
): boolean => {
  const expiresAt = getGcsV4SignedMediaExpiryMs(uri);
  return expiresAt === null || nowMs < expiresAt - GRANTED_MEDIA_EXPIRY_SKEW_MS;
};

export const isFreshGrantedMediaUrl = (
  value: unknown,
  nowMs: number = Date.now(),
): boolean => {
  const normalized = normalizeGrantedMediaUrl(value);
  return normalized !== null && isGrantedMediaUriFresh(normalized, nowMs);
};

export const pickDurableMediaUri = (
  primary?: string | null,
  ...fallbacks: Array<string | null | undefined>
): string | null => {
  const normalizedPrimary = normalizeUri(primary);
  if (normalizedPrimary && !isEphemeralMediaUri(normalizedPrimary)) {
    return normalizedPrimary;
  }
  for (const fallback of fallbacks) {
    const normalizedFallback = normalizeUri(fallback);
    if (
      normalizedFallback
      && !isEphemeralMediaUri(normalizedFallback)
    ) {
      return normalizedFallback;
    }
  }
  return null;
};

type DurableMediaRecord = Record<string, any>;

const DURABLE_MEDIA_FALLBACKS: Record<string, string[]> = {
  segment_uri: ['gcs_uri'],
  video_uri: ['gcs_uri'],
  thumbnail_uri: [],
  gif_uri: [],
  preview_segment_uri: [],
  preview_thumbnail_uri: [],
  preview_gif_uri: [],
  video_thumbnail_uri: [],
  video_gif_uri: [],
  matched_image_uri: ['matched_image_gcs_uri'],
};

/**
 * Return a shallow persistence-safe copy of an API media record. Ordinary
 * external HTTPS and raw gs:// references are retained; expiring product
 * grants and GCS V4 bearer URLs are replaced by their durable source or
 * removed.
 */
export const sanitizeMediaRecordForPersistence = <T extends DurableMediaRecord>(
  record: T,
): T => {
  const sanitized: DurableMediaRecord = { ...record };
  delete sanitized.thumbnail_data;
  delete sanitized.gif_data;
  delete sanitized.video_thumbnail_gif;
  for (const [field, fallbackFields] of Object.entries(DURABLE_MEDIA_FALLBACKS)) {
    if (!isEphemeralMediaUri(record[field])) {
      continue;
    }
    const fallback = pickDurableMediaUri(
      null,
      ...fallbackFields.map((fallbackField) => record[fallbackField]),
    );
    if (fallback) {
      sanitized[field] = fallback;
    } else {
      delete sanitized[field];
    }
  }
  return sanitized as T;
};

const buildDataUrl = (mimeType: string, data?: string | null): string | null => {
  if (typeof data !== 'string' || data.trim().length === 0) {
    return null;
  }
  return `data:${mimeType};base64,${data}`;
};

export const isStorageMediaUri = (uri?: string | null): boolean => {
  const normalized = normalizeUri(uri);
  return Boolean(normalized && normalized.startsWith('gs://'));
};

export const isRenderableMediaUri = (uri?: string | null): boolean => {
  const normalized = normalizeUri(uri);
  if (!normalized) {
    return false;
  }
  return /^(https?:|data:|blob:)/i.test(normalized);
};

export const isImageMediaUri = (uri?: string | null): boolean => {
  const normalized = normalizeUri(uri);
  if (!normalized) {
    return false;
  }

  const pathPart = normalized.split('?')[0].split('#')[0];
  const extension = pathPart.toLowerCase().split('.').pop() || '';
  return ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'heic', 'heif'].includes(extension);
};

export const pickMediaUri = (...candidates: Array<string | null | undefined>): string | null => {
  for (const candidate of candidates) {
    const normalized = normalizeUri(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
};

export const getThumbnailPreviewSource = (media: PreviewMediaFields): string | null => (
  buildDataUrl('image/jpeg', media.thumbnail_data)
  || pickMediaUri(media.thumbnail_uri, media.preview_thumbnail_uri, media.thumbnail_gcs_uri)
);

export const getGifPreviewSource = (media: PreviewMediaFields): string | null => (
  buildDataUrl('image/gif', media.gif_data)
  || pickMediaUri(media.gif_uri, media.preview_gif_uri, media.gif_gcs_uri)
);

export const getPreferredPreviewSource = (
  media: PreviewMediaFields,
  options: { preferAnimated?: boolean } = {},
): string | null => {
  const { preferAnimated = false } = options;
  if (preferAnimated) {
    return getGifPreviewSource(media) || getThumbnailPreviewSource(media);
  }
  return getThumbnailPreviewSource(media) || getGifPreviewSource(media);
};

export interface PreviewMediaCandidate {
  kind: 'thumbnail' | 'gif';
  source: string;
  durableSource: string | null;
}

/**
 * Build preview candidates by asset kind. Each candidate keeps its immediate
 * representation and durable authority together, so consumers recover that
 * exact asset before moving to the alternate preview.
 */
export const getPreviewMediaCandidates = (
  media: PreviewMediaFields,
  options: { preferAnimated?: boolean } = {},
): PreviewMediaCandidate[] => {
  const thumbnailSource = getThumbnailPreviewSource(media);
  const gifSource = getGifPreviewSource(media);
  const byKind: Record<'thumbnail' | 'gif', PreviewMediaCandidate | null> = {
    thumbnail: thumbnailSource
      ? {
          kind: 'thumbnail',
          source: thumbnailSource,
          durableSource: pickDurableMediaUri(null, media.thumbnail_gcs_uri),
        }
      : null,
    gif: gifSource
      ? {
          kind: 'gif',
          source: gifSource,
          durableSource: pickDurableMediaUri(null, media.gif_gcs_uri),
        }
      : null,
  };
  const order: Array<'thumbnail' | 'gif'> = options.preferAnimated
    ? ['gif', 'thumbnail']
    : ['thumbnail', 'gif'];
  const seen = new Set<string>();
  const candidates: PreviewMediaCandidate[] = [];
  order.forEach((kind) => {
    const candidate = byKind[kind];
    if (!candidate) {
      return;
    }
    const authorityKey = JSON.stringify([
      candidate.source,
      candidate.durableSource,
    ]);
    if (!seen.has(authorityKey)) {
      seen.add(authorityKey);
      candidates.push(candidate);
    }
  });
  return candidates;
};

export const getSegmentPlaybackSource = (media: SegmentMediaFields): string | null => (
  pickMediaUri(media.segment_uri, media.gcs_uri, media.playback_source_uri)
);

export const hasRenderableThumbnailSource = (media: PreviewMediaFields): boolean => {
  if (typeof media.thumbnail_data === 'string' && media.thumbnail_data.trim().length > 0) {
    return true;
  }
  return isRenderableMediaUri(
    pickMediaUri(media.thumbnail_uri, media.preview_thumbnail_uri, media.thumbnail_gcs_uri),
  );
};

/** Includes raw storage authority that the shared URL resolver can mint. */
const isResolvablePreviewSource = (
  source: string | null,
  durableSource?: string | null,
): boolean => {
  if (!source) return false;
  const expiresAt = getGcsV4SignedMediaExpiryMs(source);
  return (
    expiresAt === null
    || Date.now() < expiresAt - GRANTED_MEDIA_EXPIRY_SKEW_MS
    || Boolean(pickDurableMediaUri(null, durableSource))
  );
};

export const hasResolvableThumbnailSource = (media: PreviewMediaFields): boolean => (
  isResolvablePreviewSource(
    getThumbnailPreviewSource(media),
    media.thumbnail_gcs_uri,
  )
);

export const hasRenderableGifSource = (media: PreviewMediaFields): boolean => {
  if (typeof media.gif_data === 'string' && media.gif_data.trim().length > 0) {
    return true;
  }
  return isRenderableMediaUri(
    pickMediaUri(media.gif_uri, media.preview_gif_uri, media.gif_gcs_uri),
  );
};

/** Includes raw storage authority that the shared URL resolver can mint. */
export const hasResolvableGifSource = (media: PreviewMediaFields): boolean => (
  isResolvablePreviewSource(
    getGifPreviewSource(media),
    media.gif_gcs_uri,
  )
);
