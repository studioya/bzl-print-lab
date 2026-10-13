// Lab settings — edit these, no other code changes needed.

export const CONFIG = {
  // Where submissions go. Set ONE of these (leave both empty to run the page
  // without submissions):
  //  - powerAutomateUrl: the HTTP POST URL of the lab's Power Automate flow
  //    (OneDrive + Excel; see power-automate/README.md). Used if set.
  //  - appsScriptUrl: the Google Apps Script web app URL (Google Drive + Sheets;
  //    see README → "Deploy the submission backend").
  powerAutomateUrl: '',
  appsScriptUrl: '',

  // Where students can send their print. The ids must match SETTINGS.CENTERS
  // in apps-script/Code.gs, which decides each center's Drive folder and Sheet.
  // With Power Automate, each center's files go to its own folder
  // (STUDENT 3D SUBMISSIONS/Main or /Architecture) and all submissions to one
  // Excel log with a Center column. A center can have its own powerAutomateUrl
  // or appsScriptUrl; otherwise the one above is used.
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
