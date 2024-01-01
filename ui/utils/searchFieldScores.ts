import {
  canonicalizePromptSemanticSearchFieldPath,
  decodePromptSemanticSearchFieldInstanceKey,
  encodePromptSemanticSearchFieldPathSegments,
  encodePromptSemanticSearchFieldInstanceKey,
  PromptSemanticSearchFieldInstanceToken,
} from './promptSemanticFieldPaths';

const getFieldScoreForPath = (
  fieldScores: Record<string, number>,
  fieldPath: string,
  fieldPathTokens: PromptSemanticSearchFieldInstanceToken[] = [],
): number | undefined => {
  const stringPathTokens = fieldPathTokens.filter(
    (token): token is string => typeof token === 'string',
  );
  if (stringPathTokens.length > 0) {
    const encodedFieldPath = encodePromptSemanticSearchFieldPathSegments(stringPathTokens);
    if (encodedFieldPath && fieldScores[encodedFieldPath] !== undefined) {
      return fieldScores[encodedFieldPath];
    }
  }
  const canonicalFieldPath = canonicalizePromptSemanticSearchFieldPath(fieldPath);
  return canonicalFieldPath ? fieldScores[canonicalFieldPath] : undefined;
};

const buildLegacyFieldInstancePath = (
  pathTokens: PromptSemanticSearchFieldInstanceToken[],
): string => pathTokens.reduce<string[]>((parts, token) => {
  if (typeof token === 'number') {
    const indexPart = `[${token}]`;
    if (parts.length > 0) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}${indexPart}`;
    } else {
      parts.push(indexPart);
    }
    return parts;
  }

  const normalizedToken = token.trim();
  if (!normalizedToken) {
    return parts;
  }
  parts.push(normalizedToken);
  return parts;
}, []).join('.');

const hasFieldInstanceTokenPrefix = (
  candidateTokens: PromptSemanticSearchFieldInstanceToken[],
  prefixTokens: PromptSemanticSearchFieldInstanceToken[],
): boolean => (
  prefixTokens.length <= candidateTokens.length
  && prefixTokens.every((token, index) => candidateTokens[index] === token)
);

const getFieldInstanceScoreForTokens = (
  fieldInstanceScores: Record<string, number>,
  pathTokens: PromptSemanticSearchFieldInstanceToken[],
): number | undefined => {
  if (pathTokens.length === 0) {
    return undefined;
  }

  const encodedKey = encodePromptSemanticSearchFieldInstanceKey(pathTokens);
  if (encodedKey && fieldInstanceScores[encodedKey] !== undefined) {
    return fieldInstanceScores[encodedKey];
  }

  const legacyPath = buildLegacyFieldInstancePath(pathTokens);
  return legacyPath ? fieldInstanceScores[legacyPath] : undefined;
};

const pickHigherDefinedScore = (
  currentScore: number | undefined,
  nextScore: number | undefined,
): number | undefined => {
  if (nextScore === undefined) {
    return currentScore;
  }
  if (currentScore === undefined) {
    return nextScore;
  }
  return nextScore > currentScore ? nextScore : currentScore;
};

export const getBestFieldScoreForDisplayPath = (
  fieldScores: Record<string, number>,
  fieldInstanceScores: Record<string, number>,
  fieldPath: string,
  fieldPathTokens: PromptSemanticSearchFieldInstanceToken[] = [],
): number | undefined => {
  const exactInstanceScore = getFieldInstanceScoreForTokens(fieldInstanceScores, fieldPathTokens);
  if (exactInstanceScore !== undefined) {
    return exactInstanceScore;
  }

  let bestScore = getFieldScoreForPath(fieldScores, fieldPath, fieldPathTokens);

  if (!fieldPath && fieldPathTokens.length === 0) {
    return bestScore;
  }

  Object.entries(fieldInstanceScores).forEach(([instancePath, score]) => {
    const instanceTokens = decodePromptSemanticSearchFieldInstanceKey(instancePath);
    if (instanceTokens) {
      if (
        fieldPathTokens.length > 0
        && instanceTokens.length > fieldPathTokens.length
        && hasFieldInstanceTokenPrefix(instanceTokens, fieldPathTokens)
      ) {
        bestScore = pickHigherDefinedScore(bestScore, score);
      }
      return;
    }

    const dotPrefix = `${fieldPath}.`;
    const bracketPrefix = `${fieldPath}[`;
    if (fieldPath && (instancePath.startsWith(dotPrefix) || instancePath.startsWith(bracketPrefix))) {
      bestScore = pickHigherDefinedScore(bestScore, score);
    }
  });

  return bestScore;
};

