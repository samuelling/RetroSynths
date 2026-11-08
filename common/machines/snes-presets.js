/*
 * SNES native instruments, GM mapping and S-DSP envelope maths (shared by the worklet driver,
 * snes.prep.js and snes-editor.js).
 *
 * An instrument = a sample SOURCE (which GeneralUser GS preset / key region / velocity layer the prep
 * squeezes into BRR, with budget hints) + real S-DSP voice parameters:
 *   src     { bank: 0 | 128 (drum kit), prog, key (split centre / drum note), vel }
 *   splits  1–3 key splits (multisamples) at most; fixed: true → always plays src.key's pitch (drums)
 *   rate    max BRR sample rate (Hz) · loop: max loop length (ms) · len: max one-shot length (ms)
 *   env     'adsr' → ar 0–15, dr 0–7, sl 0–7, sr 0–31  |  'gain' → gmode + gval (GAIN register)
 *   rel     key-off: 0 = hardware KOFF (−8/sample ≈ 8 ms), 1–31 = GAIN exponential-decrease rate
 *   echo    EON bit · noise: NON bit (voice plays the noise generator), nrate 0–31 (FLG noise clock)
 *   coarse  semitones · tune: cents · vol 0–127 (8-bit VOL scale, 100 = nominal) · pan −64..63
 * ADSR/GAIN/rel defaults were derived from GeneralUser GS's SF2 envelopes (snes.prep.js mapEnv1).
 */
import { RATE_PERIOD } from './snes-dsp.js';

// ---------------------------------------------------------------- envelope maths
export const EXP_DB_PER_TICK = 20 * Math.log10(256 / 255);   // exponential decrease: env −= env/256 per tick
/** dB/s of an exponential decrease at a rate index (0 = never) */
export const rateDbps = (r) => (r <= 0 ? 0 : EXP_DB_PER_TICK * 32000 / RATE_PERIOD[r]);
/** rate index whose exponential decrease is closest to dbps */
export function expRate(dbps) {
  if (dbps <= 0.2) return 0;
  const period = EXP_DB_PER_TICK * 32000 / dbps;
  let best = 1, be = Infinity;
  for (let r = 1; r < 32; r++) { const e = Math.abs(Math.log(RATE_PERIOD[r] / period)); if (e < be) { be = e; best = r; } }
  return best;
}
/** seconds of one rate period (32 kHz samples) */
export const ratePeriodS = (r) => (r <= 0 ? Infinity : RATE_PERIOD[r] / 32000);
export const attackTime = (ar) => (ar === 15 ? 2 / 32000 : 64 * RATE_PERIOD[2 * ar + 1] / 32000);
export const GAIN_MODES = [['direct', 'Direct'], ['linDec', 'Linear −'], ['expDec', 'Exp −'], ['linInc', 'Linear +'], ['bentInc', 'Bent +']];
/** GAIN register value for an instrument in GAIN mode */
export function gainReg(inst) {
  const m = inst.gmode || 'direct';
  if (m === 'direct') return Math.max(0, Math.min(127, inst.gval | 0));
  const k = { linDec: 4, expDec: 5, linInc: 6, bentInc: 7 }[m] || 6;
  return (k << 5) | Math.max(0, Math.min(31, inst.gval | 0));
}
/** ADSR1 / ADSR2 registers (ADSR1 bit 7 clear in GAIN mode) */
export function adsrRegs(inst, srOverride) {
  const ar = inst.ar & 15, dr = inst.dr & 7, sl = inst.sl & 7, sr = (srOverride != null ? srOverride : inst.sr) & 31;
  return [(inst.env === 'gain' ? 0 : 0x80) | (dr << 4) | ar, (sl << 5) | sr];
}

/**
 * Exact S-DSP envelope simulation (same rules as snes-dsp.js) for graphs: key held for holdS seconds,
 * then key-off (KOFF or GAIN release). Returns { pts: [[t, level 0..1]], total }.
 */
