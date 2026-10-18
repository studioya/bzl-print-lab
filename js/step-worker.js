// Module worker: reads one STEP file at a time (see js/step.js).
import { parseSTEP } from './step.js';

self.onmessage = async (e) => {
  const { id, buffer } = e.data;
  try {
    const positions = await parseSTEP(buffer);
    self.postMessage({ id, positions }, [positions.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
