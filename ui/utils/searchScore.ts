import type { SearchResult } from '../services/api';

export function formatSearchScore(score: number | null | undefined, precision: number = 1): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return '-';
  }

  const percentage = score * 100;
  const roundedPercentage = Number(percentage.toFixed(Math.max(0, precision)));
  return `${Object.is(roundedPercentage, -0) ? 0 : roundedPercentage}%`;
}

type FieldScoredSearchResult = Pick<
  SearchResult,
  'field_scores' | 'field_instance_scores' | 'matched_field_instances'
>;

type ImageScoredSearchResult = Pick<
  SearchResult,
  'match_type' | 'matched_image_score' | 'image_score'
>;

const isFiniteScore = (score: unknown): score is number => (
  typeof score === 'number' && Number.isFinite(score)
);

const isPositiveFiniteScore = (score: unknown): score is number => (
  isFiniteScore(score) && score > 0
);

export function getHighestFieldSearchScore(
  result?: FieldScoredSearchResult | null,
): number | null {
  if (!result) {
    return null;
  }

  const scores: number[] = [];
  const collectScore = (score: unknown) => {
    if (isFiniteScore(score)) {
      scores.push(score);
    }
  };

  Object.values(result.field_scores || {}).forEach(collectScore);
  Object.values(result.field_instance_scores || {}).forEach(collectScore);
  (result.matched_field_instances || []).forEach((match) => collectScore(match?.score));

  return scores.length > 0 ? Math.max(...scores) : null;
}

export function getComparableSearchScore(result: FieldScoredSearchResult): number {
  return getHighestFieldSearchScore(result) ?? Number.NEGATIVE_INFINITY;
}

export function getImageSearchScore(
  result?: ImageScoredSearchResult | null,
): number | null {
  if (!result) {
    return null;
  }

  const isExplicitImageOrMultimodalMatch = result.match_type === 'image_only' || result.match_type === 'both';
  const isImageOnlyEndpointResult = !result.match_type && isFiniteScore(result.matched_image_score);

  if (!isExplicitImageOrMultimodalMatch && !isImageOnlyEndpointResult) {
    return null;
  }

  if (isPositiveFiniteScore(result.matched_image_score)) {
    return result.matched_image_score;
  }
  if (isPositiveFiniteScore(result.image_score)) {
    return result.image_score;
  }
  return null;
}

export interface SearchResultFieldScoreDisplay {
  key: string;
  fieldPath: string;
  score: number;
  label?: string | null;
}

export function getSearchResultFieldScoreDisplays(
  result: Pick<SearchResult, 'field_scores' | 'matched_field_instances'>,
  limit: number,
): SearchResultFieldScoreDisplay[] {
  if (limit <= 0) {
    return [];
  }

  const fieldScores = result.field_scores;
  if (fieldScores && Object.keys(fieldScores).length > 0) {
    return Object.entries(fieldScores)
      .filter(([, score]) => isPositiveFiniteScore(score))
      .sort(([, leftScore], [, rightScore]) => rightScore - leftScore)
      .slice(0, limit)
      .map(([fieldPath, score]) => ({
        key: fieldPath,
        fieldPath,
        score,
      }));
  }

  const bestByFieldPath = new Map<string, SearchResultFieldScoreDisplay>();
  (result.matched_field_instances || []).forEach((match) => {
    if (!match || !isPositiveFiniteScore(match.score) || !match.field_path) {
      return;
    }

    const existing = bestByFieldPath.get(match.field_path);
    if (!existing || match.score > existing.score) {
      bestByFieldPath.set(match.field_path, {
        key: match.field_instance_key || match.field_path,
        fieldPath: match.field_path,
        score: match.score,
        label: match.field_display_label ?? null,
      });
    }
  });

  return Array.from(bestByFieldPath.values())
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
