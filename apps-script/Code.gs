/**
 * BZL Print Lab — submission backend (Google Apps Script web app).
 *
 * Receives submissions from the web page, stores each one in its own folder
 * inside "STUDENT 3D SUBMISSIONS" on the lab's Google Drive, logs it in a
 * Google Sheet (newest on top, with a Status column for the lab) and emails
 * the student a confirmation.
 *
 * Setup: see README.md → "Deploy the submission backend".
 */

const SETTINGS = {
  FOLDER_NAME: 'STUDENT 3D SUBMISSIONS',
  SHEET_TITLE: 'STUDENT 3D SUBMISSIONS – Log',
  LAB_NAME: 'BZL Print Lab',
  // Optional: also email the lab on every new submission (leave '' to skip).
  LAB_NOTIFY_EMAIL: '',
  // Optional: address students reach when they reply to the confirmation.
  REPLY_TO: '',
  TIMEZONE: 'Asia/Jerusalem',
  MAX_FILE_MB: 25,
  MAX_MODEL_FILES: 5,   // originals per submission (+1 plates 3MF made by the page)
  MAX_OBJECTS: 50,
  MAX_COPIES_PER_OBJECT: 10,
  ALLOWED_EXTENSIONS: ['stl', 'obj', '3mf'],
  MAX_SUBMISSIONS_PER_EMAIL_PER_HOUR: 6,
  MIN_SECONDS_ON_PAGE: 5,
};

const STATUSES = ['Uploading', 'New', 'In review', 'Queued', 'Printing', 'Ready for pickup', 'Picked up', 'On hold', 'Rejected', 'Cancelled'];

const STATUS_COLORS = {
  'Uploading': '#eeeeee', 'New': '#fff2cc', 'In review': '#fce5cd', 'Queued': '#cfe2f3', 'Printing': '#d9d2e9',
  'Ready for pickup': '#d9ead3', 'Picked up': '#b6d7a8', 'On hold': '#f4cccc', 'Rejected': '#ea9999', 'Cancelled': '#cccccc',
};

const COLUMNS = [
  ['submitted', 'Submitted', 140],
  ['id', 'Submission ID', 120],
  ['status', 'Status', 130],
  ['name', 'Name', 150],
  ['idNumber', 'ID number', 100],
  ['email', 'Email', 200],
  ['phone', 'Phone', 120],
  ['department', 'Department', 140],
  ['course', 'Course', 160],
  ['deadline', 'Deadline', 100],
  ['copies', 'Pieces', 60],
  ['color', 'Color', 70],
  ['profile', 'Profile', 120],
  ['estMinutes', 'Est. time (min)', 100],
  ['estCost', 'Est. cost (₪)', 100],
  ['plates', 'Plates', 60],
  ['grams', 'Filament (g)', 90],
  ['objects', 'Objects (copies, size mm)', 300],
  ['supports', 'Supports', 75],
  ['files', 'Files', 220],
  ['folder', 'Drive folder', 110],
  ['notes', 'Student notes', 260],
  ['labNotes', 'Lab notes', 220],
];
const COL = {};
COLUMNS.forEach(function (c, i) { COL[c[0]] = i + 1; });
const TEXT_COLUMNS = ['id', 'name', 'idNumber', 'email', 'phone', 'department', 'course', 'deadline', 'objects', 'notes'];

// ---------------------------------------------------------------- setup

/** Run once from the Apps Script editor to create the folder + sheet and grant permissions. */
function setup() {
  const folder = getRootFolder_();
  const sheet = getSheet_();
  Logger.log('Folder: ' + folder.getUrl());
  Logger.log('Sheet:  ' + sheet.getParent().getUrl());
}

function getRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreated below */ }
  }
  const it = DriveApp.getRootFolder().getFoldersByName(SETTINGS.FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(SETTINGS.FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  let ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create(SETTINGS.SHEET_TITLE);
    DriveApp.getFileById(ss.getId()).moveTo(getRootFolder_());
    props.setProperty('SHEET_ID', ss.getId());
    formatSheet_(ss.getSheets()[0]);
  }
  return ss.getSheets()[0];
}

