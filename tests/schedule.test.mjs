import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClock, makeCalendar, simulateQueue, estimateRange, learnFactor } from '../js/schedule.js';

const TZ = 'Asia/Jerusalem';
const HOURS = { openHour: 9, closeHour: 22, closedWeekdays: [5, 6], closedDates: [] };
const clock = makeClock(TZ);
const J = (y, m, d, h = 0, min = 0) => clock.at(y, m, d, h, min); // Jerusalem wall clock → ms
const show = (ms) => { const p = clock.parts(ms); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`; };
const printers = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: 'P' + (i + 1), up: true, ...(extra[i] || {}) }));
const base = (o) => ({ timeZone: TZ, hours: HOURS, handlingMinutes: 10, factor: 1, ...o });

test('clock converts Jerusalem wall time both ways, across DST', () => {
  assert.equal(show(J(2026, 10, 19, 9, 30)), '2026-10-19 09:30');
  // Israel summer time ends on 2026-10-25: 09:00 local is 06:00 UTC before, 07:00 UTC after.
  assert.equal(new Date(J(2026, 10, 22, 9)).getUTCHours(), 6);
  assert.equal(new Date(J(2026, 10, 26, 9)).getUTCHours(), 7);
  assert.equal(clock.parts(J(2026, 10, 19, 12)).wd, 1); // Monday
});

test('calendar: starts only in campus hours, skips Fri/Sat and closed dates', () => {
  const cal = makeCalendar(clock, { ...HOURS, closedDates: ['2026-10-25'] });
  assert.equal(show(cal.nextStaffed(J(2026, 10, 19, 7))), '2026-10-19 09:00');
  assert.equal(show(cal.nextStaffed(J(2026, 10, 19, 13, 5))), '2026-10-19 13:05');
  assert.equal(show(cal.nextStaffed(J(2026, 10, 19, 22))), '2026-10-20 09:00');
  // Thursday night → Sunday is a closed date → Monday.
  assert.equal(show(cal.nextStaffed(J(2026, 10, 22, 23))), '2026-10-26 09:00');
  assert.equal(cal.workingDaysBetween(J(2026, 10, 22, 10), J(2026, 10, 26, 10)), 1);
});

test('six printers share the queue; prints run overnight but start only when staffed', () => {
  const now = J(2026, 10, 19, 20); // Monday 20:00
  const queue = Array.from({ length: 7 }, (_, i) => ({ id: 'R' + i, plates: [{ minutes: 600 }] }));
  const r = simulateQueue(base({ now, printers: printers(6), queue }));
  assert.equal(r.printersUp, 6);
  for (let i = 0; i < 6; i++) {
    assert.equal(show(r.requests['R' + i].start), '2026-10-19 20:00');
    // 600 min + 10 handling → ends 06:10 Tuesday; ready when staff arrive.
    assert.equal(show(r.requests['R' + i].end), '2026-10-20 06:10');
    assert.equal(show(r.requests['R' + i].ready), '2026-10-20 09:00');
  }
  // 7th waits for a printer; it frees at 06:10 but can only be started at 09:00.
  assert.equal(show(r.requests.R6.start), '2026-10-20 09:00');
});

test('a printer marked down takes no work, and its absence pushes the estimate', () => {
  const now = J(2026, 10, 19, 10);
  const queue = [{ id: 'A', plates: [{ minutes: 120 }] }, { id: 'B', plates: [{ minutes: 60 }] }];
  const two = simulateQueue(base({ now, printers: printers(2), queue }));
  const one = simulateQueue(base({ now, printers: printers(2, { 1: { up: false } }), queue }));
  assert.equal(show(two.requests.B.start), '2026-10-19 10:00');
  assert.equal(show(one.requests.B.start), '2026-10-19 12:10');
  assert.ok(one.requests.B.plates.every((p) => p.printer === 'P1'));
  const none = simulateQueue(base({ now, printers: printers(2, { 0: { up: false }, 1: { up: false } }), queue }));
  assert.equal(none.printersUp, 0);
  assert.equal(none.requests.A.ready, null);
});

test('busy printers, multi-plate requests, the correction factor', () => {
  const now = J(2026, 10, 19, 10);
  const r = simulateQueue(base({
    now, factor: 1.5,
    printers: printers(2, { 0: { busyUntil: J(2026, 10, 19, 14) } }),
    queue: [{ id: 'A', plates: [{ id: 'a1', minutes: 60 }, { id: 'a2', minutes: 60 }] }],
  }));
  const a = r.requests.A;
  assert.deepEqual(a.plates.map((p) => [p.id, p.printer, show(p.start), show(p.end)]), [
    ['a1', 'P2', '2026-10-19 10:00', '2026-10-19 11:40'],
    ['a2', 'P2', '2026-10-19 11:40', '2026-10-19 13:20'],
  ]);
  assert.equal(show(a.ready), '2026-10-19 13:20');
});

test('a long print finishing Friday is ready Sunday morning', () => {
  const now = J(2026, 10, 22, 21); // Thursday 21:00
  const r = simulateQueue(base({ now, printers: printers(1), queue: [{ id: 'A', plates: [{ minutes: 900 }] }] }));
  assert.equal(show(r.requests.A.start), '2026-10-22 21:00');
  assert.equal(show(r.requests.A.ready), '2026-10-25 09:00');
  const e = estimateRange(r.requests.A.ready, base({ now }));
  assert.deepEqual([e.days, e.daysMax], [1, 2]);
});

test('learnFactor: median ratio, ignores junk, needs enough samples, clamps', () => {
  assert.equal(learnFactor([{ estimated: 100, actual: 120 }]), 1);
  const s = [100, 110, 120, 130, 125].map((a) => ({ estimated: 100, actual: a }));
  assert.equal(learnFactor(s), 1.2);
  assert.equal(learnFactor(s.concat([{ estimated: 100, actual: 5000 }])), 1.2);
  assert.equal(learnFactor([200, 210, 220, 230, 250].map((a) => ({ estimated: 100, actual: a }))), 1.6);
});

test('apps-script/Schedule.gs is up to date with js/schedule.js (npm run build:gs)', async () => {
  const { readFileSync } = await import('node:fs');
  const { scheduleGs } = await import('../tools/build-apps-script.mjs');
  assert.equal(readFileSync(new URL('../apps-script/Schedule.gs', import.meta.url), 'utf8'), scheduleGs());
});
