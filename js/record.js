// Builds what the lab keeps for a submission when the backend is Power
// Automate (power-automate/README.md): the submission number, the folder name,
// the row for the Excel log and the text of details.txt. (With the Google Apps
// Script backend, Code.gs builds these on the server instead.)

const TIMEZONE = 'Asia/Jerusalem';

/** Parts of a date in Israel time: { yyyy, yy, MM, dd, HH, mm }. */
function dateParts(d) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { yyyy: g('year'), yy: g('year').slice(2), MM: g('month'), dd: g('day'), HH: g('hour'), mm: g('minute') };
}

/** Letters that can't be confused with each other (no 0/O, 1/I/L). */
export function randomCode(n, random = Math.random) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(random() * chars.length)];
  return s;
}

/** Safe as a OneDrive / SharePoint file or folder name. */
export function safeName(s, max = 120) {
  return String(s).replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, '_').replace(/\.{2,}/g, '.').trim().slice(0, max) || '_';
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** "material ₪x (₪/g) + printing time ₪y (₪/h)", plus what the per-plate minimum added. */
export function costText(b) {
  if (!b || typeof b !== 'object') return '';
  const n = (x) => Math.max(0, +(+x || 0).toFixed(2));
  return `material ₪${n(b.material)} (₪${n(b.perGram)}/g) + printing time ₪${n(b.time)} (₪${n(b.perHour)}/h)`
    + (n(b.minimumTopUp) > 0 ? ` + ₪${n(b.minimumTopUp)} to reach the ₪${n(b.minimum)} minimum per plate`
      + (b.minimumPlates?.length ? ` (plate ${b.minimumPlates.join(', ')})` : '') : '');
}

/**
 * @param details  student form fields
 * @param order    print/estimate details (as sent to the Apps Script backend)
 * @param center   { id, en, ... } from config.centers
 * @returns { id, folder, row, detailsText }
 *   row: values for the Excel log, keyed as in power-automate/README.md
 */
export function buildRecord(details, order, center, now = new Date(), random = Math.random) {
  const t = dateParts(now);
  const id = `P${t.yy}${t.MM}${t.dd}-${randomCode(4, random)}`;
  const submitted = `${t.yyyy}-${t.MM}-${t.dd} ${t.HH}:${t.mm}`;
  const name = str(details.name, 80);
  // Folder names start with the date/time so sorting by name (Z→A) lists the newest first.
  const folder = safeName(`${t.yyyy}-${t.MM}-${t.dd} ${t.HH}.${t.mm} · ${name} · ${id}`);
  const objects = (order.objects || []).map((x) => ({
    name: str(x.name, 160), file: str(x.file, 150), copies: Math.round(+x.copies), size: str(x.sizeMm, 40),
    unitScale: +x.unitScale || 1, scalePercent: +x.scalePercent || 100, rotation: x.rotation || null,
  }));
  const files = (order.files || []).map((f) => str(f, 150));
  const supports = order.supports ? 'Yes' : 'No';
  const row = {
    submitted,
    id,
    center: center.en,
    name,
    idNumber: str(details.idNumber, 12),
    email: str(details.email, 120).toLowerCase(),
    phone: str(details.phone, 20),
    department: str(details.department, 80),
    course: str(details.course, 120),
    deadline: str(details.deadline, 10),
    pieces: Math.round(+order.copies),
    color: str(order.color, 120),
    profile: str(order.profileLabel || order.profile, 60),
    estMinutes: Math.max(0, Math.round(+order.estimatedMinutes || 0)),
    estCost: Math.max(0, +(+order.estimatedCost || 0).toFixed(2)),
    plates: Math.max(1, Math.round(+order.plates || 1)),
    grams: Math.max(0, +(+order.filamentGrams || 0).toFixed(1)),
    objects: objects.map((o) => `${o.name} ×${o.copies} (${o.size})${o.scalePercent !== 100 ? ` scaled ${o.scalePercent}%` : ''}`).join('\n'),
    supports,
    files: '', // filled in by the caller with the uploaded file names
    folder,
    notes: str(details.notes, 1500),
  };
  const plateLayout = order.plateLayout || [];
  const detailsText = [
    `Submission ${id} — ${submitted}`,
    `Sent to: ${center.en}`,
    '',
    `Name: ${row.name}`,
    `ID number: ${row.idNumber}`,
    `Email: ${row.email}`,
    `Phone: ${row.phone}`,
    `Department: ${row.department}`,
    `Course: ${row.course}`,
    `Deadline: ${row.deadline}`,
    '',
    `Original files: ${files.join(', ')}`,
    `Profile: ${row.profile}`,
    `Color: ${row.color}`,
    `Pieces in total: ${row.pieces} (${row.plates} plate${row.plates > 1 ? 's' : ''})`,
    `Supports: ${supports}`,
    `Estimated time: ${row.estMinutes} min`,
    `Estimated cost: ₪${row.estCost}${order.costBreakdown ? ` — ${costText(order.costBreakdown)}` : ''}`,
    `Estimated filament: ${row.grams} g`,
    'Objects (size in mm as oriented):',
    ...objects.map((o) => `  • ${o.name} ×${o.copies} — ${o.size} mm, from ${o.file}`
      + (o.unitScale !== 1 ? `, file units ×${o.unitScale}` : '')
      + (o.scalePercent !== 100 ? `, resized to ${o.scalePercent}%` : '')
      + `, rotation ${JSON.stringify(o.rotation)}`),
    ...(plateLayout.length ? ['Plates as arranged by the student:'] : []),
    ...plateLayout.map((pl, i) => `  Plate ${i + 1}${order.plateNames?.[i] ? ` "${order.plateNames[i]}"` : ''}`
      + `${order.plateColors?.[i] ? ` (${order.plateColors[i]})` : ''}: ${pl.join(', ')}`),
    '  The "PLATES" 3MF in this folder is a Bambu Studio project with every piece on the plate',
    '  where the student placed it, and the chosen profile. Open it with File → Open Project.',
    '',
    'Notes:',
    row.notes || '-',
  ].join('\n');
  return { id, folder, row, detailsText };
}
