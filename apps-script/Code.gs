/**
 * BZL Print Lab — backend (Google Apps Script).
 *
 * One script project, owned by the lab manager's Google account, deployed twice:
 *  - "Intake" web app (Execute as: Me, Who has access: Anyone). The site posts
 *    submissions to it and reads the public queue/status from it.
 *  - "Dashboard" web app (Execute as: User accessing the web app, Who has
 *    access: Anyone with a Google account). Handlers open it to run the queue.
 *    It runs as each handler, so it only works for people the "BZL Print Lab"
 *    Drive folder is shared with (as editors).
 *
 * Emails aren't sent from here. They're written to the Outbox spreadsheet, and
 * a small script in the lab Gmail account (apps-script/mailer/Mailer.gs) sends
 * them — so they come from, and replies go to, the lab address.
 *
 * Data (spreadsheet "BZL Print Lab – Data"):
 *   Requests  one row per submission, no personal details (kept for analysis)
 *   Contacts  name / ID number / email / phone / notes — wiped CONTACT_RETENTION_DAYS after the request closes
 *   Plates    one row per plate: state, printer, times
 *   Printers  the six printers, up/down
 *   History   who did what, when
 *   ClosedDates  days the lab is closed (holidays) — prints aren't started then
 * Students are identified in the data by a pseudonymous key: a keyed hash of
 * their ID number (the key is a secret in Script Properties), so one student's
 * requests can be linked without storing who they are.
 *
 * Setup: see README.md → "Deploy the backend". Schedule.gs (the estimate
 * engine) is generated from js/schedule.js.
 */

const SETTINGS = {
  LAB_NAME: 'Bezalel Main Modelling Center',
  LAB_NAME_HE: 'מרכז הדיגום הראשי של בצלאל',
  LAB_EMAIL: '',                       // the lab Gmail that sends emails (shown in emails)
  SITE_URL: 'https://studioya.github.io/bzl-print-lab/',
  FOLDER_NAME: 'BZL Print Lab',
  TIMEZONE: 'Asia/Jerusalem',
  // When prints can be started. Prints run on through nights and weekends.
  HOURS: { openHour: 9, closeHour: 22, closedWeekdays: [5, 6] }, // 5 = Friday, 6 = Saturday
  HANDLING_MINUTES: 10,                // per plate: prep, removal, checks
  // Minimums for giving students a ready date. Below them we say we can't
  // estimate rather than give a date that's likely wrong.
  ESTIMATE: {
    MIN_PRINTERS_UP: 2,                // fewer working printers than this → no estimate
    MAX_WORKING_DAYS: 15,              // further away than this (~3 weeks) → "more than 3 weeks"
  },
  // Students aren't charged yet: the cost is shown as what it will cost once payment is required.
  CHARGING: false,
  // false: emails don't quote a price; they say a pricing policy is coming (matches js/config.js showCost).
  SHOW_COST: false,
  PRINTERS: 6,
  CONTACT_RETENTION_DAYS: 180,         // personal details are wiped this long after a request closes
  FILE_RETENTION_DAYS: 365,            // model files are deleted this long after closing (0 = keep)
  UNCOLLECTED_DAYS: 14,                // "ready" this long → flagged on the dashboard
  MAX_FILE_MB: 25,
  MAX_MODEL_FILES: 5,
  MAX_OBJECTS: 50,
  MAX_COPIES_PER_OBJECT: 10,
  MAX_PLATES: 36,
  ALLOWED_EXTENSIONS: ['stl', 'obj', '3mf', 'step', 'stp'],
  MAX_SUBMISSIONS_PER_EMAIL_PER_HOUR: 6,
  MIN_SECONDS_ON_PAGE: 5,
};

const STATUS = {
  'Uploading': 'בהעלאה',
  'Queued': 'בתור',
  'Printing': 'בהדפסה',
  'On hold': 'בהמתנה',
  'Ready for pickup': 'מוכן לאיסוף',
  'Picked up': 'נאסף',
  'Cancelled': 'בוטל',
  'Rejected': 'נדחה',
  'Abandoned': 'לא הושלם',
};
const IN_QUEUE = ['Queued', 'Printing'];
const OPEN = ['Queued', 'Printing', 'On hold', 'Ready for pickup'];
const CLOSED = ['Picked up', 'Cancelled', 'Rejected', 'Abandoned'];
// Statuses a handler can set from the dashboard (Printing / Ready also happen on their own).
const HANDLER_STATUSES = ['Queued', 'On hold', 'Ready for pickup', 'Picked up', 'Cancelled', 'Rejected'];

// Tab columns: [key, header, width]. Add new columns only at the right end.
const TABS = {
  Requests: [
    ['id', 'Submission', 110], ['submitted', 'Submitted', 130], ['status', 'Status', 120], ['statusChanged', 'Status changed', 130],
    ['order', 'Queue order', 0], ['studentKey', 'Student key', 110], ['department', 'Department', 140], ['course', 'Course', 150],
    ['deadline', 'Needed by', 95], ['profile', 'Profile', 110], ['colors', 'Colors', 120], ['layout', 'Laid out by', 140],
    ['plates', 'Plates', 55], ['pieces', 'Pieces', 55], ['estMinutes', 'Est. minutes', 80], ['estCost', 'Est. cost ₪', 80],
    ['grams', 'Filament g', 75], ['supports', 'Supports', 70], ['objects', 'Objects', 260], ['files', 'Files', 200],
    ['folderId', 'Folder id', 0], ['platesFileId', 'Plates file id', 0], ['estReadyAtSubmit', 'Estimated ready (at submission)', 140],
    ['readyAt', 'Ready at', 130], ['closedAt', 'Closed at', 130], ['labNotes', 'Lab notes', 220], ['filesDeleted', 'Files deleted', 110],
  ],
  Contacts: [
    ['id', 'Submission', 110], ['name', 'Name', 150], ['idNumber', 'ID number', 100], ['email', 'Email', 200],
    ['phone', 'Phone', 120], ['notes', 'Student notes', 260], ['purgedAt', 'Wiped at', 130],
  ],
  Plates: [
    ['key', 'Plate', 120], ['id', 'Submission', 110], ['n', 'No.', 40], ['name', 'Name', 120], ['color', 'Color', 70],
    ['estMinutes', 'Est. minutes', 80], ['grams', 'Filament g', 75], ['state', 'State', 80], ['printer', 'Printer', 60],
    ['started', 'Started', 130], ['finished', 'Finished', 130], ['actualMinutes', 'Actual minutes', 90],
    ['attempts', 'Attempts', 65], ['note', 'Note', 220], ['preview', 'Preview file id', 0],
  ],
  Printers: [['id', 'Printer', 60], ['name', 'Name', 120], ['up', 'Working', 70], ['note', 'Note', 260], ['since', 'Since', 130], ['plate', 'Printing plate', 120]],
  History: [['at', 'When', 130], ['who', 'Who', 180], ['id', 'Submission', 110], ['action', 'Action', 140], ['details', 'Details', 400]],
  ClosedDates: [['date', 'Date (yyyy-mm-dd)', 130], ['note', 'Note', 260]],
};
const OUTBOX_COLUMNS = [
  ['key', 'Key', 200], ['created', 'Created', 130], ['to', 'To', 200], ['subject', 'Subject', 300], ['html', 'HTML', 200],
  ['text', 'Text', 200], ['status', 'Status', 70], ['attempts', 'Attempts', 65], ['nextTry', 'Next try', 130],
  ['lastError', 'Last error', 220], ['sentAt', 'Sent at', 130],
];
const TEXT_KEYS = ['id', 'key', 'idNumber', 'phone', 'deadline', 'date', 'studentKey', 'n', 'printer'];

// ================================================================ setup

