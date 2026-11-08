// Game Boy native instrument library (original designs for RetroSynths), in DMG register terms:
//   kind 'pulse' | 'wave' | 'noise'
//   pulse: duty 0–3 (NRx1), env { vol 0–15, dir 0 down / 1 up, pace 0–7 } (NRx2), optional second envelope
//          env2 { …, at: frame } re-triggered mid-note, rel (−1 let ring, 0 cut, 1–7 release pace),
//          len 0 (off) / 1–64 (NRx1 length, 1/256 s units), sweep { pace, dir (1 = down), shift } (NR10, Pulse 1)
//   wave:  wave[32] 4-bit samples (wave RAM), level 0–3 (mute/25/50/100 %, written as NR32), lvlMac, fade
//   noise: duty = width (NR43 bit 3: 0 = 15-bit, 1 = 7-bit), poly macro = index into POLY (NR43 shift/divisor,
//          sorted high→low; empty = follows the key), env/env2/rel/len as pulse
//   all:   dutyMac, arp (semitones), pitch (frequency-register offset added each frame, + = higher), vib,
//          pan 'auto' (GM pan) | 'L' | 'R' | 'LR' (NR51), panMac (1 L · 2 R · 3 both)
// Melodic presets are generated from the shared GM designs (nes-gb-design.js) so GM playback keeps its quality.

import { INST } from './nes-gb-design.js';

const FPS = 4194304 / 70224;
const mac = (values = [], loop = -1, release = -1) => ({ values, loop, release });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

// ---------------------------------------------------------------- NR43 polynomial counter settings, high → low clock
export const POLY = [];
{
  const seen = new Set();
  const all = [];
  for (let s = 0; s < 14; s++) for (let r = 0; r < 8; r++) all.push({ s, r, hz: 524288 / (r || 0.5) / (1 << s) });
  all.sort((a, b) => b.hz - a.hz);
  for (const p of all) { const k = Math.round(p.hz * 1000); if (!seen.has(k)) { seen.add(k); POLY.push(p); } }
}
export const polyNear = (hz) => { let bi = 0, be = Infinity; POLY.forEach((p, i) => { const e = Math.abs(Math.log(p.hz / hz)); if (e < be) { be = e; bi = i; } }); return bi; };
const polyOf = (nr43) => polyNear(524288 / ((nr43 & 7) || 0.5) / (1 << (nr43 >> 4)));
const tone7 = (note) => polyNear(127 * midiHz(note));       // 7-bit LFSR repeats every 127 clocks

// ---------------------------------------------------------------- wave RAM designs (32 × 4-bit)
function waveFrom(h, ph = []) {
  const y = new Float64Array(32);
  for (let k = 0; k < 32; k++) for (let n = 0; n < h.length; n++) if (h[n]) y[k] += h[n] * Math.sin(2 * Math.PI * (n + 1) * k / 32 + (ph[n] || 0));
  let lo = Infinity, hi = -Infinity; for (const v of y) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return Array.from(y, v => Math.round((v - lo) / (hi - lo) * 15));
}
export const WAVES = {
  sine: waveFrom([1]),
  pulse: Array.from({ length: 32 }, (_, k) => (k < 8 ? 15 : 0)),
  square: Array.from({ length: 32 }, (_, k) => (k < 16 ? 15 : 0)),
  saw: Array.from({ length: 32 }, (_, k) => 15 - (k >> 1)),
  piano: waveFrom([1, 0.45, 0.25, 0.12, 0.08, 0.05]),
  bell: waveFrom([1, 0, 0.5, 0, 0.35, 0, 0.2]),
  hollow: waveFrom([1, 0, 0.45, 0, 0, 0, 0.3]),
  organ: waveFrom([1, 0.7, 0.5, 0, 0.3, 0, 0, 0.25]),
  guitar: waveFrom([1, 0.6, 0.35, 0.25, 0.15, 0.1, 0.08], [0, 0.4, 0.9, 1.3, 0.2, 0.7]),
  bass: waveFrom([1, 0.5, 0.15]),
  bassbright: waveFrom([1, 0.7, 0.5, 0.35, 0.25], [0, 0.3, 0.6, 0.9, 1.2]),
  synbass: waveFrom([1, 0.5, 0.33, 0.25, 0.2, 0.16, 0.14, 0.12]),
  cello: waveFrom([1, 0.8, 0.55, 0.4, 0.3, 0.2], [0, 0.5, 1, 1.5, 2, 2.5]),
  brass: waveFrom([1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2]),
  reed: waveFrom([1, 0.1, 0.6, 0.1, 0.4, 0.1, 0.25]),
  choir: waveFrom([1, 0.35, 0.5, 0.15, 0.2], [0, 1.1, 0.4, 2.0, 0.8]),
  pad: waveFrom([1, 0.3, 0.15, 0.1]),
  fx: waveFrom([1, 0, 0.7, 0, 0, 0, 0.3], [0, 0, 1.0, 0, 0, 0, 2.2]),
  glass: waveFrom([1, 0, 0, 0.55, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0.25]),
};

