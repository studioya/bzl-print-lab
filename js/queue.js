// Talks to the backend's public, non-personal endpoints:
//   ?action=queue        the print queue as it stands (to estimate a new submission)
//   ?action=status&id=…  one submission's status and current estimate ("Track")
// and turns the queue into a ready-date estimate with the same scheduler the
// backend uses (js/schedule.js).

import { CONFIG } from './config.js';
import { simulateQueue, estimateRange, checkEstimate } from './schedule.js';

const TZ = 'Asia/Jerusalem';
let cached = null; // { at, promise }

export function backendUrl() {
  const center = CONFIG.centers?.find((c) => c.appsScriptUrl);
  return center?.appsScriptUrl || CONFIG.appsScriptUrl || '';
}

async function getJson(params) {
  const url = backendUrl();
  if (!url) throw new Error('not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(url + (url.includes('?') ? '&' : '?') + new URLSearchParams(params), { redirect: 'follow', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/** The queue snapshot, refetched at most every 2 minutes. */
export function fetchQueue() {
  if (!cached || Date.now() - cached.at > 120000) {
    const promise = getJson({ action: 'queue' }).then((d) => { if (!d.ok) throw new Error(d.error); return d; });
    promise.catch(() => { cached = null; });
    cached = { at: Date.now(), promise };
  }
  return cached.promise;
}

export function fetchStatus(id) {
  return getJson({ action: 'status', id: String(id).trim() });
}

/**
 * A ready date for these plates if submitted now, if it's good enough to show.
 * @param plates [{ minutes }]
 * @returns { est: { ready, days, daysMax } | null, ok, reason }
 */
export function readyEstimate(snapshot, plates, now = Date.now()) {
  const est = estimateFor(snapshot, plates, now);
  const up = snapshot.printers.filter((p) => p.up).length;
  return { est, ...checkEstimate(est, up, rulesOf(snapshot)) };
}

export function rulesOf(snapshot) {
  return snapshot?.rules || CONFIG.estimate || { minPrintersUp: 1, maxWorkingDays: 0 };
}

/** What to say when there's no date to give. reason: 'printers' | 'far' | 'none' | 'offline' */
export function noEstimateText(reason, rules = rulesOf(null)) {
  const weeks = Math.max(1, Math.round((rules.maxWorkingDays || 15) / 5));
  const after = { en: "We'll email you when it's ready.", he: 'נשלח לכם מייל כשההדפסה תהיה מוכנה.' };
  if (reason === 'far') {
    return { en: `More than ${weeks} weeks`, he: `יותר מ־${weeks} שבועות`,
      noteEn: `The queue is long right now. ${after.en}`, noteHe: `התור ארוך כרגע. ${after.he}` };
  }
  const why = reason === 'printers'
    ? { en: 'Too few printers are working right now.', he: 'פחות מדי מדפסות פועלות כרגע.' }
    : { en: "The lab's queue can't be reached right now.", he: 'אין גישה כרגע לתור של המעבדה.' };
  return { en: "We can't estimate a ready date right now", he: 'לא ניתן להעריך כרגע מתי ההדפסה תהיה מוכנה',
    noteEn: `${why.en} ${after.en}`, noteHe: `${why.he} ${after.he}` };
}

/** When would these plates be ready if submitted now? (No minimums applied.) */
export function estimateFor(snapshot, plates, now = Date.now()) {
  const input = {
    now, timeZone: snapshot.timeZone || TZ, hours: snapshot.hours, handlingMinutes: snapshot.handlingMinutes,
    factor: snapshot.factor, printers: snapshot.printers,
    queue: [...snapshot.queue.map((q, i) => ({ id: 'q' + i, plates: q.plates })), { id: 'me', plates }],
  };
  const sim = simulateQueue(input);
  const r = sim.requests.me;
  if (!sim.printersUp || r.end === null) return null;
  return estimateRange(r.ready, input);
}

// Written-out dates ("Tue 20 Oct 2026", "יום שלישי, 20 באוקטובר 2026"), never 20/10, so they can't be misread.
const dayEnFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const dayEn = { format: (d) => { const p = {}; dayEnFmt.formatToParts(d).forEach((x) => { p[x.type] = x.value; }); return `${p.weekday} ${p.day} ${p.month} ${p.year}`; } };
const dayHe = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/** "around Tue 20 Oct 2026 (2–3 working days)" in both languages. */
export function formatEstimate(est) {
  if (!est) return { en: 'not available right now', he: 'לא זמין כרגע' };
  const d = new Date(est.ready);
  if (est.days === 0) return { en: `today, around ${timeOf(d)}`, he: `היום, בסביבות ${timeOf(d)}` };
  return {
    en: `around ${dayEn.format(d)} (${est.days}–${est.daysMax} working days)`,
    he: `בסביבות ${dayHe.format(d)} (${est.days}–${est.daysMax} ימי עבודה)`,
  };
}

function timeOf(d) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** True if the estimate ends after the end of the deadline day (yyyy-mm-dd, Israel time). */
export function pastDeadline(est, deadline) {
  if (!est || !/^\d{4}-\d{2}-\d{2}$/.test(deadline || '')) return false;
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(est.ready));
  return key > deadline;
}
