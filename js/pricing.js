// Price of a print: material + printing time, with a minimum charge per plate.
// Rates are in js/config.js (pricing).

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Cost of one plate ({ grams, seconds }):
 * { material, time, subtotal, minimumApplied, cost } in shekels,
 * where cost is the subtotal raised to the minimum when it's below it.
 */
export function plateCost({ grams, seconds }, pricing) {
  const material = round2(grams * pricing.perGram);
  const time = round2((seconds / 3600) * pricing.perHour);
  const subtotal = round2(material + time);
  const minimumApplied = subtotal < pricing.minimum;
  return { material, time, subtotal, minimumApplied, cost: minimumApplied ? pricing.minimum : subtotal };
}

/**
 * Price of a whole submission: the sum of its plates, each with its own minimum.
 * @returns { material, time, subtotal, minimum, minimumTopUp, platesAtMinimum, total }
 *   minimumTopUp — what the per-plate minimum adds on top of material + time;
 *   platesAtMinimum — indexes (into `plates`) of plates charged the minimum.
 */
export function submissionPrice(plates, pricing) {
  let material = 0, time = 0, subtotal = 0, total = 0;
  const platesAtMinimum = [];
  plates.forEach((p, i) => {
    const c = plateCost(p, pricing);
    material += c.material;
    time += c.time;
    subtotal += c.subtotal;
    total += c.cost;
    if (c.minimumApplied) platesAtMinimum.push(i);
  });
  return {
    material: round2(material),
    time: round2(time),
    subtotal: round2(subtotal),
    minimum: pricing.minimum,
    minimumTopUp: round2(total - subtotal),
    platesAtMinimum,
    total: round2(total),
  };
}
