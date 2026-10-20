// In-memory stand-ins for the Apps Script services the backend uses, so
// apps-script/*.gs can be exercised in Node (tests + local dashboard runs).
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';

/** Java-style date pattern formatting (the subset the scripts use). */
export function formatDate(d, tz, pattern) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  });
  const o = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  const v = { yyyy: o.year, yy: o.year.slice(2), MMM: new Date(d).toLocaleString('en-GB', { timeZone: tz, month: 'short' }), MM: o.month.padStart(2, '0'), M: o.month, dd: o.day.padStart(2, '0'), d: o.day,
    HH: String(+o.hour % 24).padStart(2, '0'), H: String(+o.hour % 24), mm: o.minute.padStart(2, '0'), m: String(+o.minute),
    u: String({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[o.weekday]) };
  return pattern.replace(/yyyy|yy|MMM|MM|M|dd|d|HH|H|mm|m|u/g, (t) => v[t]);
}

function makeServices({ user = 'owner@example.com', effective = 'owner@example.com', now } = {}) {
  const drive = { folders: [], files: [] };
  const cache = new Map();
  const props = new Map();
  const triggers = [];
  const mails = [];
  const session = { active: user, effective };
  let nextId = 1;
  let services; // the fixed clock, when given, is services.clock
  const nowMs = () => (services && services.clock ? services.clock.t : Date.now());

  const iter = (list) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
  const makeFile = (name, bytes, folder) => {
    const file = {
      id: 'fil' + nextId++, name, bytes, folder, trashed: false, created: new Date(nowMs()),
      getName() { return this.name; }, getUrl() { return 'https://drive.google.com/file/d/' + this.id; }, getId() { return this.id; },
      moveTo(f) { this.folder = f; }, setTrashed(t) { this.trashed = t; }, getDateCreated() { return this.created; },
      getBlob() { const f = this; return { name: f.name, bytes: f.bytes, setName(n) { this.name = n; return this; }, getName() { return this.name; }, getBytes() { return [...f.bytes]; } }; },
    };
    drive.files.push(file);
    return file;
  };
  const makeFolder = (name, parent = null) => {
    const f = {
      id: 'fld' + nextId++, name, parent, trashed: false,
      getId() { return this.id; }, getUrl() { return 'https://drive.google.com/drive/folders/' + this.id; }, getName() { return this.name; },
      createFolder(n) { return makeFolder(n, this); },
      getFoldersByName(n) { return iter(drive.folders.filter((x) => x.parent === this && x.name === n && !x.trashed)); },
      getFiles() { return iter(drive.files.filter((x) => x.folder === this && !x.trashed)); },
      createFile(a, b) { return typeof a === 'object' ? makeFile(a.name, Buffer.from(a.bytes), this) : makeFile(a, Buffer.from(String(b)), this); },
      setTrashed(t) { this.trashed = t; },
    };
    drive.folders.push(f);
    return f;
  };
  const root = makeFolder('My Drive');

  const spreadsheets = [];
  // Like Sheets: a leading apostrophe forces text and isn't stored.
  const clone = (v) => (v && typeof v.getTime === 'function' ? new Date(v.getTime()) : typeof v === 'string' && v[0] === "'" ? v.slice(1) : v);
  const makeTab = (name, ss) => {
    const tab = { name, rows: [], hidden: [] };
    const range = (r, c, nr, nc) => ({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => clone((tab.rows[r - 1 + i] || [])[c - 1 + j] ?? ''))),
      getValue: () => clone((tab.rows[r - 1] || [])[c - 1] ?? ''),
      setValues(vals) {
        if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error(`setValues: ${vals.length}×${vals[0]?.length} into ${nr}×${nc}`);
        vals.forEach((row, i) => { const t = (tab.rows[r - 1 + i] ||= []); row.forEach((v, j) => { t[c - 1 + j] = clone(v); }); });
        return this;
      },
      setValue(v) { (tab.rows[r - 1] ||= [])[c - 1] = clone(v); return this; },
      clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (tab.rows[r - 1 + i]) tab.rows[r - 1 + i][c - 1 + j] = ''; trim(); return this; },
      setNumberFormat() { return this; }, setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
      createTextFinder(text) {
        return { matchEntireCell() { return this; }, findNext() {
          for (let i = r - 1; i < r - 1 + nr; i++) if (tab.rows[i] && String(tab.rows[i][c - 1]) === text) return { getRow: () => i + 1 };
          return null;
        } };
      },
    });
    const trim = () => { while (tab.rows.length && (tab.rows.at(-1) || []).every((v) => v === '' || v === undefined)) tab.rows.pop(); };
    Object.assign(tab, {
      getName() { return this.name; }, setName(n) { this.name = n; },
      getRange: (r, c, nr = 1, nc = 1) => range(r, c, nr, nc),
      appendRow(vals) { tab.rows.push(vals.map(clone)); },
      getLastRow: () => tab.rows.length, getMaxRows: () => 1000,
      setFrozenRows() {}, setColumnWidth() {}, hideColumns(i) { tab.hidden.push(i); },
      getParent: () => ss,
    });
    return tab;
  };
  const makeSpreadsheet = (title) => {
    const ss = { id: 'ss' + nextId++, title, tabs: [],
      getId() { return this.id; }, getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; },
      getSheets() { return this.tabs; },
      getSheetByName(n) { return this.tabs.find((t) => t.name === n) || null; },
      insertSheet(n) { const t = makeTab(n, this); this.tabs.push(t); return t; },
      deleteSheet(t) { this.tabs = this.tabs.filter((x) => x !== t); },
    };
    ss.tabs.push(makeTab('Sheet1', ss));
    spreadsheets.push(ss);
    makeFile(title, Buffer.alloc(0), root).id = ss.id;
    return ss;
  };

  const triggerBuilder = (fn) => {
    const t = { fn, getHandlerFunction: () => fn };
    const b = { timeBased: () => b, atHour: () => b, everyDays: () => b, everyMinutes: () => b, inTimezone: () => b, create: () => { triggers.push(t); return t; } };
    return b;
  };

  services = {
    console: { ...console, error() {}, warn() {} },
    DriveApp: {
      getRootFolder: () => root,
      getFolderById: (id) => { const f = drive.folders.find((x) => x.id === id); if (!f) throw new Error('No folder ' + id); return f; },
      getFileById: (id) => { const f = drive.files.find((x) => x.id === id); if (!f) throw new Error('No file ' + id); return f; },
    },
    SpreadsheetApp: {
      create: (t) => makeSpreadsheet(t),
      openById: (id) => { const ss = spreadsheets.find((x) => x.id === id); if (!ss) throw new Error('No spreadsheet ' + id); return ss; },
      flush() {},
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Session: { getActiveUser: () => ({ getEmail: () => session.active }), getEffectiveUser: () => ({ getEmail: () => session.effective }) },
    ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1), newTrigger: triggerBuilder },
    HtmlService: {
      createHtmlOutputFromFile: (f) => ({ file: f, setTitle() { return this; }, addMetaTag() { return this; } }),
      createHtmlOutput: (html) => ({ html }),
    },
    MailApp: {
      quota: 100,
      getRemainingDailyQuota() { return this.quota; },
      sendEmail(m) { if (m.to === 'bounce@example.com') throw new Error('Invalid email: ' + m.to); mails.push(m); this.quota--; },
    },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    Logger: { log() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType() { return this; }, text: s }) },
    Utilities: {
      formatDate,
      getUuid: () => 'uuid-' + nextId++,
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      base64EncodeWebSafe: (s) => Buffer.from(s).toString('base64url'),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      computeHmacSha256Signature: (v, k) => [...createHmac('sha256', k).update(v).digest()].map((b) => (b > 127 ? b - 256 : b)),
      zip: (blobs, name) => ({ name, bytes: Buffer.from(blobs.map((b) => b.name).join('\n')) }),
    },
  };
  if (now) {
    // A fixed clock: Date.now() and new Date() follow `clock.t`.
    const clock = { t: now };
    const RealDate = Date;
    class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [clock.t])); } static now() { return clock.t; } }
    services.Date = FakeDate;
    services.clock = clock;
  }
  return { services, drive, spreadsheets, mails, props, triggers, session, cache };
}

