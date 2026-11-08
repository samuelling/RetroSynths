// NES native instrument library (original designs for RetroSynths), in 2A03 / FamiTracker terms:
//   kind 'pulse' | 'triangle' | 'noise' | 'dpcm'
//   duty 0–3 (12.5/25/50/75 %; for noise: 0 = long LFSR, 1 = short "mode" bit of $400E)
//   vol / arp / pitch / dutyMac / xMac: macros { values, loop, release } stepped once per frame
//     vol 0–15 · arp semitones · pitch = timer-period offset added each frame (+ = lower, like FamiTracker)
//     xMac (noise only) = absolute period index 0–15 written to $400E (empty → follows the key)
//   fade: release fade in frames per volume step when the volume macro has no release point (0 = cut)
//   vib { speed, depth, delay }, sweep { en, period, neg, shift } ($4001, pulse)
//   dpcm: sample, rate 0–15 ($4010), loop, track (rate follows key; ref = key that plays `rate`),
//         level ($4011 load at note start, −1 = none), layer (index of another preset played with it)
// Melodic presets are generated from the shared GM designs (nes-gb-design.js) so GM playback keeps its quality.

import { INST } from './nes-gb-design.js';

const FPS = (39375000 / 22) / 29780.5;
const mac = (values = [], loop = -1, release = -1) => ({ values, loop, release });
const T60 = { pulse: 426.6, triangle: 212.8 };       // timer period at middle C (pitch-macro scale)

function volMacro(I, maxLen = 128) {
  const dt = 1 / FPS, kd = I.d > 0 ? Math.exp(-dt / I.d) : 0;
  let lvl = I.a > 0 ? 0 : 1, stage = I.a > 0 ? 0 : 1;
  const trem = (t) => (I.trem ? 1 - I.trem * 0.5 * (1 + Math.sin(2 * Math.PI * I.tremRate * t * dt)) : 1);
  const S = Math.round(15 * I.s), vals = [];
  for (let t = 0; t < maxLen; t++) {
    vals.push(Math.round(15 * lvl * trem(t)));
    if (stage === 0) { lvl += dt / I.a; if (lvl >= 1) { lvl = 1; stage = 1; } } else lvl = I.s + (lvl - I.s) * kd;
    if (stage !== 1) continue;
    if (I.s > 0 && Math.abs(15 * (lvl - I.s)) < 0.5) {
      if (!I.trem || I.tremRate < 2) { if (vals[vals.length - 1] !== S) vals.push(S); return mac(vals, vals.length - 1); }
      const P = Math.max(2, Math.round(FPS / I.tremRate)), lp = vals.length;
      for (let k = 0; k < P; k++) vals.push(Math.round(15 * I.s * trem(lp + k)));
      return mac(vals, lp);
    }
    if (I.s <= 0 && Math.round(15 * lvl) === 0) { vals.push(0); return mac(vals); }
  }
  if (I.s > 0) return mac(vals, vals.length - 1);
  for (let k = 0; k < 10; k++) vals[maxLen - 10 + k] = Math.round(vals[maxLen - 11] * (9 - k) / 10);
  return mac(vals);
}
const fadeOf = (I) => (I.r < 0.03 ? 0 : Math.max(1, Math.min(15, Math.round(I.r * FPS / 4))));
function pitchMacro(I, kind) {
  const t60 = T60[kind] || 426.6, k = 0.0578 * t60;
  if (I.slide) return mac([Math.round(-I.slide * k) || Math.sign(-I.slide)], 0);
  if (I.bendIn) {
    const off = (t) => I.bendIn * k * Math.exp(-t / 6), v = [];
    let prev = 0; for (let t = 0; t < 24; t++) { const o = Math.round(off(t)); v.push(o - prev); prev = o; }
    v.push(-prev); v.push(0); return mac(v);
  }
  return mac();
}
const vibOf = (I) => ({ speed: 6, depth: Math.round((I.vibDepth || 0) / 0.05), delay: I.vibDelay | 0 });