/**
 * Run once from the editor (as the owner): creates the folder, spreadsheets,
 * printers, the secret for student keys and the nightly cleanup trigger.
 * Safe to run again.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('STUDENT_KEY_SECRET')) props.setProperty('STUDENT_KEY_SECRET', Utilities.getUuid() + Utilities.getUuid());
  const folder = rootFolder_();
  const ss = data_();
  Object.keys(TABS).forEach(function (t) { tab_(t); });
  const sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && ss.getSheets().length > 1) ss.deleteSheet(sheet1);
  const printers = read_('Printers');
  for (let i = printers.length + 1; i <= SETTINGS.PRINTERS; i++) {
    append_('Printers', { id: 'P' + i, name: 'Bambu ' + i, up: true, note: '', since: new Date(), plate: '' });
  }
  const outbox = outbox_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'nightly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightly').timeBased().atHour(3).everyDays(1).inTimezone(SETTINGS.TIMEZONE).create();
  Logger.log('Folder:  ' + folder.getUrl() + '\nData:    ' + ss.getUrl() + '\nOutbox:  ' + outbox.getUrl() +
    '\n\nOutbox ID (paste into the lab Gmail mailer): ' + outbox.getId());
}

function rootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) return DriveApp.getFolderById(id); // shared with handlers, so they can open it too
  const folder = DriveApp.getRootFolder().createFolder(SETTINGS.FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function subFolder_(name) {
  const root = rootFolder_();
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

let dataSS_ = null;
function data_() {
  if (dataSS_) return dataSS_;
  dataSS_ = spreadsheet_('DATA_ID', SETTINGS.FOLDER_NAME + ' – Data');
  return dataSS_;
}

let outboxSS_ = null;
function outbox_() {
  if (outboxSS_) return outboxSS_;
  outboxSS_ = spreadsheet_('OUTBOX_ID', SETTINGS.FOLDER_NAME + ' – Outbox (emails waiting to be sent)');
  const sh = outboxSS_.getSheets()[0];
  if (sh.getLastRow() === 0) formatTab_(sh, 'Outbox', OUTBOX_COLUMNS);
  return outboxSS_;
}

function spreadsheet_(prop, title) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(prop);
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create(title);
  DriveApp.getFileById(ss.getId()).moveTo(rootFolder_());
  props.setProperty(prop, ss.getId());
  return ss;
}

function tab_(name) {
  const ss = data_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    formatTab_(sh, name, TABS[name]);
  }
  return sh;
}

function formatTab_(sh, name, cols) {
  sh.setName(name);
  sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (c) { return c[1]; })])
    .setFontWeight('bold').setBackground('#1f2428').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  cols.forEach(function (c, i) {
    if (c[2]) sh.setColumnWidth(i + 1, c[2]); else sh.hideColumns(i + 1);
    if (TEXT_KEYS.indexOf(c[0]) >= 0) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  });
}

// ================================================================ table helpers

/** All rows of a tab as objects ({ _row, key: value… }). */
function read_(name) {
  const cols = TABS[name];
  const sh = tab_(name);
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, cols.length).getValues().map(function (v, i) {
    const o = { _row: i + 2 };
    cols.forEach(function (c, j) { o[c[0]] = v[j]; });
    return o;
  });
}

function rowValues_(cols, obj) {
  return cols.map(function (c) {
    const v = obj[c[0]];
    return v === undefined || v === null ? '' : v;
  });
}

function write_(name, obj) {
  tab_(name).getRange(obj._row, 1, 1, TABS[name].length).setValues([rowValues_(TABS[name], obj)]);
}

function append_(name, obj) {
  const sh = tab_(name);
  sh.appendRow(rowValues_(TABS[name], obj));
  obj._row = sh.getLastRow();
  return obj;
}

function byOrder_(a, b) {
  return (+a.order - +b.order) || (a._row - b._row);
}

function find_(rows, key, value) {
  for (let i = 0; i < rows.length; i++) if (String(rows[i][key]) === String(value)) return rows[i];
  return null;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
    CacheService.getScriptCache().remove('snapshot');
  }
}

function ms_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v.getTime === 'function') return v.getTime();
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

function fmtDate_(ms, pattern) {
  return Utilities.formatDate(new Date(ms), SETTINGS.TIMEZONE, pattern || 'yyyy-MM-dd HH:mm');
}

function history_(who, id, action, details) {
  append_('History', { at: new Date(), who: who, id: id, action: action, details: details || '' });
}

// ================================================================ estimates

/** Wall-clock parts in Israel time, via Apps Script's own date formatting. */
function formatParts_(ms) {
  const p = Utilities.formatDate(new Date(ms), SETTINGS.TIMEZONE, 'yyyy|M|d|H|m|u').split('|').map(Number);
  return { y: p[0], m: p[1], d: p[2], h: p[3], min: p[4], wd: p[5] % 7 };
}

function hours_(closedDates) {
  return {
    openHour: SETTINGS.HOURS.openHour, closeHour: SETTINGS.HOURS.closeHour,
    closedWeekdays: SETTINGS.HOURS.closedWeekdays, closedDates: closedDates,
  };
}

/** Everything the estimates need, read in one go. */
function state_() {
  const requests = read_('Requests');
  const plates = read_('Plates');
  const printers = read_('Printers');
  const closedDates = read_('ClosedDates').map(function (r) {
    const t = ms_(r.date);
    return typeof r.date === 'string' ? r.date.trim() : t ? fmtDate_(t, 'yyyy-MM-dd') : '';
  }).filter(String);
  const samples = plates.filter(function (p) { return p.state === 'done' && +p.actualMinutes > 0; })
    .slice(-300).map(function (p) { return { estimated: +p.estMinutes, actual: +p.actualMinutes }; });
  return { requests: requests, plates: plates, printers: printers, closedDates: closedDates, factor: learnFactor(samples) };
}

/** The scheduler's input: the printers and the queue as it stands. */
function simInput_(st, now) {
  const handling = SETTINGS.HANDLING_MINUTES;
  const byKey = {};
  st.plates.forEach(function (p) { byKey[p.key] = p; });
  const printers = st.printers.map(function (pr) {
    const p = pr.plate && byKey[pr.plate];
    let busyUntil = 0;
    if (p && p.state === 'printing') busyUntil = ms_(p.started) + (+p.estMinutes * st.factor + handling) * 60000;
    return { id: String(pr.id), up: pr.up === true || String(pr.up).toUpperCase() === 'TRUE', busyUntil: busyUntil };
  });
  const platesOf = {};
  st.plates.forEach(function (p) {
    if (p.state !== 'waiting') return;
    (platesOf[p.id] = platesOf[p.id] || []).push(p);
  });
  const queue = st.requests.filter(function (r) { return IN_QUEUE.indexOf(r.status) >= 0; })
    .sort(byOrder_)
    .map(function (r) {
      return {
        id: String(r.id),
        plates: (platesOf[r.id] || []).sort(function (a, b) { return +a.n - +b.n; })
          .map(function (p) { return { id: String(p.key), minutes: +p.estMinutes || 0 }; }),
      };
    });
  return {
    now: now, printers: printers, queue: queue, hours: hours_(st.closedDates), timeZone: SETTINGS.TIMEZONE,
    formatParts: formatParts_, handlingMinutes: handling, factor: st.factor,
  };
}

/** When a request's printing plates end (they're not in the simulation's queue). */
function printingEnd_(st, id) {
  let end = null;
  st.plates.forEach(function (p) {
    if (p.id !== id || p.state !== 'printing') return;
    const e = ms_(p.started) + (+p.estMinutes * st.factor + SETTINGS.HANDLING_MINUTES) * 60000;
    end = end === null ? e : Math.max(end, e);
  });
  return end;
}

