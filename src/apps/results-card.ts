import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RESULTS_CARD_URI } from '../tools/workflow-result-contract.js';

// Saved client conversations can still reference the originally published URI.
export const LEGACY_RESULTS_CARD_URI = 'ui://videovector/results-card.html';

export const resultsCardResource = {
  uri: RESULTS_CARD_URI,
  name: 'VideoVector results',
  description: 'Review results, play selected media, and open full or matching JSON downloads.',
  mimeType: 'text/html;profile=mcp-app',
};

export async function readResultsCard(uri = RESULTS_CARD_URI, uploadBaseUrl?: string) {
  const mediaOrigins = ['https://storage.googleapis.com'];
  const connectDomains = uploadBaseUrl ? [new URL(uploadBaseUrl).origin] : [];
  return { contents: [{
    ...resultsCardResource,
    uri,
    text: await readFile(join(__dirname, '../ui/results-card.html'), 'utf8'),
    _meta: {
      ui: { csp: { resourceDomains: mediaOrigins, connectDomains }, prefersBorder: true },
      'openai/widgetCSP': { resource_domains: mediaOrigins, connect_domains: connectDomains },
      'openai/widgetPrefersBorder': true,
      'openai/widgetDescription': 'A video result viewer with a preloaded paused player, selectable segments, formatted analysis, and JSON downloads. The user can inspect results here; avoid repeating the displayed fields or setup steps in the conversation.',
    },
  }] };
}
