// Lab settings — edit these, no other code changes needed.

export const CONFIG = {
  // URL of the deployed Google Apps Script web app (see README → "Deploy the
  // submission backend"). Leave empty to run the page without submissions.
  appsScriptUrl: 'https://script.google.com/macros/s/AKfycbyziT1lpeuJEWIKSwWUm2XE16vY3E_0kXNrpSCQmqjaqoU-Q9AmKD37vVpw5PdCsO-Q9g/exec',

  // The modelling center(s). With one listed, students don't see a "Send to"
  // choice. A second center would need its own backend (its own copy of
  // apps-script/, deployed from its own account) set as its appsScriptUrl.
  centers: [
    { id: 'main', en: 'Bezalel Main Modelling Center', he: 'מרכז הדיגום הראשי של בצלאל' },
    // { id: 'architecture', en: 'Bezalel Architecture Modelling Center', he: 'מרכז הדיגום של המחלקה לארכיטקטורה' },
  ],

  // Pricing (shekels): material by weight + printing time (warm-up not charged),
  // with a minimum charge per plate.
  pricing: {
    perGram: 0.05,  // ₪ per gram of filament
    perHour: 5,     // ₪ per hour of estimated printing time
    minimum: 10,    // ₪ minimum for each plate printed
    // false: printing is free for now, and the cost is shown as what it will
    // cost once payment is required. Also set CHARGING in apps-script/Code.gs.
    charging: false,
    // false: no prices on the page; a note says a pricing policy is coming.
    // Prices are still calculated and sent to the lab. Also SHOW_COST in Code.gs.
    showCost: false,
  },

  // Minimums for showing a ready date (the backend's SETTINGS.ESTIMATE wins
  // once it's connected). Below them the page says it can't estimate.
  estimate: {
    minPrintersUp: 2,    // fewer working printers → no date
    maxWorkingDays: 15,  // further away → "more than 3 weeks"
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