// ---------------------------------------------------------------- design → native conversions
function envOf(I) {
  const S = Math.round(15 * I.s);
  const decayPace = (d, from, to) => clamp(Math.round(64 * d * Math.log(Math.max(1.5, from - to) / 0.5) / Math.max(1, from - to)), 1, 7);
  const framesFor = (steps, pace) => Math.max(1, Math.round(steps * pace * FPS / 64));
  if (I.a > 0.02) {
    const pace = clamp(Math.round(64 * I.a / 15), 1, 7);
    if (S > 0) return { env: { vol: 0, dir: 1, pace }, env2: { vol: S, dir: 0, pace: 0, at: framesFor(S, pace) } };
    return { env: { vol: 0, dir: 1, pace }, env2: { vol: 15, dir: 0, pace: decayPace(I.d, 15, 0), at: framesFor(15, pace) } };
  }
  if (S >= 14 || (S > 0 && I.d <= 0)) return { env: { vol: S, dir: 0, pace: 0 }, env2: { vol: 0, dir: 0, pace: 0, at: 0 } };
  if (S > 0) { const pd = decayPace(I.d, 15, S); return { env: { vol: 15, dir: 0, pace: pd }, env2: { vol: S, dir: 0, pace: 0, at: framesFor(15 - S, pd) } }; }
  return { env: { vol: 15, dir: 0, pace: clamp(Math.round(64 * I.d * 2.7 / 15), 1, 7) }, env2: { vol: 0, dir: 0, pace: 0, at: 0 } };
}
const relOf = (I) => (I.r < 0.03 ? 0 : clamp(Math.round(64 * I.r * 2.3 / 12), 1, 7));
const vibOf = (I) => ({ speed: 6, depth: Math.round((I.vibDepth || 0) / 0.05), delay: I.vibDelay | 0 });
function pitchMacro(I, kind) {
  const k = 0.0578 * (kind === 'wave' ? 250.5 : 501);         // register steps per semitone near middle C
  if (I.slide) return mac([Math.round(I.slide * k) || Math.sign(I.slide)], 0);
  if (I.bendIn) {
    const off = (t) => -I.bendIn * k * Math.exp(-t / 6), v = [];
    let prev = 0; for (let t = 0; t < 24; t++) { const o = Math.round(off(t)); v.push(o - prev); prev = o; }
    v.push(-prev); v.push(0); return mac(v);
  }
  return mac();
}
// software ADSR → wave output-level macro (0 mute … 3 = 100 %)
function levelMacro(I) {
  const dt = 1 / FPS, kd = I.d > 0 ? Math.exp(-dt / I.d) : 0, nat = (v) => (v >= 11 ? 3 : v >= 6 ? 2 : v >= 2 ? 1 : 0);
  let lvl = I.a > 0 ? 0 : 1, stage = I.a > 0 ? 0 : 1; const vals = [];
  for (let t = 0; t < 128; t++) {
    vals.push(nat(15 * lvl));
    if (stage === 0) { lvl += dt / I.a; if (lvl >= 1) { lvl = 1; stage = 1; } } else lvl = I.s + (lvl - I.s) * kd;
    if (stage === 1 && I.s > 0 && nat(15 * lvl) === nat(15 * I.s) && Math.abs(lvl - I.s) < 0.03) { vals.push(nat(15 * I.s)); return mac(vals, vals.length - 1); }
    if (stage === 1 && I.s <= 0 && nat(15 * lvl) === 0) { vals.push(0); return mac(vals); }
  }
  return I.s > 0 ? mac(vals, vals.length - 1) : mac([...vals, 0]);
}
const base = { arp: mac(), pitch: mac(), dutyMac: mac(), vib: { speed: 0, depth: 0, delay: 0 }, pan: 'auto', panMac: mac() };
function fromDesign(name, category, kind, prog, extra = {}) {
  const I = INST[prog];
  const common = { ...base, name, category, kind, arp: I.arpMac ? mac(I.arpMac.slice(), 0) : mac(), pitch: pitchMacro(I, kind), vib: vibOf(I),
    dutyMac: I.dmac && kind === 'pulse' ? mac(I.dmac.slice()) : mac() };
  if (kind === 'wave') return { ...common, wave: (WAVES[I.wave] || WAVES.bass).slice(), level: 3, lvlMac: levelMacro(I), fade: I.r < 0.03 ? 0 : clamp(Math.round(I.r * FPS / 1.5), 1, 15), ...extra };
  const e = envOf(I);
  const p = { ...common, duty: kind === 'noise' ? 0 : I.duty, env: e.env, env2: e.env2, rel: relOf(I), len: 0 };
  if (kind === 'pulse') { p.sweep = { pace: 0, dir: 0, shift: 0 }; p.wave = I.wave; }
  if (kind === 'noise') { p.poly = mac(); if (I.slide) { const v = []; for (let t = 0; t < 64; t++) v.push(Math.round(I.slide * t)); p.arp = mac(v); } }
  return Object.assign(p, extra);
}

