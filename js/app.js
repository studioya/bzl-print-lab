// Page controller: files → objects on the plate, orientation, slicing,
// estimate and submission.

import { CONFIG } from './config.js';
import { PROCESSES, PRINTER } from './profiles-data.js';
import { PROFILE_INFO } from './profile-info.js';
import { FEATURES } from './slicer/features.js';
import { TRAVEL_INDEX } from './slicer/estimate.js';
import { loadModel, extensionOf, ACCEPTED_EXTENSIONS } from './loaders.js';
import { IDENTITY3, matMul, axisRotation, alignRotation, orientMesh, autoOrient, boundingSize, splitComponents } from './mesh.js';
import { arrangePlates, fitsPlate, footprint, hullsOverlap, clampToPlate, onPlate, findFreeSpot, PLATE } from './arrange.js';
import { buildProject3MF } from './export3mf.js';
import { Viewer } from './viewer.js';
import { submitPrint } from './submit.js';

const $ = (id) => document.getElementById(id);
const he = (text) => `<span class="he" lang="he" dir="rtl">${text}</span>`;

const state = {
  files: [],      // [{ id, file }] — originals to upload
  objects: [],    // see newObject()
  selected: null, // object key
  selectedPiece: null, // piece id
  plates: [],     // [[{ id, key, x, y }]] — every piece (copy) where the student put it
  plateIndex: 0,
  issues: new Map(), // piece id → 'overlap' | 'off' (off the plate)
  nextPiece: 1,
  profile: PROCESSES[1]?.name || PROCESSES[0].name,
  color: 'White',
  slice: null,    // worker result
  worker: null,
  sliceJob: 0,
  nextKey: 1,
  pageLoadedAt: Date.now(),
};

/** Stand-in used when WebGL is unavailable: every view call does nothing. */
class NullViewer {
  constructor() { this.onFacePick = null; this.zs = []; }
  setScene() {}
  setModelColor() {}
  frame() {}
  setMode() {}
  setFacePicking() {}
  setPreview() {}
  setPreviewLayers() {}
  setHiddenFeatures() {}
}

// The 3D view needs WebGL. If the browser can't provide it (hardware
// acceleration off, IT policy, remote desktop…), keep everything else working
// and explain why the view is empty.
let viewer;
try {
  viewer = new Viewer($('viewer'));
} catch (err) {
  console.error(err);
  viewer = new NullViewer();
  $('viewerError').hidden = false;
  state.noViewer = true;
  $('layFlat').dataset.unavailable = '1';
}
viewer.onSelect = (key, id) => { if (key) select(key, id); };
viewer.onMove = (id, x, y) => {
  const p = pieceById(id);
  if (!p) return;
  p.x = x; p.y = y;
  state.selectedPiece = id;
  state.selected = p.key;
  refresh();
};
viewer.clampDrag = (key, x, y) => clampToPlate(x, y, objectByKey(key).oriented.size);

function newObject(fileId, name, source, from = null) {
  const o = {
    key: `o${state.nextKey++}`,
    fileId,
    name,
    source,                         // Float32Array as loaded (file units)
    unitScale: from ? from.unitScale : 1,
    scale: from ? from.scale : 1,   // student's resize (uniform), on top of the file units
    R: from ? from.R.slice() : IDENTITY3.slice(),
    oriented: null,                 // { positions, size }
    fits: false,
    version: 0,
  };
  orient(o);
  return o;
}

function orient(o) {
  o.oriented = orientMesh(o.source, o.R, o.unitScale * o.scale);
  o.footprint = footprint(o.oriented.positions);
  o.fits = fitsPlate(o.oriented.size);
  o.version++;
  // Pieces keep their place; nudge them back onto the plate if they grew past an edge.
  for (const p of allPieces()) {
    if (p.key === o.key) Object.assign(p, clampToPlate(p.x, p.y, o.oriented.size));
  }
}

const objectByKey = (key) => state.objects.find((o) => o.key === key);
const selectedObject = () => objectByKey(state.selected);
const allPieces = () => state.plates.flat();
const pieceById = (id) => allPieces().find((p) => p.id === id);
const plateOf = (id) => state.plates.findIndex((pl) => pl.some((p) => p.id === id));
const copiesOf = (key) => allPieces().filter((p) => p.key === key).length;
const totalCopies = () => allPieces().length;
const MAX_PLATES = 36; // Bambu Studio's limit
function currentProcess() { return PROCESSES.find((p) => p.name === state.profile); }
function profileLabel(name) { return PROCESSES.find((p) => p.name === name)?.label || name; }

// ---------------------------------------------------------------- setup UI

function initProfiles() {
  // General-purpose profiles in the left column, functional ones on the right.
  const cols = { general: $('profilesGeneral'), functional: $('profilesFunctional') };
  PROCESSES.forEach((p, i) => {
    const info = PROFILE_INFO[p.name] || {};
    const spec = `${p.layerHeight} mm layers · ${Math.round(p.sparseInfillDensity * 100)}% infill · ${p.wallLoops} walls`;
    const label = document.createElement('label');
    label.className = 'profile';
    // Description in a tooltip: shown on hover (after a short delay), and on
    // focus/tap for keyboards and touch screens.
    label.innerHTML = `
      <input type="radio" name="profile" value="${p.name}" aria-describedby="profileTip${i}">
      <span class="p-name">${p.label}${info.he ? he(info.he) : ''}</span>
      <span class="p-tip" role="tooltip" id="profileTip${i}">
        <span class="p-spec">${spec}</span>
        ${info.descEn ? `<span class="p-desc">${info.descEn}${he(info.descHe || '')}</span>` : ''}
      </span>`;
    const input = label.querySelector('input');
    input.checked = p.name === state.profile;
    input.addEventListener('change', () => { state.profile = p.name; refresh(); });
    (cols[info.group] || cols.functional).appendChild(label);
  });
}

