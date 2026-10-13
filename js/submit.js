// Sends a submission to the lab's backend: a Microsoft Power Automate flow
// (power-automate/README.md) or the Google Apps Script (apps-script/Code.gs),
// whichever URL is set in js/config.js.
//
// Power Automate, one request per file so each stays under the flow's size limit:
//   file   → saves one file (base64) into the submission's OneDrive folder (repeated per file)
//   submit → writes details.txt, adds the row to the Excel log, emails the student
//
// Apps Script:
//   begin  → creates the Drive folder + Sheet row, returns { id, token }
//   file   → uploads one file (base64) into that folder (repeated per file)
//   finish → marks the row as New and sends the confirmation email

import { CONFIG } from './config.js';
import { buildRecord, safeName } from './record.js';

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
  const flowUrl = center?.powerAutomateUrl || CONFIG.powerAutomateUrl;
  if (flowUrl) return submitToFlow(flowUrl, { details, order, files, center, onStatus });
  const url = center?.appsScriptUrl || CONFIG.appsScriptUrl;
  if (!url) {
    throw new Error('Submissions are not set up yet. (Lab staff: set powerAutomateUrl in js/config.js.)');
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

const PREFIX = { original: 'ORIGINAL – ', plates: 'PLATES – ' };

/**
 * One request to the Power Automate flow. Parameters go in the URL query and
 * the body is sent as raw bytes with no Content-Type, which keeps it a "simple"
 * cross-origin request (no CORS preflight); the flow writes a file body
 * straight to OneDrive. The flow answers { ok } with Access-Control-Allow-Origin.
 */
async function flowRequest(url, params, body) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(u, { method: 'POST', body: new Blob([body]) });
  } catch {
    throw new Error('Could not reach the submission server. Check your connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* no JSON body */ }
  if (!res.ok || !data?.ok) throw new Error(data?.error || `Submission server error (${res.status}). Please try again.`);
  return data;
}

/** Power Automate: upload every file, then submit the record. Returns the submission number. */
async function submitToFlow(url, { details, order, files, center, onStatus }) {
  if (details.website) throw new Error('Submission rejected.'); // spam trap filled in
  const rec = buildRecord(details, order, center);
  const base = { center: center.id, folder: rec.folder };
  const names = [];
  for (let i = 0; i < files.length; i++) {
    onStatus('upload', i, files.length);
    const f = files[i];
    const name = safeName((PREFIX[f.kind] || PREFIX.original) + f.name, 150);
    await flowRequest(url, { ...base, action: 'file', name }, f.blob);
    names.push(name);
  }
  onStatus('finish', files.length, files.length);
  const submission = { row: { ...rec.row, files: names.join('\n') }, detailsText: rec.detailsText };
  await flowRequest(url, { ...base, action: 'submit' }, new TextEncoder().encode(JSON.stringify(submission)));
  return rec.id;
}