function formatSheet_(sheet) {
  sheet.setName('Submissions');
  sheet.getRange(1, 1, 1, COLUMNS.length)
    .setValues([COLUMNS.map(function (c) { return c[1]; })])
    .setFontWeight('bold').setBackground('#1f2428').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(3);
  COLUMNS.forEach(function (c, i) { sheet.setColumnWidth(i + 1, c[2]); });
  // Colour-code the Status column (whole-column rules survive row inserts).
  const statusCol = sheet.getRange(1, COL.status, sheet.getMaxRows(), 1);
  const rules = Object.keys(STATUS_COLORS).map(function (s) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(s).setBackground(STATUS_COLORS[s]).setRanges([statusCol]).build();
  });
  sheet.setConditionalFormatRules(rules);
}

// ---------------------------------------------------------------- web app entry points

function doGet() {
  return json_({ ok: true, service: SETTINGS.LAB_NAME + ' submissions' });
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

// ---------------------------------------------------------------- actions

function begin_(req) {
  const d = req.details || {};
  const o = req.order || {};
  if (d.website) throw userError_('Submission rejected.'); // spam trap filled in
  if ((+o.secondsOnPage || 0) < SETTINGS.MIN_SECONDS_ON_PAGE) throw userError_('Submission rejected. Please try again.');

  const v = validate_(d, o);
  rateLimit_(v.email);

  const now = new Date();
  const id = 'P' + Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyMMdd') + '-' + randomCode_(4);
  const token = Utilities.getUuid();

  // Folder names start with the date/time so "Name ↓" (Z→A) sorting in Drive
  // lists the newest submissions first.
  const stamp = Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy-MM-dd HH.mm');
  const folder = getRootFolder_().createFolder(stamp + ' · ' + safeName_(v.name) + ' · ' + id);

  const row = {
    submitted: Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy-MM-dd HH:mm'),
    id: id,
    status: 'Uploading',
    name: v.name, idNumber: v.idNumber, email: v.email, phone: v.phone,
    department: v.department, course: v.course, deadline: v.deadline,
    copies: v.copies, color: v.color, profile: v.profileLabel,
    estMinutes: v.estMinutes, estCost: v.estCost, plates: v.plates, grams: v.grams,
    objects: v.objects.map(function (o) {
      return o.name + ' ×' + o.copies + ' (' + o.size + ')' + (o.scalePercent !== 100 ? ' scaled ' + o.scalePercent + '%' : '');
    }).join('\n'),
    supports: v.supports ? 'Yes' : 'No',
    files: '', folder: '', notes: v.notes, labNotes: '',
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet_();
    sheet.insertRowBefore(2);
    const range = sheet.getRange(2, 1, 1, COLUMNS.length);
    range.setFontWeight('normal').setBackground(null).setFontColor('#000000');
    TEXT_COLUMNS.forEach(function (k) { sheet.getRange(2, COL[k]).setNumberFormat('@'); });
    range.setValues([COLUMNS.map(function (c) { return row[c[0]] === undefined ? '' : row[c[0]]; })]);
    sheet.getRange(2, COL.folder).setFormula('=HYPERLINK("' + folder.getUrl() + '","Open folder")');
    sheet.getRange(2, COL.status).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  } finally {
    lock.releaseLock();
  }

  folder.createFile(id + ' – details.txt', summaryText_(row, v), MimeType.PLAIN_TEXT);

  CacheService.getScriptCache().put('sub_' + id, JSON.stringify({
    token: token, folderId: folder.getId(), files: [], email: v.email, name: v.name,
    summary: row,
  }), 6 * 60 * 60);
  return { ok: true, id: id, token: token };
}

function addFile_(req) {
  const sub = session_(req);
  const name = String(req.name || '').slice(0, 150);
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
  if (!ext || SETTINGS.ALLOWED_EXTENSIONS.indexOf(ext.toLowerCase()) < 0) throw userError_('File type not allowed.');
  const data = String(req.data || '');
  if (data.length > SETTINGS.MAX_FILE_MB * 1024 * 1024 * 1.4) throw userError_('File is too large.');
  if (sub.files.length >= SETTINGS.MAX_MODEL_FILES + 1) throw userError_('Too many files.');
  const bytes = Utilities.base64Decode(data);
  if (bytes.length > SETTINGS.MAX_FILE_MB * 1024 * 1024) throw userError_('File is too large.');
  const prefix = req.kind === 'plates' ? 'PLATES – ' : req.kind === 'oriented' ? 'ORIENTED – ' : 'ORIGINAL – ';
  const file = DriveApp.getFolderById(sub.folderId)
    .createFile(Utilities.newBlob(bytes, 'application/octet-stream', prefix + safeName_(name)));
  sub.files.push({ name: file.getName(), url: file.getUrl() });
  saveSession_(req.id, sub);
  return { ok: true };
}

function finish_(req) {
  const sub = session_(req);
  if (!sub.files.length) throw userError_('No files were uploaded.');
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = getSheet_();
    const cell = sheet.getRange(1, COL.id, sheet.getLastRow(), 1).createTextFinder(req.id).matchEntireCell(true).findNext();
    if (cell) {
      const r = cell.getRow();
      sheet.getRange(r, COL.status).setValue('New');
      sheet.getRange(r, COL.files).setValue(sub.files.map(function (f) { return f.name; }).join('\n'));
    }
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove('sub_' + req.id);
  sendConfirmation_(sub);
  return { ok: true };
}

function session_(req) {
  const raw = CacheService.getScriptCache().get('sub_' + String(req.id || ''));
  if (!raw) throw userError_('Upload session expired. Please submit again.');
  const sub = JSON.parse(raw);
  if (sub.token !== req.token) throw userError_('Invalid upload session.');
  return sub;
}

function saveSession_(id, sub) {
  CacheService.getScriptCache().put('sub_' + id, JSON.stringify(sub), 6 * 60 * 60);
}

// ---------------------------------------------------------------- validation

function validate_(d, o) {
  function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
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
    color: str(o.color, 10),
    profileLabel: str(o.profileLabel || o.profile, 60),
    estMinutes: Math.max(0, Math.round(+o.estimatedMinutes || 0)),
    estCost: Math.max(0, +(+o.estimatedCost || 0).toFixed(2)),
    plates: Math.max(1, Math.round(+o.plates || 1)),
    grams: Math.max(0, +(+o.filamentGrams || 0).toFixed(1)),
    supports: !!o.supports,
    files: (Array.isArray(o.files) ? o.files : []).slice(0, SETTINGS.MAX_MODEL_FILES).map(function (f) { return str(f, 150); }),
    objects: (Array.isArray(o.objects) ? o.objects : []).slice(0, SETTINGS.MAX_OBJECTS + 1).map(function (x) {
      x = x || {};
      return {
        name: str(x.name, 160),
        file: str(x.file, 150),
        copies: Math.round(+x.copies),
        size: str(x.sizeMm, 40),
        unitScale: +x.unitScale || 1,
        scalePercent: Math.min(1000, Math.max(1, +x.scalePercent || 100)),
        rotation: Array.isArray(x.rotation) ? x.rotation.slice(0, 9).map(Number) : null,
      };
    }),
    plateLayout: (Array.isArray(o.plateLayout) ? o.plateLayout : []).slice(0, 36).map(function (pl) {
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
  if (['White', 'Black'].indexOf(v.color) < 0) problems.push('color');
  if (!v.profileLabel) problems.push('profile');
  if (problems.length) throw userError_('Please check: ' + problems.join(', ') + '.');
  return v;
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

// ---------------------------------------------------------------- outputs

function summaryText_(row, v) {
  return [
    'Submission ' + row.id + ' — ' + row.submitted,
    '',
    'Name: ' + row.name,
    'ID number: ' + row.idNumber,
    'Email: ' + row.email,
    'Phone: ' + row.phone,
    'Department: ' + row.department,
    'Course: ' + row.course,
    'Deadline: ' + row.deadline,
    '',
    'Original files: ' + v.files.join(', '),
    'Profile: ' + row.profile,
    'Color: ' + row.color,
    'Pieces in total: ' + row.copies + ' (' + row.plates + ' plate' + (row.plates > 1 ? 's' : '') + ')',
    'Supports: ' + row.supports,
    'Estimated time: ' + row.estMinutes + ' min',
    'Estimated cost: ₪' + row.estCost,
    'Estimated filament: ' + row.grams + ' g',
    'Objects (size in mm as oriented):',
  ].concat(v.objects.map(function (o) {
    return '  • ' + o.name + ' ×' + o.copies + ' — ' + o.size + ' mm, from ' + o.file +
      (o.unitScale !== 1 ? ', file units ×' + o.unitScale : '') +
      (o.scalePercent !== 100 ? ', resized to ' + o.scalePercent + '%' : '') +
      ', rotation ' + JSON.stringify(o.rotation);
  })).concat(v.plateLayout.length ? ['Plates as arranged by the student:'] : []).concat(v.plateLayout.map(function (pl, i) {
    return '  Plate ' + (i + 1) + ': ' + pl.join(', ');
  })).concat([
    '  The "PLATES" 3MF in this folder is a Bambu Studio project with every piece on the plate',
    '  where the student placed it, and the chosen profile. Open it with File → Open Project.',
    '',
    'Notes:',
    row.notes || '-',
  ]).join('\n');
}

function sendConfirmation_(sub) {
  if (MailApp.getRemainingDailyQuota() < 1) return;
  const r = sub.summary;
  const esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  const rows = [
    ['Submission number', 'מספר הגשה', r.id],
    ['Profile', 'פרופיל', r.profile],
    ['Color', 'צבע', r.color],
    ['Pieces', 'חלקים', r.copies],
    ['Needed by', 'תאריך יעד', r.deadline],
    ['Estimated print time', 'זמן הדפסה משוער', r.estMinutes + ' min'],
    ['Estimated cost', 'עלות משוערת', '₪' + r.estCost],
  ];
  const table = rows.map(function (x) {
    return '<tr><td style="padding:4px 10px 4px 0;color:#555">' + x[0] + ' · <span dir="rtl">' + x[1] + '</span></td><td style="padding:4px 0"><b>' + esc(x[2]) + '</b></td></tr>';
  }).join('');
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1d2327;max-width:560px">' +
    '<p>Hi ' + esc(sub.name) + ',</p>' +
    '<p>We received your 3D print submission. Prints can take up to several weeks, depending on the lab\'s queue. ' +
    'The time and cost below are estimates; the lab will confirm the final details.</p>' +
    '<div dir="rtl" style="text-align:right">' +
    '<p>שלום ' + esc(sub.name) + ',</p>' +
    '<p>קיבלנו את הגשת ההדפסה שלך. הדפסות עשויות להימשך עד מספר שבועות, בהתאם לתור במעבדה. ' +
    'הזמן והעלות שלהלן הם הערכה בלבד; המעבדה תאשר את הפרטים הסופיים.</p></div>' +
    '<table style="border-collapse:collapse;margin:12px 0">' + table + '</table>' +
    '<p style="color:#777;font-size:12px">' + SETTINGS.LAB_NAME + '</p></div>';
  const text = 'We received your 3D print submission ' + r.id + '. Estimated time ' + r.estMinutes +
    ' min, estimated cost ₪' + r.estCost + '. Prints can take up to several weeks.';
  const opts = { name: SETTINGS.LAB_NAME, htmlBody: html };
  if (SETTINGS.REPLY_TO) opts.replyTo = SETTINGS.REPLY_TO;
  MailApp.sendEmail(sub.email, SETTINGS.LAB_NAME + ' – submission ' + r.id + ' received · ההגשה התקבלה', text, opts);

  if (SETTINGS.LAB_NOTIFY_EMAIL && MailApp.getRemainingDailyQuota() > 0) {
    MailApp.sendEmail(SETTINGS.LAB_NOTIFY_EMAIL, 'New print submission ' + r.id + ' – ' + r.name,
      r.name + ' (' + r.department + ', ' + r.course + ') submitted ' + r.copies + ' piece(s), ' + r.profile + ', ' + r.color +
      ', ~' + r.estMinutes + ' min, needed by ' + r.deadline + '.\n\nSheet: ' + getSheet_().getParent().getUrl());
  }
}
