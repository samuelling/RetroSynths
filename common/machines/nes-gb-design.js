// GM program designs shared by the NES and Game Boy preset libraries (original designs for RetroSynths).
// Per program: duty, ADSR (seconds, levels 0..1), delayed vibrato, tremolo, pitch slide, arpeggio macro,
// GB fallback wave and a priority. nes-presets.js / gb-presets.js convert these into native chip
// instruments (volume macros, NRx2 envelopes…); nothing here is used at playback time.

import { family } from './util.js';

// ------------------------------------------------------------------------------------------------
//  Instruments: family defaults + per-program touches. Times in seconds, levels 0..1.
//  duty: 0 12.5% · 1 25% · 2 50% · 3 75%.  dmac: duty per frame from note start (last entry holds).
// ------------------------------------------------------------------------------------------------
const FAM = {
  piano:      { duty: 2, a: 0,    d: 0.9, s: 0,    r: 0.25, prio: 55, wave: 'piano' },
  chromatic:  { duty: 1, a: 0,    d: 0.5, s: 0,    r: 0.3,  prio: 55, wave: 'bell' },
  organ:      { duty: 2, a: 0.01, d: 0.5, s: 0.85, r: 0.06, prio: 60, wave: 'organ', vibDelay: 20, vibDepth: 0.08 },
  guitar:     { duty: 1, a: 0,    d: 0.8, s: 0,    r: 0.2,  prio: 60, wave: 'guitar' },
  bass:       { duty: 2, a: 0,    d: 0.8, s: 0.5,  r: 0.06, prio: 50, wave: 'bass', bass: true },
  strings:    { duty: 1, a: 0.06, d: 0.6, s: 0.85, r: 0.25, prio: 50, wave: 'saw', vibDelay: 18, vibDepth: 0.18 },
  ensemble:   { duty: 1, a: 0.12, d: 0.8, s: 0.8,  r: 0.3,  prio: 45, wave: 'saw', vibDelay: 24, vibDepth: 0.1 },
  brass:      { duty: 1, a: 0.03, d: 0.4, s: 0.8,  r: 0.12, prio: 75, wave: 'brass', vibDelay: 20, vibDepth: 0.15 },
  reed:       { duty: 1, a: 0.02, d: 0.5, s: 0.85, r: 0.1,  prio: 80, wave: 'reed', vibDelay: 18, vibDepth: 0.15 },
  pipe:       { duty: 2, a: 0.03, d: 0.5, s: 0.85, r: 0.12, prio: 80, wave: 'sine', vibDelay: 16, vibDepth: 0.15 },
  lead:       { duty: 2, a: 0,    d: 0.6, s: 0.9,  r: 0.1,  prio: 90, wave: 'pulse', vibDelay: 20, vibDepth: 0.12 },
  pad:        { duty: 2, a: 0.35, d: 1.0, s: 0.8,  r: 0.5,  prio: 35, wave: 'pad', vibDelay: 30, vibDepth: 0.1 },
  fx:         { duty: 1, a: 0.15, d: 1.0, s: 0.6,  r: 0.5,  prio: 40, wave: 'fx' },
  ethnic:     { duty: 1, a: 0,    d: 0.6, s: 0,    r: 0.2,  prio: 60, wave: 'guitar' },
  percussive: { duty: 2, a: 0,    d: 0.25, s: 0,   r: 0.1,  prio: 50, wave: 'bell' },
  sfx:        { duty: 1, a: 0,    d: 0.4, s: 0,    r: 0.2,  prio: 40, wave: 'fx' },
};

