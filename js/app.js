// Page controller: file loading, orientation, slicing, estimate and submission.

import { CONFIG } from './config.js';
import { PROCESSES } from './profiles-data.js';
import { PROFILE_INFO } from './profile-info.js';
import { FEATURES } from './slicer/features.js';
import { TRAVEL_INDEX } from './slicer/estimate.js';
import { loadModel, extensionOf, ACCEPTED_EXTENSIONS } from './loaders.js';
import { IDENTITY3, matMul, axisRotation, alignRotation, orientMesh, autoOrient, boundingSize, toBinarySTL } from './mesh.js';
import { arrangeCopies, fitsPlate, PLATE } from './arrange.js';
import { Viewer } from './viewer.js';
import { submitPrint } from './submit.js';

const $ = (id) => document.getElementById(id);

const state = {
  file: null,
  source: null,        // Float32Array as loaded
  unitScale: 1,
  R: IDENTITY3.slice(),
  oriented: null,      // { positions, size }
  fits: false,
  arrangement: null,
  profile: PROCESSES[1]?.name || PROCESSES[0].name,
  color: 'White',
  copies: 1,
  slice: null,         // worker result
  plateIndex: 0,
  worker: null,
  sliceJob: 0,
  pageLoadedAt: Date.now(),
};

const viewer = new Viewer($('viewer'));

// ---------------------------------------------------------------- setup UI

function initProfiles() {
  const fs = $('profiles');
  for (const p of PROCESSES) {
    const info = PROFILE_INFO[p.name] || { en: p.name, he: '', descEn: '', descHe: '' };
    const label = document.createElement('label');
    label.className = 'profile';
    const spec = `${p.layerHeight} mm · ${Math.round(p.sparseInfillDensity * 100)}% · ${p.wallLoops} walls`;
    label.innerHTML = `
      <input type="radio" name="profile" value="${p.name}">
      <span class="p-name">${info.en}<span class="he" lang="he" dir="rtl">${info.he}</span></span>
      <span class="p-spec">${spec}</span>
      <span class="p-desc">${info.descEn}<span class="he" lang="he" dir="rtl">${info.descHe}</span></span>`;
    const input = label.querySelector('input');
    input.checked = p.name === state.profile;
    input.addEventListener('change', () => { state.profile = p.name; invalidateSlice(); updateOrderSummary(); });
    fs.appendChild(label);
  }
}

function initControls() {
  document.querySelectorAll('[data-max-mb]').forEach((el) => { el.textContent = CONFIG.maxFileMB; });
  $('copies').max = CONFIG.maxCopies;

  // File input + drag & drop.
  const dz = $('dropzone');
  $('fileInput').addEventListener('change', (e) => e.target.files[0] && handleFile(e.target.files[0]));
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
  // Also accept drops on the 3D view.
  const v = $('viewer');
  v.addEventListener('dragover', (e) => e.preventDefault());
  v.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); });

  $('units').addEventListener('change', (e) => { state.unitScale = +e.target.value; applyOrientation(); });

  document.querySelectorAll('input[name=color]').forEach((r) => r.addEventListener('change', () => {
    state.color = r.value;
    viewer.setModelColor(state.color);
    updateOrderSummary();
  }));

  const setCopies = (n) => {
    n = Math.max(1, Math.min(CONFIG.maxCopies, Math.round(+n || 1)));
    $('copies').value = n;
    if (n !== state.copies) {
      state.copies = n;
      applyOrientation(false);
      if (state.oriented) viewer.frame(state.oriented.size, state.arrangement?.plates[0]);
    }
  };
  $('copies').addEventListener('change', (e) => setCopies(e.target.value));
  $('copiesDown').addEventListener('click', () => setCopies(state.copies - 1));
  $('copiesUp').addEventListener('click', () => setCopies(state.copies + 1));

  // Orientation tools.
  document.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', () => {
    const [axis, deg] = b.dataset.rot.split(':');
    state.R = matMul(axisRotation(axis, +deg), state.R);
    applyOrientation();
  }));
  $('resetOrient').addEventListener('click', () => { state.R = IDENTITY3.slice(); applyOrientation(); });
  $('autoOrient').addEventListener('click', () => {
    const btn = $('autoOrient');
    btn.classList.add('active');
    setTimeout(() => {
      const proc = currentProcess();
      state.R = autoOrient(state.source, proc.support.thresholdAngle || 30);
      btn.classList.remove('active');
      applyOrientation();
    }, 30);
  });
  $('layFlat').addEventListener('click', () => {
    if (viewer.onFacePick) { cancelPick(); return; }
    showTab('prepare');
    $('layFlat').classList.add('active');
    $('pickHint').hidden = false;
    viewer.setFacePicking((normal) => {
      cancelPick();
      state.R = matMul(alignRotation(normal, [0, 0, -1]), state.R);
      applyOrientation();
    });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelPick(); });

  $('sliceBtn').addEventListener('click', startSlice);
  $('tabPrepare').addEventListener('click', () => showTab('prepare'));
  $('tabPreview').addEventListener('click', () => showTab('preview'));
  $('layerRange').addEventListener('input', updateLayerView);
  $('singleLayer').addEventListener('change', updateLayerView);

  // Deadline can't be in the past.
  const today = new Date();
  const iso = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('fDeadline').min = iso;

  $('form').addEventListener('submit', onSubmit);
  $('form').addEventListener('input', (e) => e.target.classList.remove('invalid'));
  $('doneClose').addEventListener('click', () => location.reload());
}