const OFF = new Int32Array(32);
for (let r = 0; r < 32; r++) OFF[r] = r === 0 ? 1 : r >= 30 ? 0 : [1040, 536, 0][r % 3];
export function simulateEnv(inst, holdS, totalS, nPts = 240) {
  const N = Math.round(totalS * 32000), hold = Math.round(holdS * 32000), step = Math.max(1, Math.floor(N / nPts));
  const [a1, a2] = adsrRegs(inst);
  const gain = gainReg(inst), rel = inst.rel | 0;
  let env = 0, hidden = 0, mode = 0, counter = 0, released = false;   // mode 0 attack 1 decay 2 sustain 3 release
  const pts = [];
  const fire = (r) => (counter + OFF[r]) % RATE_PERIOD[r] === 0;
  for (let i = 0; i < N; i++) {
    if (--counter < 0) counter = 30719;
    if (i === hold) released = true;
    let adsr1 = a1, g = gain;
    if (released) { if (rel) { adsr1 = a1 & 0x7F; g = 0xA0 | rel; } else mode = 3; }
    if (mode === 3) { env -= 8; if (env < 0) env = 0; }
    else {
      let rate, data, e = env;
      if (adsr1 & 0x80) {
        data = a2;
        if (mode >= 1) { e--; e -= e >> 8; rate = mode === 1 ? ((adsr1 >> 3) & 0x0E) + 0x10 : data & 0x1F; }
        else { rate = ((adsr1 & 15) << 1) + 1; e += rate < 31 ? 0x20 : 0x400; }
      } else {
        data = g; const gm = g >> 5;
        if (gm < 4) { e = g << 4; rate = 31; }
        else { rate = g & 31; if (gm === 4) e -= 0x20; else if (gm === 5) { e--; e -= e >> 8; } else { e += 0x20; if (gm === 7 && hidden >= 0x600) e += 8 - 0x20; } }
      }
      if ((e >> 8) === (data >> 5) && mode === 1) mode = 2;
      hidden = e;
      if (e < 0 || e > 0x7FF) { e = e < 0 ? 0 : 0x7FF; if (mode === 0) mode = 1; }
      if (fire(rate)) env = e;
    }
    if (i % step === 0) pts.push([i / N, env / 0x7FF]);
  }
  return { pts, total: totalS, hold: holdS };
}

// ---------------------------------------------------------------- preset library
const M = (name, category, prog, key, e, extra = {}) => ({
  name, category, kind: 'sample', src: { bank: 0, prog, key, vel: 100 }, splits: 3, fixed: false,
  rate: 32000, loop: 50, len: 800,
  env: 'adsr', ar: e[0], dr: e[1], sl: e[2], sr: e[3], gmode: 'direct', gval: 127, rel: e[4],
  echo: true, noise: false, nrate: 16, coarse: 0, tune: 0, vol: 100, pan: 0, ...extra,
});
const D = (name, key, e, pan, extra = {}) => ({
  name, category: 'Drums', kind: 'sample', src: { bank: 128, prog: 0, key, vel: 100 }, splits: 1, fixed: true,
  rate: 32000, loop: 50, len: 800,
  env: 'adsr', ar: e[0], dr: e[1], sl: e[2], sr: e[3], gmode: 'direct', gval: 127, rel: e[4],
  echo: false, noise: false, nrate: 28, coarse: 0, tune: 0, vol: 100, pan, ...extra,
});

