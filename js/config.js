// Lab settings — edit these, no other code changes needed.

export const CONFIG = {
  // URL of the deployed Google Apps Script web app (see README → "Deploy the
  // submission backend"). Leave empty to run the page without submissions.
  appsScriptUrl: '',

  // Where students can send their print. The ids must match SETTINGS.CENTERS
  // in apps-script/Code.gs, which decides each center's Drive folder and Sheet.
  // A center can have its own appsScriptUrl (e.g. a script on another Google
  // account); otherwise the one above is used.
  centers: [
    { id: 'main', en: 'Bezalel Main Modelling Center', he: 'מרכז הדיגום הראשי של בצלאל' },
    { id: 'architecture', en: 'Bezalel Architecture Modelling Center', he: 'מרכז הדיגום של המחלקה לארכיטקטורה' },
  ],

  // Pricing (shekels): material by weight + printing time (warm-up not charged),
  // with a minimum charge per plate.
  pricing: {
    perGram: 0.05,  // ₪ per gram of filament
    perHour: 5,     // ₪ per hour of estimated printing time
    minimum: 10,    // ₪ minimum for each plate printed
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
