// Price of a print: material + printing time, with a minimum per submission.
// Rates are in js/config.js (pricing).

/** Cost of one plate (no minimum): { material, time, cost } in shekels. */
export function plateCost({ grams, seconds }, pricing) {
  const material = grams * pricing.perGram;
  const time = (seconds / 3600) * pricing.perHour;
  return { material, time, cost: material + time };
}

/**
 * Price of a whole submission from its plates ([{ grams, seconds }]).
 * The minimum applies once to the whole submission, not per plate.
 * @returns { material, time, subtotal, minimum, minimumApplied, total }
 */
export function submissionPrice(plates, pricing) {
  let material = 0, time = 0;
  for (const p of plates) {
    const c = plateCost(p, pricing);
    material += c.material;
    time += c.time;
  }
  const subtotal = round2(material + time);
  const minimumApplied = plates.length > 0 && subtotal < pricing.minimum;
  return {
    material: round2(material),
    time: round2(time),
    subtotal,
    minimum: pricing.minimum,
    minimumApplied,
    total: minimumApplied ? pricing.minimum : subtotal,
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
