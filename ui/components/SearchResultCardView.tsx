import ResultCardFrame from './ResultCardFrame';
import React, { useMemo, useState } from 'react';
import { Clock, Download, Eye } from 'lucide-react';
import type { SearchResult } from '../services/api';
import { formatSearchScore, getImageSearchScore } from '../utils/searchScore';
import { pickDurableMediaUri } from '../utils/mediaSources';
import { getResultDisplayDuration, getResultDisplayEndTime, getResultDisplayStartTime, hasResultDisplayTiming } from '../utils/resultTiming';
import type { PreviewGrantProjection } from '../contexts/PreviewGrantContext';
import GrantedPreviewImage from './GrantedPreviewImage';
import './SearchResultCard.css';

export interface SearchResultCardViewProps {
  result: SearchResult;
  onResultClick?: (result: SearchResult) => void;
  isActiveInSidebar?: boolean;
  markerAction?: React.ReactNode;
  isVectorSearchTile?: boolean;
  /** Ranked segment evidence shown only by the synthesized full-video tile. */
  videoTileEvidence?: SearchResultCardEvidence | SearchResultCardEvidence[] | null;
  /** Filter-selected fields that should be surfaced before other backend-ranked evidence. */
  prioritizedFieldPaths?: string[];
  /** Canonical media family selected by the containing gallery boundary. */
  previewProjection?: PreviewGrantProjection | null;
}

interface SearchTileOverlayBoxProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  ariaLabel?: string;
  multiline?: boolean;
}

const joinClassNames = (...classNames: Array<string | false | null | undefined>): string => (
  classNames.filter(Boolean).join(' ')
);

const MAX_VISIBLE_EVIDENCE_FIELDS = 3;
const MAX_EVIDENCE_SNIPPET_LENGTH = 112;
const EMPTY_PRIORITIZED_FIELD_PATHS: string[] = [];

type ScoreTone = 'text' | 'image' | 'field';

interface ResultCardScore {
  key: string;
  label: string;
  score: number;
  tone: ScoreTone;
}

export interface SearchResultCardEvidence {
  key: string;
  snippet: string;
  score: number | null;
  prioritized?: boolean;
}

interface ParsedFieldPathSegment {
  key: string | number;
  expandArray: boolean;
}

const isFiniteScore = (score: unknown): score is number => (
  typeof score === 'number' && Number.isFinite(score)
);