/** a native preset from a GM design program */
function fromDesign(name, category, kind, prog, extra = {}) {
  const I = INST[prog];
  const p = {
    name, category, kind,
    duty: kind === 'noise' ? 0 : I.duty, dutyMac: I.dmac ? mac(I.dmac.slice()) : mac(),
    vol: volMacro(I), fade: fadeOf(I),
    arp: I.arpMac ? mac(I.arpMac.slice(), 0) : mac(),
    pitch: kind === 'noise' ? mac() : pitchMacro(I, kind),
    vib: vibOf(I), sweep: { en: 0, period: 0, neg: 1, shift: 0 }, xMac: mac(),
  };
  if (kind === 'noise' && I.slide) { const v = []; for (let t = 0; t < 64; t++) v.push(Math.round(I.slide * t)); p.arp = mac(v); }
  return Object.assign(p, extra);
}

// ---------------------------------------------------------------- melodic library: [name, category, kind, design program, GM programs]
const MELODIC = [
  ['Pulse 50% Grand', 'Piano', 'pulse', 0, [0, 3]],
  ['Pulse 25% Bright Keys', 'Piano', 'pulse', 1, [1, 2, 5]],
  ['Pulse 25→50 E.Piano', 'Piano', 'pulse', 4, [4]],
  ['Pulse 12.5% Harpsichord', 'Piano', 'pulse', 6, [6, 7]],
  ['Pulse 12.5% Glockenspiel', 'Chromatic', 'pulse', 9, [8, 9, 10, 112, 113]],
  ['Pulse 50% Vibes Tremolo', 'Chromatic', 'pulse', 11, [11]],
  ['Pulse 50% Marimba', 'Chromatic', 'pulse', 12, [12, 13, 108]],
  ['Pulse 25% Tubular Bell', 'Chromatic', 'pulse', 14, [14, 15, 114]],
  ['Pulse 50% Drawbar Organ', 'Organ', 'pulse', 16, [16, 19, 20]],
  ['Pulse 12→25 Perc Organ', 'Organ', 'pulse', 17, [17, 18]],
  ['Pulse 25% Accordion', 'Organ', 'pulse', 21, [21, 22, 23]],
  ['Pulse 50% Nylon Guitar', 'Guitar', 'pulse', 24, [24, 26]],
  ['Pulse 25% Steel Guitar', 'Guitar', 'pulse', 25, [25, 27, 105, 107]],
  ['Pulse 25% Muted Pluck', 'Guitar', 'pulse', 28, [28, 115]],
  ['Pulse 12.5% Overdrive', 'Guitar', 'pulse', 30, [29, 30, 31, 84]],
  ['Tri Finger Bass', 'Bass', 'triangle', 33, [32, 33, 35, 43]],
  ['Tri Pick Bass', 'Bass', 'triangle', 34, [34, 36, 37]],
  ['Tri Synth Bass', 'Bass', 'triangle', 38, [38, 39]],
  ['Tri Tuba', 'Bass', 'triangle', 58, [58]],
  ['Pulse 25% Violin', 'Strings', 'pulse', 40, [40, 41, 110]],
  ['Pulse 50% Cello', 'Strings', 'pulse', 42, [42]],
  ['Pulse 25% Tremolo Strings', 'Strings', 'pulse', 44, [44]],
  ['Pulse 25% Harp', 'Strings', 'pulse', 46, [45, 46]],
  ['Pulse 50% Timpani', 'Strings', 'pulse', 47, [47]],
  ['Pulse 25% String Section', 'Ensemble', 'pulse', 48, [48, 49]],
  ['Pulse 12→25 Synth Strings', 'Ensemble', 'pulse', 50, [50, 51]],
  ['Pulse 50% Choir', 'Ensemble', 'pulse', 52, [52, 53, 54, 85]],
  ['Pulse 12.5% Orchestra Hit', 'Ensemble', 'pulse', 55, [55]],
  ['Pulse 25% Trumpet', 'Brass', 'pulse', 56, [56, 61]],
  ['Pulse 50% Trombone', 'Brass', 'pulse', 57, [57, 60]],
  ['Pulse 12.5% Muted Trumpet', 'Brass', 'pulse', 59, [59]],
  ['Pulse Duty-Swell Brass', 'Brass', 'pulse', 62, [62, 63]],
  ['Pulse 25% Sax', 'Reed', 'pulse', 64, [64, 65, 66, 67, 109]],
  ['Pulse 12.5% Oboe', 'Reed', 'pulse', 68, [68, 69, 111]],
  ['Pulse 25% Bassoon', 'Reed', 'pulse', 70, [70]],
  ['Pulse 50% Clarinet', 'Reed', 'pulse', 71, [71]],
  ['Pulse 50% Flute', 'Pipe', 'pulse', 73, [72, 73, 74, 79]],
  ['Pulse 50% Breathy Pipe', 'Pipe', 'pulse', 75, [75, 76, 77]],
  ['Pulse 50% Whistle', 'Pipe', 'pulse', 78, [78]],
  ['Pulse 50% Square Lead', 'Lead', 'pulse', 80, [80, 82]],
  ['Pulse 25% Saw Lead', 'Lead', 'pulse', 81, [81, 87]],
  ['Pulse 12→25 Chiff Lead', 'Lead', 'pulse', 83, [83]],
  ['Pulse Fifths Arp', 'Lead', 'pulse', 86, [86]],
  ['Pulse 50% Soft Pad', 'Pad', 'pulse', 88, [88, 89, 91, 94, 97, 99]],
  ['Pulse 25% Poly Pad', 'Pad', 'pulse', 90, [90, 92]],
  ['Pulse 12.5% Metal Pad', 'Pad', 'pulse', 93, [93]],
  ['Pulse Duty-Sweep Pad', 'Pad', 'pulse', 95, [95]],
  ['Pulse Octave Rain', 'FX', 'pulse', 96, [96, 100]],
  ['Pulse Crystal Arp', 'FX', 'pulse', 98, [98]],
  ['Pulse Wobble Vibrato', 'FX', 'pulse', 103, [101, 103]],
  ['Pulse Echo Tremolo', 'FX', 'pulse', 102, [102]],
  ['Pulse 12.5% Sitar Bend', 'Ethnic', 'pulse', 104, [104, 106]],
  ['Pulse Pitch-Drop Tom', 'Percussive', 'pulse', 117, [116, 117, 118]],
  ['Noise Reverse Swell', 'SFX', 'noise', 119, [119]],
  ['Noise Breath', 'SFX', 'noise', 121, [120, 121]],
  ['Noise Surf', 'SFX', 'noise', 122, [122, 126]],
  ['Pulse Bird Chirp', 'SFX', 'pulse', 123, [123]],
  ['Pulse Phone Trill', 'SFX', 'pulse', 124, [124]],
  ['Noise Rotor', 'SFX', 'noise', 125, [125]],
  ['Noise Gunshot', 'SFX', 'noise', 127, [127]],
];

