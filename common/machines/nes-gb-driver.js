// Shared frame-rate General MIDI "sound driver" for the NES and Game Boy machines.
//
// It behaves like a game's music engine: once per video frame it steps software envelopes, vibrato,
// pitch slides and chord arpeggios, then decides which GM parts get the chip's few voices
// (bass part → triangle/wave, the two most important melodic parts → the pulses, noise-type SFX → noise)
// and hands each voice a { note, vol (4-bit), duty, trigger } state. The machine module turns those
// states into register writes for its chip. Original code for RetroSynths.

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

/** Loudness 0..1 of a note on a channel (velocity × CC7 × CC11), on a curve that suits 4-bit volume. */
export function chipLevel(ch, vel) {
  const v = (vel / 127) * (ch.vol / 127) * (ch.expr / 127);
  return Math.min(1, Math.pow(v, 1.5) * 1.6);
}

// ------------------------------------------------------------------------------------------------
class Note {
  constructor() { this.dead = true; }
  start(ch, note, vel, inst, id) {
    this.ch = ch; this.note = note; this.vel = vel; this.inst = inst; this.id = id;
    this.on = true; this.sus = false; this.dead = false; this.t = -1; this.lvl = 0; this.stage = 0;
    this.slide = 0; this.amp = 0; this.fresh = true;
  }
}

export class Voice {
  constructor(kind, idx) {
    this.kind = kind; this.idx = idx;          // 'pulse' | 'bass' | 'noise'
    this.part = -1; this.prevPart = -1;        // MIDI channel owning the voice
    this.set = []; this.nset = 0;              // notes this voice plays (arp set), ascending pitch
    this.arpI = 0; this.arpT = 0;
    this.cur = null; this.lastId = -1;
    // output state for the machine, refreshed every frame
    this.on = false; this.note = 60; this.vol = 0; this.duty = 2; this.trig = false; this.inst = INST[0];
    this.ch = 0; this.dvdt = 0; this.amp = 0;
  }
}

export class Driver {
  /** opt: { fps, pulses (count), bass (bool), noise (bool) } */
  constructor(host, opt) {
    this.h = host; this.fps = opt.fps; this.dt = 1 / opt.fps;
    this.pool = []; for (let i = 0; i < 64; i++) this.pool.push(new Note());
    this.id = 0; this.frame = 0;
    this.arp = true; this.arpSpeed = 1;
    this.voices = [];
    for (let i = 0; i < opt.pulses; i++) this.voices.push(new Voice('pulse', i));
    this.pulses = this.voices.slice();
    this.bassV = opt.bass ? new Voice('bass', this.voices.length) : null; if (this.bassV) this.voices.push(this.bassV);
    this.noiseV = opt.noise ? new Voice('noise', this.voices.length) : null; if (this.noiseV) this.voices.push(this.noiseV);
    // per-part scratch (16 MIDI channels)
    this.pScore = new Float32Array(16); this.pN = new Int32Array(16); this.pNotes = []; for (let c = 0; c < 16; c++) this.pNotes.push([]);
    this.pHad = new Uint8Array(16); this.pTop = new Int32Array(16); this.pLow = new Int32Array(16);
    this.used = new Uint8Array(16); this.order = []; this.kd = new Map();
    this.vibPh = 0;
  }

