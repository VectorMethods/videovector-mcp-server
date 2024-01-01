import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'VideoVector attachment picker', version: '3.0.0' });
const form = document.querySelector('#upload-form');
const input = document.querySelector('#files');
const submit = document.querySelector('#submit');
const message = document.querySelector('#message');
const selection = document.querySelector('#selection');
let upload;
let job;
let chosen = [];
const uploaded = new Set();

function receive(result) {
  job = result.structuredContent;
  upload = result._meta?.upload;
  if (result.isError) {
    form.hidden = true;
    message.textContent = 'This request did not start. Return to the conversation to resolve the error.';
  } else if (upload && job?.status === 'awaiting_upload') {
    input.accept = upload.accept;
    form.hidden = false;
    message.textContent = 'Your host could not forward these files. Choose them here to continue the same request.';
  } else {
    form.hidden = true;
    message.textContent = job?.run_id
      ? 'Your execution has started. Results will include matches and all extracted segments.'
      : 'Your files are queued. You can continue this conversation while they process.';
  }
}

app.ontoolresult = receive;
input.addEventListener('change', () => {
  chosen = Array.from(input.files ?? [], file => ({ file, file_id: crypto.randomUUID() }));
  uploaded.clear();
  selection.textContent = `${chosen.length} file${chosen.length === 1 ? '' : 's'} selected`;
});

async function uploadRequest(url, body) {
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${upload.token}`,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
    body: body instanceof FormData ? body : JSON.stringify(body),
    credentials: 'omit', redirect: 'error',
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('This upload session expired. Ask to resume this job using the same invocation identity.');
    }
    throw new Error('Upload did not finish. Try again to resume the selected files.');
  }
  return response.json();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!upload || !chosen.length) return;
  if (chosen.length > upload.max_files) {
    message.textContent = `Choose no more than ${upload.max_files} files.`;
    return;
  }
  submit.disabled = true;
  input.disabled = true;
  try {
    for (const [index, entry] of chosen.entries()) {
      if (uploaded.has(entry.file_id)) continue;
      message.textContent = `Uploading ${index + 1} of ${chosen.length}: ${entry.file.name}`;
      const body = new FormData();
      body.append('file', entry.file);
      body.append('file_id', entry.file_id);
      await uploadRequest(upload.url, body);
      uploaded.add(entry.file_id);
    }
    job = await uploadRequest(upload.complete_url, { file_ids: chosen.map(entry => entry.file_id) });
    upload = undefined;
    form.hidden = true;
    message.textContent = 'Files received. Processing will continue in the background.';
    try {
      await app.sendMessage({ role: 'user', content: [{ type: 'text', text:
        `Files uploaded for VideoVector job ${job.job_id}. Continue this request by checking get_import_job; when run_id is available, read execution status and both filtered and unfiltered results. Do not start a new find or upload.` }] });
    } catch {
      message.textContent = `Files received. Ask the assistant to continue job ${job.job_id}.`;
    }
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Upload did not finish. Try again.';
  } finally {
    submit.disabled = false;
  }
});

app.connect().catch(() => {
  message.textContent = 'This client could not open the inline picker. Use a client that supports MCP Apps or forward native attachments.';
});
