import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ATTACHMENT_PICKER_URI } from '../tools/definitions.js';

const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export const attachmentPickerResource = {
  uri: ATTACHMENT_PICKER_URI,
  name: 'VideoVector attachment picker',
  description: 'Choose files only when this host cannot forward the native attachments.',
  mimeType: RESOURCE_MIME_TYPE,
};

export async function readAttachmentPicker(uploadBaseUrl: string) {
  const origin = new URL(uploadBaseUrl).origin;
  return {
    contents: [{
      uri: ATTACHMENT_PICKER_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(join(__dirname, '../ui/attachment-picker.html'), 'utf8'),
      _meta: {
        ui: { csp: { connectDomains: [origin] }, prefersBorder: true },
        'openai/widgetCSP': { connect_domains: [origin], resource_domains: [] },
        'openai/widgetPrefersBorder': true,
      },
    }],
  };
}
