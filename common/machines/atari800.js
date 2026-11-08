// Atari 400/800 — POKEY driven by a frame-rate music driver (RMT-style instruments).
//
// Instruments are native POKEY settings: distortion (AUDC bits 7–5), clock (64 kHz / 15 kHz / 1.79 MHz),
// 8- or 16-bit (joined pair), high-pass pairing, plus volume / arpeggio / pitch / distortion / AUDF frame
// macros. The driver places each note on a *placement* of channels — a single 8-bit channel, a joined
// pair (1+2 or 3+4), or a high-pass pairing (ch1 by ch3, ch2 by ch4, or pair 1+2 by ch4) — and builds
// AUDCTL every frame from what is sounding. A 16-bit bass joins channels 3+4 only while nothing else
// has wanted them for two seconds, and falls back to 8 bits (distortion C for low notes) on demand —
// trading voices for tuning, as POKEY composers did.
// Original code for RetroSynths.
import { Resampler, DCBlock, drumKind } from './util.js';
import { POKEY, POKEY_CLOCK, POKEY_CHUNK, POKEY_RATE, POKEY_FRAME_CYCLES } from './pokey.js';
import { Driver, CLASS, DRUM_PRIO, mac, envMacro, pitchMacro, qLin, gmTable, gcd } from './atari-driver.js';

const CLK = POKEY_CLOCK;
export const DIST_NAMES = ['0 · 5-bit + 17-bit poly', '1 · 5-bit poly + pure', '2 · 5-bit + 4-bit poly', '3 · 5-bit poly + pure',
  '4 · 17-bit poly (noise)', '5 · pure tone (A)', '6 · 4-bit poly (C buzz)', '7 · pure tone (E)'];
export const CLOCK_NAMES = ['64 kHz', '15 kHz', '1.79 MHz'];
/** Output pattern length (in divider underflows) of each distortion; 0 = noise. */
export const PAT = [0, 31, 465, 31, 0, 2, 15, 2];

/** Channel placements: res = channel bitmask, out = output channel, lo = low byte of a pair, hp = filter-clock channel. */
export const SLOTS = [
  { res: 0b0001, out: 0, name: 'Ch 1' }, { res: 0b0010, out: 1, name: 'Ch 2' }, { res: 0b0100, out: 2, name: 'Ch 3' }, { res: 0b1000, out: 3, name: 'Ch 4' },
  { res: 0b0011, out: 1, lo: 0, wide: true, name: 'Ch 1+2 (16-bit)' }, { res: 0b1100, out: 3, lo: 2, wide: true, name: 'Ch 3+4 (16-bit)' },
  { res: 0b1011, out: 1, lo: 0, wide: true, hp: 3, name: 'Ch 1+2 by Ch 4 (HPF)' },
  { res: 0b0101, out: 0, hp: 2, name: 'Ch 1 by Ch 3 (HPF)' }, { res: 0b1010, out: 1, hp: 3, name: 'Ch 2 by Ch 4 (HPF)' },
];

/** Divider period in cycles for AUDF n on a placement. */
const cyc = (n, wide, fast, base) => (fast ? n + (wide ? 7 : 4) : (n + 1) * base);
const toN = (P, wide, fast, base) => (fast ? P - (wide ? 7 : 4) : P / base - 1);

/** Best AUDF for a tone of `hz` with a distortion pattern; → [N, cents error]. */
export function toneN(dist, hz, wide, fast, base, out = [0, 0]) {
  const L = PAT[dist], maxN = wide ? 65535 : 255;
  const N0 = Math.round(toN(CLK / (hz * L), wide, fast, base));
  let bn = Math.max(0, Math.min(maxN, N0)), be = Infinity;
  for (let n = N0 - 4; n <= N0 + 4; n++) {
    if (n < 0 || n > maxN) continue;
    const P = cyc(n, wide, fast, base), Le = L === 2 ? 2 : L / gcd(P, L);
    if (Le === 1) continue;
    const e = Math.abs(1200 * Math.log2(CLK / (Le * P) / hz));
    if (e < be) { be = e; bn = n; }
  }
  out[0] = bn; out[1] = be;
  return out;
}

