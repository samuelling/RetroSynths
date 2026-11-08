// Per-frame drum programs for the AY drivers (own designs), used to build the native drum instruments.
import { midiHz, drumKind, TOM_NOTE } from './util.js';

// ---------------------------------------------------------------- drum macros (per driver frame)
// frame = [volume 0..15, mix (0 tone, 1 tone+noise, 2 noise), noise period, tone Hz]
function decay(v0, frames, f) {
  const out = [];
  for (let i = 0; i < frames; i++) { const v = Math.max(1, Math.round(v0 - (v0 - 1) * i / Math.max(1, frames - 1))); out.push([v, ...f(i)]); }
  return out;
}
const sweep = (h0, h1, n) => (i) => h0 * Math.pow(h1 / h0, Math.min(1, i / Math.max(1, n - 1)));
export function ayDrumMacro(n) {
  const k = drumKind(n);
  switch (k) {
    case 'kick': { const lo = n === 35 ? 0.85 : 1; return decay(15, 8, (i) => [i === 0 ? 1 : 0, 14, sweep(150 * lo, 42 * lo, 6)(i)]); }
    case 'snare': return decay(15, n === 40 ? 8 : 10, (i) => i === 0 ? [1, n === 40 ? 4 : 6, 230] : [2, (n === 40 ? 3 : 5) + (i >> 1), 0]);
    case 'stick': return [[14, 1, 1, 1700], [9, 0, 0, 1250], [4, 0, 0, 1250]];
    case 'clap': return [[13, 2, 3, 0], [3, 2, 3, 0], [13, 2, 3, 0], ...decay(12, 7, (i) => [2, 4 + (i >> 1), 0])];
    case 'hatClosed': return [[12, 2, 0, 0], [8, 2, 0, 0], [3, 2, 0, 0]];
    case 'hatPedal': return [[10, 2, 1, 0], [6, 2, 1, 0], [2, 2, 1, 0]];
    case 'hatOpen': return decay(13, 16, (i) => [2, i & 1, 0]);
    case 'crash': {
      const len = n === 55 ? 20 : 44, np = n === 52 ? 4 : 2;
      return decay(14, len, (i) => [2, np + (i % 3 === 0 ? 1 : 0), 0]);
    }
    case 'ride': return decay(12, 26, (i) => i < 2 ? [1, 0, 3400] : [1, 1, 3100]);
    case 'bell': return decay(13, 24, (i) => [0, 0, i & 1 ? 2150 : 1420]);
    case 'tom': { const t = TOM_NOTE[n] || 50; return decay(15, 9, (i) => [i === 0 ? 1 : 0, 10, sweep(midiHz(t + 7), midiHz(t - 5), 8)(i)]); }
    case 'conga': {
      const t = TOM_NOTE[n] || 64, mute = n === 62;
      return decay(14, mute ? 3 : 6, (i) => [0, 0, sweep(midiHz(t + 3), midiHz(t), 4)(i)]);
    }
    case 'cowbell':
      if (n === 56) return decay(13, 9, (i) => [0, 0, i & 1 ? 545 : 810]);
      return decay(12, 6, (i) => [0, 0, n === 67 ? 1000 : 760]);   // agogo
    case 'shaker':
      if (n === 54) return [[11, 2, 0, 0], [8, 2, 0, 0], [11, 2, 0, 0], [7, 2, 0, 0], [5, 2, 0, 0], [3, 2, 0, 0]];
      return [[9, 2, 0, 0], [6, 2, 0, 0], [3, 2, 0, 0]];
    case 'block': return decay(13, 3, () => [0, 0, n === 75 ? 2500 : n === 76 ? 1250 : 950]);
    case 'triangle': return decay(12, n === 80 ? 4 : 32, (i) => [0, 0, i & 1 ? 4480 : 4420]);
    default:
      switch (n) {
        case 58: return decay(12, 20, (i) => [i & 1 ? 2 : 1, 6, 300]);                            // vibraslap
        case 71: return decay(12, 8, (i) => [0, 0, 2350 + (i & 1) * 40]);                          // short whistle
        case 72: return decay(12, 26, (i) => [0, 0, 2350 + (i & 2) * 20]);                         // long whistle
        case 73: return [[11, 2, 6, 0], [2, 2, 6, 0], [11, 2, 6, 0], [2, 2, 6, 0], [9, 2, 6, 0]];  // short guiro
        case 74: return decay(11, 14, (i) => [2, i & 1 ? 9 : 5, 0]);                               // long guiro
        case 78: return decay(12, 5, (i) => [0, 0, sweep(420, 720, 5)(i)]);                        // mute cuica
        case 79: return decay(12, 10, (i) => [0, 0, sweep(650, 300, 10)(i)]);                     // open cuica
        default: return decay(12, 5, (i) => [1, 3, midiHz(n + 12)]);
      }
  }
}
export const DRUM_PRIO = { kick: 9, snare: 8, clap: 7, tom: 7, crash: 6, stick: 5, conga: 5, cowbell: 5, bell: 4, ride: 4, block: 4, triangle: 3, perc: 3, hatOpen: 3, shaker: 2, hatClosed: 2, hatPedal: 1 };
const MACRO_CACHE = [];
const macroFor = (n) => MACRO_CACHE[n] || (MACRO_CACHE[n] = ayDrumMacro(n));

