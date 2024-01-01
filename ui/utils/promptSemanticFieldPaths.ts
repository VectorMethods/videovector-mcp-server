/** Canonical semantic field identities, shared by schema editing and result consumers. */
export const normalizePromptSchemaFieldName = (fieldName: string): string => fieldName.trim();
export const VIDEO_LEVEL_NESTED_FIELD_NAME_PREFIX = '__nested__:';
const PROMPT_SEMANTIC_SEARCH_FIELD_INSTANCE_PREFIX = '__instance__:';
export const RESERVED_PROMPT_SCHEMA_FIELD_NAME_CHARACTERS = ['.', '[', ']'] as const;
export type PromptSemanticSearchFieldInstanceToken = string | number;

export const encodeVideoLevelNestedFieldName = (segments: string[]): string => (
  `${VIDEO_LEVEL_NESTED_FIELD_NAME_PREFIX}${JSON.stringify(segments)}`
);

const shouldEncodePromptSemanticSearchFieldSegment = (segment: string): boolean => (
  RESERVED_PROMPT_SCHEMA_FIELD_NAME_CHARACTERS.some((character) => segment.includes(character))
  || segment.startsWith(VIDEO_LEVEL_NESTED_FIELD_NAME_PREFIX)
);

export const decodeVideoLevelNestedFieldName = (fieldName: string): string[] | null => {
  if (!fieldName.startsWith(VIDEO_LEVEL_NESTED_FIELD_NAME_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fieldName.slice(VIDEO_LEVEL_NESTED_FIELD_NAME_PREFIX.length));
    return Array.isArray(parsed) && parsed.every((segment) => typeof segment === 'string' && segment.trim())
      ? parsed.map((segment) => segment.trim())
      : null;
  } catch {
    return null;
  }
};

export const canonicalizePromptSemanticSearchFieldName = (fieldName: string): string => {
  const normalizedFieldName = normalizePromptSchemaFieldName(fieldName);
  if (!normalizedFieldName) {
    return '';
  }

  const decodedNestedField = decodeVideoLevelNestedFieldName(normalizedFieldName);
  if (decodedNestedField) {
    return encodePromptSemanticSearchFieldPathSegments(decodedNestedField);
  }

  const dottedSegments = normalizedFieldName.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (dottedSegments.length > 1) {
    return encodeVideoLevelNestedFieldName(dottedSegments);
  }

  return normalizedFieldName;
};

export const encodePromptSemanticSearchFieldPathSegments = (pathSegments: string[]): string => {
  if (pathSegments.length === 0) {
    return '';
  }
  if (pathSegments.length === 1 && !shouldEncodePromptSemanticSearchFieldSegment(pathSegments[0])) {
    return pathSegments[0];
  }
  return encodeVideoLevelNestedFieldName(pathSegments);
};

export const canonicalizePromptSemanticSearchFieldPath = (
  fieldPath: string,
): string => {
  const normalizedFieldPath = normalizePromptSchemaFieldName(fieldPath);
  if (!normalizedFieldPath) {
    return '';
  }

  const decodedNestedField = decodeVideoLevelNestedFieldName(normalizedFieldPath);
  if (decodedNestedField) {
    return encodePromptSemanticSearchFieldPathSegments(decodedNestedField);
  }

  const pathSegments = normalizedFieldPath
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !/^\d+$/.test(segment));

  if (pathSegments.length === 0) {
    return '';
  }

  return encodePromptSemanticSearchFieldPathSegments(pathSegments);
};

export const encodePromptSemanticSearchFieldInstanceKey = (
  pathTokens: PromptSemanticSearchFieldInstanceToken[],
): string => {
  const normalizedTokens = pathTokens.reduce<PromptSemanticSearchFieldInstanceToken[]>((nextTokens, token) => {
    if (typeof token === 'number' && Number.isInteger(token)) {
      nextTokens.push(token);
      return nextTokens;
    }

    if (typeof token === 'string') {
      const normalizedToken = normalizePromptSchemaFieldName(token);
      if (normalizedToken) {
        nextTokens.push(normalizedToken);
      }
    }
    return nextTokens;
  }, []);

  if (normalizedTokens.length === 0) {
    return '';
  }

  return `${PROMPT_SEMANTIC_SEARCH_FIELD_INSTANCE_PREFIX}${JSON.stringify(normalizedTokens)}`;
};

export const decodePromptSemanticSearchFieldInstanceKey = (
  fieldInstanceKey: string,
): PromptSemanticSearchFieldInstanceToken[] | null => {
  if (!fieldInstanceKey.startsWith(PROMPT_SEMANTIC_SEARCH_FIELD_INSTANCE_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fieldInstanceKey.slice(PROMPT_SEMANTIC_SEARCH_FIELD_INSTANCE_PREFIX.length));
    if (!Array.isArray(parsed)) {
      return null;
    }

    const normalizedTokens = parsed.reduce<PromptSemanticSearchFieldInstanceToken[] | null>((nextTokens, token) => {
      if (nextTokens === null) {
        return null;
      }

      if (typeof token === 'number' && Number.isInteger(token)) {
        nextTokens.push(token);
        return nextTokens;
      }

      if (typeof token === 'string') {
        const normalizedToken = normalizePromptSchemaFieldName(token);
        if (!normalizedToken) {
          return null;
        }
        nextTokens.push(normalizedToken);
        return nextTokens;
      }

      return null;
    }, []);

    return normalizedTokens && normalizedTokens.length > 0 ? normalizedTokens : null;
  } catch {
    return null;
  }
};
