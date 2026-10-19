import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackend, loadMailer } from './apps-script-mock.mjs';
import { makeClock } from '../js/schedule.js';

const clock = makeClock('Asia/Jerusalem');
const MON_10 = clock.at(2026, 10, 19, 10, 0); // Monday 10:00 in Israel

const details = { name: 'Dana Levi', idNumber: '012345678', email: 'dana@example.com', phone: '050-1234567',
  department: 'Industrial Design', course: 'Studio 2', deadline: '2026-11-01', notes: 'Please print soon', website: '' };
const order = (over = {}) => ({
  files: ['part.stl'], profile: 'normal', profileLabel: 'Normal', copies: 3, plates: 2, layout: 'site',
  plateColors: ['Black', 'White'], plateNames: ['Base', ''],
  platesDetail: [{ name: 'Base', color: 'Black', minutes: 120, grams: 30 }, { name: '', color: 'White', minutes: 60, grams: 12 }],
  objects: [{ name: 'part.stl', file: 'part.stl', copies: 3, sizeMm: '40 × 20 × 10', unitScale: 1, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], layout: 'site' }],
  plateLayout: [['part.stl ×2'], ['part.stl ×1']], estimatedMinutes: 180, estimatedCost: 17.1,
  costBreakdown: { material: 2.1, time: 15, subtotal: 17.1, minimum: 10, minimumTopUp: 0, minimumPlates: [], total: 17.1, perGram: 0.05, perHour: 5 },
  filamentGrams: 42, supports: false, secondsOnPage: 60, ...over,
});

function setupBackend(opts) {
  const b = loadBackend({ now: MON_10, ...opts });
  b.run('setup()');
  return b;
}

function submit(b, o = order(), d = details) {
  const r1 = b.post({ action: 'begin', details: d, order: o });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const data = Buffer.from('solid x\nendsolid x\n').toString('base64');
  assert.equal(b.post({ action: 'file', id: r1.id, token: r1.token, name: 'part.stl', kind: 'original', data }).ok, true);
  assert.equal(b.post({ action: 'file', id: r1.id, token: r1.token, name: 'plates.3mf', kind: 'plates', data }).ok, true);
  const r3 = b.post({ action: 'finish', id: r1.id, token: r1.token });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  return r3;
}

const H = (b, name) => b.tab(name)[0];
const rowsOf = (b, name) => { const [h, ...rows] = b.tab(name); return rows.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };

test('setup creates the folder, tabs, six printers, the secret and the nightly trigger; it can run twice', () => {
  const b = setupBackend();
  b.run('setup()');
  assert.deepEqual(b.spreadsheets.map((s) => s.title), ['BZL Print Lab – Data', 'BZL Print Lab – Outbox (emails waiting to be sent)']);
  assert.deepEqual(b.spreadsheets[0].tabs.map((t) => t.name), ['Requests', 'Contacts', 'Plates', 'Printers', 'History', 'ClosedDates']);
  assert.equal(rowsOf(b, 'Printers').length, 6);
  assert.ok(b.props.get('STUDENT_KEY_SECRET').length >= 10);
  assert.deepEqual(b.triggers.map((t) => t.getHandlerFunction()), ['nightly']);
});