// ---------------------------------------------------------------- native instrument library
const Q = qLin(15);
function mel(name, category, cls, dist, bits, x = {}) {
  const c = CLASS[cls], env = x.env || c.env, vib = x.vib !== undefined ? x.vib : c.vib;
  return {
    name, category, kind: 'any', role: x.role || c.role, drum: false,
    distortion: dist, clock: x.clock ?? (bits === 16 ? 2 : 0), bits, hpf: !!x.hpf, hpfDetune: x.hpfDetune ?? 0, poly9: !!x.poly9,
    vol: envMacro(env, Q, { trem: x.trem || c.trem }),
    arp: c.trill ? mac([0, 0, c.trill, c.trill], 0) : mac(),
    pitch: pitchMacro({ sweep: x.sweep !== undefined ? x.sweep : c.sweep, bird: c.bird }),
    dist: mac(), freq: x.freq ? mac(x.freq) : mac(),
    rel: Math.max(1, Math.round(env[3] * 60)),
    vibDelay: vib ? Math.round(vib[0] * 60) : 0, vibDepth: vib ? Math.round(vib[1] * 100) : 0, vibRate: vib ? vib[2] : 5.5,
  };
}
// drum frames: [dist, value, level]; value = Hz for tones, AUDF (64 kHz) for noise
const N64 = (d, hz) => toneN(d, hz, false, false, 28)[0];
const dec = (d, v, l0, n, k = 0.72, dv = 0) => Array.from({ length: n }, (_, i) => [d, v + dv * i, l0 * Math.pow(k, i)]);
function drum(name, kind, fr, x = {}) {
  const tone = (f) => PAT[f[0]] > 0;
  return {
    name, category: 'Drums', kind: 'any', role: 'drum', drum: true, prio: DRUM_PRIO[kind] ?? 46,
    choke: kind.startsWith('hat') ? 'hat' : '', track: !!x.track,
    distortion: fr[0][0], clock: 0, bits: 8, hpf: false, hpfDetune: 0, poly9: !!x.poly9,
    vol: mac(fr.map((f) => Q(Math.min(1, 1.12 * f[2])))),
    dist: mac(fr.map((f) => f[0])),
    freq: mac(fr.map((f) => (x.track ? Math.round(f[1]) : tone(f) ? N64(f[0], f[1]) : Math.round(f[1])))),
    arp: mac(), pitch: mac(), rel: 1, vibDelay: 0, vibDepth: 0, vibRate: 5.5,
  };
}
const PURE = 5, BUZZ = 6, NOISE = 4, GRIT = 1, ENGINE = 2;