function readyOf_(st, sim, input, id) {
  const r = sim.requests[id];
  const q = input.queue.filter(function (x) { return x.id === id; })[0];
  if (!sim.printersUp && q && q.plates.length) return null; // waiting plates, no printer to print them
  const cal = makeCalendar(makeClock(SETTINGS.TIMEZONE, formatParts_), input.hours);
  const pEnd = printingEnd_(st, id);
  let end = r && r.end !== null ? r.end : null;
  if (pEnd !== null) end = end === null ? Math.max(pEnd, input.now) : Math.max(end, pEnd);
  if (end === null) return sim.printersUp ? cal.nextStaffed(input.now) : null;
  return cal.nextStaffed(end);
}

function estimateRules_() {
  return { minPrintersUp: SETTINGS.ESTIMATE.MIN_PRINTERS_UP, maxWorkingDays: SETTINGS.ESTIMATE.MAX_WORKING_DAYS };
}

/** The public queue (no names, no IDs): what the site needs to estimate a new submission. */
function queueSnapshot_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('snapshot');
  if (cached) return JSON.parse(cached);
  const st = state_();
  const input = simInput_(st, Date.now());
  const snap = {
    ok: true, now: input.now, timeZone: SETTINGS.TIMEZONE, hours: input.hours,
    handlingMinutes: input.handlingMinutes, factor: input.factor,
    printers: input.printers.map(function (p, i) { return { id: 'P' + (i + 1), up: p.up, busyUntil: p.busyUntil }; }),
    queue: input.queue.map(function (q) { return { plates: q.plates.map(function (p) { return { minutes: p.minutes }; }) }; }),
    rules: estimateRules_(),
  };
  cache.put('snapshot', JSON.stringify(snap), 120);
  return snap;
}

/** Status lookup by submission number, for the "Track" box on the site. */
function status_(id) {
  id = String(id || '').trim().toUpperCase();
  if (!/^P\d{6}-[A-Z0-9]{4,6}$/.test(id)) return { ok: false, error: 'Please enter a submission number like P261019-AB3CD.' };
  const st = state_();
  const req = find_(st.requests, 'id', id);
  if (!req || req.status === 'Uploading') return { ok: false, error: 'Submission not found. Check the number in your confirmation email.' };
  const plates = st.plates.filter(function (p) { return p.id === id && p.state !== 'cancelled'; });
  const out = {
    ok: true, id: id, status: req.status, statusHe: STATUS[req.status] || '',
    submitted: ms_(req.submitted), statusChanged: ms_(req.statusChanged),
    plates: {
      total: plates.length,
      done: plates.filter(function (p) { return p.state === 'done'; }).length,
      printing: plates.filter(function (p) { return p.state === 'printing'; }).length,
    },
  };
  if (IN_QUEUE.indexOf(req.status) >= 0) {
    const input = simInput_(st, Date.now());
    const sim = simulateQueue(input);
    const ready = readyOf_(st, sim, input, id);
    out.ahead = input.queue.map(function (q) { return q.id; }).indexOf(id);
    const est = estimateRange(ready, input);
    const check = checkEstimate(est, sim.printersUp, estimateRules_());
    out.estimate = check.ok ? est : null;
    if (!check.ok) { out.estimateIssue = check.reason; out.rules = estimateRules_(); }
    out.printersUp = sim.printersUp;
  }
  return out;
}

// ================================================================ web app

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'queue') return json_(queueSnapshot_());
    if (p.action === 'status') return json_(status_(p.id));
    if (p.action) return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'Server error. Please try again later.' });
  }
  try {
    handler_();
  } catch (err) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">' + SETTINGS.LAB_NAME +
      ' – submission service. Lab staff: open the dashboard link, signed in to a Google account the lab folder is shared with.</p>');
  }
  return HtmlService.createHtmlOutputFromFile('Dashboard')
    .setTitle('Print Lab dashboard · לוח בקרה')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (req.action === 'begin') return json_(begin_(req));
    if (req.action === 'file') return json_(addFile_(req));
    if (req.action === 'finish') return json_(finish_(req));
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: err && err.userMessage ? err.userMessage : 'Server error. Please try again or contact the lab.' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function userError_(message) {
  const e = new Error(message);
  e.userMessage = message;
  return e;
}

// ================================================================ intake