function initControls() {
  document.querySelectorAll('[data-max-mb]').forEach((el) => { el.textContent = CONFIG.maxFileMB; });
  document.querySelectorAll('[data-max-files]').forEach((el) => { el.textContent = CONFIG.maxFiles; });

  // File input + drag & drop (onto the drop zone or the 3D view).
  const dz = $('dropzone');
  $('fileInput').addEventListener('change', (e) => { handleFiles([...e.target.files]); e.target.value = ''; });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));
  const v = $('viewer');
  v.addEventListener('dragover', (e) => e.preventDefault());
  v.addEventListener('drop', (e) => { e.preventDefault(); handleFiles([...e.dataTransfer.files]); });

  $('objectList').addEventListener('click', onObjectListClick);
  $('objectList').addEventListener('change', (e) => {
    const li = e.target.closest('[data-key]');
    if (li && e.target.matches('input')) setCopies(li.dataset.key, e.target.value);
  });

  $('units').addEventListener('change', (e) => {
    const o = selectedObject();
    if (!o) return;
    o.unitScale = +e.target.value;
    orient(o);
    refresh({ reframe: true });
  });

  document.querySelectorAll('input[name=color]').forEach((r) => r.addEventListener('change', () => {
    state.color = r.value;
    viewer.setModelColor(state.color);
    updateOrderSummary();
  }));

  // Orientation tools act on the selected object.
  const rotateSelected = (R) => {
    const o = selectedObject();
    if (!o) return;
    o.R = R(o);
    orient(o);
    refresh();
  };
  document.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', () => {
    const [axis, deg] = b.dataset.rot.split(':');
    rotateSelected((o) => matMul(axisRotation(axis, +deg), o.R));
  }));
  $('resetOrient').addEventListener('click', () => rotateSelected(() => IDENTITY3.slice()));
  $('autoOrient').addEventListener('click', () => {
    const btn = $('autoOrient');
    btn.classList.add('active');
    setTimeout(() => {
      rotateSelected((o) => autoOrient(o.source, currentProcess().support.thresholdAngle || 30));
      btn.classList.remove('active');
    }, 30);
  });
  $('layFlat').addEventListener('click', () => {
    if (viewer.onFacePick) { cancelPick(); return; }
    showTab('prepare');
    $('layFlat').classList.add('active');
    $('pickHint').hidden = false;
    viewer.setFacePicking((key, normal) => {
      cancelPick();
      if (key) state.selected = key;
      rotateSelected((o) => matMul(alignRotation(normal, [0, 0, -1]), o.R));
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelPick();
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected && !e.target.closest('input, textarea, select')) {
      e.preventDefault();
      // Delete removes the selected piece (one copy); the last copy removes the object.
      if (state.selectedPiece) removePiece(state.selectedPiece); else removeObject(state.selected);
    }
  });

  // ✕ on error messages.
  document.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', () => { $(b.dataset.dismiss).hidden = true; }));
  $('submitStatusDismiss').addEventListener('click', () => setSubmitStatus(''));

  // Resize the selected object (uniformly) by percentage or to a size in mm.
  const setScale = (o, scale) => {
    scale = Math.min(10, Math.max(0.01, scale));
    if (!Number.isFinite(scale) || Math.abs(scale - o.scale) < 1e-9) { renderSelected(); return; }
    o.scale = scale;
    orient(o);
    refresh({ reframe: true });
  };
  $('scalePct').addEventListener('change', (e) => {
    const o = selectedObject();
    if (o) setScale(o, (+e.target.value || o.scale * 100) / 100);
  });
  for (const axis of ['x', 'y', 'z']) {
    $(`size${axis.toUpperCase()}`).addEventListener('change', (e) => {
      const o = selectedObject();
      const cur = o?.oriented.size[axis];
      if (o && cur > 0 && +e.target.value > 0) setScale(o, o.scale * (+e.target.value / cur));
      else renderSelected();
    });
  }
  $('fitToPlate').addEventListener('click', () => {
    const o = selectedObject();
    if (!o) return;
    const s = o.oriented.size;
    // Just inside the printable volume, rounded down to a whole 0.1 %.
    const k = Math.min(PLATE.width / s.x, PLATE.depth / s.y, PLATE.height / s.z) * 0.999;
    if (k < 1) setScale(o, Math.floor(o.scale * k * 1000) / 1000);
  });

  $('sliceBtn').addEventListener('click', startSlice);
  $('addPlate').addEventListener('click', addPlate);
  $('arrangePlate').addEventListener('click', arrangeCurrentPlate);
  $('arrangeAll').addEventListener('click', arrangeAllPlates);
  $('moveTo').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (v !== '' && state.selectedPiece) movePieceToPlate(state.selectedPiece, v === 'new' ? state.plates.length : +v);
  });
  $('tabPrepare').addEventListener('click', () => showTab('prepare'));
  $('tabPreview').addEventListener('click', () => showTab('preview'));
  $('layerRange').addEventListener('input', updateLayerView);
  $('singleLayer').addEventListener('change', updateLayerView);

  // Deadline can't be in the past.
  const today = new Date();
  $('fDeadline').min = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  $('form').addEventListener('submit', onSubmit);
  $('form').addEventListener('input', (e) => e.target.classList.remove('invalid'));
  $('doneClose').addEventListener('click', () => location.reload());
}

function cancelPick() {
  viewer.setFacePicking(null);
  $('layFlat').classList.remove('active');
  $('pickHint').hidden = true;
}

// ---------------------------------------------------------------- files & objects

