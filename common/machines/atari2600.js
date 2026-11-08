// Atari 2600 (VCS) — TIA audio driven by a 2-voice, frame-rate music driver.
//
// The TIA can only make a few dozen pitches per distortion mode (31.4 kHz ÷ (AUDF+1) ÷ the mode's
// pattern length), so — like 2600 composers working from pitch charts — the driver picks, per note,
// the AUDC/AUDF pair nearest in pitch among the instrument's distortion mode and its fallbacks
// (optionally an octave away), and lives with the error. Instruments are native: AUDC mode, 4-bit
// volume macro, arpeggio/pitch macros, and per-frame AUDC/AUDF macros for drums. AUD0/AUD1 go to
// melody and bass; drums interrupt the bass for a few frames and the bass resumes.
// Original code for RetroSynths.
import { Resampler, DCBlock, drumKind } from './util.js';
import { TIA, TIA_RATE, TIA_FRAME_CLOCKS, MODE_PERIOD, tiaHz } from './tia.js';
import { Driver, CLASS, DRUM_PRIO, mac, envMacro, pitchMacro, qLin, gmTable } from './atari-driver.js';

const RANK_CENTS = 14;     // cost of using a fallback mode, in cents of pitch error
const OCT_CENTS = 40;      // cost per octave of substitution
export const AUDC_NAMES = ['0 · set to 1 (volume only)', '1 · 4-bit poly (buzz)', '2 · ÷15 → 4-bit poly (drone)', '3 · 5-bit → 4-bit poly (drone)',
  '4 · ÷2 pure (high square)', '5 · ÷2 pure (high square)', '6 · ÷31 pure (bass square)', '7 · 5-bit poly → ÷2 (buzzy)',
  '8 · 9-bit poly (white noise)', '9 · 5-bit poly (tone noise)', '10 · ÷31 pure (bass)', '11 · set last 4 bits to 1 (volume only)',
  '12 · ÷6 pure (lead)', '13 · ÷6 pure (lead)', '14 · ÷93 pure (low)', '15 · 5-bit poly ÷6 (rumble)'];
/** Modes whose AUDF is a colour, not a pitch. */
export const NOISE_MODE = (c) => c === 8 || c === 0 || c === 11;

/** Nearest AUDF in one mode for a frequency → [AUDF, cents error]. */
export function nearestF(mode, hz, out = [0, 0]) {
  const P = MODE_PERIOD[mode];
  if (!P) { out[0] = 0; out[1] = 1200; return out; }
  let F = Math.round(TIA_RATE / (P * hz)) - 1;
  F = F < 0 ? 0 : F > 31 ? 31 : F;
  let best = F, be = Infinity;
  for (let f = Math.max(0, F - 1); f <= Math.min(31, F + 1); f++) {
    const e = Math.abs(1200 * Math.log2(tiaHz(mode, f) / hz));
    if (e < be) { be = e; best = f; }
  }
  out[0] = best; out[1] = be;
  return out;
}
const OCTS = [0, -12, 12, -24, -36, -48];
/** Choose AUDC/AUDF (and octave substitution) for a MIDI pitch. → { audc, audf, oct, cents } */
export function pickTone(modes, semis, allowOct = true) {
  const hz = 440 * Math.pow(2, (semis - 69) / 12), tmp = [0, 0];
  let best = null, bc = Infinity;
  for (let r = 0; r < modes.length; r++) {
    if (!MODE_PERIOD[modes[r]]) continue;
    for (const oct of allowOct ? OCTS : [0]) {
      nearestF(modes[r], hz * Math.pow(2, oct / 12), tmp);
      const cost = tmp[1] + r * RANK_CENTS + Math.abs(oct / 12) * OCT_CENTS;
      if (cost < bc) { bc = cost; best = { audc: modes[r], audf: tmp[0], oct, cents: tmp[1] }; }
    }
  }
  return best || { audc: modes[0] | 0, audf: 0, oct: 0, cents: 1200 };
}