function cancelPick() {
  viewer.setFacePicking(null);
  $('layFlat').classList.remove('active');
  $('pickHint').hidden = true;
}

function currentProcess() {
  return PROCESSES.find((p) => p.name === state.profile);
}

// ---------------------------------------------------------------- file loading

async function handleFile(file) {
  const err = $('loadError');
  err.hidden = true;
  const ext = extensionOf(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    return showLoadError(`Unsupported file type. Please upload STL, OBJ or 3MF.`, 'סוג קובץ לא נתמך. יש להעלות קובץ STL, OBJ או 3MF.');
  }
  if (file.size > CONFIG.maxFileMB * 1024 * 1024) {
    return showLoadError(`The file is larger than ${CONFIG.maxFileMB} MB. Export it with a coarser mesh and try again.`,
      `הקובץ גדול מ־${CONFIG.maxFileMB} MB. יש לייצא אותו ברזולוציה נמוכה יותר ולנסות שוב.`);
  }
  try {
    const positions = await loadModel(await file.arrayBuffer(), file.name);
    state.file = file;
    state.source = positions;
    state.R = IDENTITY3.slice();
    state.unitScale = 1;
    $('units').value = '1';
    $('fileInfo').hidden = false;
    $('fileName').textContent = file.name;
    $('emptyState').hidden = true;
    document.querySelectorAll('.orient-tools .tool').forEach((b) => { b.disabled = false; });
    suggestUnits();
    applyOrientation();
    viewer.frame(state.oriented.size);
  } catch (e) {
    console.error(e);
    showLoadError(`Could not read this file: ${e.message}`, 'לא ניתן לקרוא את הקובץ.');
  }
}

function showLoadError(en, he) {
  const err = $('loadError');
  err.innerHTML = `${en}<span class="he" lang="he" dir="rtl">${he}</span>`;
  err.hidden = false;
}

function suggestUnits() {
  const s = boundingSize(state.source);
  const max = Math.max(s.x, s.y, s.z);
  const hint = $('unitsHint');
  hint.hidden = true;
  if (max > 0 && max < 4) {
    hint.innerHTML = `This model is only ${fmt(max, 2)} mm across. Was it exported in cm, inches or metres? Choose the file units above.
      <span class="he" lang="he" dir="rtl">המודל בגודל ${fmt(max, 2)} מ״מ בלבד. האם יוצא בס״מ, באינצ׳ים או במטרים? בחרו את יחידות הקובץ למעלה.</span>`;
    hint.hidden = false;
  }
}

// ---------------------------------------------------------------- orientation & arrangement