// program → overrides
const PROG = {
  0: { d: 1.1 }, 1: { duty: 1, d: 1.0 }, 2: { duty: 1, dmac: [2, 1] }, 3: { vibDepth: 0.06, vibDelay: 0 },
  4: { d: 1.4, dmac: [1, 2] }, 5: { duty: 1, d: 1.2 }, 6: { duty: 0, d: 0.5 }, 7: { duty: 0, d: 0.35, r: 0.08 },
  8: { duty: 2, d: 0.6 }, 9: { duty: 0, d: 0.45, wave: 'hollow' }, 10: { duty: 0, d: 0.6, wave: 'hollow' },
  11: { duty: 2, d: 1.2, trem: 0.35, tremRate: 5.5 }, 12: { duty: 2, d: 0.2, wave: 'hollow' }, 13: { duty: 1, d: 0.15 },
  14: { duty: 1, d: 2.0, s: 0 }, 15: { d: 0.8 },
  16: { duty: 2 }, 17: { duty: 1, dmac: [0, 0, 1], d: 0.3, s: 0.7 }, 18: { duty: 1, vibDelay: 0, vibDepth: 0.1 },
  19: { duty: 2, a: 0.08, r: 0.3, wave: 'organ' }, 20: { duty: 1 }, 21: { duty: 1, vibDelay: 6, vibDepth: 0.12 },
  22: { duty: 1, a: 0.03, vibDelay: 12, vibDepth: 0.2, prio: 80 }, 23: { duty: 1, vibDelay: 6, vibDepth: 0.12 },
  24: { duty: 2, d: 0.9 }, 25: { duty: 1, d: 0.8 }, 26: { duty: 2, d: 1.1 }, 27: { duty: 1, d: 1.0, dmac: [0, 1] },
  28: { duty: 1, d: 0.12, r: 0.05 }, 29: { duty: 0, d: 1.2, s: 0.6, prio: 75 }, 30: { duty: 0, d: 1.5, s: 0.7, prio: 80, vibDelay: 20, vibDepth: 0.2 },
  31: { duty: 0, d: 0.3, wave: 'hollow' },
  32: { d: 0.6, s: 0.3 }, 33: { d: 0.9, s: 0.55 }, 34: { duty: 1, d: 0.6, s: 0.5, wave: 'bassbright' },
  35: { d: 1.0, s: 0.6, vibDelay: 20, vibDepth: 0.12 }, 36: { duty: 1, d: 0.25, s: 0.45, dmac: [0, 1], wave: 'bassbright' },
  37: { duty: 1, d: 0.25, s: 0.45, dmac: [0, 1], wave: 'bassbright' }, 38: { duty: 1, d: 0.5, s: 0.7, wave: 'synbass' },
  39: { duty: 0, d: 0.4, s: 0.8, dmac: [0, 1, 2], wave: 'synbass' },
  40: { duty: 1, prio: 70 }, 41: { duty: 1 }, 42: { duty: 2, wave: 'cello' }, 43: { duty: 2, bass: true, wave: 'cello' },
  44: { trem: 0.5, tremRate: 9, vibDepth: 0 }, 45: { a: 0, d: 0.2, s: 0, r: 0.1, vibDepth: 0 },
  46: { a: 0, d: 0.7, s: 0, r: 0.3, vibDepth: 0, wave: 'guitar' }, 47: { a: 0, d: 0.5, s: 0, duty: 2, slide: -0.04, wave: 'sine', vibDepth: 0 },
  48: {}, 49: { a: 0.3, r: 0.5 }, 50: { duty: 1, a: 0.1, dmac: [0, 0, 1] }, 51: { duty: 2, a: 0.25, wave: 'pad' },
  52: { duty: 2, a: 0.1, wave: 'choir', vibDelay: 10, vibDepth: 0.15 }, 53: { duty: 2, a: 0.08, wave: 'sine', vibDelay: 10 },
  54: { duty: 2, a: 0.08, wave: 'choir' }, 55: { duty: 0, a: 0, d: 0.25, s: 0, r: 0.1, slide: -0.06, prio: 70, wave: 'brass' },
  56: { duty: 1, prio: 80 }, 57: { duty: 2 }, 58: { duty: 2, bass: true }, 59: { duty: 0, prio: 75 },
  60: { duty: 2, a: 0.06 }, 61: { duty: 1 }, 62: { duty: 0, dmac: [0, 0, 1, 1, 2] }, 63: { duty: 1, dmac: [0, 1, 2] },
  64: { duty: 1 }, 65: { duty: 1 }, 66: { duty: 1 }, 67: { duty: 1, wave: 'brass' }, 68: { duty: 0 }, 69: { duty: 0 },
  70: { duty: 1, prio: 60 }, 71: { duty: 2, wave: 'square' },
  72: { vibDepth: 0.12 }, 73: {}, 74: { vibDepth: 0.08 }, 75: { a: 0.05, wave: 'sine' }, 76: { a: 0.08, duty: 2 },
  77: { a: 0.05, vibDepth: 0.25 }, 78: { vibDelay: 8, vibDepth: 0.2 }, 79: {},
  80: { duty: 2, wave: 'square' }, 81: { duty: 1, wave: 'saw' }, 82: { duty: 2, vibDelay: 0, vibDepth: 0.15 },
  83: { duty: 1, dmac: [0, 0, 1], d: 0.4, s: 0.6 }, 84: { duty: 0, d: 0.8, s: 0.6 }, 85: { duty: 2, vibDelay: 8, vibDepth: 0.2, wave: 'choir' },
  86: { duty: 1, arpMac: [0, 7] }, 87: { duty: 1, wave: 'saw' },
  88: { duty: 2 }, 89: { duty: 2, a: 0.5 }, 90: { duty: 1, a: 0.08, d: 0.6, s: 0.6, r: 0.3 }, 91: { duty: 2, a: 0.4, wave: 'choir' },
  92: { duty: 1, a: 0.4 }, 93: { duty: 0, a: 0.2, wave: 'hollow' }, 94: { duty: 2, a: 0.5, wave: 'choir' },
  95: { duty: 1, a: 0.3, dmac: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2] },
  96: { duty: 0, a: 0, d: 0.5, s: 0.3, arpMac: [0, 12] }, 97: { duty: 2, a: 0.3 }, 98: { duty: 0, a: 0, d: 0.6, s: 0, arpMac: [0, 12, 19] },
  99: { duty: 1, a: 0.1 }, 100: { duty: 1, a: 0.05, arpMac: [0, 0, 12] }, 101: { duty: 0, a: 0.2, vibDelay: 0, vibDepth: 0.4 },
  102: { duty: 1, a: 0, d: 0.15, s: 0.35, trem: 0.6, tremRate: 4 }, 103: { duty: 0, a: 0.05, vibDelay: 0, vibDepth: 0.8 },
  104: { duty: 0, d: 1.0, s: 0, bendIn: 0.6 }, 105: { duty: 1, d: 0.35 }, 106: { duty: 0, d: 0.3 }, 107: { duty: 1, d: 0.6 },
  108: { duty: 2, d: 0.3, wave: 'sine' }, 109: { duty: 1, a: 0.02, d: 1, s: 0.9, r: 0.1, prio: 75, wave: 'reed' },
  110: { duty: 1, a: 0.04, d: 1, s: 0.85, r: 0.15, vibDelay: 12, vibDepth: 0.2, prio: 75 },
  111: { duty: 0, a: 0.02, d: 1, s: 0.85, r: 0.1, vibDelay: 10, vibDepth: 0.2, prio: 75 },
  112: { duty: 0, d: 0.4, wave: 'hollow' }, 113: { duty: 1, d: 0.15 }, 114: { duty: 2, d: 0.45, wave: 'hollow' },
  115: { duty: 2, d: 0.05, r: 0.03 }, 116: { duty: 2, d: 0.2, slide: -0.3, wave: 'sine' }, 117: { duty: 2, d: 0.25, slide: -0.12, wave: 'sine' },
  118: { duty: 2, d: 0.2, slide: -0.2, wave: 'sine' },
  119: { noise: true, a: 0.6, d: 1, s: 1, r: 0.05, slide: -0.3 },
  120: { noise: true, d: 0.06, r: 0.03 }, 121: { noise: true, a: 0.08, d: 0.3, s: 0.4, r: 0.15 },
  122: { noise: true, a: 0.6, d: 1.5, s: 0.5, r: 0.8, trem: 0.4, tremRate: 0.3 },
  123: { duty: 0, a: 0, d: 0.4, s: 0.5, vibDelay: 0, vibDepth: 1.5, arpMac: [0, 12, 7] },
  124: { duty: 1, a: 0, d: 1, s: 1, r: 0.02, arpMac: [0, 0, 4, 4] },
  125: { noise: true, a: 0.2, d: 1, s: 0.9, r: 0.3, trem: 0.8, tremRate: 12 },
  126: { noise: true, a: 0.3, d: 1, s: 0.8, r: 0.6, trem: 0.5, tremRate: 7 },
  127: { noise: true, d: 0.35, r: 0.15, slide: 0.6 },
};

const DEF = { duty: 2, dmac: null, a: 0, d: 0.5, s: 0.5, r: 0.2, prio: 50, wave: 'pulse', vibDelay: 0, vibDepth: 0,
  trem: 0, tremRate: 5, slide: 0, arpMac: null, bass: false, noise: false, bendIn: 0 };
export const INST = [];
for (let p = 0; p < 128; p++) INST.push(Object.freeze({ ...DEF, ...FAM[family(p)], ...(PROG[p] || {}), prog: p, fam: family(p) }));

