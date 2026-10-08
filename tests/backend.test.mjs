import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBackend } from './apps-script-mock.mjs';

const details = { name: 'Dana Levi', idNumber: '012345678', email: 'dana@example.com', phone: '050-1234567',
  department: 'Industrial Design', course: 'Studio 2', deadline: '2026-11-01', notes: 'Please print soon', website: '' };
const order = { files: ['part.stl', 'bracket.3mf'], profile: 'Normal - Bezalel Modelling Center', profileLabel: 'Normal', color: 'Black (plate 1), White (plate 2)', plateColors: ['Black', 'White'], plateNames: ['Base', ''], center: 'main', copies: 4,
  objects: [
    { name: 'part.stl', file: 'part.stl', copies: 3, sizeMm: '40 × 20 × 10', unitScale: 1, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    { name: 'bracket.3mf – part 2', file: 'bracket.3mf', copies: 1, sizeMm: '12 × 8 × 5', unitScale: 10, scalePercent: 150, rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0] },
  ],
  plates: 2, plateLayout: [['part.stl ×2', 'bracket.3mf – part 2 ×1'], ['part.stl ×1']], estimatedMinutes: 95, estimatedCost: 10, costBreakdown: { material: 1.56, time: 7.92, subtotal: 9.48, minimum: 10, minimumTopUp: 0.52, minimumPlates: [2], total: 10, perGram: 0.05, perHour: 5 }, filamentGrams: 31.2, supports: true, secondsOnPage: 60 };

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
  assert.equal(b.call({ action: 'file', id: r1.id, token: r1.token, name: 'bracket.3mf', kind: 'original', data }).ok, true);
  assert.equal(b.call({ action: 'file', id: r1.id, token: r1.token, name: 'plates.3mf', kind: 'plates', data }).ok, true);
  const r3 = b.call({ action: 'finish', id: r1.id, token: r1.token });
  assert.equal(r3.ok, true, JSON.stringify(r3));
  assert.equal(b.sheetRows[1][2], 'New');
  assert.match(b.sheetRows[1][19], /ORIGINAL – part\.stl\nORIGINAL – bracket\.3mf\nPLATES – plates\.3mf/);
  assert.equal(b.sheetRows[1][10], 4, 'pieces in total');
  assert.equal(b.sheetRows[1][17], 'part.stl ×3 (40 × 20 × 10)\nbracket.3mf – part 2 ×1 (12 × 8 × 5) scaled 150%');
  assert.equal(b.mails.length, 1);
  assert.equal(b.mails[0][0], 'dana@example.com');
  const names = b.drive.files.filter((f) => f.folder === sub).map((f) => f.name);
  assert.equal(names.length, 4); // details.txt + 2 originals + plates 3MF
  const txt = b.drive.files.find((f) => f.folder === sub && f.name.endsWith('details.txt')).content;
  assert.match(txt, /Estimated cost: ₪10 — material ₪1\.56 \(₪0\.05\/g\) \+ printing time ₪7\.92 \(₪5\/h\) \+ ₪0\.52 to reach the ₪10 minimum per plate \(plate 2\)/);
  assert.match(txt, /Plate 1 "Base" \(Black\): part\.stl ×2, bracket\.3mf – part 2 ×1\n  Plate 2 \(White\): part\.stl ×1/);
  assert.match(txt, /Sent to: Bezalel Main Modelling Center/);
  assert.match(txt, /bracket\.3mf – part 2 ×1 — 12 × 8 × 5 mm, from bracket\.3mf, file units ×10, resized to 150%/);
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
  assert.equal(b.call({ action: 'begin', details, order: { ...order, copies: 5 } }).ok, false, 'total must match objects');
  const tooMany = { ...order, objects: [{ ...order.objects[0], copies: 11 }], copies: 11 };
  assert.equal(b.call({ action: 'begin', details, order: tooMany }).ok, false, 'max 10 copies per object');
  assert.equal(b.call({ action: 'begin', details, order: { ...order, objects: [], copies: 0 } }).ok, false);
  assert.equal(b.call({ action: 'begin', details: { ...details, website: 'spam' }, order }).ok, false);
  assert.equal(b.call({ action: 'begin', details, order: { ...order, secondsOnPage: 1 } }).ok, false);
  assert.equal(b.call({ action: 'begin', details, order: { ...order, center: '' } }).ok, false, 'a center must be chosen');
  assert.equal(b.call({ action: 'begin', details, order: { ...order, center: 'nope' } }).ok, false);
  assert.equal(b.call({ action: 'begin', details, order: { ...order, plateColors: ['Red'] } }).ok, false);
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

test('each modelling center gets its own folder and sheet', () => {
  const b = loadBackend();
  const data = Buffer.from('x').toString('base64');
  const send = (center, email) => {
    const r = b.call({ action: 'begin', details: { ...details, email }, order: { ...order, center } });
    assert.equal(r.ok, true, JSON.stringify(r));
    b.call({ action: 'file', id: r.id, token: r.token, name: 'plates.3mf', kind: 'plates', data });
    assert.equal(b.call({ action: 'finish', id: r.id, token: r.token }).ok, true);
    return r.id;
  };
  const m = send('main', 'a@example.com');
  const a = send('architecture', 'b@example.com');
  const folderOf = (id) => b.drive.folders.find((f) => f.name.endsWith(id)).parent.name;
  assert.equal(folderOf(m), 'STUDENT 3D SUBMISSIONS');
  assert.equal(folderOf(a), 'STUDENT 3D SUBMISSIONS – ARCHITECTURE');
  const [ssMain, ssArch] = b.spreadsheets;
  assert.equal(ssMain.title, 'STUDENT 3D SUBMISSIONS – Log');
  assert.equal(ssArch.title, 'STUDENT 3D SUBMISSIONS – ARCHITECTURE – Log');
  assert.equal(ssMain.tabs[0].rows[1][1], m);
  assert.equal(ssArch.tabs[0].rows[1][1], a);
  assert.equal(ssArch.tabs[0].rows[1][2], 'New');
  assert.equal(ssArch.tabs[0].rows.length, 2, 'only its own submission');
  assert.match(b.mails.at(-1)[2], /submission/);
  assert.match(b.mails.at(-1)[3].htmlBody, /Bezalel Architecture Modelling Center/);
});

test('a center can use an existing folder and Sheet (log goes on a Submissions tab)', () => {
  const b = loadBackend();
  const folder = b.root.createFolder('Architecture prints');
  const existing = b.makeSpreadsheet('Arch lab sheet');
  existing.tabs[0].rows.push(['their own data']);
  b.settings.CENTERS.architecture.FOLDER_ID = folder.getId();
  b.settings.CENTERS.architecture.SHEET_ID = existing.getId();
  b.settings.CENTERS.architecture.NOTIFY_EMAIL = 'arch-lab@example.com';
  const r = b.call({ action: 'begin', details, order: { ...order, center: 'architecture' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(b.drive.folders.find((f) => f.name.endsWith(r.id)).parent, folder);
  assert.equal(existing.tabs[0].name, 'Submissions');
  assert.equal(existing.tabs[0].rows[1][1], r.id);
  assert.deepEqual(existing.tabs[1].rows, [['their own data']], 'existing tab untouched');
  b.call({ action: 'file', id: r.id, token: r.token, name: 'plates.3mf', kind: 'plates', data: Buffer.from('x').toString('base64') });
  b.call({ action: 'finish', id: r.id, token: r.token });
  assert.ok(b.mails.some((m) => m[0] === 'arch-lab@example.com'), 'center notify email');
});
