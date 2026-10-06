// Module Web Worker: slices each object once, then estimates every plate.
//
// in:  { id, objects: [{ key, positions: Float32Array }], processName, filamentName,
//        plates: [[{ key, x, y }, ...], ...] }
// out: { id, type: 'progress', stage, fraction }
//      { id, type: 'done', result } | { id, type: 'error', message }

import { PROCESSES, FILAMENTS, PRINTER } from '../profiles-data.js';
import { sliceObject } from './pipeline.js';
import { estimatePlate } from './estimate.js';
import { buildPreview } from './preview.js';

const STAGES = { slice: [0, 0.3], walls: [0.3, 0.45], shells: [0.45, 0.6], support: [0.6, 0.75], paths: [0.75, 1] };

self.onmessage = (e) => {
  const { id, objects, processName, filamentName, plates } = e.data;
  try {
    const proc = PROCESSES.find((p) => p.name === processName);
    const filament = FILAMENTS[filamentName];
    if (!proc || !filament) throw new Error(`Unknown profile ${processName} / ${filamentName}`);

    // Slicing takes 90% of the bar, shared between objects by triangle count.
    const totalTris = objects.reduce((s, o) => s + o.positions.length, 0) || 1;
    let done = 0;
    let lastPost = 0;
    const sliced = new Map();
    const previews = {};
    for (const o of objects) {
      const share = o.positions.length / totalTris;
      const progress = (stage, f) => {
        const [a, b] = STAGES[stage] || [0, 1];
        const now = Date.now();
        if (now - lastPost < 80 && f < 1) return;
        lastPost = now;
        const within = a + (b - a) * Math.min(1, f);
        self.postMessage({ id, type: 'progress', stage, fraction: 0.9 * (done + share * within) });
      };
      const obj = sliceObject(o.positions, proc, progress);
      sliced.set(o.key, obj);
      previews[o.key] = buildPreview(obj);
      done += share;
    }

    // Estimate each distinct plate layout once.
    self.postMessage({ id, type: 'progress', stage: 'estimate', fraction: 0.92 });
    const cache = new Map();
    const plateResults = plates.map((items) => {
      const k = JSON.stringify(items);
      if (!cache.has(k)) {
        cache.set(k, estimatePlate(items.map((it) => ({ obj: sliced.get(it.key), x: it.x, y: it.y })), proc, filament, PRINTER));
      }
      return { items, ...cache.get(k) };
    });

    const objectsInfo = {};
    for (const [key, obj] of sliced) objectsInfo[key] = { layers: obj.layers.length, hasSupport: obj.hasSupport };
    const result = {
      processName,
      layers: Math.max(...[...sliced.values()].map((o) => o.layers.length)),
      hasSupport: [...sliced.values()].some((o) => o.hasSupport),
      objects: objectsInfo,
      plates: plateResults,
      previews,
    };
    const transfer = [];
    for (const pv of Object.values(previews)) transfer.push(pv.data.buffer, pv.layerStart.buffer, pv.zs.buffer);
    self.postMessage({ id, type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err), stack: err?.stack });
  }
};
