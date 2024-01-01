export const sanitizeDownloadFilenamePart = (
  value: string,
  fallback: string,
  maxLength = 80,
): string => {
  const sanitized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, maxLength);
  return sanitized || fallback;
};

export const getMediaFilenameExtension = (
  uri: string,
  fallback = 'mp4',
): string => {
  const withoutQuery = String(uri || '').split(/[?#]/, 1)[0];
  const filename = withoutQuery.split('/').pop() || '';
  const extension = filename.includes('.') ? filename.split('.').pop() || '' : '';
  return /^[a-zA-Z0-9]{1,8}$/.test(extension) ? extension.toLowerCase() : fallback;
};

export const triggerBrowserDownload = (url: string, filename: string): void => {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

export const downloadJsonFile = (value: unknown, filename: string): void => {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json',
  });
  const objectUrl = URL.createObjectURL(blob);
  try {
    triggerBrowserDownload(objectUrl, filename);
  } finally {
    // Keep the URL alive through the browser's download dispatch task.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
};
