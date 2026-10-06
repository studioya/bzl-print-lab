// Extrusion feature types, with the colours Bambu Studio uses in its
// "Line Type" preview.

export const F = {
  OUTER_WALL: 0,
  INNER_WALL: 1,
  SPARSE_INFILL: 2,
  INTERNAL_SOLID: 3,
  TOP_SURFACE: 4,
  BOTTOM_SURFACE: 5,
  BRIDGE: 6,
  GAP_INFILL: 7,
  BRIM: 8,
  SUPPORT: 9,
  SUPPORT_INTERFACE: 10,
  OVERHANG_WALL: 11,
};

export const FEATURES = [
  { id: F.OUTER_WALL, en: 'Outer wall', he: 'דופן חיצונית', color: '#ff7d38' },
  { id: F.INNER_WALL, en: 'Inner wall', he: 'דופן פנימית', color: '#ffe64d' },
  { id: F.SPARSE_INFILL, en: 'Sparse infill', he: 'מילוי דליל', color: '#b03029' },
  { id: F.INTERNAL_SOLID, en: 'Internal solid infill', he: 'מילוי מלא פנימי', color: '#9654cc' },
  { id: F.TOP_SURFACE, en: 'Top surface', he: 'משטח עליון', color: '#f04040' },
  { id: F.BOTTOM_SURFACE, en: 'Bottom surface', he: 'משטח תחתון', color: '#665cc7' },
  { id: F.BRIDGE, en: 'Bridge', he: 'גישור', color: '#4d80ba' },
  { id: F.GAP_INFILL, en: 'Gap infill', he: 'מילוי מרווחים', color: '#e8e8e8' },
  { id: F.BRIM, en: 'Brim', he: 'שוליים (ברים)', color: '#00876e' },
  { id: F.SUPPORT, en: 'Support', he: 'תמיכות', color: '#00c040' },
  { id: F.SUPPORT_INTERFACE, en: 'Support interface', he: 'ממשק תמיכה', color: '#00703c' },
  { id: F.OVERHANG_WALL, en: 'Overhang wall', he: 'דופן תלויה', color: '#1f1fff' },
];