function begin_(req) {
  const d = req.details || {};
  const o = req.order || {};
  if (d.website) throw userError_('Submission rejected.'); // spam trap filled in
  if ((+o.secondsOnPage || 0) < SETTINGS.MIN_SECONDS_ON_PAGE) throw userError_('Submission rejected. Please try again.');
  const v = validate_(d, o);
  rateLimit_(v.email);

  const now = new Date();
  const id = 'P' + Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyMMdd') + '-' + randomCode_(5);
  const token = Utilities.getUuid();
  // No names in folder names: they'd outlive the personal-data wipe.
  const folder = subFolder_('Submissions').createFolder(Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy-MM-dd HH.mm') + ' · ' + id);
  folder.createFile(id + ' – details.txt', detailsText_(id, now, v), MimeType.PLAIN_TEXT);

  withLock_(function () {
    append_('Requests', {
      id: id, submitted: now, status: 'Uploading', statusChanged: now, order: now.getTime(),
      studentKey: studentKey_(v.idNumber), department: v.department, course: v.course, deadline: v.deadline,
      profile: v.profileLabel, colors: v.plateColors.join(', '), layout: v.layout, plates: v.plates.length,
      pieces: v.copies, estMinutes: v.estMinutes, estCost: v.estCost, grams: v.grams, supports: v.supports ? 'Yes' : 'No',
      objects: v.objects.map(function (x) {
        return x.name + ' ×' + x.copies + ' (' + x.size + ')' + (x.scalePercent !== 100 ? ' ' + x.scalePercent + '%' : '') + (x.layout ? ' – ' + x.layout : '');
      }).join('\n'),
      files: '', folderId: folder.getId(), platesFileId: '', estReadyAtSubmit: '', readyAt: '', closedAt: '', labNotes: '', filesDeleted: '',
    });
    append_('Contacts', { id: id, name: v.name, idNumber: v.idNumber, email: v.email, phone: v.phone, notes: v.notes, purgedAt: '' });
    v.plates.forEach(function (p, i) {
      append_('Plates', {
        key: id + '-' + (i + 1), id: id, n: i + 1, name: p.name, color: p.color, estMinutes: p.minutes, grams: p.grams,
        state: 'waiting', printer: '', started: '', finished: '', actualMinutes: '', attempts: 0, note: '',
      });
    });
  });

  CacheService.getScriptCache().put('sub_' + id, JSON.stringify({ token: token, folderId: folder.getId(), files: [] }), 6 * 60 * 60);
  return { ok: true, id: id, token: token };
}

function addFile_(req) {
  const sub = session_(req);
  const name = String(req.name || '').slice(0, 150);
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
  // A picture of one plate, rendered by the page: "plate-3.jpg".
  const isPreview = req.kind === 'preview';
  const plateNo = isPreview ? +((name.match(/^plate-(\d+)\.jpg$/) || [])[1] || 0) : 0;
  if (isPreview && !(plateNo >= 1 && plateNo <= SETTINGS.MAX_PLATES)) throw userError_('File type not allowed.');
  if (!isPreview && (!ext || SETTINGS.ALLOWED_EXTENSIONS.indexOf(ext.toLowerCase()) < 0)) throw userError_('File type not allowed.');
  const data = String(req.data || '');
  const maxMB = isPreview ? 2 : SETTINGS.MAX_FILE_MB;
  if (data.length > maxMB * 1024 * 1024 * 1.4) throw userError_('File is too large.');
  const count = function (preview) { return sub.files.filter(function (f) { return !!f.preview === preview; }).length; };
  if (isPreview ? count(true) >= SETTINGS.MAX_PLATES : count(false) >= SETTINGS.MAX_MODEL_FILES + 1) throw userError_('Too many files.');
  const bytes = Utilities.base64Decode(data);
  if (bytes.length > maxMB * 1024 * 1024) throw userError_('File is too large.');
  const isPlates = req.kind === 'plates';
  const fileName = isPreview ? 'PREVIEW – plate ' + plateNo + '.jpg' : (isPlates ? 'PLATES – ' + req.id + ' – ' : 'ORIGINAL – ') + safeName_(name);
  const file = DriveApp.getFolderById(sub.folderId)
    .createFile(Utilities.newBlob(bytes, isPreview ? 'image/jpeg' : 'application/octet-stream', fileName));
  sub.files.push({ name: file.getName(), id: file.getId(), plates: isPlates, preview: isPreview ? plateNo : 0 });
  CacheService.getScriptCache().put('sub_' + req.id, JSON.stringify(sub), 6 * 60 * 60);
  return { ok: true };
}

function finish_(req) {
  const sub = session_(req);
  if (!sub.files.length) throw userError_('No files were uploaded.');
  const result = withLock_(function () {
    const st = state_();
    const r = find_(st.requests, 'id', req.id);
    if (!r) throw userError_('Submission not found. Please submit again.');
    if (r.status !== 'Uploading') return { already: true };
    const now = new Date();
    r.status = 'Queued';
    r.statusChanged = now;
    r.files = sub.files.filter(function (f) { return !f.preview; }).map(function (f) { return f.name; }).join('\n');
    sub.files.forEach(function (f) {
      if (!f.preview) return;
      const p = find_(st.plates, 'key', r.id + '-' + f.preview);
      if (p) { p.preview = f.id; write_('Plates', p); }
    });
    const plates = sub.files.filter(function (f) { return f.plates; })[0];
    r.platesFileId = plates ? plates.id : '';
    // The estimate the student was given, kept to measure how good estimates are.
    const input = simInput_(st, now.getTime());
    const ready = readyOf_(st, simulateQueue(input), input, r.id);
    r.estReadyAtSubmit = ready ? new Date(ready) : '';
    write_('Requests', r);
    history_('student', r.id, 'Submitted', r.plates + ' plate(s), ' + r.estMinutes + ' min');
    const contact = find_(read_('Contacts'), 'id', r.id);
    const est = estimateRange(ready, input);
    const check = checkEstimate(est, input.printers.filter(function (p) { return p.up; }).length, estimateRules_());
    const shown = check.ok ? est : null;
    queueEmail_('confirm:' + r.id, contact, r, 'confirm', { estimate: shown, estimateIssue: check.reason });
    return { estimate: shown, estimateIssue: check.reason };
  });
  CacheService.getScriptCache().remove('sub_' + req.id);
  return { ok: true, id: req.id, trackUrl: trackUrl_(req.id), estimate: result.estimate || null, estimateIssue: result.estimateIssue || null };
}

function session_(req) {
  const raw = CacheService.getScriptCache().get('sub_' + String(req.id || ''));
  if (!raw) throw userError_('Upload session expired. Please submit again.');
  const sub = JSON.parse(raw);
  if (sub.token !== req.token) throw userError_('Invalid upload session.');
  return sub;
}

// Who laid each object out on the page: the site (auto-orient + placement), or the student.
const LAYOUT_LABELS = { site: 'site', student: 'student', 'site+student': 'site, then the student' };

function validate_(d, o) {
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
  const plateColors = (Array.isArray(o.plateColors) ? o.plateColors : []).slice(0, SETTINGS.MAX_PLATES).map(function (c) { return str(c, 10); });
  const plateNames = (Array.isArray(o.plateNames) ? o.plateNames : []).slice(0, SETTINGS.MAX_PLATES).map(function (n) { return str(n, 40); });
  const detail = Array.isArray(o.platesDetail) ? o.platesDetail.slice(0, SETTINGS.MAX_PLATES) : [];
  const nPlates = Math.max(1, Math.min(SETTINGS.MAX_PLATES, Math.round(+o.plates || detail.length || 1)));
  const plates = [];
  for (let i = 0; i < nPlates; i++) {
    const p = detail[i] || {};
    plates.push({
      name: str(p.name || plateNames[i], 40),
      color: str(p.color || plateColors[i] || plateColors[0], 10),
      minutes: Math.max(0, Math.min(20000, Math.round(+p.minutes || (detail.length ? 0 : (+o.estimatedMinutes || 0) / nPlates)))),
      grams: Math.max(0, +(+p.grams || 0).toFixed(1)),
    });
  }
  const v = {
    name: str(d.name, 80),
    idNumber: str(d.idNumber, 12),
    email: str(d.email, 120).toLowerCase(),
    phone: str(d.phone, 20),
    department: str(d.department, 80),
    course: str(d.course, 120),
    deadline: str(d.deadline, 10),
    notes: str(d.notes, 1500),
    copies: Math.round(+o.copies),
    plateColors: plates.map(function (p) { return p.color; }),
    plates: plates,
    profileLabel: str(o.profileLabel || o.profile, 60),
    estMinutes: Math.max(0, Math.round(+o.estimatedMinutes || 0)),
    estCost: Math.max(0, +(+o.estimatedCost || 0).toFixed(2)),
    costText: costText_(o.costBreakdown),
    grams: Math.max(0, +(+o.filamentGrams || 0).toFixed(1)),
    supports: !!o.supports,
    files: (Array.isArray(o.files) ? o.files : []).slice(0, SETTINGS.MAX_MODEL_FILES).map(function (f) { return str(f, 150); }),
    objects: (Array.isArray(o.objects) ? o.objects : []).slice(0, SETTINGS.MAX_OBJECTS + 1).map(function (x) {
      x = x || {};
      return {
        name: str(x.name, 160), file: str(x.file, 150), copies: Math.round(+x.copies), size: str(x.sizeMm, 40),
        unitScale: +x.unitScale || 1, scalePercent: Math.min(1000, Math.max(1, +x.scalePercent || 100)),
        rotation: Array.isArray(x.rotation) ? x.rotation.slice(0, 9).map(Number) : null,
        layout: LAYOUT_LABELS[x.layout] || '',
      };
    }),
    layout: str(o.layout, 40),
    plateLayout: (Array.isArray(o.plateLayout) ? o.plateLayout : []).slice(0, SETTINGS.MAX_PLATES).map(function (pl) {
      return (Array.isArray(pl) ? pl : []).slice(0, SETTINGS.MAX_OBJECTS + 1).map(function (s) { return str(s, 180); });
    }),
  };
  const problems = [];
  if (v.name.length < 2) problems.push('name');
  if (!/^[0-9A-Za-z]{5,12}$/.test(v.idNumber)) problems.push('ID number');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) problems.push('email');
  if (!/^[+0-9][0-9 \-]{7,18}$/.test(v.phone)) problems.push('phone');
  if (v.department.length < 2) problems.push('department');
  if (v.course.length < 2) problems.push('course');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.deadline)) problems.push('deadline');
  if (!v.objects.length || v.objects.length > SETTINGS.MAX_OBJECTS) problems.push('objects');
  if (v.objects.some(function (x) { return !x.name || !(x.copies >= 1 && x.copies <= SETTINGS.MAX_COPIES_PER_OBJECT); })) problems.push('copies');
  if (v.copies !== v.objects.reduce(function (s, x) { return s + x.copies; }, 0)) problems.push('copies');
  if (!v.files.length) problems.push('files');
  if (v.plates.some(function (p) { return ['White', 'Black'].indexOf(p.color) < 0; })) problems.push('color');
  if (!v.profileLabel) problems.push('profile');
  if (problems.length) throw userError_('Please check: ' + problems.join(', ') + '.');
  return v;
}

/**
 * A stable pseudonym for a student: keyed hash of the normalised ID number.
 * The same ID always gives the same key; without the secret it can't be
 * reversed (or recomputed from a list of ID numbers).
 */