function applyOrientation(reorient = true) {
  if (!state.source) return;
  if (reorient || !state.oriented) state.oriented = orientMesh(state.source, state.R, state.unitScale);
  const { size } = state.oriented;
  state.fits = fitsPlate(size);
  const proc = currentProcess();
  state.arrangement = state.fits ? arrangeCopies(size, state.copies, proc.brim) : null;
  const copies = state.arrangement ? state.arrangement.plates[0] : [[PLATE.width / 2, PLATE.depth / 2]];
  viewer.setModel(state.oriented.positions, copies, state.fits);
  viewer.setModelColor(state.color);
  showTab('prepare');

  const tris = state.source.length / 9;
  $('fileMeta').textContent = `${fmt(size.x, 1)} × ${fmt(size.y, 1)} × ${fmt(size.z, 1)} mm · ${tris.toLocaleString()} triangles`;

  const fit = $('fitStatus');
  fit.hidden = false;
  if (state.fits) {
    const plates = state.arrangement.plates.length;
    fit.className = 'fit ok';
    fit.innerHTML = `Fits the build plate. ${state.copies > 1 ? `${state.copies} copies on ${plates} plate${plates > 1 ? 's' : ''} (up to ${state.arrangement.perPlate} per plate).` : ''}
      <span class="he" lang="he" dir="rtl">המודל נכנס למשטח ההדפסה.${state.copies > 1 ? ` ${state.copies} עותקים על ${plates} ${plates > 1 ? 'משטחים' : 'משטח'}.` : ''}</span>`;
  } else {
    fit.className = 'fit bad';
    fit.innerHTML = `Too big for the printer: the maximum is ${PLATE.width} × ${PLATE.depth} × ${PLATE.height} mm. Try rotating it, or scale the model down in your 3D software. Models that don't fit can't be submitted.
      <span class="he" lang="he" dir="rtl">המודל גדול מדי למדפסת: הגודל המרבי הוא ${PLATE.width} × ${PLATE.depth} × ${PLATE.height} מ״מ. נסו לסובב אותו או להקטין אותו בתוכנת התלת־ממד. לא ניתן להגיש מודל שאינו נכנס.</span>`;
  }
  invalidateSlice();
  updateOrderSummary();
}

// ---------------------------------------------------------------- slicing

function invalidateSlice() {
  if (state.worker && state.sliceJob) { state.worker.terminate(); state.worker = null; }
  state.sliceJob = 0;
  state.slice = null;
  $('sliceProgress').hidden = true;
  $('tabPreview').disabled = true;
  $('estimateBody').hidden = true;
  $('estimateEmpty').hidden = false;
  $('legend').hidden = true;
  $('layerSlider').hidden = true;
  $('plateTabs').innerHTML = '';
  $('sliceBtn').disabled = !state.source || !state.fits;
  updateSubmitState();
}

const STAGE_LABEL = {
  slice: ['Slicing layers', 'חיתוך שכבות'],
  walls: ['Generating walls', 'יצירת דפנות'],
  shells: ['Top & bottom shells', 'מעטפות עליונות ותחתונות'],
  support: ['Supports', 'תמיכות'],
  paths: ['Toolpaths', 'מסלולי הדפסה'],
  estimate: ['Estimating time', 'חישוב זמן'],
};