  // ---------------------------------------------------------------- MIDI side
  noteOn(c, note, vel) {
    const ch = this.h.ch[c];
    // retrigger of the same key on the same part: reuse that note
    let n = null;
    for (const x of this.pool) if (!x.dead && x.ch === c && x.note === note) { n = x; break; }
    if (!n) for (const x of this.pool) if (x.dead) { n = x; break; }
    if (!n) {                                     // steal: oldest released, else oldest
      let best = null;
      for (const x of this.pool) if (!x.on && (!best || x.id < best.id)) best = x;
      if (!best) for (const x of this.pool) if (!best || x.id < best.id) best = x;
      n = best;
    }
    n.start(c, note, vel, INST[ch.program & 127], ++this.id);
  }
  noteOff(c, note) {
    const sus = this.h.ch[c].sustain;
    for (const x of this.pool) if (!x.dead && x.on && x.ch === c && x.note === note) {
      if (sus) x.sus = true; else { x.on = false; if (x.stage < 3) x.stage = 3; }
    }
  }
  sustainOff(c) { for (const x of this.pool) if (!x.dead && x.sus && x.ch === c) { x.sus = false; x.on = false; if (x.stage < 3) x.stage = 3; } }
  allOff(c, hard) {
    for (const x of this.pool) if (!x.dead && x.ch === c) { x.on = false; x.sus = false; x.stage = 3; if (hard) x.dead = true; }
  }
  reset() { for (const x of this.pool) x.dead = true; this.pHad.fill(0); for (const v of this.voices) { v.part = v.prevPart = -1; v.on = false; v.vol = 0; v.nset = 0; v.cur = null; v.lastId = -1; } }
  liveCount() { let k = 0; for (const x of this.pool) if (!x.dead) k++; return k; }

  // ---------------------------------------------------------------- frame tick
  k(tc) {                                         // per-frame exponential factor for a time constant
    let v = this.kd.get(tc);
    if (v === undefined) { v = tc > 0 ? Math.exp(-this.dt / tc) : 0; this.kd.set(tc, v); }
    return v;
  }
  stepNote(n) {
    const I = n.inst, dt = this.dt;
    n.t++;
    switch (n.stage) {
      case 0: n.lvl = I.a > 0 ? n.lvl + dt / I.a : 1; if (n.lvl >= 1) { n.lvl = 1; n.stage = 1; } break;
      case 1: n.lvl = I.s + (n.lvl - I.s) * this.k(I.d); if (I.s <= 0 && n.lvl < 0.015) n.dead = true; break;
      case 3: n.lvl *= this.k(I.r); if (n.lvl < 0.015) n.dead = true; break;
    }
    n.slide += I.slide;
    const ch = this.h.ch[n.ch];
    let a = n.lvl * chipLevel(ch, n.vel);
    if (I.trem > 0) a *= 1 - I.trem * 0.5 * (1 + Math.sin(2 * Math.PI * I.tremRate * n.t * dt));
    if (this.h.mute[n.ch] || ch.drum) a = 0;
    n.amp = a;
  }
  /** slope of a note's volume in 4-bit units per second (for chips with hardware envelopes) */
  slope(n) {
    const I = n.inst, L = n.lvl > 0 ? n.amp / n.lvl : 0;
    switch (n.stage) {
      case 0: return I.a > 0 ? 15 * L / I.a : 0;
      case 1: return I.d > 0 ? -15 * L * (n.lvl - I.s) / I.d : 0;
      case 3: return I.r > 0 ? -15 * L * n.lvl / I.r : -1e3;
    }
    return 0;
  }