function studentKey_(idNumber) {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('STUDENT_KEY_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('STUDENT_KEY_SECRET', secret);
  }
  let norm = String(idNumber).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (/^\d+$/.test(norm)) norm = ('000000000' + norm).slice(-9);
  const sig = Utilities.computeHmacSha256Signature(norm, secret);
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += chars.charAt(((sig[i] % 256) + 256) % 256 % chars.length);
  return 'S-' + s;
}

function rateLimit_(email) {
  const cache = CacheService.getScriptCache();
  const key = 'rate_' + Utilities.base64EncodeWebSafe(email).slice(0, 200);
  const n = +(cache.get(key) || 0);
  if (n >= SETTINGS.MAX_SUBMISSIONS_PER_EMAIL_PER_HOUR) throw userError_('Too many submissions from this email. Please try again later.');
  cache.put(key, String(n + 1), 60 * 60);
}

function randomCode_(n) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function safeName_(s) {
  return String(s).replace(/[\\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
}

function trackUrl_(id) {
  return SETTINGS.SITE_URL + '?track=' + encodeURIComponent(id);
}

/** "material ₪x (₪/g) + printing time ₪y (₪/h)", plus what the per-plate minimum added. */
function costText_(b) {
  if (!b || typeof b !== 'object') return '';
  const n = function (x) { return Math.max(0, +(+x || 0).toFixed(2)); };
  return 'material ₪' + n(b.material) + ' (₪' + n(b.perGram) + '/g) + printing time ₪' + n(b.time) +
    ' (₪' + n(b.perHour) + '/h)' + (n(b.minimumTopUp) > 0 ? ' + ₪' + n(b.minimumTopUp) + ' to reach the ₪' + n(b.minimum) +
      ' minimum per plate' + (Array.isArray(b.minimumPlates) && b.minimumPlates.length ? ' (plate ' + b.minimumPlates.slice(0, 36).map(Number).join(', ') + ')' : '') : '');
}

/** The print details saved next to the files (no personal details: those live in Contacts). */
function detailsText_(id, now, v) {
  return [
    'Submission ' + id + ' — ' + fmtDate_(now.getTime()),
    'Department: ' + v.department,
    'Course: ' + v.course,
    'Needed by: ' + v.deadline,
    '',
    'Original files: ' + v.files.join(', '),
    'Profile: ' + v.profileLabel,
    'Laid out by: ' + (v.layout || '-') + ' (the student chose whether the site or they themselves orient and place each model)',
    'Pieces in total: ' + v.copies + ' (' + v.plates.length + ' plate' + (v.plates.length > 1 ? 's' : '') + ')',
    'Supports: ' + (v.supports ? 'Yes' : 'No'),
    'Estimated time: ' + v.estMinutes + ' min',
    'Estimated cost: ₪' + v.estCost + (v.costText ? ' — ' + v.costText : ''),
    'Estimated filament: ' + v.grams + ' g',
    'Objects (size in mm as oriented):',
  ].concat(v.objects.map(function (o) {
    return '  • ' + o.name + ' ×' + o.copies + ' — ' + o.size + ' mm, from ' + o.file +
      (o.unitScale !== 1 ? ', file units ×' + o.unitScale : '') +
      (o.scalePercent !== 100 ? ', resized to ' + o.scalePercent + '%' : '') +
      ', rotation ' + JSON.stringify(o.rotation) + (o.layout ? ', laid out by ' + o.layout : '');
  })).concat(['Plates:']).concat(v.plates.map(function (p, i) {
    return '  Plate ' + (i + 1) + (p.name ? ' "' + p.name + '"' : '') + ' (' + p.color + ', ~' + p.minutes + ' min, ' + p.grams + ' g)' +
      (v.plateLayout[i] ? ': ' + v.plateLayout[i].join(', ') : '');
  })).concat([
    '  The "PLATES" 3MF in this folder is a Bambu Studio project with every piece on the plate',
    '  where the student placed it, and the chosen profile. Open it with File → Open Project.',
  ]).join('\n');
}

// ================================================================ emails (via the Outbox)

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
}

function fmtEstimate_(est, issue) {
  if (!est && issue === 'far') {
    const w = Math.round(SETTINGS.ESTIMATE.MAX_WORKING_DAYS / 5);
    return { en: 'more than ' + w + ' weeks (the queue is long)', he: 'יותר מ־' + w + ' שבועות (התור ארוך)' };
  }
  if (!est) return { en: 'can\'t be estimated right now', he: 'לא ניתן להעריך כרגע' };
  const day = Utilities.formatDate(new Date(est.ready), SETTINGS.TIMEZONE, 'dd/MM/yyyy');
  const range = est.days === 0 ? '' : ' (' + est.days + '–' + est.daysMax + ' working days)';
  const rangeHe = est.days === 0 ? '' : ' (' + est.days + '–' + est.daysMax + ' ימי עבודה)';
  return { en: 'around ' + day + range, he: 'בסביבות ' + day + rangeHe };
}

const EMAILS = {
  confirm: {
    subject: ['Print submission {id} received', 'ההגשה התקבלה'],
    en: 'We received your 3D print submission. It\'s in the queue now. Your submission number is <b>{id}</b> — use it on the site to see its status and current estimate at any time. We won\'t email you again until it\'s ready, unless something needs your attention.',
    he: 'קיבלנו את הגשת ההדפסה שלך והיא נכנסה לתור. מספר ההגשה שלך הוא <b>{id}</b> — אפשר להשתמש בו באתר כדי לראות בכל עת את הסטטוס וההערכה העדכנית. לא נשלח מייל נוסף עד שההדפסה תהיה מוכנה, אלא אם משהו ידרוש את תשומת לבך.',
  },
  'Ready for pickup': {
    subject: ['Your print {id} is ready for pickup', 'ההדפסה מוכנה לאיסוף'],
    en: 'Your 3D print <b>{id}</b> is ready. You can pick it up at the modelling center during opening hours.',
    he: 'ההדפסה שלך <b>{id}</b> מוכנה. אפשר לאסוף אותה ממרכז הדיגום בשעות הפעילות.',
  },
  'On hold': {
    subject: ['Your print {id} is on hold', 'ההדפסה בהמתנה'],
    en: 'Your 3D print submission <b>{id}</b> is on hold. Please reply to this email.',
    he: 'הגשת ההדפסה שלך <b>{id}</b> בהמתנה. נא להשיב למייל זה.',
  },
  'Rejected': {
    subject: ['Your print {id} could not be accepted', 'לא ניתן לקבל את ההגשה'],
    en: 'Unfortunately we can\'t print submission <b>{id}</b>. You\'re welcome to fix it and submit again.',
    he: 'לצערנו לא נוכל להדפיס את ההגשה <b>{id}</b>. אפשר לתקן ולהגיש מחדש.',
  },
  'Cancelled': {
    subject: ['Your print {id} was cancelled', 'ההגשה בוטלה'],
    en: 'Submission <b>{id}</b> was cancelled.',
    he: 'ההגשה <b>{id}</b> בוטלה.',
  },
  'Queued': {
    subject: ['Your print {id} is back in the queue', 'ההגשה חזרה לתור'],
    en: 'Submission <b>{id}</b> is back in the print queue.',
    he: 'ההגשה <b>{id}</b> חזרה לתור ההדפסה.',
  },
  'Picked up': {
    subject: ['Your print {id} was picked up', 'ההדפסה נאספה'],
    en: 'Submission <b>{id}</b> was picked up. Thanks!',
    he: 'ההדפסה <b>{id}</b> נאספה. תודה!',
  },
};

/** Builds a bilingual email. kind: 'confirm' or a status. */
function buildEmail_(kind, r, contact, opts) {
  opts = opts || {};
  const t = EMAILS[kind];
  const fill = function (s) { return s.replace(/\{id\}/g, esc_(r.id)); };
  const name = esc_(contact && contact.name || '');
  const message = opts.message ? esc_(opts.message).replace(/\n/g, '<br>') : '';
  const track = trackUrl_(r.id);
  let table = '';
  if (kind === 'confirm') {
    const est = fmtEstimate_(opts.estimate, opts.estimateIssue);
    const rows = [
      ['Submission number', 'מספר הגשה', r.id],
      ['Profile', 'פרופיל', r.profile],
      ['Plates', 'פלטות', r.plates + ' (' + r.colors + ')'],
      ['Needed by', 'תאריך יעד', r.deadline],
      ['Estimated print time', 'זמן הדפסה משוער', r.estMinutes + ' min'],
      !SETTINGS.SHOW_COST ? ['Cost', 'עלות', 'Bezalel is working on a pricing policy. Printing won\'t always be free. · בצלאל עובדת על מדיניות תמחור. ההדפסות לא יהיו תמיד ללא תשלום.']
        : SETTINGS.CHARGING ? ['Estimated cost', 'עלות משוערת', '₪' + r.estCost]
        : ['Future cost', 'עלות עתידית', '₪' + r.estCost + ' — free for now; this is what it will cost once payment is required · ללא תשלום כרגע; זו תהיה העלות כשהתשלום יהיה חובה'],
      ['Estimated ready', 'מוכן משוער', est.en + ' · ' + est.he],
    ];
    table = '<table style="border-collapse:collapse;margin:12px 0">' + rows.map(function (x) {
      return '<tr><td style="padding:4px 10px 4px 0;color:#555">' + x[0] + ' · <span dir="rtl">' + x[1] + '</span></td><td style="padding:4px 0"><b>' + esc_(x[2]) + '</b></td></tr>';
    }).join('') + '</table>';
  }
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d2327;max-width:560px">' +
    '<p>Hi ' + name + ',</p><p>' + fill(t.en) + '</p>' + (message ? '<p style="border-left:3px solid #ccc;padding-left:10px">' + message + '</p>' : '') +
    '<div dir="rtl" style="text-align:right"><p>שלום ' + name + ',</p><p>' + fill(t.he) + '</p></div>' +
    table +
    '<p><a href="' + esc_(track) + '">Check status · מעקב אחר ההגשה</a></p>' +
    '<p style="color:#777;font-size:12px">' + esc_(SETTINGS.LAB_NAME) + ' · <span dir="rtl">' + esc_(SETTINGS.LAB_NAME_HE) + '</span><br>' +
    'Questions? Reply to this email. · שאלות? אפשר להשיב למייל זה.</p></div>';
  const text = (fill(t.en) + (opts.message ? '\n\n' + opts.message : '') + '\n\nStatus: ' + track).replace(/<[^>]+>/g, '');
  return { subject: fill(t.subject[0]) + ' · ' + t.subject[1], html: html, text: text };
}

/** Adds an email to the Outbox, once per key. Call inside the lock. */
function queueEmail_(key, contact, r, kind, opts) {
  if (!contact || !contact.email || contact.purgedAt) return false;
  const sh = outbox_().getSheets()[0];
  const n = sh.getLastRow();
  if (n > 1) {
    const found = sh.getRange(2, 1, n - 1, 1).createTextFinder(key).matchEntireCell(true).findNext();
    if (found) return false;
  }
  const m = buildEmail_(kind, r, contact, opts);
  sh.appendRow(rowValues_(OUTBOX_COLUMNS, {
    key: key, created: new Date(), to: contact.email, subject: m.subject, html: m.html, text: m.text,
    status: 'pending', attempts: 0, nextTry: new Date(), lastError: '', sentAt: '',
  }));
  return true;
}

function outboxSummary_() {
  const sh = outbox_().getSheets()[0];
  const n = sh.getLastRow();
  const out = { pending: 0, failed: [] };
  if (n < 2) return out;
  sh.getRange(2, 1, n - 1, OUTBOX_COLUMNS.length).getValues().forEach(function (v, i) {
    if (v[6] === 'pending') out.pending++;
    if (v[6] === 'failed') out.failed.push({ row: i + 2, key: v[0], subject: v[3], error: v[9] });
  });
  return out;
}

// ================================================================ dashboard API

/**
 * Who is using the dashboard. In the dashboard deployment the script runs as
 * the visitor, so their identity is known and their own Drive access decides
 * what they can open. In the intake deployment (which runs as the owner) only
 * the owner gets through; anyone else gets nothing.
 */
function handler_() {
  const active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const effective = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!active || active !== effective) throw new Error('Not authorised. Open the dashboard link signed in to your Google account.');
  return active;
}