// ---------------------------------------------------------------- native instrument library
const Q = qLin(15);
function mel(name, category, cls, audc, alt, x = {}) {
  const c = CLASS[cls], env = x.env || c.env, vib = x.vib !== undefined ? x.vib : c.vib;
  return {
    name, category, kind: 'any', role: x.role || c.role, drum: false,
    audc, alt, octSub: x.octSub !== undefined ? x.octSub : true,
    vol: envMacro(env, Q, { trem: x.trem || c.trem }),
    arp: c.trill ? mac([0, 0, c.trill, c.trill], 0) : mac(),
    pitch: pitchMacro({ sweep: x.sweep !== undefined ? x.sweep : c.sweep, bird: c.bird }),
    dist: mac(), freq: mac(),
    rel: Math.max(1, Math.round(env[3] * 60)),
    vibDelay: vib ? Math.round(vib[0] * 60) : 0, vibDepth: vib ? Math.round(vib[1] * 100) : 0, vibRate: vib ? vib[2] : 5.5,
  };
}
const dec = (c, f, v0, n, k = 0.72, df = 0) => Array.from({ length: n }, (_, i) => [c, Math.min(31, Math.round(f + df * i)), v0 * Math.pow(k, i)]);
function drum(name, kind, fr, x = {}) {
  return {
    name, category: 'Drums', kind: 'any', role: 'drum', drum: true, prio: DRUM_PRIO[kind] ?? 46,
    choke: kind.startsWith('hat') ? 'hat' : '', track: !!x.track, audc: fr[0][0], alt: [], octSub: false,
    vol: mac(fr.map((f) => Q(Math.min(1, 1.12 * f[2])))), dist: mac(fr.map((f) => f[0])), freq: mac(fr.map((f) => f[1])),
    arp: mac(), pitch: mac(), rel: 1, vibDelay: 0, vibDepth: 0, vibRate: 5.5,
  };
}