// ---------------------------------------------------------------- showcase sounds unique to the 2A03
const SHOWCASE = [
  { name: 'Pulse Duty-Sweep Lead', category: 'Showcase', kind: 'pulse', duty: 2,
    dutyMac: mac([0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 1, 1, 1], 0), vol: mac([15, 14, 13, 12, 12, 11], 5), fade: 2,
    arp: mac(), pitch: mac(), vib: { speed: 6, depth: 4, delay: 18 }, sweep: { en: 0, period: 0, neg: 1, shift: 0 }, xMac: mac() },
  { name: 'Pulse Sweep Laser', category: 'Showcase', kind: 'pulse', duty: 0, dutyMac: mac([0, 1, 2], 0),
    vol: mac([15, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]), fade: 0, arp: mac([12, 0]), pitch: mac(),
    vib: { speed: 0, depth: 0, delay: 0 }, sweep: { en: 1, period: 0, neg: 0, shift: 3 }, xMac: mac() },
  { name: 'Tri Lead', category: 'Showcase', kind: 'triangle', duty: 0, dutyMac: mac(),
    vol: mac([15], 0), fade: 1, arp: mac(), pitch: mac(), vib: { speed: 7, depth: 4, delay: 16 },
    sweep: { en: 0, period: 0, neg: 1, shift: 0 }, xMac: mac() },
  { name: 'DPCM Saw Bass', category: 'Showcase', kind: 'dpcm', sample: 'Saw Loop', rate: 15, loop: 1, track: 1, ref: 60, level: 0, layer: -1 },
];