function startSlice() {
  if (!state.source || !state.fits) return;
  invalidateSlice();
  cancelPick();
  const proc = currentProcess();
  const info = PROFILE_INFO[proc.name] || {};
  const job = Date.now();
  state.sliceJob = job;
  state.worker = new Worker(new URL('./slicer/worker.js', import.meta.url), { type: 'module' });
  $('sliceBtn').disabled = true;
  $('sliceProgress').hidden = false;
  $('sliceBar').style.width = '0%';
  $('sliceLabel').textContent = 'Starting…';

  state.worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.id !== job || state.sliceJob !== job) return;
    if (msg.type === 'progress') {
      $('sliceBar').style.width = `${Math.round(msg.fraction * 100)}%`;
      const [en, he] = STAGE_LABEL[msg.stage] || [msg.stage, ''];
      $('sliceLabel').textContent = `${en} · ${he}`;
    } else if (msg.type === 'done') {
      state.worker.terminate();
      state.worker = null;
      state.sliceJob = 0;
      onSliced(msg.result);
    } else if (msg.type === 'error') {
      console.error(msg.stack || msg.message);
      state.worker.terminate();
      state.worker = null;
      state.sliceJob = 0;
      $('sliceProgress').hidden = true;
      $('sliceBtn').disabled = false;
      showLoadError(`Slicing failed: ${msg.message}`, 'החיתוך נכשל. נסו כיוון אחר או קובץ אחר.');
    }
  };
  state.worker.onerror = (e) => {
    console.error(e);
    $('sliceProgress').hidden = true;
    $('sliceBtn').disabled = false;
    showLoadError('Slicing failed in this browser. Try an up-to-date Chrome, Edge, Firefox or Safari.', 'החיתוך נכשל בדפדפן זה.');
  };
  state.worker.postMessage({
    id: job,
    positions: state.oriented.positions,
    processName: proc.name,
    filamentName: info.filament || 'BEZALEL GENERIC PLA',
    plates: state.arrangement.plates,
  });
}

function calibration(name) {
  return CONFIG.timeCalibration.perProfile?.[name] ?? CONFIG.timeCalibration.default ?? 1;
}

function onSliced(result) {
  const k = calibration(result.processName);
  result.plates.forEach((p) => { p.seconds *= k; p.byFeature = p.byFeature.map((s) => s * k); });
  result.totalSeconds = result.plates.reduce((s, p) => s + p.seconds, 0);
  result.totalMinutes = Math.ceil(result.totalSeconds / 60);
  result.cost = result.totalMinutes * CONFIG.pricePerMinute;
  result.grams = result.plates.reduce((s, p) => s + p.grams, 0);
  result.meters = result.plates.reduce((s, p) => s + p.meters, 0);
  state.slice = result;
  state.plateIndex = 0;

  $('sliceProgress').hidden = true;
  $('sliceBtn').disabled = false;
  $('tabPreview').disabled = false;
  renderEstimate();
  renderPlateTabs();
  showPlatePreview(0);
  showTab('preview');
  updateOrderSummary();
  updateSubmitState();
}

function renderEstimate() {
  const r = state.slice;
  $('estimateEmpty').hidden = true;
  $('estimateBody').hidden = false;
  $('estTime').textContent = fmtDuration(r.totalSeconds);
  $('estCost').textContent = `${CONFIG.currency}${fmtMoney(r.cost)}`;
  $('estRate').textContent = `${r.totalMinutes} min × ${CONFIG.currency}${fmtMoney(CONFIG.pricePerMinute)} / min`;
  const info = PROFILE_INFO[r.processName] || { en: r.processName, he: '' };
  const rows = [
    ['Profile', 'פרופיל', `${info.en}`],
    ['Copies', 'עותקים', `${state.copies}`],
    ['Plates', 'משטחים', `${r.plates.length}`],
    ['Filament', 'חומר', `${fmt(r.grams, 1)} g · ${fmt(r.meters, 2)} m`],
    ['Layers', 'שכבות', `${r.layers}`],
    ['Size', 'מידות', `${fmt(state.oriented.size.x, 0)}×${fmt(state.oriented.size.y, 0)}×${fmt(state.oriented.size.z, 0)} mm`],
    ['Supports', 'תמיכות', r.hasSupport ? 'Yes · כן' : 'No · לא'],
  ];
  if (r.plates.length > 1) {
    r.plates.forEach((p, i) => rows.push([`Plate ${i + 1}`, `משטח ${i + 1}`, `${fmtDuration(p.seconds)} · ${p.copies.length}×`]));
  }
  $('estFacts').innerHTML = rows.map(([en, he, v]) => `<dt>${en}<span class="he" lang="he" dir="rtl">${he}</span></dt><dd>${v}</dd>`).join('');
}