async function handleFiles(files) {
  $('loadError').hidden = true;
  const errors = [];
  let added = 0;
  for (const file of files) {
    const ext = extensionOf(file.name);
    if (state.files.length >= CONFIG.maxFiles) {
      errors.push([`You can add up to ${CONFIG.maxFiles} files. Remove one to add another.`,
        `ניתן להוסיף עד ${CONFIG.maxFiles} קבצים. הסירו קובץ כדי להוסיף אחר.`]);
      break;
    }
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      errors.push([`${file.name}: unsupported file type. Please upload STL, OBJ or 3MF.`, `${file.name}: סוג קובץ לא נתמך. יש להעלות STL, OBJ או 3MF.`]);
      continue;
    }
    if (file.size > CONFIG.maxFileMB * 1024 * 1024) {
      errors.push([`${file.name} is larger than ${CONFIG.maxFileMB} MB. Export it with a coarser mesh and try again.`,
        `${file.name} גדול מ־${CONFIG.maxFileMB} MB. יש לייצא אותו ברזולוציה נמוכה יותר.`]);
      continue;
    }
    if (state.objects.length >= CONFIG.maxObjects) {
      errors.push([`The plate already has ${CONFIG.maxObjects} objects.`, `על המשטח כבר יש ${CONFIG.maxObjects} אובייקטים.`]);
      break;
    }
    try {
      const positions = await loadModel(await file.arrayBuffer(), file.name);
      const fileId = `f${state.nextKey++}`;
      state.files.push({ id: fileId, file });
      const o = newObject(fileId, file.name, positions);
      state.objects.push(o);
      const piece = placePiece(o.key);
      state.selected = o.key;
      state.selectedPiece = piece.id;
      added++;
    } catch (e) {
      console.error(e);
      errors.push([`Could not read ${file.name}: ${e.message}`, `לא ניתן לקרוא את ${file.name}.`]);
    }
  }
  if (errors.length) showLoadError(errors);
  if (added) {
    // Show the plate the last new piece went to.
    state.plateIndex = Math.max(0, plateOf(state.selectedPiece));
    refresh({ reframe: true });
  }
}

function showLoadError(list) {
  $('loadErrorMsg').innerHTML = list.map(([en, h]) => `<div>${en}${he(h)}</div>`).join('');
  $('loadError').hidden = false;
}

/** Status line under the Submit button; errors get a ✕ to dismiss them. */
function setSubmitStatus(html, isError = false) {
  $('submitStatusMsg').innerHTML = html;
  $('submitStatus').className = `submit-status${isError ? ' error' : ''}`;
  $('submitStatusDismiss').hidden = !isError || !html;
}

function removeObject(key, { render = true } = {}) {
  const i = state.objects.findIndex((o) => o.key === key);
  if (i < 0) return;
  const [o] = state.objects.splice(i, 1);
  state.plates = state.plates.map((pl) => pl.filter((p) => p.key !== key));
  // Drop the original file once none of its objects are left on the plate.
  if (!state.objects.some((x) => x.fileId === o.fileId)) state.files = state.files.filter((f) => f.id !== o.fileId);
  if (state.selected === key) select(state.objects[Math.min(i, state.objects.length - 1)]?.key ?? null, null, false);
  if (!state.objects.length) { state.plates = []; state.plateIndex = 0; }
  $('loadError').hidden = true;
  if (render) refresh({ reframe: true });
}

// ---------------------------------------------------------------- pieces & plates

const pieceGap = () => {
  const b = currentProcess().brim;
  return 2 * ((b?.width || 0) + (b?.objectGap || 0)) + 2;
};
const occupiedOn = (plate) => plate.map((p) => ({ x: p.x, y: p.y, size: objectByKey(p.key).oriented.size }));

/**
 * Puts a new piece (copy) of an object in a free spot, trying plate `prefer`
 * first, then the other plates, then a new plate.
 */
function placePiece(key, prefer = state.plateIndex) {
  const o = objectByKey(key);
  const piece = { id: state.nextPiece++, key, x: PLATE.width / 2, y: PLATE.depth / 2 };
  if (!state.plates.length) state.plates.push([]);
  prefer = Math.min(Math.max(0, prefer), state.plates.length - 1);
  if (o.fits) {
    const order = [prefer, ...state.plates.keys()].filter((v, i, a) => a.indexOf(v) === i);
    for (const i of order) {
      const spot = findFreeSpot(o.oriented.size, occupiedOn(state.plates[i]), pieceGap());
      if (spot) { Object.assign(piece, spot); state.plates[i].push(piece); return piece; }
    }
    if (state.plates.length < MAX_PLATES) { state.plates.push([piece]); return piece; }
  }
  state.plates[prefer].push(piece); // too big, or no room anywhere: shown in red
  return piece;
}

function removePiece(id) {
  const p = pieceById(id);
  if (!p) return;
  if (copiesOf(p.key) <= 1) return removeObject(p.key);
  state.plates = state.plates.map((pl) => pl.filter((q) => q.id !== id));
  if (state.selectedPiece === id) state.selectedPiece = null;
  refresh();
}

function addPlate() {
  if (state.plates.length >= MAX_PLATES) return;
  state.plates.push([]);
  state.plateIndex = state.plates.length - 1;
  refresh({ reframe: true });
}

function deletePlate(i) {
  const pieces = state.plates[i];
  if (!pieces) return;
  if (pieces.length && !confirm(`Delete plate ${i + 1} and the ${pieces.length} piece(s) on it?\nלמחוק את משטח ${i + 1} ואת החלקים שעליו?`)) return;
  state.plates.splice(i, 1);
  // Objects with no pieces left are removed too.
  for (const key of new Set(pieces.map((p) => p.key))) if (!copiesOf(key)) removeObject(key, { render: false });
  if (!state.plates.length && state.objects.length) state.plates.push([]);
  state.plateIndex = Math.min(state.plateIndex >= i ? Math.max(0, state.plateIndex - 1) : state.plateIndex, Math.max(0, state.plates.length - 1));
  refresh({ reframe: true });
}