const RAW = [
  // leads
  mel('16-bit Pure Lead', 'Lead', 'square', PURE, 16),
  mel('16-bit Dist C Saw Lead', 'Lead', 'saw', BUZZ, 16),
  mel('16-bit HPF Sweep Lead', 'Lead', 'saw', PURE, 16, { hpf: true, hpfDetune: 6, env: [0.002, 0.5, 0.85, 0.12] }),
  mel('8-bit HPF Phaser', 'Lead', 'square', PURE, 8, { hpf: true, hpfDetune: -20 }),
  mel('16-bit Pure Flute', 'Lead', 'flute', PURE, 16),
  mel('16-bit Dist C Reed', 'Lead', 'reed', BUZZ, 16),
  mel('8-bit Pure Square', 'Lead', 'square', PURE, 8),
  mel('1.79M 8-bit Whistle', 'Lead', 'flute', PURE, 8, { clock: 2 }),
  mel('16-bit Dist C Brass', 'Brass', 'brass', BUZZ, 16),
  mel('16-bit Pure Brass Swell', 'Brass', 'brass', PURE, 16, { env: [0.08, 0.3, 0.8, 0.15] }),
  // keys / chromatic
  mel('8-bit Pure Piano', 'Keys', 'piano', PURE, 8),
  mel('8-bit Pure E.Piano', 'Keys', 'epiano', PURE, 8),
  mel('8-bit Dist C Harpsi', 'Keys', 'harpsi', BUZZ, 8),
  mel('8-bit Pure Organ', 'Keys', 'organ', PURE, 8),
  mel('8-bit Pure Bell', 'Chromatic', 'bell', PURE, 8),
  mel('8-bit Vibes Tremolo', 'Chromatic', 'vibes', PURE, 8),
  mel('8-bit Pure Mallet', 'Chromatic', 'mallet', PURE, 8),
  // guitar / strings / pads
  mel('8-bit Pure Pluck', 'Guitar', 'pluck', PURE, 8),
  mel('16-bit Dist C Overdrive', 'Guitar', 'dist', BUZZ, 16),
  mel('8-bit Dist C Strings', 'Strings', 'string', BUZZ, 8),
  mel('8-bit Pure Pad', 'Pad', 'pad', PURE, 8),
  mel('8-bit Pure Voice', 'Pad', 'voice', PURE, 8),
  mel('8-bit Dist C Orch Hit', 'Strings', 'hit', BUZZ, 8),
  // bass
  mel('16-bit Pure Bass', 'Bass', 'bass', PURE, 16),
  mel('16-bit Dist C Synth Bass', 'Bass', 'synbass', BUZZ, 16),
  mel('8-bit Dist C Bass', 'Bass', 'bass', BUZZ, 8),
  mel('15k Dist C Sub Bass', 'Bass', 'synbass', BUZZ, 8, { clock: 1, env: [0.002, 0.8, 0.6, 0.1] }),
  mel('16-bit Pure Timpani', 'Bass', 'timpani', PURE, 16),
  // percussive / FX
  mel('8-bit Tom Sweep', 'Percussive', 'tomperc', PURE, 8),
  mel('8-bit Wood Block', 'Percussive', 'block', PURE, 8),
  mel('Poly17 Surf', 'FX', 'noise', NOISE, 8, { env: [0.8, 1.0, 0.7, 1.0], trem: [0.25, 0.7], freq: [6] }),
  mel('Poly17 Noise Hit', 'FX', 'noise', NOISE, 8, { env: [0.001, 0.5, 0, 0.1], freq: [12] }),
  mel('Poly17 Noise Swell', 'FX', 'noise', NOISE, 8, { env: [1.0, 0.1, 0.8, 0.3], freq: [2] }),
  mel('Poly5+4 Engine', 'FX', 'noise', ENGINE, 8, { env: [0.3, 0.3, 0.9, 0.5], trem: [12, 0.5] }),
  mel('Poly5 Grit Tone', 'FX', 'pad', GRIT, 8),
  mel('Pure Bird Chirp', 'FX', 'bird', PURE, 8),
  mel('Pure Phone Trill', 'FX', 'phone', PURE, 8),
  // drums
  drum('Kick Noise+C Drop', 'kick', [[NOISE, 40, 1], [BUZZ, 110, 0.95], [BUZZ, 82, 0.85], [BUZZ, 66, 0.72], [BUZZ, 56, 0.58], [BUZZ, 50, 0.44], [BUZZ, 46, 0.3], [BUZZ, 44, 0.18], [BUZZ, 42, 0.09]]),
  drum('Kick Deep C Drop', 'kick', [[NOISE, 40, 1], [BUZZ, 94, 0.95], [BUZZ, 70, 0.85], [BUZZ, 56, 0.72], [BUZZ, 48, 0.58], [BUZZ, 42, 0.44], [BUZZ, 39, 0.3], [BUZZ, 37, 0.18], [BUZZ, 36, 0.09]]),
  drum('Snare Pure+Poly17', 'snare', [[PURE, 200, 0.9], ...dec(NOISE, 6, 0.95, 9, 0.72, 1)]),
  drum('Snare Poly17 Bright', 'snare', [[NOISE, 2, 1], ...dec(NOISE, 6, 0.95, 9, 0.72, 1)]),
  drum('Clap Poly17', 'clap', [[NOISE, 4, 0.9], [NOISE, 4, 0.25], [NOISE, 4, 0.85], [NOISE, 4, 0.25], ...dec(NOISE, 5, 0.75, 7, 0.68)]),
  drum('Side Stick', 'stick', [[NOISE, 0, 1], [PURE, 1800, 0.7], [PURE, 1800, 0.35]]),
  drum('Hat Closed Poly17', 'hatClosed', [[NOISE, 0, 0.85], [NOISE, 0, 0.45], [NOISE, 0, 0.18]]),
  drum('Hat Pedal Poly17', 'hatPedal', [[NOISE, 0, 0.7], [NOISE, 0, 0.35], [NOISE, 0, 0.14]]),
  drum('Hat Open Poly17', 'hatOpen', dec(NOISE, 0, 0.55, 18, 0.86)),
  drum('Crash Poly17', 'crash', dec(NOISE, 1, 0.85, 48, 0.94)),
  drum('Crash Poly9', 'crash', dec(NOISE, 0, 0.75, 26, 0.9), { poly9: true }),
  drum('Ride Pure+Poly17', 'ride', [[PURE, 2600, 0.4], ...dec(NOISE, 0, 0.38, 24, 0.9)]),
  drum('Shaker Poly17', 'shaker', [[NOISE, 0, 0.28], [NOISE, 0, 0.36], [NOISE, 0, 0.2], [NOISE, 0, 0.08]]),
  drum('Cowbell Pure', 'cowbell', dec(PURE, 800, 0.8, 9, 0.75)),
  drum('Bell Pure', 'bell', dec(PURE, 1750, 0.7, 22, 0.88)),
  drum('Triangle Pure', 'triangle', dec(PURE, 3100, 0.55, 6, 0.7)),
  drum('Triangle Pure Open', 'triangle', dec(PURE, 3100, 0.55, 36, 0.93)),
  drum('Tom Pure (tracks)', 'tom', dec(PURE, 0, 1, 12, 0.78, 2), { track: true }),
  drum('Conga Pure (tracks)', 'conga', dec(PURE, 0, 0.85, 6, 0.65), { track: true }),
  drum('Perc Pure (tracks)', 'block', [[PURE, 0, 0.75], [PURE, 0, 0.3], [PURE, 0, 0.1]], { track: true }),
  drum('Rattle Poly5', 'perc', dec(GRIT, 900, 0.7, 20, 0.88)),
  drum('Scrape Poly17', 'perc', Array.from({ length: 10 }, (_, i) => [NOISE, 6, i & 1 ? 0.1 : 0.55])),
];
const PRESETS = RAW;

