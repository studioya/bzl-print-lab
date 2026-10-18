// STEP (.step / .stp) import: OpenCascade compiled to WebAssembly
// (vendor/occt, occt-import-js) turns the CAD geometry into triangles, in mm.
// The 7.6 MB WebAssembly file is only downloaded when someone adds a STEP file.
// In the page this runs inside js/step-worker.js so big files don't freeze it.

import occtFactory from '../vendor/occt/occt-import-js.esm.js';

/** Tessellation: at most 0.01 mm off the true surface and 0.1 rad (≈6°) between facets. */
export const STEP_PARAMS = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'absolute_value',
  linearDeflection: 0.01,
  angularDeflection: 0.1,
};

let occtPromise = null;
function occt() {
  occtPromise ||= occtFactory({
    locateFile: (file) => {
      const url = new URL(`../vendor/occt/${file}`, import.meta.url);
      // Node (tests) reads the .wasm from disk; browsers fetch it.
      return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : url.href;
    },
  });
  return occtPromise;
}

/** All meshes of an occt-import-js result as one triangle soup (Float32Array, mm). */
export function stepResultToTriangles(result) {
  let count = 0;
  for (const m of result.meshes || []) count += m.index?.array.length || 0;
  const out = new Float32Array(count * 3);
  let o = 0;
  for (const m of result.meshes || []) {
    const pos = m.attributes.position.array;
    const idx = m.index.array;
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i] * 3;
      out[o++] = pos[v]; out[o++] = pos[v + 1]; out[o++] = pos[v + 2];
    }
  }
  return out;
}

/** @returns Float32Array triangle soup in mm; throws if the file can't be read. */
export async function parseSTEP(buffer) {
  const result = (await occt()).ReadStepFile(new Uint8Array(buffer), STEP_PARAMS);
  if (!result?.success) throw new Error('Could not read this STEP file');
  const tris = stepResultToTriangles(result);
  if (!tris.length) throw new Error('The STEP file has no solid geometry');
  return tris;
}