const truncateEvidenceSnippet = (value: string): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_EVIDENCE_SNIPPET_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_EVIDENCE_SNIPPET_LENGTH - 1).trimEnd()}\u2026`;
};

const formatEvidenceValue = (value: unknown, depth = 0): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return truncateEvidenceSnippet(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'boolean') {
    return null;
  }
  if (Array.isArray(value)) {
    const entries = value
      .slice(0, 4)
      .map((entry) => formatEvidenceValue(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry));
    if (entries.length === 0) {
      return null;
    }
    const suffix = value.length > entries.length ? ` \u00b7 +${value.length - entries.length}` : '';
    return truncateEvidenceSnippet(`${entries.join(' \u00b7 ')}${suffix}`);
  }
  if (typeof value === 'object' && depth < 2) {
    const entries = Object.values(value as Record<string, unknown>)
      .slice(0, 3)
      .flatMap((entryValue) => {
        const formattedValue = formatEvidenceValue(entryValue, depth + 1);
        return formattedValue ? [formattedValue] : [];
      });
    return entries.length > 0
      ? truncateEvidenceSnippet(entries.join(' \u00b7 '))
      : null;
  }
  return null;
};

const parseFieldPath = (fieldPath: string): ParsedFieldPathSegment[] => {
  const normalizedPath = fieldPath.trim();
  if (!normalizedPath) {
    return [];
  }

  if (normalizedPath.startsWith('__nested__:')) {
    try {
      const decoded = JSON.parse(normalizedPath.slice('__nested__:'.length));
      if (Array.isArray(decoded)) {
        return decoded.flatMap((rawSegment): ParsedFieldPathSegment[] => {
          if (typeof rawSegment !== 'string' || !rawSegment.trim()) {
            return [];
          }
          const segment = rawSegment.trim();
          const expandArray = segment.endsWith('[]');
          return [{
            key: expandArray ? segment.slice(0, -2) : segment,
            expandArray,
          }];
        });
      }
    } catch {
      return [];
    }
  }

  const segments: ParsedFieldPathSegment[] = [];
  const pathPattern = /([^.[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(normalizedPath)) !== null) {
    if (match[2] !== undefined) {
      segments.push({ key: Number(match[2]), expandArray: false });
      continue;
    }
    const segment = match[1];
    const expandArray = segment.endsWith('[]');
    segments.push({
      key: expandArray ? segment.slice(0, -2) : segment,
      expandArray,
    });
  }
  return segments;
};

const resolveMetadataPath = (
  metadata: Record<string, unknown>,
  fieldPath: string,
): unknown => {
  if (Object.prototype.hasOwnProperty.call(metadata, fieldPath)) {
    return metadata[fieldPath];
  }

  const segments = parseFieldPath(fieldPath);
  if (segments.length === 0) {
    return undefined;
  }

  let nodes: unknown[] = [metadata];
  segments.forEach(({ key, expandArray }) => {
    const nextNodes: unknown[] = [];
    nodes.forEach((node) => {
      if (Array.isArray(node)) {
        if (typeof key === 'number') {
          if (key < node.length) nextNodes.push(node[key]);
          return;
        }
        node.forEach((entry) => {
          if (entry && typeof entry === 'object' && key in entry) {
            const value = (entry as Record<string, unknown>)[key];
            if (expandArray && Array.isArray(value)) nextNodes.push(...value);
            else nextNodes.push(value);
          }
        });
        return;
      }
      if (!node || typeof node !== 'object') {
        return;
      }
      const value = (node as Record<string, unknown>)[String(key)];
      if (value === undefined) {
        return;
      }
      if (expandArray && Array.isArray(value)) nextNodes.push(...value);
      else nextNodes.push(value);
    });
    nodes = nextNodes;
  });

  if (nodes.length === 0) return undefined;
  return nodes.length === 1 ? nodes[0] : nodes;
};

const selectResultMetadata = (result: SearchResult): Record<string, unknown> => {
  return {
    ...(result.metadata || {}),
    ...(result.extracted_metadata || {}),
  };
};

const getComparableFieldPath = (fieldPath: string): string => (
  JSON.stringify(
    parseFieldPath(fieldPath)
      .filter((segment) => typeof segment.key === 'string')
      .map((segment) => String(segment.key).trim())
      .filter(Boolean),
  )
);

const isBooleanEvidenceValue = (value: unknown, preview?: string | null): boolean => {
  if (typeof value === 'boolean') return true;
  if (
    Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'boolean')
  ) {
    return true;
  }
  return (
    (value === null || value === undefined)
    && typeof preview === 'string'
    && /^(true|false)$/i.test(preview.trim())
  );
};

const buildResultCardEvidence = (
  result: SearchResult,
  prioritizedFieldPaths: string[] = [],
): SearchResultCardEvidence[] => {
  const metadata = selectResultMetadata(result);
  const evidence: SearchResultCardEvidence[] = [];
  const representedFieldPaths = new Set<string>();
  const representedValues = new Set<string>();

  const appendEvidence = ({
    key,
    fieldPath,
    fieldInstancePath,
    valuePreview,
    score,
    prioritized = false,
  }: {
    key: string;
    fieldPath: string;
    fieldInstancePath?: string | null;
    valuePreview?: string | null;
    score: number | null;
    prioritized?: boolean;
  }): void => {
    if (
      evidence.length >= MAX_VISIBLE_EVIDENCE_FIELDS
      || !fieldPath
      || representedFieldPaths.has(getComparableFieldPath(fieldPath))
    ) {
      return;
    }

    const rawValue = resolveMetadataPath(metadata, fieldInstancePath || fieldPath);
    if (isBooleanEvidenceValue(rawValue, valuePreview)) return;
    const snippet = formatEvidenceValue(valuePreview) || formatEvidenceValue(rawValue);
    if (!snippet) return;
    const normalizedSnippet = snippet.toLocaleLowerCase();
    if (representedValues.has(normalizedSnippet)) return;
    representedFieldPaths.add(getComparableFieldPath(fieldPath));
    representedValues.add(normalizedSnippet);
    evidence.push({ key, snippet, score, prioritized });
  };

  const exactMatches = result.matched_field_instances || [];
  const aggregateFieldScores = Object.entries(result.field_scores || {})
    .filter((entry): entry is [string, number] => isFiniteScore(entry[1]));
  const exactMatchByFieldPath = new Map<string, (typeof exactMatches)[number]>();
  exactMatches.forEach((match) => {
    if (!match?.field_path || !isFiniteScore(match.score)) return;
    const comparableFieldPath = getComparableFieldPath(match.field_path);
    if (!exactMatchByFieldPath.has(comparableFieldPath)) {
      exactMatchByFieldPath.set(comparableFieldPath, match);
    }
  });
  const aggregateScoreByFieldPath = new Map(
    aggregateFieldScores.map(([fieldPath, score]) => [getComparableFieldPath(fieldPath), score]),
  );

  prioritizedFieldPaths.forEach((fieldPath) => {
    const normalizedFieldPath = String(fieldPath || '').trim();
    if (!normalizedFieldPath) return;
    const comparableFieldPath = getComparableFieldPath(normalizedFieldPath);
    const exactMatch = exactMatchByFieldPath.get(comparableFieldPath);
    const aggregateScore = aggregateScoreByFieldPath.get(comparableFieldPath);
    appendEvidence({
      key: `priority:${normalizedFieldPath}`,
      fieldPath: normalizedFieldPath,
      fieldInstancePath: exactMatch?.field_instance_path,
      valuePreview: exactMatch?.value_preview,
      score: exactMatch?.score ?? aggregateScore ?? null,
      prioritized: true,
    });
  });

  if (exactMatches.length > 0) {
    // The backend orders this list by the Pinecone field-document match score.
    // Preserve that order and pass the raw finite score to the shared formatter;
    // do not clamp it or guess whether it is already a percentage.
    exactMatches.forEach((match) => {
      if (!match || !match.field_path || !isFiniteScore(match.score)) return;
      appendEvidence({
        key: match.field_instance_key || match.field_path,
        fieldPath: match.field_path,
        fieldInstancePath: match.field_instance_path,
        valuePreview: match.value_preview,
        score: match.score,
      });
    });
  } else {
    // Legacy payloads expose only the backend's max exact-instance score per path.
    aggregateFieldScores
      .sort((left, right) => right[1] - left[1])
      .forEach(([fieldPath, score]) => {
        appendEvidence({
          key: fieldPath,
          fieldPath,
          score,
        });
      });
  }

  // Conditional results can identify matched fields without similarity scores.
  (result.matched_field_paths || []).forEach((fieldPath) => {
    appendEvidence({
      key: `matched:${fieldPath}`,
      fieldPath,
      score: null,
    });
  });

  return evidence;
};

export const getSearchResultCardEvidence = (
  result: SearchResult,
  prioritizedFieldPaths: string[] = [],
): SearchResultCardEvidence[] => buildResultCardEvidence(result, prioritizedFieldPaths);

const buildResultCardScores = (result: SearchResult): ResultCardScore[] => {
  const scores: ResultCardScore[] = [];
  if (
    (result.match_type === 'both' || result.match_type === 'text_only')
    && isFiniteScore(result.text_score)
    && result.text_score > 0
  ) {
    scores.push({ key: 'text', label: 'Text', score: result.text_score, tone: 'text' });
  }
  const imageScore = getImageSearchScore(result);
  if (imageScore !== null) {
    scores.push({ key: 'image', label: 'Image', score: imageScore, tone: 'image' });
  }
  return scores;
};

const ScorePill: React.FC<{
  label: string;
  score: number;
  tone: ScoreTone;
  compact?: boolean;
}> = ({ label, score, tone, compact = false }) => {
  const formattedScore = formatSearchScore(score);
  return (
    <span
      className={joinClassNames(
        'result-card-score-pill',
        `result-card-score-pill--${tone}`,
        compact && 'result-card-score-pill--compact',
      )}
      aria-label={`${label}: ${formattedScore}`}
      title={`${label}: ${formattedScore}`}
    >
      {!compact && <span className="result-card-score-label">{label}</span>}
      <strong>{formattedScore}</strong>
    </span>
  );
};

const sanitizeFilenamePart = (value: string | null | undefined, fallback: string, maxLength = 50): string => {
  const sanitized = (value || fallback)
    .replace(/[^a-zA-Z0-9-_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, maxLength);

  return sanitized || fallback;
};

const SearchTileOverlayBox: React.FC<SearchTileOverlayBoxProps> = ({
  children,
  className,
  title,
  ariaLabel,
  multiline = false,
}) => (
  <span
    className={joinClassNames(
      'search-tile-overlay-box',
      multiline && 'search-tile-overlay-box--multiline',
      className,
    )}
    title={title}
    aria-label={ariaLabel}
  >
    {children}
  </span>
);

const SearchResultCardView: React.FC<SearchResultCardViewProps> = ({
  result,
  onResultClick,
  isActiveInSidebar = false,
  markerAction,
  isVectorSearchTile = false,
  videoTileEvidence,
  prioritizedFieldPaths = EMPTY_PRIORITIZED_FIELD_PATHS,
  previewProjection,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusWithin, setIsFocusWithin] = useState(false);
  const hasTiming = hasResultDisplayTiming(result);
  const displayStartTime = getResultDisplayStartTime(result);
  const displayEndTime = getResultDisplayEndTime(result);
  const displayDuration = getResultDisplayDuration(result);
  const resultEvidenceItems = useMemo(
    () => buildResultCardEvidence(result, prioritizedFieldPaths),
    [prioritizedFieldPaths, result],
  );
  const evidenceItems = useMemo(() => (
    result.result_type === 'video' && videoTileEvidence !== undefined
      ? videoTileEvidence
        ? Array.isArray(videoTileEvidence) ? videoTileEvidence : [videoTileEvidence]
        : []
      : resultEvidenceItems
  ), [result.result_type, resultEvidenceItems, videoTileEvidence]);
  const scoreItems = useMemo(() => buildResultCardScores(result), [result]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleCardClick = () => {
    if (onResultClick) {
      onResultClick(result);
    }
  };

  const handleDownloadTileMetadata = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    const exportLabel = result.result_type === 'video' ? 'video_result' : 'segment';
    const videoName = result.video_name || result.video_id;
    const runId = result.run_id || result.source_run_id || result.prompt_run_id || null;
    const hasExtractedMetadata = Boolean(
      result.extracted_metadata && Object.keys(result.extracted_metadata).length > 0
    );
    const metadata = hasExtractedMetadata ? result.extracted_metadata : result.metadata || {};
    // Metadata downloads are durable artifacts. Never persist a short-lived
    // matched-shot grant, and never substitute a thumbnail/GIF authority for
    // it: only the exact validated matched-image source can replace it.
    const durableMatchedImageUri = pickDurableMediaUri(
      result.matched_image_uri,
      result.matched_image_gcs_uri,
    );
    const durablePlaybackUri = pickDurableMediaUri(
      result.segment_uri,
      result.gcs_uri,
      result.result_type === 'video' ? result.video_uri : null,
    );
    const exportData = {
      export_info: {
        exported_at: new Date().toISOString(),
        result_type: result.result_type,
        result_id: result.result_id,
        video_id: result.video_id,
        video_name: videoName || null,
        segment_id: result.segment_id,
        run_id: runId,
        index_id: result.source_index_id || null,
      },
      result: {
        result_type: result.result_type,
        result_id: result.result_id,
        segment_id: result.segment_id,
        video_id: result.video_id,
        video_name: videoName || null,
        start_time: displayStartTime,
        end_time: displayEndTime,
        duration: displayDuration,
        segment_uri: durablePlaybackUri,
        run_id: runId,
        index_id: result.source_index_id || null,
        text_content: result.text_content || null,
        metadata_text: result.metadata_text || null,
        metadata,
        field_scores: result.field_scores || {},
        field_instance_scores: result.field_instance_scores || {},
        matched_field_paths: result.matched_field_paths || [],
        matched_field_instances: result.matched_field_instances || [],
        matched_image_gcs_uri: result.matched_image_gcs_uri || null,
        matched_image_uri: durableMatchedImageUri,
        matched_image_timestamp: result.matched_image_timestamp ?? null,
        shot_timestamp: result.shot_timestamp ?? null,
      },
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeVideoName = sanitizeFilenamePart(videoName, 'search_result');
    const entityKey = sanitizeFilenamePart(result.segment_id || result.result_id || result.video_id, 'result', 24);

    link.href = url;
    link.download = `${safeVideoName}_${exportLabel}_${entityKey}_metadata.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const matchText = result.content_preview || result.text_content;
  const matchTextLimit = isVectorSearchTile ? 320 : 150;
  const visibleMatchText = matchText && evidenceItems.length === 0
    ? matchText.length <= matchTextLimit
      ? matchText
      : `${matchText.substring(0, matchTextLimit).trimEnd()}...`
    : '';
  
  return (
    <ResultCardFrame
      className={`${isActiveInSidebar ? 'active-in-sidebar' : ''} ${isVectorSearchTile ? 'vector-result-card' : ''}`}
      onOpen={handleCardClick}
      label={`Open ${result.video_name || 'search result'}`}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onFocus={() => setIsFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsFocusWithin(false);
      }}

    >
      {markerAction && <div className="result-card-marker" onClick={(event) => event.stopPropagation()}>
        {markerAction}
      </div>}
      <button
        type="button"
        className="result-card-download-btn"
        onClick={handleDownloadTileMetadata}
        aria-label="Download tile metadata"
        title="Download tile metadata JSON"
      >
        <Download size={12} />
      </button>

      {/* Preview fills entire card */}
      <GrantedPreviewImage
        projection={previewProjection}
        alt="Video preview"
        className="preview-image"
        containerClassName="result-preview"
        engaged={isHovered || isFocusWithin}
        placeholder={(
          <div className="preview-placeholder">
            <Eye size={32} />
            <span>No Preview</span>
          </div>
        )}
      />

      {/* Content overlay - time is always visible; details expand on hover/show-details */}
      <div className="result-content">
        <div className="result-content-details">
          {/* Text content */}
          {visibleMatchText && !visibleMatchText.includes(': ') && (
            <SearchTileOverlayBox multiline>
              {visibleMatchText}
            </SearchTileOverlayBox>
          )}
        </div>

        {scoreItems.length > 0 && (
          <div className="result-card-score-strip" aria-label="Search modality scores">
            {scoreItems.map((score) => (
              <ScorePill
                key={score.key}
                label={score.label}
                score={score.score}
                tone={score.tone}
              />
            ))}
          </div>
        )}

        {evidenceItems.length > 0 && (
          <div className="result-card-evidence-list" aria-label="Matched field evidence">
            {evidenceItems.map((evidence) => {
              const formattedScore = evidence.score === null
                ? null
                : formatSearchScore(evidence.score);
              const rowDescription = [
                evidence.snippet,
                formattedScore ? `${formattedScore} field similarity` : 'Matched field',
              ].filter(Boolean).join(', ');
              return (
                <div
                  className="result-card-evidence-row"
                  key={evidence.key}
                  aria-label={rowDescription}
                >
                  <span className="result-card-evidence-snippet">
                    {evidence.snippet}
                  </span>
                  {evidence.score !== null && (
                    <ScorePill
                      label="Field similarity"
                      score={evidence.score}
                      tone="field"
                      compact
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="result-preview-bottombar">
          {hasTiming ? (
            <>
              <SearchTileOverlayBox>
                {formatTime(displayDuration as number)}
              </SearchTileOverlayBox>
              <SearchTileOverlayBox>
                <Clock size={12} />
                {formatTime(displayStartTime as number)} - {formatTime(displayEndTime as number)}
              </SearchTileOverlayBox>
            </>
          ) : evidenceItems.length === 0 && result.result_type !== 'video' ? (
            <SearchTileOverlayBox>
              Result
            </SearchTileOverlayBox>
          ) : null}
        </div>
      </div>
    </ResultCardFrame>
  );
};

export default SearchResultCardView;