function movePieceToPlate(id, target) {
  const from = plateOf(id);
  if (from < 0 || target === from) return;
  if (target >= state.plates.length) {
    if (state.plates.length >= MAX_PLATES) return;
    state.plates.push([]);
    target = state.plates.length - 1;
  }
  const [piece] = state.plates[from].splice(state.plates[from].findIndex((p) => p.id === id), 1);
  const o = objectByKey(piece.key);
  const spot = o.fits && findFreeSpot(o.oriented.size, occupiedOn(state.plates[target]), pieceGap());
  Object.assign(piece, spot || { x: PLATE.width / 2, y: PLATE.depth / 2 });
  state.plates[target].push(piece);
  state.plateIndex = target;
  refresh({ reframe: true });
}

/** Packs pieces automatically. Pieces that don't fit on `plates[i]` go onto new plates after it. */
function arrangePieces(pieces) {
  const fit = pieces.filter((p) => objectByKey(p.key).fits);
  const packed = fit.length
    ? arrangePlates(fit.map((p) => ({ key: p.id, size: objectByKey(p.key).oriented.size, count: 1 })), currentProcess().brim)
    : [[]];
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const out = packed.map((pl) => pl.map((q) => Object.assign(byId.get(q.key), { x: q.x, y: q.y })));
  for (const p of pieces) if (!objectByKey(p.key).fits) out[0].push(Object.assign(p, { x: PLATE.width / 2, y: PLATE.depth / 2 }));
  return out;
}

function arrangeCurrentPlate() {
  const i = state.plateIndex;
  if (!state.plates[i]?.length) return;
  const out = arrangePieces(state.plates[i]);
  state.plates.splice(i, 1, ...out.slice(0, MAX_PLATES - state.plates.length + 1));
  refresh({ reframe: true });
}

function arrangeAllPlates() {
  if (!allPieces().length) return;
  state.plates = arrangePieces(allPieces()).slice(0, MAX_PLATES);
  state.plateIndex = Math.min(state.plateIndex, state.plates.length - 1);
  refresh({ reframe: true });
}

/** Finds pieces that overlap another piece or stick out of the plate. */
function findIssues() {
  const issues = new Map();
  for (const plate of state.plates) {
    plate.forEach((p, i) => {
      const o = objectByKey(p.key);
      if (!o.fits) return;
      if (!onPlate(p.x, p.y, o.oriented.size)) issues.set(p.id, 'off');
      for (let j = i + 1; j < plate.length; j++) {
        const q = plate[j], oq = objectByKey(q.key);
        if (!oq.fits) continue;
        const sa = o.oriented.size, sb = oq.oriented.size;
        if (Math.abs(p.x - q.x) * 2 >= sa.x + sb.x || Math.abs(p.y - q.y) * 2 >= sa.y + sb.y) continue;
        if (hullsOverlap(o.footprint, p.x, p.y, oq.footprint, q.x, q.y)) {
          if (!issues.has(p.id)) issues.set(p.id, 'overlap');
          if (!issues.has(q.id)) issues.set(q.id, 'overlap');
        }
      }
    });
  }
  return issues;
}

function splitObject(key) {
  const o = objectByKey(key);
  if (!o) return;
  const parts = splitComponents(o.source);
  if (parts.length < 2) {
    showLoadError([[`${o.name} is a single connected part, so there is nothing to split.`, `${o.name} הוא חלק אחד רציף, אין מה לפצל.`]]);
    return;
  }
  if (state.objects.length - 1 + parts.length > CONFIG.maxObjects) {
    showLoadError([[`Splitting ${o.name} would make ${parts.length} parts, more than the ${CONFIG.maxObjects}-object limit.`,
      `פיצול ${o.name} ייצור ${parts.length} חלקים, יותר מהמגבלה של ${CONFIG.maxObjects} אובייקטים.`]]);
    return;
  }
  $('loadError').hidden = true;
  const created = parts.map((positions, k) => newObject(o.fileId, `${o.name} – part ${k + 1}`, positions, o));
  // Each copy of the object becomes a set of parts on the same plate.
  const plates = allPieces().filter((p) => p.key === key).map((p) => plateOf(p.id));
  state.plates = state.plates.map((pl) => pl.filter((p) => p.key !== key));
  state.objects.splice(state.objects.indexOf(o), 1, ...created);
  for (const plate of plates) for (const c of created) placePiece(c.key, plate);
  state.selected = created[0].key;
  state.selectedPiece = allPieces().find((p) => p.key === created[0].key)?.id ?? null;
  refresh({ reframe: true });
}

function setCopies(key, n) {
  const o = objectByKey(key);
  if (!o) return;
  n = Math.max(1, Math.min(CONFIG.maxCopies, Math.round(+n || 1)));
  const have = copiesOf(key);
  if (n === have) { renderObjectList(); return; }
  if (n > have) {
    // New copies go next to the existing ones when there's room.
    const mine = allPieces().filter((p) => p.key === key);
    const prefer = plateOf(mine.at(-1)?.id);
    for (let k = have; k < n; k++) placePiece(key, prefer >= 0 ? prefer : state.plateIndex);
  } else {
    // Remove the most recently added copies.
    let drop = have - n;
    for (let i = state.plates.length - 1; i >= 0 && drop; i--) {
      for (let j = state.plates[i].length - 1; j >= 0 && drop; j--) {
        if (state.plates[i][j].key === key) { state.plates[i].splice(j, 1); drop--; }
      }
    }
  }
  refresh();
}

