// Hebrew names and short descriptions for each lab process profile (the
// English name comes from the preset itself — see `label` in profiles-data.js).
// Keys are the Bambu Studio preset names from profiles/lab/process.
// `filament` picks which lab filament preset the slicer uses with it
// (only PLA is used; the STRONG variant prints hotter for better layer bonding).

export const PROFILE_INFO = {
  'Draft - Bezalel Modelling Center': {
    he: 'טיוטה',
    descEn: 'Fastest. Thick 0.24 mm layers for quick prototypes and form studies.',
    descHe: 'המהיר ביותר. שכבות עבות של 0.24 מ״מ, לאבות טיפוס מהירים ובדיקות צורה.',
    filament: 'Generic PLA - Bezalel Modelling Center',
  },
  'Normal - Bezalel Modelling Center': {
    he: 'רגיל',
    descEn: 'The everyday choice. 0.18 mm layers, a good balance of quality and speed.',
    descHe: 'הבחירה היומיומית. שכבות של 0.18 מ״מ, איזון טוב בין איכות למהירות.',
    filament: 'Generic PLA - Bezalel Modelling Center',
  },
  'Fine - Bezalel Modelling Center': {
    he: 'עדין',
    descEn: 'Smoothest surfaces. 0.12 mm layers for small or detailed models. Slower.',
    descHe: 'המשטחים החלקים ביותר. שכבות של 0.12 מ״מ לדגמים קטנים או מפורטים. איטי יותר.',
    filament: 'Generic PLA - Bezalel Modelling Center',
  },
  'Strong - Bezalel Modelling Center': {
    he: 'חזק',
    descEn: 'For functional parts. 4 walls and 28% infill: stiff and durable.',
    descHe: 'לחלקים פונקציונליים. 4 דפנות ו־28% מילוי: קשיח ועמיד.',
    filament: 'Generic PLA Strong - Bezalel Modelling Center',
  },
  'Press - Bezalel Modelling Center': {
    he: 'מכבש',
    descEn: 'For forms used in the hydraulic press. Open top (no top layers), 4 walls, 12% infill, fast 0.24 mm layers.',
    descHe: 'לתבניות לשימוש במכבש ההידראולי. חלק עליון פתוח (ללא שכבות עליונות), 4 דפנות, 12% מילוי, שכבות מהירות של 0.24 מ״מ.',
    filament: 'Generic PLA Strong - Bezalel Modelling Center',
  },
  'Lost PLA - Bezalel Modelling Center': {
    he: 'PLA אבוד',
    descEn: 'For lost-PLA metal casting. Minimal 3% infill and thin shells so it burns out cleanly.',
    descHe: 'ליציקת מתכת בשיטת PLA אבוד. מילוי מינימלי של 3% ומעטפת דקה לשריפה נקייה.',
    filament: 'Generic PLA - Bezalel Modelling Center',
  },
  'Pour Mold - Bezalel Modelling Center': {
    he: 'תבנית יציקה',
    descEn: 'For molds you pour into (silicone, plaster, resin). Thick sealed walls, smooth 0.12 mm layers.',
    descHe: 'לתבניות יציקה (סיליקון, גבס, שרף). דפנות עבות ואטומות ושכבות חלקות של 0.12 מ״מ.',
    filament: 'Generic PLA - Bezalel Modelling Center',
  },
};