// ---------------------------------------------------------------- drums
// noise drum macro: period index p0→p1 over n frames, volume v·(1−x)^curve·pat, mode bit
function nz(name, p0, p1, n, v, o = {}) {
  const vols = [], per = [], mode = [];
  for (let f = 0; f < n; f++) {
    const x = f / n; let vol = v * Math.pow(1 - x, o.curve || 1);
    if (o.pat) vol *= o.pat[Math.min(f, o.pat.length - 1)];
    vols.push(Math.min(15, Math.round(vol))); per.push(Math.round(p0 + (p1 - p0) * x));
    mode.push(o.then === 0 && f >= 3 ? 0 : o.mode || 0);
  }
  vols.push(0);
  const same = mode.every(m => m === mode[0]);
  return { name, category: 'Drums', kind: 'noise', duty: mode[0], dutyMac: same ? mac() : mac(mode), vol: mac(vols), fade: 0,
    arp: mac(), pitch: mac(), vib: { speed: 0, depth: 0, delay: 0 }, sweep: { en: 0, period: 0, neg: 1, shift: 0 }, xMac: mac(per) };
}
const DR = [
  nz('Noise Kick Click', 10, 13, 3, 9),
  nz('Noise Snare', 5, 7, 12, 14),
  nz('Noise Tom Hit', 9, 10, 2, 6),
  nz('Noise Kick', 12, 15, 7, 15),
  nz('Noise Closed Hat', 0, 1, 3, 9),
  nz('Noise Pedal Hat', 1, 1, 3, 7),
  nz('Noise Open Hat', 0, 1, 14, 9, { curve: 1.3 }),
  nz('Noise Crash', 2, 4, 55, 12, { curve: 1.6 }),
  nz('Noise Ride Ping', 1, 1, 24, 8, { mode: 1, curve: 1.4, then: 0 }),
  nz('Noise Ride Bell', 2, 2, 22, 10, { mode: 1, curve: 1.3 }),
  nz('Noise Stick', 2, 3, 2, 12),
  nz('Noise Clap', 4, 5, 10, 13, { pat: [1, 0.3, 1, 0.3, 1, 1, 1, 1, 1, 1] }),
  nz('Noise Shaker', 0, 0, 6, 9, { pat: [1, 0.5, 1, 0.8, 0.6, 0.4] }),
  nz('Noise Cowbell', 3, 3, 10, 10, { mode: 1 }),
  nz('Noise Rattle', 5, 6, 16, 9, { pat: [1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3] }),
  nz('Noise Whistle', 0, 0, 20, 7, { mode: 1 }),
  nz('Noise Block', 2, 2, 2, 11, { mode: 1 }),
  nz('Noise Triangle', 0, 0, 30, 7, { mode: 1, curve: 1.3 }),
];
const dp = (name, sample, rate, layer, o = {}) => ({ name, category: 'Drums', kind: 'dpcm', sample, rate, loop: 0, track: 0, ref: 60, level: -1, layer, ...o });