  tick() {
    this.frame++;
    const h = this.h, pool = this.pool;
    for (const n of pool) if (!n.dead) this.stepNote(n);
    this.vibPh += 5.6 * this.dt;

    // gather parts
    const pN = this.pN, pNotes = this.pNotes, pScore = this.pScore;
    for (let c = 0; c < 16; c++) { pN[c] = 0; pNotes[c].length = 0; this.used[c] = 0; }
    let anyNoise = false;
    for (const n of pool) {
      if (n.dead || n.amp < 0.02 || h.ch[n.ch].drum) continue;
      pNotes[n.ch].push(n); pN[n.ch]++;
    }
    const order = this.order; order.length = 0;
    for (let c = 0; c < 16; c++) {
      const L = pNotes[c]; if (!L.length) continue;
      // like a channel in a game driver: a held note cuts the release tails of earlier ones
      let held = 0; for (const n of L) if (n.on || n.sus) held++;
      if (held && held < L.length) { let j = 0; for (const n of L) if (n.on || n.sus) L[j++] = n; L.length = j; pN[c] = j; }
      L.sort((a, b) => b.note - a.note || b.id - a.id);
      const I = INST[h.ch[c].program & 127];
      let amp = 0, newest = 1e9;
      for (const n of L) { if (n.amp > amp) amp = n.amp; if (n.t < newest) newest = n.t; }
      let s = I.prio + 40 * amp + (L.length === 1 ? 12 : L.length >= 3 ? -8 : 0) + 30 * Math.max(0, 1 - newest / 30);
      if (this.pHad[c]) s += 20;
      pScore[c] = s; this.pTop[c] = L[0].note; this.pLow[c] = L[L.length - 1].note;
      if (I.noise) { if (this.noiseV) { anyNoise = true; continue; } }
      order.push(c);
    }
    this.pHad.fill(0);

    // noise-type SFX parts → noise voice
    if (this.noiseV) {
      const v = this.noiseV; v.prevPart = v.part; v.part = -1;
      if (anyNoise) {
        let best = -1;
        for (let c = 0; c < 16; c++) if (pN[c] && INST[h.ch[c].program & 127].noise && (best < 0 || pScore[c] > pScore[best])) best = c;
        v.part = best; this.used[best] = 1; this.pHad[best] = 1;
        v.set.length = 0; v.set.push(pNotes[best][0]); v.nset = 1;
      }
      // noise SFX parts that lost go to the melodic ranking (played as tones)
      for (let c = 0; c < 16; c++) if (pN[c] && !this.used[c] && INST[h.ch[c].program & 127].noise) order.push(c);
    }

    // bass part → bass voice
    let bassPart = -1;
    if (this.bassV) {
      for (const c of order) if (INST[h.ch[c].program & 127].bass && (bassPart < 0 || pScore[c] > pScore[bassPart])) bassPart = c;
    }
    // melodic ranking with unison penalty
    order.sort((a, b) => pScore[b] - pScore[a]);
    const chosen = [];
    for (let i = 0; i < order.length && chosen.length < this.pulses.length; i++) {
      // pick the best remaining (re-ranked after the unison penalty)
      let best = -1, bs = -1e9;
      for (const c of order) {
        if (c === bassPart || this.used[c]) continue;
        let s = pScore[c];
        for (const x of chosen) { const d = Math.abs(this.pTop[c] - this.pTop[x]); if (d % 12 === 0 && d <= 24) s -= 45; }
        if (s > bs) { bs = s; best = c; }
      }
      if (best < 0) break;
      chosen.push(best); this.used[best] = 1;
    }

    // map chosen parts onto pulse voices, sticky to last frame's owner
    const P = this.pulses;
    for (const v of P) { v.prevPart = v.part; v.part = -1; v.nset = 0; v.set.length = 0; }
    for (const c of chosen) { const v = P.find(v => v.prevPart === c && v.part < 0); if (v) v.part = c; }
    for (const c of chosen) {
      if (P.some(v => v.part === c)) continue;
      const v = P.find(v => v.part < 0 && !chosen.includes(v.prevPart)) || P.find(v => v.part < 0);
      if (v) v.part = c;
    }
    // spare pulses go to parts that have more notes than voices (spread chords)
    for (const v of P) {
      if (v.part >= 0) continue;
      let best = -1, need = 0;
      for (const c of chosen) {
        const k = P.reduce((s, w) => s + (w.part === c ? 1 : 0), 0), extra = pN[c] - k;
        if (extra > need) { need = extra; best = c; }
      }
      if (best >= 0) v.part = best;
    }

    // bass voice
    let splitNote = null;
    if (this.bassV) {
      const v = this.bassV; v.prevPart = v.part; v.part = -1; v.set.length = 0; v.nset = 0;
      if (bassPart >= 0) { v.part = bassPart; v.set.push(this.newest(pNotes[bassPart], true)); }
      else {
        // an unplaced part: the one with the lowest note
        let low = -1;
        for (const c of order) if (!this.used[c] && (low < 0 || this.pLow[c] < this.pLow[low])) low = c;
        if (low >= 0 && this.pLow[low] <= 67) { v.part = low; v.set.push(pNotes[low][pNotes[low].length - 1]); }
        else {
          // split: lowest note of a chord part already on a pulse
          let sp = -1;
          for (const c of chosen) if (pN[c] >= 2 && this.pLow[c] < 55 && (sp < 0 || this.pLow[c] < this.pLow[sp])) sp = c;
          if (sp >= 0) { v.part = sp; splitNote = pNotes[sp][pNotes[sp].length - 1]; v.set.push(splitNote); }
        }
      }
      if (v.part >= 0) { v.nset = 1; this.pHad[v.part] = 1; }
    }

    // distribute each pulse part's notes over its voices (top notes direct, the last voice arps the rest)
    for (const c of chosen) {
      this.pHad[c] = 1;
      const vs = []; for (const v of P) if (v.part === c) vs.push(v);
      const notes = pNotes[c].filter(n => n !== splitNote);
      if (!notes.length) { for (const v of vs) v.part = -1; continue; }
      const k = vs.length;
      for (let j = 0; j < k; j++) {
        const v = vs[j];
        if (j < k - 1) { if (j < notes.length) v.set.push(notes[j]); continue; }
        const rest = notes.slice(Math.min(j, notes.length - 1));
        if (rest.length > 1 && this.arp) { for (let q = rest.length - 1; q >= 0; q--) v.set.push(rest[q]); }
        else v.set.push(this.arp ? rest[0] : this.newest(rest, false));
      }
      for (const v of vs) v.nset = v.set.length;
    }

    for (const v of this.voices) this.voiceOut(v);
  }

