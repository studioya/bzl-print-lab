// Minimal in-memory stand-ins for the Apps Script services Code.gs uses, so
// the backend can be exercised in Node (tests + local end-to-end runs).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadBackend() {
  const drive = { folders: [], files: [] };
  const sheetRows = [];        // row arrays, index 0 = header
  const formulas = {};
  const mails = [];
  const cache = new Map();
  const props = new Map();
  let nextId = 1;

  const makeFolder = (name, parent = null) => {
    const f = {
      id: 'fld' + nextId++, name, parent,
      getId() { return this.id; }, getUrl() { return 'https://drive.google.com/drive/folders/' + this.id; },
      getName() { return this.name; },
      createFolder(n) { return makeFolder(n, this); },
      getFoldersByName(n) { const list = drive.folders.filter((x) => x.parent === this && x.name === n); let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; },
      createFile(a, b) {
        const isBlob = typeof a === 'object';
        const file = { id: 'fil' + nextId++, name: isBlob ? a.name : a, size: isBlob ? a.bytes.length : String(b).length, content: isBlob ? null : b, folder: this,
          getName() { return this.name; }, getUrl() { return 'https://drive.google.com/file/d/' + this.id; }, getId() { return this.id; }, moveTo() {} };
        drive.files.push(file);
        return file;
      },
    };
    drive.folders.push(f);
    return f;
  };
  const root = makeFolder('My Drive');

  const cell = (r, c) => ({
    setValue(v) { (sheetRows[r - 1] ||= [])[c - 1] = v; return this; },
    setFormula(v) { formulas[`${r},${c}`] = v; return this; },
    setNumberFormat() { return this; }, setDataValidation() { return this; },
    getRow() { return r; },
  });
  const sheet = {
    insertRowBefore(r) { sheetRows.splice(r - 1, 0, []); },
    getRange(r, c, nr = 1, nc = 1) {
      if (nr === 1 && nc === 1) return { ...cell(r, c), setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; } };
      return {
        setValues(vals) { vals.forEach((row, i) => { sheetRows[r - 1 + i] = row.slice(); }); return this; },
        setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; },
        createTextFinder(text) {
          return { matchEntireCell() { return this; }, findNext() {
            for (let i = r - 1; i < r - 1 + nr; i++) if (sheetRows[i] && sheetRows[i][c - 1] === text) return cell(i + 1, c);
            return null;
          } };
        },
      };
    },
    getLastRow() { return sheetRows.length; }, getMaxRows() { return 1000; },
    setName() {}, setFrozenRows() {}, setFrozenColumns() {}, setColumnWidth() {}, setConditionalFormatRules() {},
    getParent() { return { getUrl: () => 'https://docs.google.com/spreadsheets/d/mock' }; },
  };
  const ss = { getId: () => 'ss1', getSheets: () => [sheet] };

  const builder = () => new Proxy({}, { get: (t, k) => (k === 'build' ? () => ({}) : () => builder()) });
  const ctx = {
    console: { ...console, error() {} },
    DriveApp: { getRootFolder: () => root, getFolderById: (id) => drive.folders.find((f) => f.id === id), getFileById: () => ({ moveTo() {} }) },
    SpreadsheetApp: { create: () => ss, openById: () => ss, newConditionalFormatRule: builder, newDataValidation: builder },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: (...a) => mails.push(a) },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    Logger: { log() {} },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType() { return this; }, text: s }) },
    Utilities: {
      formatDate: (d, tz, f) => {
        const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
        const g = (t) => p.find((x) => x.type === t).value;
        return f.replace('yyyy', g('year')).replace('yy', g('year').slice(2)).replace('MM', g('month')).replace('dd', g('day')).replace('HH', g('hour')).replace('mm', g('minute'));
      },
      getUuid: () => 'uuid-' + nextId++,
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
      base64EncodeWebSafe: (s) => Buffer.from(s).toString('base64url'),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx);
  const call = (body) => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text);
  return { call, drive, sheetRows, formulas, mails, root };
}
