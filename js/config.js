// Lab settings — edit these, no other code changes needed.

export const CONFIG = {
  // URL of the deployed Google Apps Script web app (see README → "Deploy the
  // submission backend"). Leave empty to run the page without submissions.
  appsScriptUrl: '',

  // Pricing (shekels): material by weight + printing time (warm-up not charged),
  // with a minimum charge per submission.
  pricing: {
    perGram: 0.05,  // ₪ per gram of filament
    perHour: 5,     // ₪ per hour of estimated printing time
    minimum: 10,    // ₪ minimum for any print submission
  },
  currency: '₪',

  maxFiles: 5,      // model files per submission
  maxObjects: 50,   // objects on the plate (after splitting)
  maxCopies: 10,    // copies of each object
  maxFileMB: 25,

  // Multiplies the slicer's time estimate. Tune by comparing with Bambu Studio
  // on real models (README → "Calibrating the time estimate").
  // Per-profile values override the default, e.g. { 'Fine - Bezalel Modelling Center': 1.05 }.
  timeCalibration: {
    default: 1.0,
    perProfile: {},
  },
};
