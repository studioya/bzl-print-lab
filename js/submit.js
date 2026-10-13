// Sends a submission to the Google Apps Script backend (apps-script/Code.gs).
//
// Three steps so each request stays well under Apps Script's ~50 MB limit:
//   begin  → creates the Drive folder + Sheet row, returns { id, token }
//   file   → uploads one file (base64) into that folder (repeated per file)
//   finish → marks the row as New and sends the confirmation email

import { CONFIG } from './config.js';

async function postTo(url, body) {
  let res;
  try {
    // text/plain body keeps this a "simple" CORS request (no preflight), which
    // Apps Script web apps require.
    res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
    });
  } catch {
    throw new Error('Could not reach the submission server. Check your connection and try again.');
  }
  if (!res.ok) throw new Error(`Submission server error (${res.status}). Please try again.`);
  let data;
  try { data = await res.json(); } catch { throw new Error('Unexpected reply from the submission server.'); }
  if (!data.ok) throw new Error(data.error || 'Submission failed.');
  return data;
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * @param details student form fields
 * @param order   print/estimate details
 * @param files   [{ name, blob, kind }]
 * @param onStatus (stage, index, total) callback for UI updates
 * @returns submission id
 */
export async function submitPrint({ details, order, files, onStatus = () => {} }) {
  const center = CONFIG.centers?.find((c) => c.id === order.center);
  const url = center?.appsScriptUrl || CONFIG.appsScriptUrl;
  if (!url) {
    throw new Error('Submissions are not set up yet. (Lab staff: set appsScriptUrl in js/config.js.)');
  }
  const post = (body) => postTo(url, body);
  onStatus('begin', 0, files.length);
  const { id, token } = await post({ action: 'begin', details, order });
  for (let i = 0; i < files.length; i++) {
    onStatus('upload', i, files.length);
    const f = files[i];
    await post({
      action: 'file', id, token,
      name: f.name, kind: f.kind,
      mimeType: f.blob.type || 'application/octet-stream',
      data: await toBase64(f.blob),
    });
  }
  onStatus('finish', files.length, files.length);
  await post({ action: 'finish', id, token });
  return id;
}