const GM = gmTable(PRESETS, [
  ['8-bit Pure Piano', [0, 1, 2, 3]], ['8-bit Pure E.Piano', [4, 5]], ['8-bit Dist C Harpsi', [6, 7]],
  ['8-bit Pure Bell', [8, 9, 10, 14, 31, 93, 96, 98, 100, 103, 108, 112]], ['8-bit Vibes Tremolo', [11]], ['8-bit Pure Mallet', [12, 13, 113, 114]],
  ['8-bit Pure Organ', [16, 17, 18, 19, 20]], ['16-bit Dist C Reed', [21, 22, 23, 64, 65, 66, 67, 68, 69, 70, 71, 109, 111]],
  ['8-bit Pure Pluck', [15, 24, 25, 26, 27, 28, 45, 46, 99, 104, 105, 106, 107]], ['16-bit Dist C Overdrive', [29, 30, 84]],
  ['16-bit Pure Bass', [32, 33, 34, 35, 36, 37, 43, 58]], ['16-bit Dist C Synth Bass', [38, 39, 87]],
  ['8-bit Dist C Strings', [40, 41, 42, 44, 48, 49, 110]], ['8-bit Pure Pad', [50, 51, 88, 89, 92, 95, 97, 101, 102]],
  ['8-bit Pure Voice', [52, 53, 54, 85, 91, 94]], ['8-bit Dist C Orch Hit', [55]], ['16-bit Dist C Brass', [56, 57, 59, 61, 62, 63]], ['16-bit Pure Brass Swell', [60]],
  ['16-bit Pure Flute', [72, 73, 74, 75, 76, 77, 78, 79, 82, 83]], ['16-bit Pure Lead', [80]], ['16-bit Dist C Saw Lead', [81, 86, 90]],
  ['16-bit Pure Timpani', [47, 116]], ['8-bit Tom Sweep', [117, 118]], ['8-bit Wood Block', [115]],
  ['Poly17 Noise Swell', [119, 121]], ['Poly17 Noise Hit', [120, 127]], ['Poly17 Surf', [122, 126]], ['Poly5+4 Engine', [125]],
  ['Pure Bird Chirp', [123]], ['Pure Phone Trill', [124]],
]);
const PI = (n) => PRESETS.findIndex((p) => p.name === n);
const DRUMS = new Int16Array(128).fill(-1);
for (let n = 27; n <= 87; n++) {
  const k = drumKind(n);
  const name = n === 35 ? 'Kick Deep C Drop' : n === 40 ? 'Snare Poly17 Bright' : n === 55 ? 'Crash Poly9' : n === 81 ? 'Triangle Pure Open' : n === 58 ? 'Rattle Poly5' : (n === 73 || n === 74) ? 'Scrape Poly17' :
    { kick: 'Kick Noise+C Drop', snare: 'Snare Pure+Poly17', clap: 'Clap Poly17', stick: 'Side Stick', hatClosed: 'Hat Closed Poly17', hatPedal: 'Hat Pedal Poly17',
      hatOpen: 'Hat Open Poly17', crash: 'Crash Poly17', ride: 'Ride Pure+Poly17', shaker: 'Shaker Poly17', cowbell: 'Cowbell Pure', bell: 'Bell Pure',
      triangle: 'Triangle Pure', tom: 'Tom Pure (tracks)', conga: 'Conga Pure (tracks)', block: 'Perc Pure (tracks)', perc: 'Perc Pure (tracks)' }[k];
  DRUMS[n] = PI(name);
}