function renderPlateTabs() {
  const box = $('plateTabs');
  box.innerHTML = '';
  const plates = state.slice.plates;
  if (plates.length < 2) return;
  plates.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `Plate ${i + 1}`;
    b.className = i === state.plateIndex ? 'active' : '';
    b.addEventListener('click', () => { showPlatePreview(i); renderPlateTabs(); showTab('preview'); });
    box.appendChild(b);
  });
}

function showPlatePreview(i) {
  state.plateIndex = i;
  const r = state.slice;
  const plate = r.plates[i];
  viewer.setPreview(r.preview, plate.copies);
  viewer.setModel(state.oriented.positions, plate.copies, true);
  viewer.setModelColor(state.color);
  const range = $('layerRange');
  range.max = r.layers - 1;
  range.value = r.layers - 1;
  updateLayerView();
  renderLegend(plate);
}

function updateLayerView() {
  const r = state.slice;
  if (!r) return;
  const top = +$('layerRange').value;
  const single = $('singleLayer').checked;
  viewer.setPreviewLayers(single ? top : 0, top);
  $('layerLabel').innerHTML = `${top + 1}<br>${fmt(r.preview.zs[top], 2)}`;
}

function renderLegend(plate) {
  const total = plate.seconds;
  const rows = FEATURES.map((f) => ({ ...f, s: plate.byFeature[f.id] }))
    .filter((f) => f.s > 0.5);
  const travel = plate.byFeature[TRAVEL_INDEX];
  const hidden = new Set();
  const legend = $('legend');
  legend.innerHTML = `<div class="legend-title">Line type · time <span class="he" lang="he" dir="rtl">סוג קו · זמן</span></div>
    <table>${rows.map((f) => `<tr>
      <td><label><input type="checkbox" checked data-feature="${f.id}"><span class="sw" style="background:${f.color}"></span>${f.en}<span class="he" lang="he" dir="rtl">${f.he}</span></label></td>
      <td class="num-col">${fmtDuration(f.s)}</td><td class="num-col">${Math.round((f.s / total) * 100)}%</td></tr>`).join('')}
      <tr><td><label><span class="sw" style="background:#9aa3ab"></span>Travel<span class="he" lang="he" dir="rtl">תנועה</span></label></td>
      <td class="num-col">${fmtDuration(travel)}</td><td class="num-col">${Math.round((travel / total) * 100)}%</td></tr>
    </table>`;
  legend.querySelectorAll('input[data-feature]').forEach((cb) => cb.addEventListener('change', () => {
    const id = +cb.dataset.feature;
    if (cb.checked) hidden.delete(id); else hidden.add(id);
    viewer.setHiddenFeatures([...hidden]);
  }));
  viewer.setHiddenFeatures([]);
}

function showTab(tab) {
  const preview = tab === 'preview' && state.slice;
  $('tabPrepare').classList.toggle('active', !preview);
  $('tabPreview').classList.toggle('active', !!preview);
  $('tabPrepare').setAttribute('aria-selected', String(!preview));
  $('tabPreview').setAttribute('aria-selected', String(!!preview));
  viewer.setMode(preview ? 'preview' : 'model');
  $('layerSlider').hidden = !preview;
  $('legend').hidden = !preview;
}

// ---------------------------------------------------------------- submission

function updateOrderSummary() {
  const info = PROFILE_INFO[state.profile] || { en: state.profile };
  const parts = [
    state.file ? state.file.name : 'No model yet',
    info.en,
    `${state.color}`,
    `${state.copies} ${state.copies > 1 ? 'copies' : 'copy'}`,
  ];
  if (state.slice) parts.push(`${fmtDuration(state.slice.totalSeconds)} · ${CONFIG.currency}${fmtMoney(state.slice.cost)}`);
  $('orderSummary').textContent = parts.join(' · ');
}

function updateSubmitState() {
  const ready = !!(state.source && state.fits && state.slice);
  $('submitBtn').disabled = !ready;
  $('submitHint').hidden = ready;
}

