import { ATTACHMENT_PICKER_URI } from '../tools/definitions.js';
import { readResultsCard } from './results-card.js';

const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export const attachmentPickerResource = {
  uri: ATTACHMENT_PICKER_URI,
  name: 'VideoVector attachment picker',
  description: 'Choose files only when this host cannot forward the native attachments.',
  mimeType: RESOURCE_MIME_TYPE,
};

export async function readAttachmentPicker(uploadBaseUrl: string) {
  // Saved conversations may reference this URI; both entry points use one UI.
  return readResultsCard(ATTACHMENT_PICKER_URI, uploadBaseUrl);
}