// ---------------------------------------------------------------- assemble
export const PRESETS = [];
const GM = new Array(128).fill(0);
for (const [name, cat, kind, prog, progs] of MELODIC) { const i = PRESETS.length; PRESETS.push(fromDesign(name, cat, kind, prog)); for (const p of progs) GM[p] = i; }
for (const s of SHOWCASE) PRESETS.push(s);
const idx = (name) => PRESETS.findIndex(p => p.name === name);
for (const d of DR) PRESETS.push(d);
PRESETS.push(dp('DPCM Kick', 'Kick', 15, idx('Noise Kick Click')));
PRESETS.push(dp('DPCM Deep Kick', 'Kick', 14, idx('Noise Kick Click')));
PRESETS.push(dp('DPCM Snare', 'Snare', 15, idx('Noise Snare')));
PRESETS.push(dp('DPCM Tom', 'Tom', 15, idx('Noise Tom Hit'), { track: 1, ref: 50 }));
PRESETS.push(dp('DPCM Conga', 'Tom', 15, -1, { track: 1, ref: 66 }));
PRESETS.push({ name: 'Tri Kick', category: 'Drums', kind: 'triangle', duty: 0, dutyMac: mac(), vol: mac([15, 15, 15, 15, 15, 15, 15, 0]), fade: 0,
  arp: mac([12, 0], 1), pitch: mac([0, 20, 40, 60, 90, 120, 160, 0]), vib: { speed: 0, depth: 0, delay: 0 }, sweep: { en: 0, period: 0, neg: 1, shift: 0 }, xMac: mac() });

for (let i = 0; i < PRESETS.length; i++) PRESETS[i] = JSON.parse(JSON.stringify(PRESETS[i]));   // no shared macro objects

const DRUM = {
  35: 'DPCM Deep Kick', 36: 'DPCM Kick', 37: 'Noise Stick', 38: 'DPCM Snare', 39: 'Noise Clap', 40: 'DPCM Snare',
  41: 'DPCM Tom', 43: 'DPCM Tom', 45: 'DPCM Tom', 47: 'DPCM Tom', 48: 'DPCM Tom', 50: 'DPCM Tom',
  42: 'Noise Closed Hat', 44: 'Noise Pedal Hat', 46: 'Noise Open Hat', 49: 'Noise Crash', 52: 'Noise Crash', 55: 'Noise Crash', 57: 'Noise Crash',
  51: 'Noise Ride Ping', 59: 'Noise Ride Ping', 53: 'Noise Ride Bell', 54: 'Noise Shaker', 69: 'Noise Shaker', 70: 'Noise Shaker', 82: 'Noise Shaker',
  56: 'Noise Cowbell', 67: 'Noise Cowbell', 68: 'Noise Cowbell', 58: 'Noise Rattle', 73: 'Noise Rattle', 74: 'Noise Rattle',
  60: 'DPCM Conga', 61: 'DPCM Conga', 62: 'DPCM Conga', 63: 'DPCM Conga', 64: 'DPCM Conga', 65: 'DPCM Conga', 66: 'DPCM Conga',
  71: 'Noise Whistle', 72: 'Noise Whistle', 78: 'Noise Whistle', 79: 'Noise Whistle', 75: 'Noise Block', 76: 'Noise Block', 77: 'Noise Block',
  80: 'Noise Triangle', 81: 'Noise Triangle',
};
export const GM_MAP = GM;
export const DRUM_MAP = {};
for (const [n, name] of Object.entries(DRUM)) DRUM_MAP[n] = idx(name);
export const gmDrum = (note) => (DRUM_MAP[note] != null ? DRUM_MAP[note] : note >= 27 && note <= 87 ? idx('Noise Snare') : -1);
export const SAMPLE_NAMES = ['Kick', 'Snare', 'Tom', 'Clap', 'Saw Loop', 'Square Loop'];