const PRESETS = [
  // leads
  mel('Div6 Pure Lead', 'Lead', 'square', 12, [4, 6]),
  mel('Poly4 Saw Lead', 'Lead', 'saw', 1, [12, 6]),
  mel('Poly5 Buzz Lead', 'Lead', 'dist', 7, [1], { env: [0.003, 0.5, 0.8, 0.1] }),
  mel('Div2 High Square', 'Lead', 'square', 4, [12], { octSub: true }),
  mel('Div6 Flute', 'Lead', 'flute', 12, [4, 6]),
  mel('Poly4 Reed', 'Lead', 'reed', 1, [12, 6]),
  mel('Poly4 Brass', 'Brass', 'brass', 1, [12, 6]),
  mel('Div6 Brass Swell', 'Brass', 'brass', 12, [6], { env: [0.08, 0.3, 0.8, 0.15] }),
  // keys / mallets
  mel('Div6 Piano Decay', 'Keys', 'piano', 12, [4, 6]),
  mel('Div6 E.Piano', 'Keys', 'epiano', 12, [4, 6]),
  mel('Poly4 Harpsi Pluck', 'Keys', 'harpsi', 1, [12]),
  mel('Div6 Organ', 'Keys', 'organ', 12, [6, 4]),
  mel('Div2 Bell', 'Chromatic', 'bell', 4, [12]),
  mel('Div2 Vibes Tremolo', 'Chromatic', 'vibes', 4, [12]),
  mel('Div6 Mallet', 'Chromatic', 'mallet', 12, [4]),
  // plucked / strings / pads
  mel('Div6 Pluck', 'Guitar', 'pluck', 12, [1, 6]),
  mel('Poly5 Dist Guitar', 'Guitar', 'dist', 7, [1]),
  mel('Poly4 Strings', 'Strings', 'string', 1, [12, 6]),
  mel('Div6 Pad', 'Pad', 'pad', 12, [6]),
  mel('Div6 Voice', 'Pad', 'voice', 12, [6]),
  mel('Poly4 Orchestra Hit', 'Strings', 'hit', 1, [12]),
  // bass
  mel('Div31 Bass', 'Bass', 'bass', 6, [14, 1]),
  mel('Poly4 Synth Bass', 'Bass', 'synbass', 1, [6, 15]),
  mel('Div93 Sub Bass', 'Bass', 'bass', 14, [6], { env: [0.002, 0.8, 0.6, 0.1] }),
  mel('Poly5 Rumble Bass', 'Bass', 'synbass', 15, [7, 6]),
  mel('Div31 Timpani', 'Bass', 'timpani', 6, [14]),
  // melodic percussion & FX
  mel('Div31 Tom Sweep', 'Percussive', 'tomperc', 6, [14, 12]),
  mel('Div2 Wood Block', 'Percussive', 'block', 4, [12]),
  mel('Poly9 Surf', 'FX', 'noise', 8, [], { env: [0.8, 1.0, 0.7, 1.0], trem: [0.25, 0.7] }),
  mel('Poly9 Noise Hit', 'FX', 'noise', 8, [], { env: [0.001, 0.5, 0, 0.1] }),
  mel('Poly9 Noise Swell', 'FX', 'noise', 8, [], { env: [1.0, 0.1, 0.8, 0.3] }),
  mel('Poly5>Poly4 Engine', 'FX', 'noise', 3, [2], { env: [0.3, 0.3, 0.9, 0.5], trem: [12, 0.6] }),
  mel('Div31>Poly4 Drone', 'FX', 'pad', 2, [3]),
  mel('Div2 Bird Chirp', 'FX', 'bird', 4, [12]),
  mel('Div2 Phone Trill', 'FX', 'phone', 4, [12]),
  // drums (per-frame AUDC / AUDF / AUDV tables)
  drum('Kick Div31 Drop', 'kick', [[6, 6, 1], [6, 9, 0.92], [6, 13, 0.78], [6, 17, 0.62], [6, 22, 0.46], [6, 27, 0.3], [6, 31, 0.17], [6, 31, 0.08]]),
  drum('Kick Div31 Deep', 'kick', [[6, 8, 1], [6, 11, 0.92], [6, 15, 0.78], [6, 19, 0.62], [6, 24, 0.46], [6, 29, 0.3], [6, 31, 0.17], [6, 31, 0.08]]),
  drum('Snare Poly9', 'snare', [[8, 6, 1], [8, 7, 0.86], [8, 8, 0.7], [8, 9, 0.55], [8, 10, 0.42], [8, 11, 0.3], [8, 12, 0.2], [8, 13, 0.12], [8, 14, 0.06]]),
  drum('Snare Div6+Poly9', 'snare', [[12, 7, 0.9], [8, 6, 1], [8, 7, 0.86], [8, 8, 0.7], [8, 9, 0.55], [8, 10, 0.42], [8, 11, 0.3], [8, 12, 0.2], [8, 13, 0.12]]),
  drum('Clap Poly9', 'clap', [[8, 3, 0.9], [8, 3, 0.3], [8, 3, 0.85], [8, 3, 0.3], ...dec(8, 4, 0.75, 7, 0.68)]),
  drum('Side Stick', 'stick', [[8, 1, 1], [4, 6, 0.7], [4, 6, 0.35]]),
  drum('Hat Closed Poly9', 'hatClosed', [[8, 0, 0.85], [8, 0, 0.45], [8, 0, 0.18]]),
  drum('Hat Pedal Poly9', 'hatPedal', [[8, 0, 0.7], [8, 0, 0.35], [8, 0, 0.14]]),
  drum('Hat Open Poly9', 'hatOpen', dec(8, 0, 0.55, 18, 0.86)),
  drum('Crash Poly9', 'crash', dec(8, 1, 0.85, 48, 0.94)),
  drum('Ride Div2+Poly9', 'ride', [[4, 3, 0.45], ...dec(8, 0, 0.4, 24, 0.9)]),
  drum('Shaker Poly9', 'shaker', [[8, 0, 0.28], [8, 0, 0.36], [8, 0, 0.2], [8, 0, 0.08]]),
  drum('Cowbell Div2', 'cowbell', dec(4, 19, 0.8, 9, 0.75)),
  drum('Bell Div2', 'bell', dec(4, 8, 0.7, 22, 0.88)),
  drum('Triangle Div2', 'triangle', dec(4, 3, 0.55, 6, 0.7)),
  drum('Triangle Div2 Open', 'triangle', dec(4, 3, 0.55, 36, 0.93)),
  drum('Tom Div31 (tracks)', 'tom', dec(6, 0, 1, 12, 0.78, 0.5), { track: true }),
  drum('Conga Div6 (tracks)', 'conga', dec(12, 0, 0.85, 6, 0.65), { track: true }),
  drum('Perc Div2 (tracks)', 'block', [[4, 0, 0.75], [4, 0, 0.3], [4, 0, 0.1]], { track: true }),
  drum('Rattle Poly5', 'perc', dec(9, 4, 0.7, 20, 0.88)),
  drum('Scrape Poly9', 'perc', Array.from({ length: 10 }, (_, i) => [8, 5, i & 1 ? 0.1 : 0.55])),
];