/** Selects an object, and one of its pieces (the given one, or one on the plate shown). */
function select(key, pieceId = null, render = true) {
  state.selected = key;
  if (key) {
    const mine = allPieces().filter((p) => p.key === key);
    const piece = mine.find((p) => p.id === pieceId)
      || mine.find((p) => p.id === state.selectedPiece)
      || mine.find((p) => plateOf(p.id) === state.plateIndex)
      || mine[0];
    state.selectedPiece = piece?.id ?? null;
  } else state.selectedPiece = null;
  if (!render) return;
  // Show the plate the piece is on.
  const plate = plateOf(state.selectedPiece);
  if (plate >= 0 && plate !== state.plateIndex) {
    state.plateIndex = plate;
    renderPlateTabs();
    if (state.slice) showPlatePreview();
    frameCurrentPlate();
  }
  // Re-rendering the list would steal focus from a copies box being edited.
  document.querySelectorAll('#objectList .obj').forEach((li) => li.classList.toggle('selected', li.dataset.key === key));
  renderSelected();
  renderPieceTools();
  renderScene();
}

function onObjectListClick(e) {
  const li = e.target.closest('[data-key]');
  if (!li) return;
  const key = li.dataset.key;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'remove') return removeObject(key);
  select(key); // any other click on a row (copies, split, name) selects it
  if (act === 'split') return splitObject(key);
  if (act === 'inc' || act === 'dec') return setCopies(key, copiesOf(key) + (act === 'inc' ? 1 : -1));
}

// ---------------------------------------------------------------- rendering the plate

function refresh({ reframe = false } = {}) {
  state.plateIndex = Math.min(state.plateIndex, Math.max(0, state.plates.length - 1));
  if (state.selectedPiece && !pieceById(state.selectedPiece)) state.selectedPiece = null;
  state.issues = findIssues();
  $('emptyState').hidden = state.objects.length > 0 || !!state.noViewer;
  $('dropzone').classList.toggle('compact', state.objects.length > 0);
  invalidateSlice();
  renderObjectList();
  renderSelected();
  renderFitStatus();
  renderPlateTabs();
  renderPieceTools();
  showTab('prepare');
  renderScene();
  if (reframe) frameCurrentPlate();
  updateOrderSummary();
}

function currentPlacements() {
  return (state.plates[state.plateIndex] || []).map((p) => ({ ...p, bad: state.issues.has(p.id) }));
}

function renderScene() {
  viewer.setScene(
    state.objects.map((o) => ({ key: o.key, positions: o.oriented.positions, version: o.version, fits: o.fits })),
    currentPlacements(),
    state.selectedPiece,
  );
  viewer.setModelColor(state.color);
}