test('a submission is queued with its plates, no personal data in Requests, and a confirmation in the Outbox', () => {
  const b = setupBackend();
  const r = submit(b);
  assert.match(r.id, /^P261019-[A-Z0-9]{5}$/);
  assert.equal(r.trackUrl, 'https://studioya.github.io/bzl-print-lab/?track=' + r.id);
  // Two plates on two free printers, started now: ready today.
  assert.equal(r.estimate.days, 0);

  const req = rowsOf(b, 'Requests')[0];
  assert.equal(req.Status, 'Queued');
  assert.match(req['Student key'], /^S-[A-Z0-9]{10}$/);
  assert.ok(req['Plates file id']);
  const flat = JSON.stringify(b.tab('Requests'));
  for (const pii of ['Dana', 'dana@example.com', '012345678', '050-1234567', 'Please print soon']) assert.ok(!flat.includes(pii), pii);
  assert.equal(rowsOf(b, 'Contacts')[0].Email, 'dana@example.com');
  assert.deepEqual(rowsOf(b, 'Plates').map((p) => [p.Plate, p.Color, p['Est. minutes'], p.State]),
    [[r.id + '-1', 'Black', 120, 'waiting'], [r.id + '-2', 'White', 60, 'waiting']]);
  // Folder names carry no names.
  const folder = b.drive.folders.find((f) => f.name.endsWith(r.id));
  assert.match(folder.name, /^2026-10-19 10\.00 · P261019-/);
  assert.ok(!b.drive.files.find((f) => f.folder === folder && f.name.endsWith('details.txt')).bytes.toString().includes('Dana'));

  const ob = b.outbox().rows;
  assert.equal(ob.length, 2);
  assert.equal(ob[1][0], 'confirm:' + r.id);
  assert.equal(ob[1][2], 'dana@example.com');
  assert.match(ob[1][3], new RegExp(r.id));
  assert.match(ob[1][4], /track=/);
  // Finishing twice doesn't queue a second email.
  assert.equal(b.outbox().rows.length, 2);
});

test('the same student gets the same key; a different one a different key', () => {
  const b = setupBackend();
  submit(b);
  submit(b, order(), { ...details, idNumber: '12345678', email: 'other@example.com' }); // same ID without the leading 0
  submit(b, order(), { ...details, idNumber: '987654321' });
  const keys = rowsOf(b, 'Requests').map((r) => r['Student key']);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
});