/** Loads Schedule.gs + Code.gs. Returns helpers to call it like the web app would. */
export function loadBackend(opts = {}) {
  const env = makeServices(opts);
  const ctx = { ...env.services };
  vm.createContext(ctx);
  for (const f of ['Schedule.gs', 'Code.gs']) vm.runInContext(readFileSync(new URL('../apps-script/' + f, import.meta.url), 'utf8'), ctx, { filename: f });
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  const get = (parameter) => JSON.parse(ctx.doGet({ parameter }).text);
  const api = (name, args) => JSON.parse(ctx.api(name, args));
  const run = (code) => vm.runInContext(code, ctx);
  const tab = (name) => {
    const ss = env.spreadsheets.find((s) => s.getSheetByName(name));
    return ss ? ss.getSheetByName(name).rows : [];
  };
  const outbox = () => env.spreadsheets.find((s) => /Outbox/.test(s.title)).getSheets()[0];
  return { ...env, ctx, post, get, api, run, tab, outbox, clock: ctx.clock };
}

/** Loads the lab-Gmail mailer against a given outbox spreadsheet (from loadBackend). */
export function loadMailer(backend) {
  const ctx = { ...backend.services, SpreadsheetApp: backend.services.SpreadsheetApp };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../apps-script/mailer/Mailer.gs', import.meta.url), 'utf8'), ctx, { filename: 'Mailer.gs' });
  vm.runInContext(`MAILER.OUTBOX_ID = ${JSON.stringify(backend.outbox().getParent().getId())};`, ctx);
  return ctx;
}
