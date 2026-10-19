// GENERATED from js/schedule.js by tools/build-apps-script.mjs — edit that file, not this one.
// In Apps Script all files share one scope, so these functions are global.

// Queue simulation: when will each print start and be ready?
//
// Used in two places with the same code:
//  - the site (js/app.js), to show a student the estimated ready date for the
//    plates they're about to submit, and on the "Track my print" lookup;
//  - the backend (apps-script/Schedule.gs is generated from this file by
//    tools/build-apps-script.mjs — don't edit that copy).
// So: plain JavaScript, no imports, no browser APIs.
//
// Model
//  - Each plate is one print job: its slicer estimate × the learned correction
//    factor, plus a fixed handling time (prep, removal, checks).
//  - Plates are taken in queue order and go to whichever working printer is
//    free first. A printer that is printing is busy until its plate's
//    estimated end; a printer marked down takes nothing.
//  - A print can only be STARTED when the lab is staffed (campus hours, not on
//    closed days/dates), but it keeps running through nights and weekends.
//  - A request is ready when its last plate ends — counted from the next
//    staffed time, when someone can take it off the printer.

const MINUTE = 60 * 1000;

/**
 * Wall-clock helpers in a fixed time zone (Israel), whatever the time zone of
 * the computer running this. `formatParts(ms)` may be supplied (Apps Script
 * passes one based on Utilities.formatDate); otherwise Intl is used.
 */
function makeClock(timeZone, formatParts) {
  const fmt = formatParts || intlParts(timeZone);
  const parts = (ms) => fmt(ms); // { y, m, d, h, min, wd (0 = Sunday) }
  /** Epoch ms of a wall-clock time in the zone (handles DST). */
  function at(y, m, d, h, min) {
    const target = Date.UTC(y, m - 1, d, h, min);
    let guess = target;
    for (let i = 0; i < 3; i++) {
      const p = parts(guess);
      const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
      guess += target - shown;
    }
    return guess;
  }
  const key = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return { parts, at, dateKey: (ms) => key(parts(ms)) };
}

function intlParts(timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  });
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return (ms) => {
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, wd: WD[o.weekday] };
  };
}

/**
 * Campus calendar: when may a print be started?
 * hours: { openHour, closeHour, closedWeekdays: [5, 6], closedDates: ['2026-10-21', …] }
 */
function makeCalendar(clock, hours) {
  const closedDates = new Set(hours.closedDates || []);
  const closedWeekdays = new Set(hours.closedWeekdays || []);
  const isOpenDay = (p) => !closedWeekdays.has(p.wd) && !closedDates.has(`${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`);
  const nextDay = (p) => clock.parts(clock.at(p.y, p.m, p.d, 12, 0) + 24 * 60 * MINUTE);

  /** The earliest time ≥ ms when the lab is staffed. */
  function nextStaffed(ms) {
    let p = clock.parts(ms);
    for (let i = 0; i < 400; i++) {
      if (isOpenDay(p)) {
        const open = clock.at(p.y, p.m, p.d, hours.openHour, 0);
        const close = clock.at(p.y, p.m, p.d, hours.closeHour, 0);
        if (ms < open) return open;
        if (ms < close) return ms;
      }
      p = nextDay(p);
      ms = clock.at(p.y, p.m, p.d, 0, 0);
    }
    return ms; // calendar closed for over a year: give up gracefully
  }

  /** Number of staffed days strictly after `fromMs`'s day, up to and including `toMs`'s day. */
  function workingDaysBetween(fromMs, toMs) {
    let n = 0;
    let p = clock.parts(fromMs);
    const end = clock.dateKey(toMs);
    for (let i = 0; i < 400; i++) {
      p = nextDay(p);
      const k = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
      if (k > end) break;
      if (isOpenDay(p)) n++;
    }
    return n;
  }

  return { nextStaffed, workingDaysBetween, isOpenDay: (ms) => isOpenDay(clock.parts(ms)) };
}