test('bad input is refused with a clear message', () => {
  const b = setupBackend();
  const r = b.post({ action: 'begin', details: { ...details, email: 'nope' }, order: order({ platesDetail: [{ color: 'Pink', minutes: 1 }], plates: 1 }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /email.*color/);
  assert.equal(b.post({ action: 'finish', id: 'P261019-AAAAA', token: 'x' }).ok, false);
});

test('public queue snapshot and status lookup expose no personal data', () => {
  const b = setupBackend();
  const r = submit(b);
  const snap = b.get({ action: 'queue' });
  assert.equal(snap.ok, true);
  assert.equal(snap.printers.length, 6);
  assert.deepEqual(snap.queue, [{ plates: [{ minutes: 120 }, { minutes: 60 }] }]);
  assert.ok(!JSON.stringify(snap).includes(r.id));
  const s = b.get({ action: 'status', id: r.id.toLowerCase() });
  assert.equal(s.ok, true);
  assert.equal(s.status, 'Queued');
  assert.equal(s.statusHe, 'בתור');
  assert.deepEqual(s.plates, { total: 2, done: 0, printing: 0 });
  assert.equal(s.ahead, 0);
  assert.ok(s.estimate.ready > MON_10);
  assert.ok(!JSON.stringify(s).includes('Dana'));
  assert.equal(b.get({ action: 'status', id: 'P261019-ZZZZZ' }).ok, false);
  assert.equal(b.get({ action: 'status', id: '<script>' }).ok, false);
});

test('dashboard: only a signed-in handler gets data', () => {
  const b = setupBackend({ user: '', effective: 'owner@example.com' });
  assert.equal(b.api('load').ok, false);
  assert.ok(b.ctx.doGet({ parameter: {} }).html, 'anonymous visitors get a plain page, not the dashboard');
  b.session.active = 'someone@example.com'; // visitor ≠ the account the script runs as
  assert.equal(b.api('load').ok, false);
  b.session.active = 'owner@example.com';
  assert.equal(b.api('load').ok, true);
  assert.equal(b.ctx.doGet({ parameter: {} }).file, 'Dashboard');
});

test('dashboard flow: start, fail, reprint, finish → ready email; printer down pushes estimates', () => {
  const b = setupBackend();
  const r = submit(b);
  let d = b.api('load').data;
  assert.equal(d.requests.length, 1);
  assert.equal(d.requests[0].name, 'Dana Levi');
  assert.equal(d.requests[0].plates[0].plan.printer, 'P1');

  // Five printers down: both plates must share P1.
  for (const id of ['P2', 'P3', 'P4', 'P5', 'P6']) d = b.api('setPrinter', { id, up: false, note: 'maintenance' }).data;
  assert.deepEqual(d.requests[0].plates.map((p) => p.plan.printer), ['P1', 'P1']);
  assert.ok(d.requests[0].estReady > MON_10 + 3 * 3600000);
  assert.equal(b.get({ action: 'queue' }).printers.filter((p) => p.up).length, 1, 'snapshot cache refreshed');

  const k1 = r.id + '-1', k2 = r.id + '-2';
  d = b.api('startPlate', { key: k1, printer: 'P1' }).data;
  assert.equal(d.requests[0].status, 'Printing');
  assert.equal(b.api('startPlate', { key: k2, printer: 'P1' }).ok, false, 'P1 is busy');
  b.clock.t += 30 * 60000;
  d = b.api('failPlate', { key: k1, note: 'spaghetti' }).data;
  assert.equal(d.requests[0].plates[0].state, 'waiting');
  assert.match(d.requests[0].plates[0].note, /spaghetti/);
  b.api('startPlate', { key: k1, printer: 'P1' });
  b.clock.t += 130 * 60000;
  b.api('finishPlate', { key: k1 });
  b.api('startPlate', { key: k2, printer: 'P1' });
  b.clock.t += 50 * 60000;
  assert.equal(b.api('finishPlate', { key: k2, finished: b.clock.t + 3600000 }).ok, false, 'no finish times in the future');
  d = b.api('finishPlate', { key: k2, finished: b.clock.t - 5 * 60000 }).data;
  assert.equal(d.requests[0].status, 'Ready for pickup');
  const plates = rowsOf(b, 'Plates');
  assert.deepEqual(plates.map((p) => [p.State, p['Actual minutes'], p.Attempts]), [['done', 130, 2], ['done', 45, 1]]);
  const keys = b.outbox().rows.slice(1).map((x) => x[0]);
  assert.equal(keys.length, 2);
  assert.match(keys[1], new RegExp('^ready:' + r.id));
  assert.ok(rowsOf(b, 'History').some((h) => h.Action === 'Plate 1 failed' && /spaghetti/.test(h.Details)));
});

test('status changes: on hold leaves the queue, email only when asked, preview, picked up closes', () => {
  const b = setupBackend();
  const a = submit(b);
  const c = submit(b, order(), { ...details, email: 'c@example.com' });
  let d = b.api('setStatus', { id: a.id, status: 'On hold', email: false }).data;
  assert.equal(b.outbox().rows.length, 3, 'no email');
  assert.equal(b.get({ action: 'status', id: c.id }).ahead, 0, 'C moves up while A is on hold');
  const prev = b.api('previewEmail', { id: a.id, status: 'Rejected', message: 'Walls too thin <1mm' }).data;
  assert.equal(prev.to, 'dana@example.com');
  assert.match(prev.html, /Walls too thin &lt;1mm/);
  d = b.api('setStatus', { id: a.id, status: 'Rejected', email: true, message: 'Walls too thin' }).data;
  assert.equal(b.outbox().rows.length, 4);
  assert.equal(d.requests.find((x) => x.id === a.id).plates.every((p) => p.state === 'cancelled'), true);
  // Back to the queue restores the plates.
  d = b.api('setStatus', { id: a.id, status: 'Queued' }).data;
  assert.equal(d.requests.find((x) => x.id === a.id).plates.every((p) => p.state === 'waiting'), true);
  b.api('setStatus', { id: c.id, status: 'Ready for pickup', email: true });
  b.api('setStatus', { id: c.id, status: 'Picked up' });
  const row = rowsOf(b, 'Requests').find((x) => x.Submission === c.id);
  assert.equal(row.Status, 'Picked up');
  assert.ok(row['Closed at']);
  assert.equal(b.api('setStatus', { id: c.id, status: 'Printing' }).ok, false, 'not a handler status');
});

test('queue order: move to top / up / down', () => {
  const b = setupBackend();
  const ids = ['a', 'b', 'c'].map((x) => { b.clock.t += 60000; return submit(b, order(), { ...details, email: x + '@example.com' }).id; });
  let d = b.api('move', { id: ids[2], to: 'top' }).data;
  assert.deepEqual(d.requests.map((r) => r.id), [ids[2], ids[0], ids[1]]);
  d = b.api('move', { id: ids[1], to: 'up' }).data;
  assert.deepEqual(d.requests.map((r) => r.id), [ids[2], ids[1], ids[0]]);
  assert.equal(b.get({ action: 'status', id: ids[0] }).ahead, 2);
});

test('closed dates delay estimates', () => {
  const b = setupBackend();
  b.clock.t = clock.at(2026, 10, 19, 23, 0); // Monday night: next start Tuesday 9:00
  const r = submit(b);
  const before = b.get({ action: 'status', id: r.id }).estimate.ready;
  b.api('setClosedDates', { dates: [{ date: '2026-10-20', note: 'Holiday' }] });
  const after = b.get({ action: 'status', id: r.id }).estimate.ready;
  assert.equal(after - before, 24 * 3600000);
  assert.deepEqual(b.api('load').data.closedDates, [{ date: '2026-10-20', note: 'Holiday' }]);
});

test('nightly: abandons unfinished uploads, wipes contacts after the retention period, deletes old files and temp zips', () => {
  const b = setupBackend();
  const r = submit(b);
  const half = b.post({ action: 'begin', details: { ...details, email: 'x@example.com' }, order: order() });
  b.api('setStatus', { id: r.id, status: 'Picked up' });
  const zip = b.api('zip', { ids: [r.id] }).data;
  assert.equal(zip.count, 1);

  b.clock.t += 2 * 86400000;
  b.run('nightly()');
  let reqs = rowsOf(b, 'Requests');
  assert.equal(reqs.find((x) => x.Submission === half.id).Status, 'Abandoned');
  let contacts = rowsOf(b, 'Contacts');
  assert.equal(contacts.find((c) => c.Submission === half.id).Email, '', 'abandoned → wiped at once');
  assert.equal(contacts.find((c) => c.Submission === r.id).Email, 'dana@example.com', 'kept for now');
  assert.ok(b.drive.files.find((f) => f.name === zip.name).trashed, 'temp zip removed');

  b.clock.t += 181 * 86400000;
  b.run('nightly()');
  contacts = rowsOf(b, 'Contacts');
  const c = contacts.find((x) => x.Submission === r.id);
  assert.deepEqual([c.Name, c['ID number'], c.Email, c.Phone, c['Student notes']], ['', '', '', '', '']);
  assert.ok(c['Wiped at']);
  reqs = rowsOf(b, 'Requests');
  assert.ok(reqs.find((x) => x.Submission === r.id)['Student key'], 'analysis data kept');

  b.clock.t += 200 * 86400000;
  b.run('nightly()');
  assert.ok(b.drive.folders.find((f) => f.name.endsWith(r.id)).trashed);
  assert.ok(rowsOf(b, 'Requests').find((x) => x.Submission === r.id)['Files deleted']);
});

test('mailer: sends pending emails, one bad address never blocks the rest, retries then fails, respects quota', () => {
  const b = setupBackend();
  const ok1 = submit(b);
  submit(b, order(), { ...details, email: 'bounce@example.com' });
  submit(b, order(), { ...details, email: 'c@example.com' });
  const m = loadMailer(b);
  m.sendOutbox();
  assert.deepEqual(b.mails.map((x) => x.to), ['dana@example.com', 'c@example.com']);
  const rows = b.outbox().rows;
  assert.deepEqual(rows.slice(1).map((r) => r[6]), ['sent', 'pending', 'sent']);
  assert.equal(rows[1][2], '', 'address removed after sending');
  assert.equal(rows[1][4], '', 'body removed after sending');
  assert.match(rows[1][3], new RegExp(ok1.id), 'subject kept as a record');
  for (let i = 0; i < 6; i++) { b.clock.t += 24 * 3600000; m.sendOutbox(); }
  assert.equal(b.outbox().rows[2][6], 'failed');
  assert.equal(b.api('load').data.outbox.failed.length, 1);
  b.api('retryEmails');
  assert.equal(b.outbox().rows[2][6], 'pending');
  // Quota: nothing sent while at the reserve.
  submit(b, order(), { ...details, email: 'd@example.com' });
  b.services.MailApp.quota = 5;
  m.sendOutbox();
  assert.ok(!b.mails.some((x) => x.to === 'd@example.com'));
});