/** Single entry point for google.script.run. Returns JSON text (Dates can't be returned directly). */
function api(name, args) {
  try {
    const who = handler_();
    const fn = API[name];
    if (!fn) throw new Error('Unknown action ' + name);
    return JSON.stringify({ ok: true, data: fn(args || {}, who) });
  } catch (err) {
    console.error(err && err.stack || err);
    return JSON.stringify({ ok: false, error: String(err && err.message || err) });
  }
}

const API = {
  load: function (a, who) { return dashboardData_(who); },

  setPrinter: function (a, who) {
    return withLock_(function () {
      const pr = find_(read_('Printers'), 'id', a.id);
      if (!pr) throw new Error('No printer ' + a.id);
      const up = !!a.up;
      if (up !== (pr.up === true || String(pr.up).toUpperCase() === 'TRUE')) pr.since = new Date();
      pr.up = up;
      if (a.name !== undefined) pr.name = String(a.name).slice(0, 40);
      if (a.note !== undefined) pr.note = String(a.note).slice(0, 300);
      write_('Printers', pr);
      history_(who, '', 'Printer ' + pr.id + (up ? ' up' : ' down'), pr.note);
      return dashboardData_(who);
    });
  },

  startPlate: function (a, who) {
    return withLock_(function () {
      const plates = read_('Plates');
      const p = find_(plates, 'key', a.key);
      if (!p) throw new Error('No plate ' + a.key);
      if (p.state !== 'waiting') throw new Error('Plate ' + p.key + ' is ' + p.state + ', not waiting.');
      const printers = read_('Printers');
      const pr = find_(printers, 'id', a.printer);
      if (!pr) throw new Error('No printer ' + a.printer);
      if (pr.plate) {
        const cur = find_(plates, 'key', pr.plate);
        if (cur && cur.state === 'printing') throw new Error(pr.id + ' is still printing ' + cur.key + '. Mark it done or failed first.');
      }
      const r = find_(read_('Requests'), 'id', p.id);
      if (!r || IN_QUEUE.indexOf(r.status) < 0) throw new Error('Request ' + p.id + ' is ' + (r ? r.status : 'missing') + '.');
      const now = new Date();
      p.state = 'printing'; p.printer = pr.id; p.started = now; p.finished = ''; p.actualMinutes = '';
      p.attempts = (+p.attempts || 0) + 1;
      write_('Plates', p);
      pr.plate = p.key;
      write_('Printers', pr);
      if (r.status === 'Queued') { r.status = 'Printing'; r.statusChanged = now; write_('Requests', r); }
      history_(who, p.id, 'Plate ' + p.n + ' started', pr.id + (p.attempts > 1 ? ', attempt ' + p.attempts : ''));
      return dashboardData_(who);
    });
  },

  finishPlate: function (a, who) {
    return withLock_(function () {
      const p = find_(read_('Plates'), 'key', a.key);
      if (!p || p.state !== 'printing') throw new Error('Plate ' + a.key + ' is not printing.');
      const now = Date.now();
      let end = a.finished ? ms_(a.finished) : now;
      const start = ms_(p.started);
      if (!end || end < start || end > now + 60000) throw new Error('Finish time must be between the start and now.');
      p.state = 'done'; p.finished = new Date(end); p.actualMinutes = Math.round((end - start) / 60000);
      write_('Plates', p);
      clearPrinter_(p);
      history_(who, p.id, 'Plate ' + p.n + ' done', p.printer + ', ' + p.actualMinutes + ' min');
      const plates = read_('Plates').filter(function (x) { return x.id === p.id && x.state !== 'cancelled'; });
      if (plates.every(function (x) { return x.state === 'done'; })) setStatus_(p.id, 'Ready for pickup', who, { email: true });
      return dashboardData_(who);
    });
  },

  failPlate: function (a, who) {
    return withLock_(function () {
      const p = find_(read_('Plates'), 'key', a.key);
      if (!p || p.state !== 'printing') throw new Error('Plate ' + a.key + ' is not printing.');
      const note = String(a.note || '').slice(0, 300);
      history_(who, p.id, 'Plate ' + p.n + ' failed', p.printer + (note ? ': ' + note : ''));
      clearPrinter_(p);
      p.state = 'waiting'; p.printer = ''; p.started = ''; p.note = note ? 'Failed: ' + note : 'Failed';
      write_('Plates', p);
      return dashboardData_(who);
    });
  },

  /** Undo a mistaken "start" (back to waiting, no failure recorded). */
  unstartPlate: function (a, who) {
    return withLock_(function () {
      const p = find_(read_('Plates'), 'key', a.key);
      if (!p || p.state !== 'printing') throw new Error('Plate ' + a.key + ' is not printing.');
      clearPrinter_(p);
      p.state = 'waiting'; p.printer = ''; p.started = ''; p.attempts = Math.max(0, (+p.attempts || 1) - 1);
      write_('Plates', p);
      history_(who, p.id, 'Plate ' + p.n + ' start undone', '');
      const r = find_(read_('Requests'), 'id', p.id);
      const any = read_('Plates').some(function (x) { return x.id === p.id && (x.state === 'printing' || x.state === 'done'); });
      if (r.status === 'Printing' && !any) { r.status = 'Queued'; r.statusChanged = new Date(); write_('Requests', r); }
      return dashboardData_(who);
    });
  },

  setStatus: function (a, who) {
    if (HANDLER_STATUSES.indexOf(a.status) < 0) throw new Error('Unknown status ' + a.status);
    return withLock_(function () {
      setStatus_(a.id, a.status, who, { email: !!a.email, message: String(a.message || '').slice(0, 2000) });
      return dashboardData_(who);
    });
  },

  previewEmail: function (a) {
    const r = find_(read_('Requests'), 'id', a.id);
    const c = find_(read_('Contacts'), 'id', a.id);
    if (!r || !EMAILS[a.status]) return null;
    const m = buildEmail_(a.status, r, c, { message: a.message });
    return { to: c && !c.purgedAt ? c.email : '', subject: m.subject, html: m.html };
  },

  move: function (a, who) {
    return withLock_(function () {
      const all = read_('Requests');
      const queue = all.filter(function (r) { return OPEN.indexOf(r.status) >= 0; }).sort(byOrder_);
      const i = queue.findIndex(function (r) { return r.id === a.id; });
      if (i < 0) throw new Error('Not in the queue: ' + a.id);
      const r = queue[i];
      if (a.to === 'top') {
        r.order = Math.min.apply(null, queue.map(function (q) { return +q.order; })) - 1;
        write_('Requests', r);
      } else {
        const j = a.to === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= queue.length) return dashboardData_(who);
        const other = queue[j];
        const t = r.order; r.order = other.order; other.order = t;
        if (+r.order === +other.order) r.order = +other.order + (a.to === 'up' ? -1 : 1);
        write_('Requests', r); write_('Requests', other);
      }
      history_(who, a.id, 'Moved ' + a.to, '');
      return dashboardData_(who);
    });
  },

  saveNotes: function (a, who) {
    return withLock_(function () {
      const r = find_(read_('Requests'), 'id', a.id);
      if (!r) throw new Error('No request ' + a.id);
      r.labNotes = String(a.notes || '').slice(0, 2000);
      write_('Requests', r);
      return dashboardData_(who);
    });
  },

  setClosedDates: function (a, who) {
    return withLock_(function () {
      const dates = (a.dates || []).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d.date); })
        .sort(function (x, y) { return x.date < y.date ? -1 : 1; });
      const sh = tab_('ClosedDates');
      const n = sh.getLastRow();
      if (n > 1) sh.getRange(2, 1, n - 1, TABS.ClosedDates.length).clearContent();
      if (dates.length) {
        sh.getRange(2, 1, dates.length, TABS.ClosedDates.length).setValues(dates.map(function (d) { return [d.date, String(d.note || '').slice(0, 100)]; }));
      }
      history_(who, '', 'Closed dates', dates.map(function (d) { return d.date; }).join(', '));
      return dashboardData_(who);
    });
  },

  /** One ZIP of the PLATES files of several requests, in a temp folder (deleted the next night). */
  zip: function (a, who) {
    const ids = (a.ids || []).slice(0, 40);
    const requests = read_('Requests');
    const blobs = [];
    ids.forEach(function (id) {
      const r = find_(requests, 'id', id);
      if (!r || !r.platesFileId) return;
      const b = DriveApp.getFileById(r.platesFileId).getBlob();
      b.setName(id + '.3mf');
      blobs.push(b);
    });
    if (!blobs.length) throw new Error('No plate files found.');
    const name = 'plates ' + fmtDate_(Date.now(), 'yyyy-MM-dd HH.mm') + '.zip';
    const file = subFolder_('Temp downloads').createFile(Utilities.zip(blobs, name));
    history_(who, '', 'ZIP', ids.join(', '));
    return { url: file.getUrl(), name: name, count: blobs.length };
  },

  /** The plate pictures of one request, as data URLs (Drive images can't be shown directly here). */
  previews: function (a) {
    return read_('Plates').filter(function (p) { return p.id === a.id && p.preview; }).map(function (p) {
      try {
        return { n: +p.n, src: 'data:image/jpeg;base64,' + Utilities.base64Encode(DriveApp.getFileById(p.preview).getBlob().getBytes()) };
      } catch (e) {
        return { n: +p.n, src: '' }; // deleted with the files
      }
    });
  },

  retryEmails: function (a, who) {
    return withLock_(function () {
      const sh = outbox_().getSheets()[0];
      const n = sh.getLastRow();
      if (n > 1) {
        const vals = sh.getRange(2, 1, n - 1, OUTBOX_COLUMNS.length).getValues();
        vals.forEach(function (v, i) {
          if (v[6] === 'failed') sh.getRange(i + 2, 7, 1, 3).setValues([['pending', 0, new Date()]]);
        });
      }
      history_(who, '', 'Retry failed emails', '');
      return dashboardData_(who);
    });
  },
};