// envelopes: [AR, DR, SL, SR, release-rate] (GENERATED from GeneralUser GS — see header)
export const PRESETS = [
  // Piano
  M('Grand Piano', 'Piano', 0, 60, [15, 7, 7, 11, 23]),
  M('E.Piano Tine', 'Piano', 4, 60, [15, 7, 7, 9, 0]),
  M('Harpsichord', 'Piano', 6, 60, [15, 7, 7, 13, 24]),
  // Chromatic
  M('Glockenspiel', 'Chromatic', 9, 72, [15, 7, 7, 16, 16]),
  M('Vibraphone', 'Chromatic', 11, 72, [15, 7, 7, 13, 22]),
  M('Marimba', 'Chromatic', 12, 72, [15, 7, 7, 17, 17]),
  M('Tubular Bell', 'Chromatic', 14, 72, [15, 7, 7, 12, 16]),
  // Organ
  M('Drawbar Organ', 'Organ', 16, 60, [15, 7, 7, 0, 0]),
  M('Rock Organ', 'Organ', 18, 60, [15, 7, 7, 0, 0]),
  M('Pipe Organ', 'Organ', 19, 60, [14, 7, 7, 0, 23]),
  M('Accordion', 'Organ', 21, 60, [15, 4, 3, 0, 0]),
  // Guitar
  M('Nylon Guitar', 'Guitar', 24, 57, [15, 7, 7, 13, 25]),
  M('Steel Guitar', 'Guitar', 25, 57, [15, 7, 7, 13, 27]),
  M('Clean Guitar', 'Guitar', 27, 57, [15, 7, 7, 11, 28]),
  M('Muted Guitar', 'Guitar', 28, 57, [15, 7, 7, 21, 0]),
  M('Overdrive Guitar', 'Guitar', 29, 57, [14, 7, 7, 10, 28]),
  M('Distortion Guitar', 'Guitar', 30, 57, [15, 7, 7, 1, 28]),
  // Bass
  M('Finger Bass', 'Bass', 33, 40, [15, 7, 7, 11, 0]),
  M('Fretless Bass', 'Bass', 35, 40, [15, 7, 7, 16, 0]),
  M('Slap Bass', 'Bass', 36, 40, [15, 7, 7, 12, 0]),
  M('Synth Bass', 'Bass', 38, 40, [15, 7, 7, 10, 27]),
  // Strings
  M('Violin', 'Strings', 40, 62, [13, 7, 7, 0, 27]),
  M('Cello', 'Strings', 42, 62, [10, 7, 7, 0, 26]),
  M('Pizzicato', 'Strings', 45, 62, [15, 7, 7, 18, 18]),
  M('Harp', 'Strings', 46, 62, [15, 7, 7, 14, 17]),
  M('Timpani', 'Strings', 47, 62, [15, 7, 7, 17, 21]),
  // Ensemble
  M('String Section', 'Ensemble', 48, 62, [8, 0, 6, 0, 22]),
  M('Synth Strings', 'Ensemble', 50, 62, [6, 7, 7, 0, 19]),
  M('Choir Aah', 'Ensemble', 52, 62, [7, 7, 7, 0, 22]),
  M('Orchestra Hit', 'Ensemble', 55, 62, [15, 7, 7, 16, 22]),
  // Brass
  M('Trumpet', 'Brass', 56, 60, [13, 7, 7, 0, 0]),
  M('Trombone', 'Brass', 57, 60, [13, 7, 7, 0, 28]),
  M('French Horn', 'Brass', 60, 60, [13, 0, 3, 0, 26]),
  M('Brass Section', 'Brass', 61, 60, [13, 7, 7, 0, 26]),
  M('Synth Brass', 'Brass', 62, 60, [11, 0, 3, 0, 0]),
  // Reed
  M('Alto Sax', 'Reed', 65, 64, [13, 0, 3, 0, 0]),
  M('Oboe', 'Reed', 68, 64, [15, 0, 5, 0, 0]),
  M('Clarinet', 'Reed', 71, 64, [15, 0, 5, 0, 28]),
  // Pipe
  M('Flute', 'Pipe', 73, 74, [13, 7, 7, 0, 0]),
  // Lead
  M('Square Lead', 'Lead', 80, 67, [15, 0, 3, 0, 0]),
  M('Saw Lead', 'Lead', 81, 67, [15, 0, 3, 0, 27]),
  // Pad
  M('Fantasia Pad', 'Pad', 88, 60, [14, 7, 7, 10, 18]),
  M('Warm Pad', 'Pad', 89, 60, [4, 0, 6, 0, 17]),
  M('Choir Pad', 'Pad', 91, 60, [8, 0, 0, 0, 17]),
  // FX
  M('Atmosphere', 'FX', 99, 64, [9, 0, 3, 0, 16]),
  // Ethnic
  M('Sitar', 'Ethnic', 104, 64, [15, 7, 7, 0, 18]),
  M('Banjo', 'Ethnic', 105, 64, [15, 7, 7, 17, 25]),
  M('Kalimba', 'Ethnic', 108, 64, [15, 7, 7, 19, 23]),
  // Percussive
  M('Steel Drum', 'Percussive', 114, 60, [15, 7, 7, 19, 18]),
  M('Taiko', 'Percussive', 116, 60, [15, 7, 7, 17, 15]),
  // SFX
  M('Seashore', 'SFX', 122, 60, [2, 7, 7, 10, 14]),
  // Drums (GeneralUser GS standard kit; fixed = plays the source key's pitch, else follows the note)
  D('Kick Deep', 35, [15, 7, 7, 0, 24], 0),
  D('Kick', 36, [15, 7, 7, 14, 14], 0),
  D('Side Stick', 37, [15, 7, 7, 24, 24], 0),
  D('Snare', 38, [15, 7, 7, 0, 4], 0),
  D('Hand Clap', 39, [15, 7, 7, 17, 17], -12),
  D('Snare Tight', 40, [15, 7, 7, 8, 8], 5),
  D('Tom', 45, [15, 7, 7, 9, 9], -9, { fixed: false }),
  D('Tom High', 48, [15, 7, 7, 11, 11], 25, { fixed: false }),
  D('Hat Closed', 42, [15, 7, 7, 19, 19], 22),
  D('Hat Pedal', 44, [15, 7, 7, 21, 21], 22),
  D('Hat Open', 46, [15, 7, 7, 11, 11], 22),
  D('Crash', 49, [15, 7, 7, 0, 7], 26),
  D('Ride', 51, [15, 7, 7, 0, 7], -26),
  D('Ride Bell', 53, [15, 7, 7, 0, 7], -26),
  D('Tambourine', 54, [15, 7, 7, 21, 22], 12),
  D('Cowbell', 56, [15, 7, 7, 0, 18], 22),
  D('Bongo', 60, [15, 7, 7, 0, 16], 42, { fixed: false }),
  D('Conga', 63, [15, 7, 7, 0, 9], -35, { fixed: false }),
  D('Timbale', 65, [15, 7, 7, 0, 18], 26, { fixed: false }),
  D('Agogo', 67, [15, 7, 7, 22, 27], -41, { fixed: false }),
  D('Shaker', 70, [15, 7, 7, 0, 27], -47),
  D('Whistle', 71, [15, 7, 7, 0, 9], 43, { fixed: false }),
  D('Guiro', 73, [15, 7, 7, 0, 9], 40, { fixed: false }),
  D('Clave', 75, [15, 7, 7, 0, 18], 26),
  D('Wood Block', 76, [15, 7, 7, 23, 23], 44, { fixed: false }),
  D('Cuica', 78, [15, 7, 7, 0, 9], -26, { fixed: false }),
  D('Triangle', 81, [15, 7, 7, 19, 19], -48),
  // Showcase — sounds built around what the S-DSP does
  M('FF Echo Strings', 'Showcase', 49, 62, [6, 0, 6, 0, 16], { rate: 16000, loop: 30, splits: 2 }),
  M('Lo-Fi Orch Hit 8k', 'Showcase', 55, 62, [15, 7, 7, 14, 20], { rate: 8000, loop: 4, len: 350, splits: 1 }),
  M('Noise Wind (NON)', 'Showcase', 122, 60, [0, 0, 7, 0, 13], { noise: true, nrate: 18, env: 'gain', gmode: 'bentInc', gval: 12, vol: 70 }),
  M('Crystal Echo Bell', 'Showcase', 11, 79, [15, 7, 4, 14, 14], { rate: 24000, splits: 2 }),
  D('Noise Snare (NON)', 38, [15, 7, 7, 22, 22], 0, { noise: true, nrate: 29, vol: 60 }),
  D('Noise Hat (NON)', 42, [15, 7, 7, 26, 26], 0, { noise: true, nrate: 31, vol: 45 }),
];