const ORD = {
  lead16: [4, 5, 0, 2, 1, 3], bass16: [5, 2, 3, 1, 0, 4], hp16: [6, 7, 8, 4, 5], hp8: [7, 8, 2, 3, 1, 0],
  fast8: [2, 0, 7], mel8: [2, 3, 1, 0], drum: [3, 2, 1, 0],
};

export default class Atari800 extends Driver {
  static info = {
    id: 'atari800', name: 'Atari 800', maker: 'Atari', year: 1979,
    chip: 'POKEY (C012294)', voices: '4 × 8-bit dividers · joinable 16-bit · 4/5/17-bit polys',
    spec: 'POKEY at 1.79 MHz: 16-bit pairs, high-pass pairings, distortion C buzz, poly17 noise — AUDCTL per frame',
  };
  static voices = [{ id: 'c1', name: 'Ch 1', kind: 'pokey' }, { id: 'c2', name: 'Ch 2', kind: 'pokey' }, { id: 'c3', name: 'Ch 3', kind: 'pokey' }, { id: 'c4', name: 'Ch 4', kind: 'pokey' }];
  static presets = PRESETS;
  static gmPreset(p) { return GM[p & 127]; }
  static gmDrum(n) { return n >= 0 && n < 128 ? DRUMS[n] : -1; }

