type ResultRow = Record<string, unknown>;

const PREVIEW_REFERENCE_FIELDS = [
  'thumbnail_gcs_uri', 'gif_gcs_uri', 'video_thumbnail_gcs_uri', 'video_gif_gcs_uri',
] as const;

function rows(value: ResultRow): ResultRow[] {
  return [value, value.filtered, value.unfiltered].flatMap(page => {
    if (!page || typeof page !== 'object') return [];
    const data = (page as ResultRow).data;
    return Array.isArray(data) ? data as ResultRow[] : [];
  });
}

/** Durable identities stay private; the shared viewport grant client loads media lazily. */
export function addWorkflowPreviewReferences(view: ResultRow, source: ResultRow): void {
  const originals = new Map(rows(source).map(row => [row.result_id, row]));
  for (const row of rows(view)) {
    const original = originals.get(row.result_id);
    if (!original || original.video_id !== row.video_id) continue;
    for (const field of PREVIEW_REFERENCE_FIELDS) {
      const value = original[field];
      row[field] = typeof value === 'string' && value.startsWith('gs://') ? value : null;
    }
  }
}
