// Module Web Worker: slices an oriented mesh and estimates every plate.
//
// in:  { id, positions: Float32Array, processName, filamentName, plates: [[[cx,cy],...],...] }
// out: { id, type: 'progress', stage, fraction }
//      { id, type: 'done', result } | { id, type: 'error', message }

import { PROCESSES, FILAMENTS, PRINTER } from '../profiles-data.js';
import { sliceObject } from './pipeline.js';
import { estimatePlate } from './estimate.js';
import { buildPreview } from './preview.js';

const STAGES = { slice: [0, 0.3], walls: [0.3, 0.45], shells: [0.45, 0.6], support: [0.6, 0.75], paths: [0.75, 0.9] };

self.onmessage = (e) => {
  const { id, positions, processName, filamentName, plates } = e.data;
  try {
    const proc = PROCESSES.find((p) => p.name === processName);
    const filament = FILAMENTS[filamentName];
    if (!proc || !filament) throw new Error(`Unknown profile ${processName} / ${filamentName}`);

    let lastPost = 0;
    const progress = (stage, f) => {
      const [a, b] = STAGES[stage] || [0, 1];
      const now = Date.now();
      if (now - lastPost < 80 && f < 1) return;
      lastPost = now;
      self.postMessage({ id, type: 'progress', stage, fraction: a + (b - a) * Math.min(1, f) });
    };

    const obj = sliceObject(positions, proc, progress);

    // Estimate each distinct plate layout once (full plates share a layout).
    self.postMessage({ id, type: 'progress', stage: 'estimate', fraction: 0.92 });
    const cache = new Map();
    const plateResults = plates.map((copies) => {
      const key = JSON.stringify(copies);
      if (!cache.has(key)) cache.set(key, estimatePlate(obj, copies, proc, filament, PRINTER));
      return { copies, ...cache.get(key) };
    });

    const preview = buildPreview(obj);
    const result = {
      processName,
      layers: obj.layers.length,
      height: obj.height,
      hasSupport: obj.hasSupport,
      plates: plateResults,
      preview,
    };
    self.postMessage({ id, type: 'done', result }, [preview.data.buffer, preview.layerStart.buffer, preview.zs.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err), stack: err?.stack });
  }
};
