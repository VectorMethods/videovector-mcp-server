import type { SearchResult } from '../services/api';

const normalizeTimingValue = (value: number | null | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const getResultDisplayStartTime = (
  result: Partial<SearchResult> | null | undefined,
): number | null => (
  normalizeTimingValue(result?.start_time)
  ?? normalizeTimingValue(result?.preview_start_time)
);

export const getResultDisplayEndTime = (
  result: Partial<SearchResult> | null | undefined,
): number | null => (
  normalizeTimingValue(result?.end_time)
  ?? normalizeTimingValue(result?.preview_end_time)
);

export const hasResultDisplayTiming = (
  result: Partial<SearchResult> | null | undefined,
): boolean => (
  getResultDisplayStartTime(result) !== null
  && getResultDisplayEndTime(result) !== null
);

export const getResultDisplayDuration = (
  result: Partial<SearchResult> | null | undefined,
): number | null => {
  const start = getResultDisplayStartTime(result);
  const end = getResultDisplayEndTime(result);
  if (start === null || end === null) {
    return null;
  }
  return end - start;
};