  newest(list, lowest) {
    let best = null;
    for (const n of list) if (!best || n.id > best.id || (n.id === best.id && (lowest ? n.note < best.note : n.note > best.note))) best = n;
    return best;
  }

  voiceOut(v) {
    v.trig = false;
    if (v.part < 0 || v.nset === 0) { v.on = false; v.vol = 0; v.cur = null; v.amp = 0; return; }
    const h = this.h, ch = h.ch[v.part];
    let n;
    if (v.nset > 1) {
      if (v.part !== v.prevPart) { v.arpI = 0; v.arpT = 0; }
      if (++v.arpT >= this.arpSpeed) { v.arpT = 0; v.arpI++; }
      v.arpI %= v.nset; n = v.set[v.arpI];
      for (const x of v.set) if (x.t === 0) v.trig = true;
    } else {
      n = v.set[0];
      if (n.id !== v.lastId || n.t === 0) v.trig = true;
    }
    if (v.part !== v.prevPart) v.trig = true;
    v.lastId = n.id; v.cur = n;
    const I = n.inst;
    let pitch = n.note + ch.bend * ch.bendRange + n.slide;
    if (I.arpMac && v.nset === 1) pitch += I.arpMac[n.t % I.arpMac.length];
    if (I.bendIn) pitch -= I.bendIn * Math.exp(-n.t / 6);
    // vibrato: instrument (delayed, ramped) + mod wheel
    let depth = ch.mod / 127 * 0.6;
    if (I.vibDepth > 0 && n.t > I.vibDelay) depth += I.vibDepth * Math.min(1, (n.t - I.vibDelay) / 20);
    if (depth > 0) { const ph = this.vibPh % 1; pitch += depth * (ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph); }
    v.note = pitch; v.inst = I; v.ch = v.part;
    v.duty = I.dmac ? I.dmac[Math.min(n.t, I.dmac.length - 1)] : I.duty;
    // an arpeggiating voice is one driver channel with one envelope: follow the loudest note of its set
    let e = n;
    if (v.nset > 1) for (const x of v.set) if (x.amp > e.amp) e = x;
    v.amp = e.amp;
    v.vol = Math.min(15, Math.round(15 * e.amp));
    v.dvdt = this.slope(e);
    v.on = true;
    v.held = n.on || n.sus;
  }
}