// ---------------------------------------------------------------- GM mapping
const AUTO = PRESETS.map((p, i) => [p, i]).filter(([p]) => p.category !== 'Drums' && p.category !== 'Showcase' && p.src.bank === 0);
export const GM_MAP = Array.from({ length: 128 }, (_, prog) => {
  let best = -1, bd = Infinity;
  for (const [p, i] of AUTO) {
    const d = p.src.prog === prog ? -1 : Math.abs(p.src.prog - prog) + ((p.src.prog >> 3) === (prog >> 3) ? 0 : 1000);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
});
const DRUM_BY_NOTE = {
  35: 'Kick Deep', 36: 'Kick', 37: 'Side Stick', 38: 'Snare', 39: 'Hand Clap', 40: 'Snare Tight',
  41: 'Tom', 43: 'Tom', 45: 'Tom', 47: 'Tom', 48: 'Tom High', 50: 'Tom High',
  42: 'Hat Closed', 44: 'Hat Pedal', 46: 'Hat Open', 49: 'Crash', 52: 'Crash', 55: 'Crash', 57: 'Crash',
  51: 'Ride', 59: 'Ride', 53: 'Ride Bell', 54: 'Tambourine', 56: 'Cowbell', 58: 'Shaker',
  60: 'Bongo', 61: 'Bongo', 62: 'Conga', 63: 'Conga', 64: 'Conga', 65: 'Timbale', 66: 'Timbale',
  67: 'Agogo', 68: 'Agogo', 69: 'Shaker', 70: 'Shaker', 71: 'Whistle', 72: 'Whistle', 73: 'Guiro', 74: 'Guiro',
  75: 'Clave', 76: 'Wood Block', 77: 'Wood Block', 78: 'Cuica', 79: 'Cuica', 80: 'Triangle', 81: 'Triangle',
  27: 'Snare Tight', 28: 'Snare', 29: 'Shaker', 30: 'Shaker', 31: 'Side Stick', 32: 'Clave', 33: 'Side Stick', 34: 'Ride Bell',
  82: 'Shaker', 83: 'Triangle', 84: 'Triangle', 85: 'Clave', 86: 'Conga', 87: 'Conga',
};
const byName = new Map(PRESETS.map((p, i) => [p.name, i]));
export const DRUM_MAP = Array.from({ length: 128 }, (_, n) => (DRUM_BY_NOTE[n] && byName.has(DRUM_BY_NOTE[n]) ? byName.get(DRUM_BY_NOTE[n]) : -1));
export const gmPreset = (program) => GM_MAP[program & 127];
export const gmDrum = (note) => DRUM_MAP[note & 127];