function clearPrinter_(plate) {
  const pr = find_(read_('Printers'), 'id', plate.printer);
  if (pr && pr.plate === plate.key) { pr.plate = ''; write_('Printers', pr); }
}

/** Changes a request's status (call inside the lock). */
function setStatus_(id, status, who, opts) {
  opts = opts || {};
  const r = find_(read_('Requests'), 'id', id);
  if (!r) throw new Error('No request ' + id);
  if (r.status === 'Uploading') throw new Error(id + ' was never finished uploading.');
  const from = r.status;
  const now = new Date();
  const plates = read_('Plates').filter(function (p) { return p.id === id; });
  if (status === 'Queued' || status === 'On hold') {
    // Back in line (or paused): anything printing stays printing; the rest waits.
    if (IN_QUEUE.indexOf(from) < 0 && from !== 'On hold') {
      plates.forEach(function (p) { if (p.state === 'cancelled') { p.state = 'waiting'; write_('Plates', p); } });
      r.closedAt = '';
      r.readyAt = '';
    }
    if (status === 'Queued' && plates.some(function (p) { return p.state === 'printing' || p.state === 'done'; }) &&
      plates.some(function (p) { return p.state !== 'done'; })) status = 'Printing';
  }
  if (status === 'Ready for pickup') {
    r.readyAt = r.readyAt || now;
    plates.forEach(function (p) {
      if (p.state === 'waiting') { p.state = 'cancelled'; p.note = (p.note ? p.note + '; ' : '') + 'not printed (marked ready)'; write_('Plates', p); }
    });
  }
  if (status === 'Cancelled' || status === 'Rejected') {
    plates.forEach(function (p) {
      if (p.state === 'printing') clearPrinter_(p);
      if (p.state === 'waiting' || p.state === 'printing') { p.state = 'cancelled'; write_('Plates', p); }
    });
  }
  if (CLOSED.indexOf(status) >= 0) r.closedAt = r.closedAt || now;
  r.status = status;
  r.statusChanged = now;
  write_('Requests', r);
  history_(who, id, from + ' → ' + status, opts.message || '');
  if (opts.email && EMAILS[status]) {
    const key = status === 'Ready for pickup' ? 'ready:' + id + ':' + ms_(r.readyAt) : 'status:' + id + ':' + status + ':' + now.getTime();
    queueEmail_(key, find_(read_('Contacts'), 'id', id), r, status, { message: opts.message });
  }
}