const MELODIC = [
  ['Pulse 50% Grand', 'Piano', 'pulse', 0, [0, 3]],
  ['Pulse 25% Bright Keys', 'Piano', 'pulse', 1, [1, 2, 5]],
  ['Pulse 25→50 E.Piano', 'Piano', 'pulse', 4, [4]],
  ['Pulse 12.5% Harpsichord', 'Piano', 'pulse', 6, [6, 7]],
  ['Pulse 12.5% Glockenspiel', 'Chromatic', 'pulse', 9, [8, 9, 10, 112, 113]],
  ['Pulse 50% Vibraphone', 'Chromatic', 'pulse', 11, [11]],
  ['Pulse 50% Marimba', 'Chromatic', 'pulse', 12, [12, 13, 108]],
  ['Pulse 25% Tubular Bell', 'Chromatic', 'pulse', 14, [14, 15, 114]],
  ['Pulse 50% Drawbar Organ', 'Organ', 'pulse', 16, [16, 19, 20]],
  ['Pulse 12→25 Perc Organ', 'Organ', 'pulse', 17, [17, 18]],
  ['Pulse 25% Accordion', 'Organ', 'pulse', 21, [21, 22, 23]],
  ['Pulse 50% Nylon Guitar', 'Guitar', 'pulse', 24, [24, 26]],
  ['Pulse 25% Steel Guitar', 'Guitar', 'pulse', 25, [25, 27, 105, 107]],
  ['Pulse 25% Muted Pluck', 'Guitar', 'pulse', 28, [28, 115]],
  ['Pulse 12.5% Overdrive', 'Guitar', 'pulse', 30, [29, 30, 31, 84]],
  ['Wave Finger Bass', 'Bass', 'wave', 33, [32, 33, 35]],
  ['Wave Pick Bass', 'Bass', 'wave', 34, [34, 36, 37]],
  ['Wave Synth Bass', 'Bass', 'wave', 38, [38, 39]],
  ['Wave Contrabass', 'Bass', 'wave', 43, [43]],
  ['Wave Tuba', 'Bass', 'wave', 58, [58]],
  ['Pulse 25% Violin', 'Strings', 'pulse', 40, [40, 41, 110]],
  ['Pulse 50% Cello', 'Strings', 'pulse', 42, [42, 44]],
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
  ['Pulse 50% Breathy Pipe', 'Pipe', 'pulse', 75, [75, 76, 77, 78]],
  ['Pulse 50% Square Lead', 'Lead', 'pulse', 80, [80, 82]],
  ['Pulse 25% Saw Lead', 'Lead', 'pulse', 81, [81, 87]],
  ['Pulse 12→25 Chiff Lead', 'Lead', 'pulse', 83, [83]],
  ['Pulse Fifths Arp', 'Lead', 'pulse', 86, [86]],
  ['Pulse 50% Soft Pad', 'Pad', 'pulse', 88, [88, 89, 91, 94, 97, 99]],
  ['Pulse 25% Poly Pad', 'Pad', 'pulse', 90, [90, 92, 93]],
  ['Pulse Duty-Sweep Pad', 'Pad', 'pulse', 95, [95]],
  ['Pulse Octave Rain', 'FX', 'pulse', 96, [96, 100]],
  ['Pulse Crystal Arp', 'FX', 'pulse', 98, [98, 102]],
  ['Pulse Wobble Vibrato', 'FX', 'pulse', 103, [101, 103]],
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

const pulseShow = (o) => ({ ...base, kind: 'pulse', category: 'Showcase', duty: 2, env: { vol: 15, dir: 0, pace: 0 }, env2: { vol: 0, dir: 0, pace: 0, at: 0 },
  rel: 2, len: 0, sweep: { pace: 0, dir: 0, shift: 0 }, wave: 'pulse', ...o });
const SHOWCASE = [
  { ...base, name: 'Wave Glass Bells', category: 'Showcase', kind: 'wave', wave: WAVES.glass.slice(), level: 3,
    lvlMac: mac([3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]), fade: 3, arp: mac([12, 0, 0, 0], 3), vib: { speed: 5, depth: 1, delay: 10 } },
  { ...base, name: 'Wave Drawbar Organ', category: 'Showcase', kind: 'wave', wave: WAVES.organ.slice(), level: 3, lvlMac: mac([3], 0), fade: 2, vib: { speed: 6, depth: 1, delay: 20 } },
  pulseShow({ name: 'Ping-Pong Echo Lead', duty: 1, env: { vol: 13, dir: 0, pace: 3 }, env2: { vol: 7, dir: 0, pace: 3, at: 12 }, rel: -1,
    panMac: mac([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2], 12), vib: { speed: 6, depth: 2, delay: 6 } }),
  pulseShow({ name: 'Pulse 1 Sweep Zap', duty: 0, env: { vol: 15, dir: 0, pace: 2 }, rel: 0, sweep: { pace: 1, dir: 0, shift: 2 } }),
  pulseShow({ name: 'Pulse 25% Hard-Pan Arp', duty: 1, env: { vol: 12, dir: 0, pace: 0 }, rel: 1, arp: mac([0, 4, 7, 12], 0), panMac: mac([1, 2], 0) }),
];

// ---------------------------------------------------------------- drums (noise channel; Sweep Kick on Pulse 1)
// X(name, vol, pace, NR43 sequence, frames, { re: retrigger frame })
function X(name, v, p, seq, n, o = {}) {
  const widths = seq.map(b => (b >> 3) & 1), same = widths.every(w => w === widths[0]);
  const len = n * 256 / FPS <= 64 ? Math.max(1, Math.round(n * 256 / FPS)) : 0;
  return { ...base, name, category: 'Drums', kind: 'noise', duty: widths[0], dutyMac: same ? mac() : mac(widths),
    env: { vol: v, dir: 0, pace: p }, env2: o.re ? { vol: Math.round(v * 0.8), dir: 0, pace: p, at: o.re } : { vol: 0, dir: 0, pace: 0, at: 0 },
    rel: -1, len, poly: mac(seq.map(polyOf)), arp: mac() };
}
const nr = (idx, w) => (POLY[idx].s << 4) | (w << 3) | POLY[idx].r;
const t7 = (note) => nr(tone7(note), 1);
const DR = [
  X('Noise Kick', 15, 1, [0x30, t7(48), t7(40), t7(34), t7(29)], 9),
  X('Noise Deep Kick', 15, 1, [t7(50), t7(41), t7(35), t7(30), t7(26)], 9),
  X('Noise Snare', 14, 1, [0x21, 0x22, 0x32], 14),
  X('Noise Bright Snare', 15, 1, [0x11, 0x21, 0x22], 14),
  X('Noise Stick', 12, 1, [0x10], 3),
  X('Noise Clap', 13, 1, [0x21, 0x21, 0x31], 12, { re: 3 }),
  X('Noise Closed Hat', 9, 1, [0x00], 3),
  X('Noise Pedal Hat', 7, 1, [0x01], 3),
  X('Noise Open Hat', 10, 3, [0x00], 30),
  X('Noise Crash', 13, 6, [0x10, 0x20], 70),
  X('Noise China', 12, 5, [0x18, 0x20], 60),
  X('Noise Ride', 8, 4, [0x09, 0x01], 40),
  X('Noise Ride Bell', 10, 4, [0x0A], 40),
  X('Noise Shaker', 8, 1, [0x00], 5, { re: 2 }),
  X('Noise Cowbell', 10, 2, [t7(79)], 14),
  X('Noise Rattle', 10, 3, [0x31], 30, { re: 3 }),
  X('Noise Whistle', 7, 4, [t7(96)], 30),
  X('Noise Block', 11, 1, [t7(88)], 3),
  X('Noise Triangle', 7, 5, [0x08], 40),
];
const TOM = { ...base, name: 'Noise Tonal Tom', category: 'Drums', kind: 'noise', duty: 1, dutyMac: mac(), env: { vol: 13, dir: 0, pace: 2 },
  env2: { vol: 0, dir: 0, pace: 0, at: 0 }, rel: -1, len: 60, poly: mac(), arp: mac([7, 3, 0, -3, -5]) };
const SWEEP_KICK = pulseShow({ name: 'Pulse 1 Sweep Kick', category: 'Drums', duty: 2, env: { vol: 15, dir: 0, pace: 1 }, rel: -1,
  sweep: { pace: 1, dir: 1, shift: 1 }, len: 40, arp: mac([0], 0) });

export const PRESETS = [];
const GM = new Array(128).fill(0);
for (const [name, cat, kind, prog, progs] of MELODIC) { const i = PRESETS.length; PRESETS.push(fromDesign(name, cat, kind, prog)); for (const p of progs) GM[p] = i; }
for (const s of SHOWCASE) PRESETS.push(s);
for (const d of DR) PRESETS.push(d);
PRESETS.push(TOM, SWEEP_KICK);
for (let i = 0; i < PRESETS.length; i++) PRESETS[i] = JSON.parse(JSON.stringify(PRESETS[i]));   // no shared macro objects
const idx = (name) => PRESETS.findIndex(p => p.name === name);
const DRUM = {
  35: 'Noise Deep Kick', 36: 'Noise Kick', 37: 'Noise Stick', 38: 'Noise Snare', 39: 'Noise Clap', 40: 'Noise Bright Snare',
  42: 'Noise Closed Hat', 44: 'Noise Pedal Hat', 46: 'Noise Open Hat', 49: 'Noise Crash', 57: 'Noise Crash', 55: 'Noise Crash', 52: 'Noise China',
  51: 'Noise Ride', 59: 'Noise Ride', 53: 'Noise Ride Bell', 54: 'Noise Shaker', 69: 'Noise Shaker', 70: 'Noise Shaker', 82: 'Noise Shaker',
  56: 'Noise Cowbell', 67: 'Noise Cowbell', 68: 'Noise Cowbell', 58: 'Noise Rattle', 73: 'Noise Rattle', 74: 'Noise Rattle',
  71: 'Noise Whistle', 72: 'Noise Whistle', 78: 'Noise Whistle', 79: 'Noise Whistle', 75: 'Noise Block', 76: 'Noise Block', 77: 'Noise Block',
  80: 'Noise Triangle', 81: 'Noise Triangle',
};
for (const n of [41, 43, 45, 47, 48, 50, 60, 61, 62, 63, 64, 65, 66]) DRUM[n] = 'Noise Tonal Tom';
export const GM_MAP = GM;
export const DRUM_MAP = {};
for (const [n, name] of Object.entries(DRUM)) DRUM_MAP[n] = idx(name);
export const gmDrum = (note) => (DRUM_MAP[note] != null ? DRUM_MAP[note] : note >= 27 && note <= 87 ? idx('Noise Snare') : -1);