  constructor(host) {
    super(host, SLOTS.map((s) => s.res), 4, POKEY_CLOCK / POKEY_FRAME_CYCLES);
    this.pk = new POKEY();
    this.rs = new Resampler(POKEY_RATE, host.sampleRate);
    this.dc = new DCBlock(host.sampleRate, 12);
    this.fcyc = 0; this.gain = 1.5 / 60;
    this.ctl = 0; this.demandF = -1e9; this.tmp = [0, 0];
    this.reg = new Int16Array(10).fill(-1);
    this.w(8, 0);
  }
  maxVoices() { return 4; }
  reset() { this.resetDriver(); const m = this.pk.mute; this.pk.reset(); this.pk.mute = m; this.reg.fill(-1); this.ctl = -1; this.demandF = -1e9; this.w(8, 0); this.ctl = 0; for (let i = 0; i < 4; i++) this.w(i * 2 + 1, 0); }
  applyVoiceMute() { this.chipMute(); }
  /** Muting any channel of a pair / pairing mutes the channel that carries its output. */
  chipMute() {
    let m = this.vmask & 15;
    for (let vi = 4; vi < this.nv; vi++) if (this.owner[vi] && (this.vmask & SLOTS[vi].res)) m |= 1 << SLOTS[vi].out;
    if (m !== this.pk.mute) { this.pk.mute = m; this.pk.levels(); }
  }
  w(r, v) { if (this.reg[r] !== v) { this.reg[r] = v; this.pk.write(r, v); } }

  kindOf(vn) {
    const i = vn.inst;
    if (vn.isDrum) return 'drum';
    if (i.hpf) return i.bits === 16 ? 'hp16' : 'hp8';
    if (i.bits === 16) return vn.role === 'lead' ? 'lead16' : 'bass16';
    return i.clock === 2 ? 'fast8' : 'mel8';
  }
  prefer(vn) { return ORD[this.kindOf(vn)]; }
  strict(vn) { return vn.role === 'lead'; }
  allowed(vi, vn) {
    if (!ORD[this.kindOf(vn)].includes(vi)) return false;
    if (vi === 5 && vn.role !== 'lead' && vn.voice !== 5) return this.frameNo - this.demandF > 2 * this.frameHz;
    if (vi === 5 && vn.role !== 'lead') return this.frameNo - this.demandF > 0;
    return true;
  }
  preAssign() {
    let n = 0, single = false;
    for (const vn of this.pool) if (vn.active && vn.amp > 0.003) { n++; if (vn.isDrum || (vn.inst.bits !== 16 && !vn.inst.hpf)) single = true; }
    if (single || n >= 3) this.demandF = this.frameNo;
  }
  postAssign() { this.config(); this.chipMute(); }

  /** Build AUDCTL from the sounding placements; reprogram everything if the clocks changed. */
  config() {
    let ctl = 0, top15 = -1, p15 = -Infinity, top9 = -1, p9 = -Infinity;
    for (let vi = 0; vi < this.nv; vi++) {
      const vn = this.owner[vi];
      if (!vn) continue;
      const s = SLOTS[vi], inst = vn.inst, fast = inst.clock === 2;
      if (s.wide) { ctl |= s.out === 1 ? 0x10 : 0x08; if (fast) ctl |= s.out === 1 ? 0x40 : 0x20; }
      else if (fast && (s.out === 0 || s.out === 2)) ctl |= s.out === 0 ? 0x40 : 0x20;
      if (s.hp != null) ctl |= s.out === 0 ? 0x04 : 0x02;
      const pr = vn.pr ?? 0;
      if (!fast && pr > p15) { p15 = pr; top15 = inst.clock === 1 ? 1 : 0; }
      const d = vn.dist >= 0 ? vn.dist : inst.distortion;
      if ((d === 0 || d === 4) && pr > p9) { p9 = pr; top9 = inst.poly9 ? 1 : 0; }
    }
    if (top15 === 1) ctl |= 0x01;
    if (top9 === 1) ctl |= 0x80;
    if (ctl !== this.ctl) {
      this.ctl = ctl; this.w(8, ctl);
      for (let vi = 0; vi < this.nv; vi++) if (this.owner[vi]) this.update(vi, this.owner[vi]);
    }
  }