const GM = gmTable(PRESETS, [
  ['Div6 Piano Decay', [0, 1, 2, 3]], ['Div6 E.Piano', [4, 5]], ['Poly4 Harpsi Pluck', [6, 7]],
  ['Div2 Bell', [8, 9, 10, 14, 31, 93, 96, 98, 100, 103, 108, 112]], ['Div2 Vibes Tremolo', [11]], ['Div6 Mallet', [12, 13, 113, 114]],
  ['Div6 Organ', [16, 17, 18, 19, 20]], ['Poly4 Reed', [21, 22, 23, 64, 65, 66, 67, 68, 69, 70, 71, 109, 111]],
  ['Div6 Pluck', [15, 24, 25, 26, 27, 28, 45, 46, 99, 104, 105, 106, 107]], ['Poly5 Dist Guitar', [29, 30, 84]],
  ['Div31 Bass', [32, 33, 34, 35, 36, 37, 43, 58]], ['Poly4 Synth Bass', [38, 39, 87]],
  ['Poly4 Strings', [40, 41, 42, 44, 48, 49, 110]], ['Div6 Pad', [50, 51, 88, 89, 92, 95, 97, 101, 102]],
  ['Div6 Voice', [52, 53, 54, 85, 91, 94]], ['Poly4 Orchestra Hit', [55]], ['Poly4 Brass', [56, 57, 59, 61, 62, 63]], ['Div6 Brass Swell', [60]],
  ['Div6 Flute', [72, 73, 74, 75, 76, 77, 78, 79, 82, 83]], ['Div6 Pure Lead', [80]], ['Poly4 Saw Lead', [81, 86, 90]],
  ['Div31 Timpani', [47, 116]], ['Div31 Tom Sweep', [117, 118]], ['Div2 Wood Block', [115]],
  ['Poly9 Noise Swell', [119, 121]], ['Poly9 Noise Hit', [120, 127]], ['Poly9 Surf', [122, 126]], ['Poly5>Poly4 Engine', [125]],
  ['Div2 Bird Chirp', [123]], ['Div2 Phone Trill', [124]],
]);
const PI = (n) => PRESETS.findIndex((p) => p.name === n);
const DRUMS = new Int16Array(128).fill(-1);
for (let n = 27; n <= 87; n++) {
  const k = drumKind(n);
  const name = n === 35 ? 'Kick Div31 Deep' : n === 40 ? 'Snare Div6+Poly9' : n === 81 ? 'Triangle Div2 Open' : n === 58 ? 'Rattle Poly5' : (n === 73 || n === 74) ? 'Scrape Poly9' :
    { kick: 'Kick Div31 Drop', snare: 'Snare Poly9', clap: 'Clap Poly9', stick: 'Side Stick', hatClosed: 'Hat Closed Poly9', hatPedal: 'Hat Pedal Poly9',
      hatOpen: 'Hat Open Poly9', crash: 'Crash Poly9', ride: 'Ride Div2+Poly9', shaker: 'Shaker Poly9', cowbell: 'Cowbell Div2', bell: 'Bell Div2',
      triangle: 'Triangle Div2', tom: 'Tom Div31 (tracks)', conga: 'Conga Div6 (tracks)', block: 'Perc Div2 (tracks)', perc: 'Perc Div2 (tracks)' }[k];
  DRUMS[n] = PI(name);
}

