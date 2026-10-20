/**
 * BZL Print Lab — mailer. Runs in the LAB GMAIL account (not the owner's).
 *
 * The backend never sends email itself: it writes each email as a row in the
 * Outbox spreadsheet. Every 5 minutes this script sends the waiting ones from
 * the lab Gmail, so emails come from — and student replies go to — the lab
 * address, whoever in the lab handled the print.
 *
 * Setup (signed in to the lab Gmail):
 *  1. The owner shares the Outbox spreadsheet with the lab Gmail (Editor).
 *  2. script.google.com → New project "BZL Print Lab mailer". Paste this file
 *     (and appsscript.json: Project Settings → show the manifest).
 *  3. Paste the Outbox ID below, run `install` once and allow access.
 */

const MAILER = {
  OUTBOX_ID: '',                         // from the backend's setup log
  FROM_NAME: 'Bezalel Modelling Center',     // plain, one language: mixed-script sender names look like spam
  MAX_ATTEMPTS: 5,
  PER_RUN: 40,                           // emails per run at most
  KEEP_QUOTA: 5,                         // leave a few of the daily quota for manual use
};

// Outbox columns (1-based), as created by the backend.
const C = { key: 1, created: 2, to: 3, subject: 4, html: 5, text: 6, status: 7, attempts: 8, nextTry: 9, lastError: 10, sentAt: 11 };

/** Run once: installs the 5-minute trigger and sends anything waiting. */
function install() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendOutbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendOutbox').timeBased().everyMinutes(5).create();
  sendOutbox();
}

function sendOutbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // the previous run is still going
  try {
    const sh = SpreadsheetApp.openById(MAILER.OUTBOX_ID).getSheets()[0];
    const n = sh.getLastRow();
    if (n < 2) return;
    // Only look at the status column first: cheap even with many old rows.
    const statuses = sh.getRange(2, C.status, n - 1, 1).getValues();
    const now = Date.now();
    let sent = 0;
    for (let i = 0; i < statuses.length && sent < MAILER.PER_RUN; i++) {
      if (statuses[i][0] !== 'pending') continue;
      const row = i + 2;
      const v = sh.getRange(row, 1, 1, C.sentAt).getValues()[0];
      const next = v[C.nextTry - 1];
      if (next && new Date(next).getTime() > now) continue;
      if (MailApp.getRemainingDailyQuota() <= MAILER.KEEP_QUOTA) {
        console.warn('Daily email quota reached; the rest wait until tomorrow.');
        return;
      }
      const attempts = (+v[C.attempts - 1] || 0) + 1;
      try {
        MailApp.sendEmail({
          to: v[C.to - 1], subject: v[C.subject - 1], htmlBody: v[C.html - 1], body: v[C.text - 1], name: MAILER.FROM_NAME,
        });
        // Sent: keep the record, drop the address and body (personal data).
        sh.getRange(row, C.to, 1, C.sentAt - C.to + 1).setValues([['', v[C.subject - 1], '', '', 'sent', attempts, '', '', new Date()]]);
        sent++;
      } catch (err) {
        // One bad email never blocks the others: back off and retry later.
        const failed = attempts >= MAILER.MAX_ATTEMPTS;
        const wait = Math.pow(2, attempts) * 5 * 60000; // 10 min, 20, 40, 80…
        sh.getRange(row, C.status, 1, 4).setValues([[failed ? 'failed' : 'pending', attempts,
          failed ? '' : new Date(now + wait), String(err && err.message || err).slice(0, 300)]]);
      }
    }
  } finally {
    lock.releaseLock();
  }
}