  program() {}
  update(vi, vn) {
    const s = SLOTS[vi], inst = vn.inst, ctl = this.ctl, base = ctl & 1 ? 114 : 28;
    const wide = !!s.wide;
    const fast = !!(wide ? (s.out === 1 ? ctl & 0x40 : ctl & 0x20) : (s.out === 0 ? ctl & 0x40 : s.out === 2 ? ctl & 0x20 : 0));
    let dist = (vn.dist >= 0 ? vn.dist : inst.distortion) & 7;
    const maxN = wide ? 65535 : 255;
    let n, toneHz = 0;
    if (vn.isDrum && !inst.track) {                         // fixed AUDF at the instrument's own clock
      const iv = Math.max(0, vn.freq), ic = inst.clock === 2 ? 2 : inst.clock;
      const P = ic === 2 ? iv + 4 : (iv + 1) * (ic === 1 ? 114 : 28);
      n = Math.round(toN(P, wide, fast, base));
      toneHz = PAT[dist] ? CLK / (PAT[dist] * P) : 0;
    } else if (!PAT[dist]) {                                // noise: AUDF colour follows the key
      const b = vn.freq >= 0 ? vn.freq : 6, iv = Math.max(0, Math.min(255, Math.round(b + (60 - vn.pitch) * 0.4)));
      n = Math.round(toN((iv + 1) * 28, wide, fast, base));
    } else {
      const hz = 440 * Math.pow(2, (vn.pitch - 69) / 12);
      toneN(dist, hz, wide, fast, base, this.tmp);
      if (!wide && this.tmp[1] > 50 && (dist === 5 || dist === 7)) { dist = 6; toneN(dist, hz, wide, fast, base, this.tmp); }   // too low for 8 bits: distortion C
      n = this.tmp[0];
      if (vn.isDrum && inst.track) n += Math.max(0, vn.freq);
      toneHz = CLK / ((PAT[dist] === 2 ? 2 : PAT[dist]) * cyc(n, wide, fast, base));
    }
    n = n < 0 ? 0 : n > maxN ? maxN : n;
    const v = Math.round(vn.vol * Math.min(1, 1.4 * vn.gm * (vn.isDrum ? 2.2 : 1)));
    const audc = (dist << 5) | (v < 0 ? 0 : v > 15 ? 15 : v);
    if (wide) { this.w(s.lo * 2, n & 255); this.w(s.out * 2, n >> 8); this.w(s.lo * 2 + 1, 0); }
    else this.w(s.out * 2, n);
    this.w(s.out * 2 + 1, audc);
    if (s.hp != null) {                                     // filter clock: ~2× the tone, detuned (never exactly 2×: that XORs to silence)
      const f2 = (toneHz || 440) * 2, det = inst.hpfDetune || 0;
      let hn = Math.max(0, Math.min(255, Math.round(CLK / (base * f2 * Math.pow(2, det / 1200))) - 1));
      const off = (k) => 1200 * Math.log2(CLK / (base * (k + 1)) / f2);
      if (Math.abs(off(hn)) < 3) hn = Math.max(0, Math.min(255, hn + (det >= 0 ? -1 : 1)));
      this.w(s.hp * 2, hn);
      this.w(s.hp * 2 + 1, 0);
    }
  }
  silence(vi) {
    const s = SLOTS[vi];
    for (let k = 0; k < 4; k++) if (s.res & (1 << k)) {
      let used = false;
      for (let j = 0; j < this.nv; j++) if (j !== vi && this.owner[j] && (SLOTS[j].res & (1 << k))) used = true;
      if (!used) this.w(k * 2 + 1, 0);
    }
  }

  render(L, R, n) {
    const rs = this.rs, pk = this.pk, g = this.gain;
    for (let i = 0; i < n; i++) {
      for (let k = rs.advance(); k > 0; k--) {
        const y = pk.chunk();
        rs.push(y, y);
        this.fcyc += POKEY_CHUNK;
        if (this.fcyc >= POKEY_FRAME_CYCLES) { this.fcyc -= POKEY_FRAME_CYCLES; this.frame(); }
      }
      const v = this.dc.run(rs.out()[0]) * g;
      L[i] = v; R[i] = v;
    }
  }
}