export default class Atari2600 extends Driver {
  static info = {
    id: 'atari2600', name: 'Atari 2600', maker: 'Atari', year: 1977,
    chip: 'TIA (Television Interface Adaptor)', voices: '2 × 5-bit divider · 4/5/9-bit polys',
    spec: 'two TIA channels at 31.4 kHz; nearest-pitch AUDC/AUDF tables, out of tune by design',
  };
  static voices = [{ id: 'aud0', name: 'AUD0', kind: 'tia' }, { id: 'aud1', name: 'AUD1', kind: 'tia' }];
  static presets = PRESETS;
  static gmPreset(p) { return GM[p & 127]; }
  static gmDrum(n) { return n >= 0 && n < 128 ? DRUMS[n] : -1; }
  static options = [
    { key: 'oct', label: 'Octave substitution', choices: [[true, 'Per instrument'], [false, 'Never']], default: true },
  ];

  constructor(host) {
    super(host, [1, 2], 2, TIA_RATE / TIA_FRAME_CLOCKS);
    this.tia = new TIA();
    this.rs = new Resampler(TIA_RATE, host.sampleRate);
    this.dc = new DCBlock(host.sampleRate, 12);
    this.fc = 0; this.allowOct = true; this.tmp = [0, 0];
    this.gain = 0.8;
    this.melOrder = [0, 1]; this.drumOrder = [1, 0];
    this.cache = [[-1, -1, -1], [-1, -1, -1]];
  }
  setOption(key, value) { if (key === 'oct') this.allowOct = !!value; }
  maxVoices() { return 2; }
  reset() { this.resetDriver(); this.tia.reset(); this.cache = [[-1, -1, -1], [-1, -1, -1]]; }
  applyVoiceMute(m) { this.tia.mute[0] = m & 1; this.tia.mute[1] = (m >> 1) & 1; }

  w(vi, audc, audf, audv) {
    const c = this.cache[vi];
    if (c[0] !== audc) { c[0] = audc; this.tia.write(0x15 + vi, audc); }
    if (c[1] !== audf) { c[1] = audf; this.tia.write(0x17 + vi, audf); }
    if (c[2] !== audv) { c[2] = audv; this.tia.write(0x19 + vi, audv); }
  }
  program(vi, vn) {
    const inst = vn.inst;
    if (vn.isDrum) { vn.tm = inst.audc; vn.toct = 0; vn.baseF = inst.track ? nearestF(inst.audc, 440 * Math.pow(2, (vn.pitch - 69) / 12), this.tmp)[0] : 0; return; }
    if (NOISE_MODE(inst.audc)) { vn.tm = inst.audc; vn.toct = 0; return; }
    const ch = this.h.ch[vn.ch];
    const t = pickTone([inst.audc, ...(inst.alt || [])], vn.note + ch.bend * ch.bendRange, this.allowOct && inst.octSub);
    vn.tm = t.audc; vn.toct = t.oct;
  }
  update(vi, vn) {
    const inst = vn.inst, gm = vn.gm;
    const audc = vn.dist >= 0 ? vn.dist & 15 : vn.tm;
    let audf;
    if (vn.isDrum) audf = Math.max(0, Math.min(31, (inst.track ? vn.baseF : 0) + (vn.freq >= 0 ? vn.freq : 0)));
    else if (NOISE_MODE(audc)) audf = Math.max(0, Math.min(31, Math.round((96 - vn.pitch) / 2.5)));
    else audf = nearestF(audc, 440 * Math.pow(2, (vn.pitch + vn.toct - 69) / 12), this.tmp)[0];
    const v = Math.round(vn.vol * Math.min(1, 1.4 * gm * (vn.isDrum ? 2.1 : 1)));
    this.w(vi, audc, audf, v < 0 ? 0 : v > 15 ? 15 : v);
  }
  silence(vi) { this.w(vi, this.cache[vi][0] < 0 ? 0 : this.cache[vi][0], Math.max(0, this.cache[vi][1]), 0); }

  render(L, R, n) {
    const rs = this.rs, tia = this.tia, g = this.gain;
    for (let i = 0; i < n; i++) {
      for (let k = rs.advance(); k > 0; k--) {
        const y = tia.clock();
        rs.push(y, y);
        if (++this.fc >= TIA_FRAME_CLOCKS) { this.fc = 0; this.frame(); }
      }
      const v = this.dc.run(rs.out()[0]) * g;
      L[i] = v; R[i] = v;
    }
  }
}
