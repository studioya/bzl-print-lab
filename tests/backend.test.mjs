import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackend } from './apps-script-mock.mjs';

const details = { name: 'Dana Levi', idNumber: '012345678', email: 'dana@example.com', phone: '050-1234567',
  department: 'Industrial Design', course: 'Studio 2', deadline: '2026-11-01', notes: 'Please print soon', website: '' };
const order = { fileName: 'part.stl', profile: 'BEZALEL FABLAB NORMAL', profileLabel: 'Normal', color: 'Black', copies: 3,
  plates: 1, estimatedMinutes: 95, estimatedCost: 47.5, filamentGrams: 31.2, sizeMm: '40 × 20 × 10', supports: true,
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], secondsOnPage: 60 };

test('begin → file → finish stores files, logs the row and emails the student', () => {
  const b = loadBackend();
  const r1 = b.call({ action: 'begin', details, order });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.match(r1.id, /^P\d{6}-[A-Z0-9]{4}$/);
  const sub = b.drive.folders.find((f) => f.name.endsWith(r1.id));
  assert.ok(sub, 'submission folder created');
  assert.equal(sub.parent.name, 'STUDENT 3D SUBMISSIONS');
  assert.match(sub.name, /^\d{4}-\d{2}-\d{2} \d{2}\.\d{2} · Dana Levi · /);
  assert.equal(b.sheetRows[1][1], r1.id);
  assert.equal(b.sheetRows[1][2], 'Uploading');
  assert.equal(b.sheetRows[1][4], '012345678', 'ID number keeps leading zero');

  const data = Buffer.from('solid x\nendsolid x\n').toString('base64');
  assert.equal(b.call({ action: 'file', id: r1.id, token: r1.token, name: 'part.stl', kind: 'original', data }).ok, true);
  assert.equal(b.call({ action: 'file', id: r1.id, token: r1.token, name: 'part_oriented.stl', kind: 'oriented', data }).ok, true);
  const r3 = b.call({ action: 'finish', id: r1.id, token: r1.token });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(b.sheetRows[1][2], 'New');
  assert.match(b.sheetRows[1][19], /ORIGINAL – part\.stl\nORIENTED – part_oriented\.stl/);
  assert.equal(b.mails.length, 1);
  assert.equal(b.mails[0][0], 'dana@example.com');
  const names = b.drive.files.filter((f) => f.folder === sub).map((f) => f.name);
  assert.equal(names.length, 3); // details.txt + 2 models
});

test('newest submission goes on top', () => {
  const b = loadBackend();
  const a = b.call({ action: 'begin', details, order });
  const c = b.call({ action: 'begin', details: { ...details, email: 'x@example.com' }, order });
  assert.equal(b.sheetRows[1][1], c.id);
  assert.equal(b.sheetRows[2][1], a.id);
});

test('rejects bad input, spam and wrong tokens', () => {
  const b = loadBackend();
  assert.equal(b.call({ action: 'begin', details: { ...details, email: 'nope' }, order }).ok, false);
  assert.equal(b.call({ action: 'begin', details, order: { ...order, copies: 11 } }).ok, false);
  assert.equal(b.call({ action: 'begin', details: { ...details, website: 'spam' }, order }).ok, false);
  assert.equal(b.call({ action: 'begin', details, order: { ...order, secondsOnPage: 1 } }).ok, false);
  const r = b.call({ action: 'begin', details, order });
  assert.equal(b.call({ action: 'file', id: r.id, token: 'bad', name: 'a.stl', data: '' }).ok, false);
  assert.equal(b.call({ action: 'file', id: r.id, token: r.token, name: 'a.exe', data: 'AAAA' }).ok, false);
  assert.equal(b.call({ action: 'finish', id: r.id, token: r.token }).ok, false, 'finish needs a file');
  assert.equal(b.call('not json').ok, false);
});

test('rate-limits repeated submissions from one email', () => {
  const b = loadBackend();
  let last;
  for (let i = 0; i < 7; i++) last = b.call({ action: 'begin', details, order });
  assert.equal(last.ok, false);
});