/** Everything the dashboard shows, with estimates. */
function dashboardData_(who) {
  const st = state_();
  const now = Date.now();
  const input = simInput_(st, now);
  const sim = simulateQueue(input);
  const planned = {};
  Object.keys(sim.requests).forEach(function (id) {
    sim.requests[id].plates.forEach(function (p) { planned[p.id] = { printer: p.printer, start: p.start, end: p.end }; });
  });
  const contacts = {};
  read_('Contacts').forEach(function (c) { contacts[c.id] = c; });
  const recent = now - 30 * 86400000;
  const shown = st.requests.filter(function (r) {
    return OPEN.indexOf(r.status) >= 0 || (CLOSED.indexOf(r.status) >= 0 && ms_(r.closedAt) > recent) ||
      (r.status === 'Uploading' && ms_(r.submitted) > now - 86400000);
  });
  const shownIds = {};
  shown.forEach(function (r) { shownIds[r.id] = true; });
  const platesOf = {};
  st.plates.forEach(function (p) {
    if (!shownIds[p.id]) return;
    const pl = { key: p.key, n: +p.n, name: p.name, color: p.color, estMinutes: +p.estMinutes, grams: +p.grams, state: p.state,
      printer: p.printer, started: ms_(p.started), finished: ms_(p.finished), actualMinutes: +p.actualMinutes || null,
      attempts: +p.attempts || 0, note: p.note, plan: planned[p.key] || null, hasPreview: !!p.preview };
    if (p.state === 'printing') pl.expectedEnd = ms_(p.started) + +p.estMinutes * st.factor * 60000;
    (platesOf[p.id] = platesOf[p.id] || []).push(pl);
  });
  let folderUrl = '';
  try { folderUrl = rootFolder_().getUrl(); } catch (e) { /* not shared */ }
  return {
    me: who, now: now, factor: st.factor, handlingMinutes: SETTINGS.HANDLING_MINUTES, uncollectedDays: SETTINGS.UNCOLLECTED_DAYS,
    statuses: STATUS, handlerStatuses: HANDLER_STATUSES, emailStatuses: Object.keys(EMAILS).filter(function (k) { return k !== 'confirm'; }),
    folderUrl: folderUrl, dataUrl: data_().getUrl(),
    printers: st.printers.map(function (pr) {
      return { id: String(pr.id), name: pr.name, up: pr.up === true || String(pr.up).toUpperCase() === 'TRUE', note: pr.note, since: ms_(pr.since), plate: pr.plate };
    }),
    closedDates: read_('ClosedDates').map(function (d) {
      return { date: typeof d.date === 'string' ? d.date : fmtDate_(ms_(d.date), 'yyyy-MM-dd'), note: d.note };
    }),
    outbox: outboxSummary_(),
    requests: shown.sort(byOrder_).map(function (r) {
      const c = contacts[r.id] || {};
      const inQueue = IN_QUEUE.indexOf(r.status) >= 0;
      const ready = inQueue ? readyOf_(st, sim, input, r.id) : null;
      return {
        id: r.id, status: r.status, submitted: ms_(r.submitted), statusChanged: ms_(r.statusChanged), order: +r.order,
        studentKey: r.studentKey, department: r.department, course: r.course,
        deadline: typeof r.deadline === 'string' ? r.deadline : r.deadline ? fmtDate_(ms_(r.deadline), 'yyyy-MM-dd') : '',
        profile: r.profile, colors: r.colors, layout: r.layout, pieces: +r.pieces, estMinutes: +r.estMinutes, estCost: +r.estCost,
        grams: +r.grams, supports: r.supports, objects: r.objects, files: r.files, labNotes: r.labNotes,
        folderUrl: r.folderId && !r.filesDeleted ? 'https://drive.google.com/drive/folders/' + r.folderId : '',
        platesFileUrl: r.platesFileId && !r.filesDeleted ? 'https://drive.google.com/file/d/' + r.platesFileId + '/view' : '',
        platesDownloadUrl: r.platesFileId && !r.filesDeleted ? 'https://drive.google.com/uc?export=download&id=' + r.platesFileId : '',
        readyAt: ms_(r.readyAt), closedAt: ms_(r.closedAt), estReadyAtSubmit: ms_(r.estReadyAtSubmit),
        name: c.name || '', email: c.email || '', phone: c.phone || '', idNumber: c.idNumber || '', notes: c.notes || '',
        estStart: sim.requests[r.id] ? sim.requests[r.id].start : null, estReady: ready,
        plates: (platesOf[r.id] || []).sort(function (x, y) { return x.n - y.n; }),
      };
    }),
  };
}

// ================================================================ nightly job

/**
 * Daily (3am): wipes personal details of requests closed more than
 * CONTACT_RETENTION_DAYS ago, deletes old model files, removes temp ZIPs and
 * closes submissions whose upload never finished. Analysis data stays.
 */
function nightly() {
  withLock_(function () {
    const now = Date.now();
    const day = 86400000;
    const requests = read_('Requests');
    const byId = {};
    requests.forEach(function (r) {
      byId[r.id] = r;
      if (r.status === 'Uploading' && ms_(r.submitted) < now - day) {
        r.status = 'Abandoned'; r.statusChanged = new Date(now); r.closedAt = new Date(now);
        write_('Requests', r);
        read_('Plates').forEach(function (p) { if (p.id === r.id && p.state === 'waiting') { p.state = 'cancelled'; write_('Plates', p); } });
        history_('nightly', r.id, 'Upload never finished → Abandoned', '');
      }
    });
    read_('Contacts').forEach(function (c) {
      const r = byId[c.id];
      if (c.purgedAt || !r) return;
      const closed = ms_(r.closedAt);
      const due = r.status === 'Abandoned' ? closed : closed && closed + SETTINGS.CONTACT_RETENTION_DAYS * day;
      if (!due || due > now) return;
      c.name = ''; c.idNumber = ''; c.email = ''; c.phone = ''; c.notes = ''; c.purgedAt = new Date(now);
      write_('Contacts', c);
    });
    if (SETTINGS.FILE_RETENTION_DAYS > 0) {
      requests.forEach(function (r) {
        const closed = ms_(r.closedAt);
        if (!closed || r.filesDeleted || !r.folderId || closed + SETTINGS.FILE_RETENTION_DAYS * day > now) return;
        try { DriveApp.getFolderById(r.folderId).setTrashed(true); } catch (e) { /* already gone */ }
        r.filesDeleted = new Date(now);
        write_('Requests', r);
      });
    }
  });
  const temp = subFolder_('Temp downloads').getFiles();
  while (temp.hasNext()) {
    const f = temp.next();
    if (ms_(f.getDateCreated()) < Date.now() - 20 * 3600000) f.setTrashed(true);
  }
}
