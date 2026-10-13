import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, safeName, costText } from '../js/record.js';

const details = { name: 'Dana <Levi>', idNumber: '012345678', email: 'Dana@Example.com', phone: '050-1234567',
  department: 'Industrial Design', course: 'Studio 2', deadline: '2026-11-01', notes: '' };
const order = {
  files: ['part.stl'], profileLabel: 'Normal', color: 'White (plate 1), Black (plate 2)', copies: 3,
  objects: [{ name: 'part.stl', file: 'part.stl', copies: 3, sizeMm: '40 × 20 × 10', unitScale: 1, scalePercent: 150, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
  plates: 2, plateLayout: [['part.stl ×2'], ['part.stl ×1']], plateColors: ['White', 'Black'], plateNames: ['Base', ''],
  estimatedMinutes: 95, estimatedCost: 20, filamentGrams: 31.2, supports: false,
  costBreakdown: { material: 1.56, time: 7.92, minimumTopUp: 10.52, minimum: 10, minimumPlates: [1, 2], perGram: 0.05, perHour: 5 },
};
const center = { id: 'architecture', en: 'Bezalel Architecture Modelling Center' };

test('record: id, folder, row and details for the Power Automate flow', () => {
  // 2026-10-06 11:32 UTC = 14:32 in Israel.
  const r = buildRecord(details, order, center, new Date(Date.UTC(2026, 9, 6, 11, 32)), () => 0);
  assert.equal(r.id, 'P261006-AAAA');
  assert.equal(r.folder, '2026-10-06 14.32 · Dana _Levi_ · P261006-AAAA', 'no characters OneDrive rejects');
  assert.equal(r.row.submitted, '2026-10-06 14:32');
  assert.equal(r.row.center, 'Bezalel Architecture Modelling Center');
  assert.equal(r.row.email, 'dana@example.com');
  assert.equal(r.row.objects, 'part.stl ×3 (40 × 20 × 10) scaled 150%');
  assert.equal(r.row.supports, 'No');
  assert.equal(r.row.estCost, 20);
  assert.match(r.detailsText, /^Submission P261006-AAAA — 2026-10-06 14:32\nSent to: Bezalel Architecture Modelling Center/);
  assert.match(r.detailsText, /Plate 1 "Base" \(White\): part\.stl ×2\n  Plate 2 \(Black\): part\.stl ×1/);
  assert.match(r.detailsText, /\+ ₪10\.52 to reach the ₪10 minimum per plate \(plate 1, 2\)/);
});

test('safeName strips path and reserved characters', () => {
  assert.equal(safeName('../a/b\\c:d*e?"f<g>h|i#j%k'), '._a_b_c_d_e__f_g_h_i_j_k');
  assert.equal(safeName('  '), '_');
  assert.equal(costText(null), '');
});
