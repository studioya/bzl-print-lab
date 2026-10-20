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

  // The lab's email address, shown on the privacy notice for privacy requests.
  labEmail: '',

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

  // The "Department" menu on the details form. "Other" (always last) lets
  // anyone not listed type their own. `en` is what the lab sees.
  departments: [
    {
      group: "Bachelor's", groupHe: 'תואר ראשון',
      items: [
        { en: 'Architecture', he: 'אדריכלות' },
        { en: 'Ceramics and Glass Design', he: 'עיצוב קרמיקה וזכוכית' },
        { en: 'Fine Arts', he: 'אמנויות' },
        { en: 'Industrial Design', he: 'עיצוב תעשייתי' },
        { en: 'Jewelry and Fashion', he: 'צורפות ואופנה' },
        { en: 'Photography', he: 'צילום' },
        { en: 'Screen-Based Arts', he: 'אמנויות המסך' },
        { en: 'Visual and Material Culture', he: 'תרבות חזותית וחומרית' },
        { en: 'Visual Communication', he: 'תקשורת חזותית' },
      ],
    },
    {
      group: "Master's", groupHe: 'תואר שני',
      items: [
        { en: 'M.Des. Industrial Design', he: 'תואר שני בעיצוב תעשייתי' },
        { en: 'M.Des. Visual Communication', he: 'תואר שני בתקשורת חזותית' },
        { en: 'M.F.A. Fine Arts', he: 'תואר שני באמנויות' },
        { en: 'M.Urb.Des. Urban Design', he: 'תואר שני בעיצוב עירוני' },
        { en: 'M.A. Policy and Theory of the Arts', he: 'תואר שני במדיניות ותאוריה של האמנויות' },
      ],
    },
  ],

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
