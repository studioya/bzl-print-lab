// Lab settings — edit these, no other code changes needed.

export const CONFIG = {
  // URL of the deployed Google Apps Script web app (see README → "Deploy the
  // submission backend"). Leave empty to run the page without submissions.
  appsScriptUrl: '',

  // Pricing: shekels per minute of estimated print time (warm-up not charged).
  pricePerMinute: 0.5,
  currency: '₪',

  maxCopies: 10,
  maxFileMB: 25,

  // Multiplies the slicer's time estimate. Tune by comparing with Bambu Studio
  // on real models (README → "Calibrating the time estimate").
  // Per-profile values override the default, e.g. { 'BEZALEL FABLAB FINE': 1.05 }.
  timeCalibration: {
    default: 1.0,
    perProfile: {},
  },
};