/**
 * Simulates the queue.
 *
 * @param input {
 *   now: epoch ms,
 *   printers: [{ id, up: bool, busyUntil?: epoch ms (estimated end of what it's printing) }],
 *   queue: [{ id, plates: [{ id?, minutes }] }]  — in print order; only plates still to print,
 *   hours, timeZone, handlingMinutes, factor (correction for the slicer estimates)
 * }
 * @returns {
 *   printersUp,
 *   requests: { [id]: { start, end, ready, plates: [{ id, printer, start, end }] } }  (epoch ms),
 * } — or null estimates (start/end/ready = null) when no printer is up.
 */
function simulateQueue(input) {
  const clock = makeClock(input.timeZone || 'Asia/Jerusalem', input.formatParts);
  const cal = makeCalendar(clock, input.hours);
  const factor = input.factor > 0 ? input.factor : 1;
  const handling = (input.handlingMinutes || 0) * MINUTE;
  const now = input.now;
  const free = (input.printers || []).filter((p) => p.up).map((p) => ({
    id: p.id,
    at: Math.max(now, p.busyUntil || 0),
  }));
  const out = { printersUp: free.length, requests: {} };
  for (const req of input.queue || []) {
    const r = { start: null, end: null, ready: null, plates: [] };
    out.requests[req.id] = r;
    if (!free.length) continue;
    for (const plate of req.plates || []) {
      // The printer that can start this plate soonest.
      let best = null;
      let bestStart = Infinity;
      for (const pr of free) {
        const s = cal.nextStaffed(pr.at);
        if (s < bestStart) { bestStart = s; best = pr; }
      }
      const end = bestStart + Math.max(0, plate.minutes || 0) * factor * MINUTE + handling;
      best.at = end;
      r.plates.push({ id: plate.id, printer: best.id, start: bestStart, end });
      r.start = r.start === null ? bestStart : Math.min(r.start, bestStart);
      r.end = r.end === null ? end : Math.max(r.end, end);
    }
    if (r.end !== null) r.ready = cal.nextStaffed(r.end);
    else if (!(req.plates || []).length) r.ready = cal.nextStaffed(now); // nothing left to print
  }
  return out;
}

/**
 * A student-facing estimate: the ready time and a range in working days
 * (estimates are rough — the range widens with the wait).
 * @returns { ready, days, daysMax } or null
 */
function estimateRange(readyMs, input) {
  if (readyMs === null || readyMs === undefined) return null;
  const clock = makeClock(input.timeZone || 'Asia/Jerusalem', input.formatParts);
  const cal = makeCalendar(clock, input.hours);
  const days = cal.workingDaysBetween(input.now, readyMs);
  const daysMax = days + Math.max(1, Math.round(days * 0.3));
  return { ready: readyMs, days, daysMax };
}

/**
 * Is an estimate good enough to show? Below these minimums the date would be
 * a guess, so we say we can't estimate instead of giving a wrong date.
 * rules: { minPrintersUp, maxWorkingDays }
 * @returns { ok: true } or { ok: false, reason: 'printers' | 'far' | 'none' }
 */
function checkEstimate(est, printersUp, rules) {
  const r = rules || {};
  if (printersUp < (r.minPrintersUp || 1)) return { ok: false, reason: 'printers' };
  if (!est) return { ok: false, reason: 'none' };
  if (r.maxWorkingDays && est.days > r.maxWorkingDays) return { ok: false, reason: 'far' };
  return { ok: true };
}

/**
 * Correction factor for slicer estimates, learned from finished plates:
 * the median of actual ÷ estimated minutes, clamped to a sane range.
 * @param samples [{ estimated, actual }] (minutes)
 */
function learnFactor(samples, opts) {
  const o = opts || {};
  const min = o.min || 0.7, max = o.max || 1.6, need = o.minSamples || 5;
  const ratios = (samples || [])
    .filter((s) => s.estimated >= 10 && s.actual > 0)
    .map((s) => s.actual / s.estimated)
    .filter((x) => x > 0.3 && x < 3) // ignore obvious mistakes (e.g. "done" pressed days later)
    .sort((a, b) => a - b);
  if (ratios.length < need) return 1;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return Math.min(max, Math.max(min, Math.round(median * 100) / 100));
}