function frameCurrentPlate() {
  const placements = currentPlacements();
  if (!placements.length) { viewer.frame(0, PLATE.width, 0, PLATE.depth, 20); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = 0;
  for (const p of placements) {
    const s = objectByKey(p.key).oriented.size;
    minX = Math.min(minX, p.x - s.x / 2); maxX = Math.max(maxX, p.x + s.x / 2);
    minY = Math.min(minY, p.y - s.y / 2); maxY = Math.max(maxY, p.y + s.y / 2);
    maxZ = Math.max(maxZ, s.z);
  }
  viewer.frame(minX, maxX, minY, maxY, maxZ);
}

function renderObjectList() {
  const ul = $('objectList');
  if (!state.objects.length) { ul.innerHTML = ''; return; }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  ul.innerHTML = `<li class="obj-head"><span>Objects ${he('אובייקטים')}</span><span>Copies ${he('עותקים')}</span></li>` +
    state.objects.map((o) => {
      const s = o.oriented.size;
      return `<li class="obj${o.key === state.selected ? ' selected' : ''}${o.fits ? '' : ' bad'}" data-key="${o.key}">
        <span class="obj-name" title="${esc(o.name)}">${esc(o.name)}</span>
        <span class="obj-meta">${fmt(s.x, 1)} × ${fmt(s.y, 1)} × ${fmt(s.z, 1)} mm${o.fits ? '' : ` · <span class="bad-note">Too big · גדול מדי</span>`}</span>
        <div class="obj-actions">
          <div class="stepper">
            <button type="button" data-act="dec" aria-label="Fewer copies">−</button>
            <input type="number" min="1" max="${CONFIG.maxCopies}" value="${copiesOf(o.key)}" inputmode="numeric" aria-label="Copies of ${esc(o.name)}">
            <button type="button" data-act="inc" aria-label="More copies">+</button>
          </div>
          <button type="button" class="icon-btn" data-act="split" title="Split into separate parts · פיצול לחלקים">Split</button>
          <button type="button" class="icon-btn danger" data-act="remove" title="Remove from plate · הסרה מהמשטח" aria-label="Remove ${esc(o.name)}">✕</button>
        </div>
      </li>`;
    }).join('');
}

function renderSelected() {
  const o = selectedObject();
  document.querySelectorAll('.orient-tools .tool').forEach((b) => { b.disabled = !o || !!b.dataset.unavailable; });
  $('selectedPanel').hidden = !o;
  $('sizeTools').hidden = !o;
  if (o) {
    $('scalePct').value = +(o.scale * 100).toFixed(1);
    $('sizeX').value = o.oriented.size.x.toFixed(1);
    $('sizeY').value = o.oriented.size.y.toFixed(1);
    $('sizeZ').value = o.oriented.size.z.toFixed(1);
    $('fitToPlate').hidden = o.fits;
  }
  const target = $('orientTarget');
  if (!o) {
    target.innerHTML = `Select an object to orient it.${he('בחרו אובייקט כדי לכוון אותו.')}`;
    return;
  }
  target.innerHTML = `Orienting: <b></b>${he('מכוונים את האובייקט הנבחר')}`;
  target.querySelector('b').textContent = o.name;
  $('units').value = String(o.unitScale);
  const s = boundingSize(o.source);
  const max = Math.max(s.x, s.y, s.z);
  const hint = $('unitsHint');
  hint.hidden = !(max > 0 && max < 4 && o.unitScale === 1);
  if (!hint.hidden) {
    hint.innerHTML = `This model is only ${fmt(max, 2)} mm across. Was it exported in cm, inches or metres? Choose the file units above.
      ${he(`המודל בגודל ${fmt(max, 2)} מ״מ בלבד. האם יוצא בס״מ, באינצ׳ים או במטרים? בחרו את יחידות הקובץ למעלה.`)}`;
  }
}

function renderFitStatus() {
  const fit = $('fitStatus');
  fit.hidden = !state.objects.length;
  if (!state.objects.length) return;
  const bad = state.objects.filter((o) => !o.fits);
  if (bad.length) {
    fit.className = 'fit bad';
    fit.innerHTML = `Too big for the printer: ${bad.map((o) => `<b>${o.name.replace(/</g, '&lt;')}</b>`).join(', ')}. The maximum is ${PLATE.width} × ${PLATE.depth} × ${PLATE.height} mm. Select it and use <b>Scale to fit the plate</b>, or rotate, split or remove it. Objects that don't fit can't be submitted.
      ${he(`גדול מדי למדפסת. הגודל המרבי הוא ${PLATE.width} × ${PLATE.depth} × ${PLATE.height} מ״מ. בחרו אותו והשתמשו ב״הקטנה כך שייכנס למשטח״, או סובבו, פצלו או הסירו אותו.`)}`;
    return;
  }
  if (state.issues.size) {
    const plates = [...new Set([...state.issues.keys()].map((id) => plateOf(id) + 1))].sort((a, b) => a - b);
    const off = [...state.issues.values()].includes('off');
    fit.className = 'fit bad';
    fit.innerHTML = `${state.issues.size} piece${state.issues.size > 1 ? 's' : ''} (in red) ${off ? 'overlap or stick out of the plate' : 'overlap'} on plate ${plates.join(', ')}. Drag them apart, move one to another plate, or press <b>Arrange</b>.
      ${he(`${state.issues.size} חלקים (באדום) ${off ? 'חופפים או בולטים מהמשטח' : 'חופפים'} במשטח ${plates.join(', ')}. גררו אותם, העבירו למשטח אחר או לחצו ״סידור״.`)}`;
    return;
  }
  const n = state.objects.length, c = totalCopies(), p = state.plates.filter((pl) => pl.length).length;
  fit.className = 'fit ok';
  fit.innerHTML = `Everything fits: ${n} object${n > 1 ? 's' : ''}, ${c} piece${c > 1 ? 's' : ''} in total, on ${p} plate${p > 1 ? 's' : ''}.
    ${he(`הכול נכנס: ${n} אובייקטים, ${c} חלקים בסך הכול, על ${p} ${p > 1 ? 'משטחים' : 'משטח'}.`)}`;
}

function renderPlateTabs() {
  const box = $('plateTabs');
  box.innerHTML = '';
  $('plateBar').hidden = !state.objects.length;
  if (!state.objects.length) return;
  state.plates.forEach((pl, i) => {
    const tab = document.createElement('span');
    const bad = pl.some((p) => state.issues.has(p.id));
    tab.className = `plate-tab${i === state.plateIndex ? ' active' : ''}${bad ? ' bad' : ''}`;
    tab.innerHTML = `<button type="button" class="plate-pick" title="Show plate ${i + 1}">Plate ${i + 1} <span class="plate-count">${pl.length}</span></button>`
      + (state.plates.length > 1 ? `<button type="button" class="plate-del" title="Delete plate ${i + 1} · מחיקת המשטח" aria-label="Delete plate ${i + 1}">✕</button>` : '');
    tab.querySelector('.plate-pick').addEventListener('click', () => showPlate(i));
    tab.querySelector('.plate-del')?.addEventListener('click', () => deletePlate(i));
    box.appendChild(tab);
  });
  $('addPlate').disabled = state.plates.length >= MAX_PLATES;
}

function showPlate(i) {
  state.plateIndex = i;
  const p = state.plates[i]?.find((q) => q.key === state.selected);
  if (p) state.selectedPiece = p.id;
  renderPlateTabs();
  renderPieceTools();
  renderScene();
  if (state.slice) showPlatePreview();
  frameCurrentPlate();
}

/** "Move to plate" for the selected piece, and the arrange buttons. */
function renderPieceTools() {
  const id = state.selectedPiece, from = plateOf(id);
  const sel = $('moveTo');
  const ok = from >= 0;
  sel.disabled = !ok;
  sel.innerHTML = `<option value="">Move piece to… · העברה ל…</option>`
    + state.plates.map((_, i) => `<option value="${i}"${i === from ? ' disabled' : ''}>Plate ${i + 1}</option>`).join('')
    + (state.plates.length < MAX_PLATES ? `<option value="new">New plate · משטח חדש</option>` : '');
  $('arrangePlate').disabled = !state.plates[state.plateIndex]?.length;
  $('arrangeAll').disabled = !allPieces().length;
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
  $('sliceBtn').disabled = !canSlice();
  updateSubmitState();
}

const canSlice = () => state.objects.length > 0 && state.objects.every((o) => o.fits) && !state.issues.size;

/** Drops plates with nothing on them (before slicing, so plates match the estimate). */
function pruneEmptyPlates() {
  const cur = state.plates[state.plateIndex];
  const kept = state.plates.filter((pl) => pl.length);
  if (kept.length === state.plates.length) return false;
  state.plates = kept;
  state.plateIndex = Math.max(0, kept.indexOf(cur));
  return true;
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
  if (!canSlice()) return;
  if (pruneEmptyPlates()) { renderPlateTabs(); renderPieceTools(); renderScene(); }
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

  const fail = (en, h) => {
    state.worker?.terminate();
    state.worker = null;
    state.sliceJob = 0;
    $('sliceProgress').hidden = true;
    $('sliceBtn').disabled = false;
    showLoadError([[en, h]]);
  };
  state.worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.id !== job || state.sliceJob !== job) return;
    if (msg.type === 'progress') {
      $('sliceBar').style.width = `${Math.round(msg.fraction * 100)}%`;
      const [en, h] = STAGE_LABEL[msg.stage] || [msg.stage, ''];
      $('sliceLabel').textContent = `${en} · ${h}`;
    } else if (msg.type === 'done') {
      state.worker.terminate();
      state.worker = null;
      state.sliceJob = 0;
      onSliced(msg.result);
    } else if (msg.type === 'error') {
      console.error(msg.stack || msg.message);
      fail(`Slicing failed: ${msg.message}`, 'החיתוך נכשל. נסו כיוון אחר או קובץ אחר.');
    }
  };
  state.worker.onerror = (e) => {
    console.error(e);
    fail('Slicing failed in this browser. Try an up-to-date Chrome, Edge, Firefox or Safari.', 'החיתוך נכשל בדפדפן זה.');
  };
  state.worker.postMessage({
    id: job,
    objects: state.objects.map((o) => ({ key: o.key, positions: o.oriented.positions })),
    processName: proc.name,
    filamentName: info.filament || 'Generic PLA - Bezalel Modelling Center',
    plates: state.plates.map((pl) => pl.map(({ key, x, y }) => ({ key, x, y }))),
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

  $('sliceProgress').hidden = true;
  $('sliceBtn').disabled = false;
  $('tabPreview').disabled = false;
  renderEstimate();
  showTab('preview');
  showPlatePreview();
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
  const rows = [
    ['Profile', 'פרופיל', profileLabel(r.processName)],
    ['Objects', 'אובייקטים', `${state.objects.length}`],
    ['Pieces', 'חלקים', `${totalCopies()}`],
    ['Plates', 'משטחים', `${r.plates.length}`],
    ['Filament', 'חומר', `${fmt(r.grams, 1)} g · ${fmt(r.meters, 2)} m`],
    ['Layers', 'שכבות', `${r.layers}`],
    ['Supports', 'תמיכות', r.hasSupport ? 'Yes · כן' : 'No · לא'],
  ];
  if (r.plates.length > 1) {
    r.plates.forEach((p, i) => rows.push([`Plate ${i + 1}`, `משטח ${i + 1}`, `${fmtDuration(p.seconds)} · ${p.items.length} pcs`]));
  }
  $('estFacts').innerHTML = rows.map(([en, h, v]) => `<div class="fact"><span class="fact-label">${en}${he(h)}</span><b>${v}</b></div>`).join('');
}

function showPlatePreview() {
  const r = state.slice;
  const plate = r.plates[state.plateIndex];
  viewer.setPreview(r.previews, plate.items);
  const range = $('layerRange');
  range.max = plate.layers - 1;
  range.value = plate.layers - 1;
  updateLayerView();
  renderLegend(plate);
}

function updateLayerView() {
  if (!state.slice) return;
  const top = +$('layerRange').value;
  viewer.setPreviewLayers($('singleLayer').checked ? top : 0, top);
  $('layerLabel').innerHTML = `${top + 1}<br>${fmt(viewer.zs[top] ?? 0, 2)}`;
}

function renderLegend(plate) {
  const total = plate.seconds;
  const rows = FEATURES.map((f) => ({ ...f, s: plate.byFeature[f.id] })).filter((f) => f.s > 0.5);
  const travel = plate.byFeature[TRAVEL_INDEX];
  const hidden = new Set();
  const legend = $('legend');
  legend.innerHTML = `<button type="button" class="legend-title" aria-expanded="true">Line type · time ${he('סוג קו · זמן')}</button>
    <table>${rows.map((f) => `<tr>
      <td><label><input type="checkbox" checked data-feature="${f.id}"><span class="sw" style="background:${f.color}"></span>${f.en}${he(f.he)}</label></td>
      <td class="num-col">${fmtDuration(f.s)}</td><td class="num-col">${Math.round((f.s / total) * 100)}%</td></tr>`).join('')}
      <tr><td><label><span class="sw" style="background:#9aa3ab"></span>Travel${he('תנועה')}</label></td>
      <td class="num-col">${fmtDuration(travel)}</td><td class="num-col">${Math.round((travel / total) * 100)}%</td></tr>
    </table>`;
  legend.querySelectorAll('input[data-feature]').forEach((cb) => cb.addEventListener('change', () => {
    const id = +cb.dataset.feature;
    if (cb.checked) hidden.delete(id); else hidden.add(id);
    viewer.setHiddenFeatures([...hidden]);
  }));
  viewer.setHiddenFeatures([]);
  // Collapsible; starts collapsed when the 3D view is narrow so the legend doesn't cover it.
  const toggle = legend.querySelector('.legend-title');
  const setCollapsed = (c) => { legend.classList.toggle('collapsed', c); toggle.setAttribute('aria-expanded', String(!c)); };
  toggle.addEventListener('click', () => setCollapsed(!legend.classList.contains('collapsed')));
  setCollapsed(state.legendCollapsed ?? $('viewer').clientWidth < 640);
  toggle.addEventListener('click', () => { state.legendCollapsed = legend.classList.contains('collapsed'); });
}

function showTab(tab) {
  const preview = tab === 'preview' && !!state.slice;
  $('tabPrepare').classList.toggle('active', !preview);
  $('tabPreview').classList.toggle('active', preview);
  $('tabPrepare').setAttribute('aria-selected', String(!preview));
  $('tabPreview').setAttribute('aria-selected', String(preview));
  viewer.setMode(preview ? 'preview' : 'model');
  $('layerSlider').hidden = !preview || !!state.noViewer;
  $('legend').hidden = !preview;
}

// ---------------------------------------------------------------- submission

function updateOrderSummary() {
  const n = state.objects.length, c = totalCopies();
  const parts = n ? [`${n} object${n > 1 ? 's' : ''}`, `${c} piece${c > 1 ? 's' : ''}`] : ['No models yet'];
  parts.push(profileLabel(state.profile), state.color);
  if (state.slice) parts.push(`${fmtDuration(state.slice.totalSeconds)} · ${CONFIG.currency}${fmtMoney(state.slice.cost)}`);
  $('orderSummary').textContent = parts.join(' · ');
}

function updateSubmitState() {
  const ready = !!(canSlice() && state.slice);
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

/** Bambu Studio project: every piece where the student placed it, plate by plate, with the chosen profile. */
async function buildPlatesFile(processName) {
  const { PROJECT_PRESETS } = await import('./project-presets.js');
  const index = new Map(state.objects.map((o, i) => [o.key, i]));
  return buildProject3MF(
    state.objects.map((o) => ({ name: o.name, positions: o.oriented.positions })),
    state.plates.map((pl) => pl.map((p) => ({ object: index.get(p.key), x: p.x, y: p.y }))),
    PROJECT_PRESETS,
    {
      processName,
      filamentName: PROFILE_INFO[processName]?.filament || 'Generic PLA - Bezalel Modelling Center',
      color: state.color === 'Black' ? '#000000' : '#FFFFFF',
      printableArea: PRINTER.printableArea,
      title: 'Student plates',
    },
  );
}

/** Per plate: "name ×n" for each object on it. */
function plateLayout() {
  return state.plates.filter((pl) => pl.length).map((pl) => {
    const counts = new Map();
    for (const p of pl) counts.set(p.key, (counts.get(p.key) || 0) + 1);
    return [...counts].map(([key, n]) => `${objectByKey(key).name} ×${n}`);
  });
}

async function onSubmit(e) {
  e.preventDefault();
  setSubmitStatus('');
  if (!state.slice) return;
  if (!validateForm()) {
    setSubmitStatus(`Please fill in the highlighted fields. ${he('נא למלא את השדות המסומנים.')}`, true);
    return;
  }
  const r = state.slice;
  const fileName = (id) => state.files.find((f) => f.id === id)?.file.name || '';
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
    files: state.files.map((f) => f.file.name),
    objects: state.objects.map((o) => ({
      name: o.name,
      file: fileName(o.fileId),
      copies: copiesOf(o.key),
      sizeMm: `${fmt(o.oriented.size.x, 1)} × ${fmt(o.oriented.size.y, 1)} × ${fmt(o.oriented.size.z, 1)}`,
      unitScale: o.unitScale,
      scalePercent: +(o.scale * 100).toFixed(1),
      rotation: o.R.map((v) => Math.round(v * 1e6) / 1e6),
    })),
    profile: r.processName,
    profileLabel: profileLabel(r.processName),
    color: state.color,
    copies: totalCopies(),
    plates: r.plates.length,
    plateLayout: plateLayout(),
    estimatedMinutes: r.totalMinutes,
    estimatedCost: r.cost,
    pricePerMinute: CONFIG.pricePerMinute,
    filamentGrams: Math.round(r.grams * 10) / 10,
    layers: r.layers,
    supports: r.hasSupport,
    secondsOnPage: Math.round((Date.now() - state.pageLoadedAt) / 1000),
  };

  const btn = $('submitBtn');
  btn.disabled = true;
  try {
    setSubmitStatus('Preparing files… · מכין קבצים…');
    const plate3mf = await buildPlatesFile(r.processName);
    if (plate3mf.size > CONFIG.maxFileMB * 1024 * 1024) {
      throw new Error(`The models together are too detailed to upload (over ${CONFIG.maxFileMB} MB). Remove an object or export coarser meshes.`);
    }
    const files = [
      ...state.files.map((f) => ({ name: f.file.name, blob: f.file, kind: 'original' })),
      { name: 'plates.3mf', blob: plate3mf, kind: 'plates' },
    ];
    const id = await submitPrint({
      details, order, files,
      onStatus: (stage, i, n) => {
        setSubmitStatus(stage === 'begin' ? 'Creating submission… · יוצר הגשה…'
          : stage === 'upload' ? `Uploading file ${i + 1} of ${n}… · מעלה קובץ ${i + 1} מתוך ${n}…`
            : 'Finishing… · מסיים…');
      },
    });
    setSubmitStatus('');
    $('doneId').textContent = id;
    $('doneIdHe').textContent = id;
    $('doneDialog').showModal();
  } catch (err) {
    setSubmitStatus(escapeHtml(err.message), true);
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- formatting

function fmt(v, d) { return Number(v).toFixed(d); }
function escapeHtml(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtMoney(v) { return Number(v).toFixed(2); }
function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return `${Math.max(0, Math.round(sec))}s`;
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

initProfiles();
initControls();
renderSelected();
updateOrderSummary();
if (state.noViewer) $('emptyState').hidden = true;
window.__printLabReady = true;
