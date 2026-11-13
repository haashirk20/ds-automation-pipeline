// Caption plate and text styles, one per template. Plain TypeScript so both the templates and the
// producer's QA gate can import it.
export const CAPTION_STYLES = {
  'kinetic-bold': { fontPx: 76, textHex: '#FFFFFF', plateHex: '#000000', plateAlpha: 0.85 },
  'cozy-soft': { fontPx: 64, textHex: '#3A2A20', plateHex: '#FFFFFF', plateAlpha: 0.92 },
  'gift-guide': { fontPx: 66, textHex: '#FFF8EC', plateHex: '#12241B', plateAlpha: 0.9 },
} as const;