const FIELD_RULES = {
  fName: (v) => v.trim().length >= 2,
  fId: (v) => /^[0-9A-Za-z]{5,12}$/.test(v.trim()),
  fEmail: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()),
  fPhone: (v) => /^[+0-9][0-9 \-]{7,18}$/.test(v.trim()),
  fDept: (v) => v.trim().length >= 2,
  fCourse: (v) => v.trim().length >= 2,
  fDeadline: (v) => !!v && v >= $('fDeadline').min,
};

function validateForm() {
  let firstBad = null;
  for (const [id, ok] of Object.entries(FIELD_RULES)) {
    const el = $(id);
    const good = ok(el.value);
    el.classList.toggle('invalid', !good);
    if (!good && !firstBad) firstBad = el;
  }
  const consent = $('fConsent');
  consent.closest('.consent').classList.toggle('invalid', !consent.checked);
  if (!consent.checked && !firstBad) firstBad = consent;
  if (firstBad) firstBad.focus();
  return !firstBad;
}

async function onSubmit(e) {
  e.preventDefault();
  const status = $('submitStatus');
  status.className = 'submit-status';
  if (!state.slice) return;
  if (!validateForm()) {
    status.className = 'submit-status error';
    status.innerHTML = 'Please fill in the highlighted fields. <span class="he" lang="he" dir="rtl">נא למלא את השדות המסומנים.</span>';
    return;
  }
  const r = state.slice;
  const info = PROFILE_INFO[r.processName] || { en: r.processName };
  const s = state.oriented.size;
  const details = {
    name: $('fName').value.trim(),
    idNumber: $('fId').value.trim(),
    email: $('fEmail').value.trim(),
    phone: $('fPhone').value.trim(),
    department: $('fDept').value.trim(),
    course: $('fCourse').value.trim(),
    deadline: $('fDeadline').value,
    notes: $('fNotes').value.trim(),
    website: $('fWebsite').value, // spam trap
  };
  const order = {
    fileName: state.file.name,
    fileSizeBytes: state.file.size,
    triangles: state.source.length / 9,
    profile: r.processName,
    profileLabel: info.en,
    color: state.color,
    copies: state.copies,
    plates: r.plates.length,
    estimatedMinutes: r.totalMinutes,
    estimatedCost: r.cost,
    pricePerMinute: CONFIG.pricePerMinute,
    filamentGrams: Math.round(r.grams * 10) / 10,
    layers: r.layers,
    supports: r.hasSupport,
    sizeMm: `${fmt(s.x, 1)} × ${fmt(s.y, 1)} × ${fmt(s.z, 1)}`,
    unitScale: state.unitScale,
    rotation: state.R.map((v) => Math.round(v * 1e6) / 1e6),
    secondsOnPage: Math.round((Date.now() - state.pageLoadedAt) / 1000),
  };
  const base = state.file.name.replace(/\.[^.]+$/, '');
  const files = [
    { name: state.file.name, blob: state.file, kind: 'original' },
    { name: `${base}_oriented.stl`, blob: new Blob([toBinarySTL(state.oriented.positions)], { type: 'model/stl' }), kind: 'oriented' },
  ];

  const btn = $('submitBtn');
  btn.disabled = true;
  try {
    const id = await submitPrint({
      details, order, files,
      onStatus: (stage, i, n) => {
        status.textContent = stage === 'begin' ? 'Creating submission… · יוצר הגשה…'
          : stage === 'upload' ? `Uploading file ${i + 1} of ${n}… · מעלה קובץ ${i + 1} מתוך ${n}…`
            : 'Finishing… · מסיים…';
      },
    });
    status.textContent = '';
    $('doneId').textContent = id;
    $('doneIdHe').textContent = id;
    $('doneDialog').showModal();
  } catch (err) {
    status.className = 'submit-status error';
    status.textContent = err.message;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- formatting

function fmt(v, d) { return Number(v).toFixed(d); }
function fmtMoney(v) { return Number(v).toFixed(2); }
function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.max(0, Math.round(sec))}s`;
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

initProfiles();
initControls();
updateOrderSummary();
