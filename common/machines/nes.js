// NES — Ricoh 2A03 APU (NTSC) with a frame-rate General MIDI sound driver.
//
// Chip: nes-apu.js, cycle-exact at 1.789773 MHz with the NESdev nonlinear mixer; its output is
// box-integrated over 8 CPU cycles (223.7 kHz), run through the console's analog chain
// (1st-order HP 90 Hz, HP 440 Hz, LP 14 kHz) and band-limited to the output rate.
// Driver (nes-gb-driver.js + below): every NTSC frame (60.0988 Hz) it writes $4000-$4017 like a
// game's music engine — melody/harmony on the pulses (constant-volume 4-bit software envelopes, duty
// macros, delayed vibrato, chord arpeggios), bass on the triangle (gated through the linear counter),
// drums as per-frame noise macros plus DPCM kick/snare/tom samples synthesized and delta-encoded here.

import { midiHz, Resampler } from './util.js';
import { APU, NES_CPU, NES_FRAME, DMC_P } from './nes-apu.js';
import { Driver, chipLevel } from './nes-gb-driver.js';

const D = 8;                                   // CPU cycles per integration step
const IRATE = NES_CPU / D;

// ------------------------------------------------------------------------------------------------
//  DPCM drum samples: synthesized here, delta-encoded (1 bit, ±2 steps of the 7-bit counter).
//  Waveforms are unipolar and start/end at counter level 0, so between hits the DMC rests at 0 and
//  the triangle/noise keep full loudness in the nonlinear mixer.
// ------------------------------------------------------------------------------------------------
function synthDrum(kind, rate, amp) {
  const fs = NES_CPU / DMC_P[rate];
  const dur = kind === 'kick' ? 0.2 : kind === 'snare' ? 0.17 : 0.3;
  const n = Math.round(dur * fs), y = new Float32Array(n);
  let ph = 0, seed = 22222, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const att = Math.min(1, t / 0.0015);
    let v;
    if (kind === 'kick') {
      const f = 48 + 120 * Math.exp(-t / 0.022);
      ph += 2 * Math.PI * f / fs;
      v = att * Math.exp(-t / 0.055) * 0.5 * (1 - Math.cos(ph));
    } else if (kind === 'snare') {
      ph += 2 * Math.PI * 185 / fs;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      lp += 0.6 * ((seed / 0x7fffffff) - lp);
      const tone = 0.5 * (1 - Math.cos(ph)) * Math.exp(-t / 0.03);
      v = att * (0.55 * tone + 0.6 * lp * Math.exp(-t / 0.05));
    } else {
      const f = 85 + 55 * Math.exp(-t / 0.04);
      ph += 2 * Math.PI * f / fs;
      v = att * Math.exp(-t / 0.09) * 0.5 * (1 - Math.cos(ph));
    }
    y[i] = v * amp;
  }
  // greedy delta encoder against the real counter rules (clamped at 0..127)
  const bytes = new Uint8Array(Math.ceil(n / 8) + 1);
  let lev = 0;
  for (let i = 0; i < n; i++) {
    const up = y[i] > lev;
    if (up) { bytes[i >> 3] |= 1 << (i & 7); if (lev <= 125) lev += 2; } else if (lev >= 2) lev -= 2;
  }
  return bytes;
}

// GM drum note → { dmc, rate, noise macro: p0→p1 period index, mode, n frames, vol, curve, pat, prio }
function drumDef(note) {
  const N = (p0, p1, n, vol, o = {}) => ({ p0, p1, n, vol, mode: 0, curve: 1, prio: 3, ...o });
  switch (note) {
    case 35: return { dmc: 'kick', rate: 14, ...N(11, 13, 3, 8, { prio: 4, alt: N(12, 15, 7, 15, { prio: 4 }) }) };
    case 36: return { dmc: 'kick', rate: 15, ...N(10, 13, 3, 9, { prio: 4, alt: N(12, 15, 7, 15, { prio: 4 }) }) };
    case 37: return N(2, 3, 2, 12, { prio: 5 });
    case 38: return { dmc: 'snare', rate: 15, ...N(5, 7, 10, 13, { prio: 6, alt: N(5, 7, 12, 15, { prio: 6 }) }) };
    case 40: return { dmc: 'snare', rate: 15, ...N(4, 6, 12, 14, { prio: 6, alt: N(4, 6, 14, 15, { prio: 6 }) }) };
    case 39: return N(4, 5, 10, 13, { prio: 6, pat: [1, 0.3, 1, 0.3, 1, 1, 1, 1, 1, 1] });
    case 42: return N(0, 1, 3, 9, { prio: 2 });
    case 44: return N(1, 1, 3, 7, { prio: 2 });
    case 46: return N(0, 1, 14, 9, { prio: 3, curve: 1.3 });
    case 41: case 43: case 45: case 47: case 48: case 50: {
      const r = { 41: 10, 43: 11, 45: 12, 47: 13, 48: 14, 50: 15 }[note];
      return { dmc: 'tom', rate: r, ...N(9, 10, 2, 6, { prio: 5, alt: N(8, 12, 9, 13, { prio: 5 }) }) };
    }
    case 49: return N(2, 4, 55, 12, { prio: 5, curve: 1.6 });
    case 57: return N(3, 5, 55, 12, { prio: 5, curve: 1.6 });
    case 52: return N(3, 4, 40, 12, { prio: 5, curve: 1.4, mode: 1 });
    case 55: return N(1, 3, 25, 11, { prio: 5, curve: 1.5 });
    case 51: return N(1, 1, 24, 8, { mode: 1, curve: 1.4, then: 0 });
    case 59: return N(1, 2, 24, 8, { mode: 1, curve: 1.4, then: 0 });
    case 53: return N(2, 2, 22, 10, { mode: 1, curve: 1.3 });
    case 54: return N(0, 0, 6, 9, { pat: [1, 0.5, 1, 0.8, 0.6, 0.4] });
    case 69: return N(0, 0, 4, 7);
    case 70: return N(0, 0, 3, 8);
    case 56: return N(3, 3, 10, 10, { mode: 1 });
    case 67: return N(2, 2, 8, 10, { mode: 1 });
    case 68: return N(3, 3, 8, 10, { mode: 1 });
    case 58: return N(6, 7, 30, 10, { pat: [1, 0.2, 0.9, 0.2, 0.8, 0.2, 0.7, 0.2, 0.6, 0.2, 0.5, 0.2] });
    case 60: return { dmc: 'tom', rate: 15, ...N(3, 4, 2, 6, { prio: 4, alt: N(3, 5, 5, 11) }) };
    case 61: return { dmc: 'tom', rate: 14, ...N(4, 5, 2, 6, { prio: 4, alt: N(4, 6, 5, 11) }) };
    case 62: return { dmc: 'tom', rate: 15, ...N(3, 3, 2, 8, { prio: 4, alt: N(3, 4, 3, 11) }) };
    case 63: return { dmc: 'tom', rate: 14, ...N(4, 5, 2, 6, { prio: 4, alt: N(4, 6, 6, 11) }) };
    case 64: return { dmc: 'tom', rate: 13, ...N(5, 6, 2, 6, { prio: 4, alt: N(5, 7, 7, 11) }) };
    case 65: return { dmc: 'tom', rate: 15, ...N(2, 4, 6, 9, { prio: 4, alt: N(2, 4, 8, 12) }) };
    case 66: return { dmc: 'tom', rate: 14, ...N(3, 5, 6, 9, { prio: 4, alt: N(3, 5, 8, 12) }) };
    case 71: return N(0, 0, 14, 7, { mode: 1 });
    case 72: return N(0, 0, 30, 7, { mode: 1 });
    case 73: return N(5, 5, 6, 9, { pat: [1, 0.3, 1, 0.3, 1, 0.3] });
    case 74: return N(5, 6, 16, 9, { pat: [1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3, 1, 0.3] });
    case 75: return N(1, 1, 2, 11, { mode: 1, prio: 4 });
    case 76: return N(2, 2, 2, 11, { mode: 1, prio: 4 });
    case 77: return N(3, 3, 2, 11, { mode: 1, prio: 4 });
    case 78: return N(6, 4, 6, 9, { mode: 1 });
    case 79: return N(4, 6, 6, 9, { mode: 1 });
    case 80: return N(0, 0, 4, 7, { mode: 1 });
    case 81: return N(0, 0, 30, 7, { mode: 1, curve: 1.3 });
    default: return N(4, 6, 6, 10);
  }
}
const DRUMS = []; for (let n = 0; n < 128; n++) DRUMS.push(drumDef(n < 35 || n > 81 ? 0 : n));

// period index for a noise "pitch" (MIDI note), for the noise-SFX programs
const noiseIndex = (note) => Math.max(0, Math.min(15, Math.round(14 - (note - 24) / 5)));

export default class NES {
  static info = {
    id: 'nes', name: 'NES', maker: 'Nintendo', year: 1985,
    chip: 'Ricoh 2A03 APU', voices: '2 pulse · triangle · noise · DPCM',
    spec: '2A03 at 1.79 MHz, nonlinear mixer and NES filter chain · 60 Hz driver: pulse leads, triangle bass, noise + DPCM drums',
  };
  static options = [
    { key: 'arp', label: 'Chord arps', choices: [[true, 'On'], [false, 'Off']], default: true },
    { key: 'dpcm', label: 'DPCM drums', choices: [[true, 'On'], [false, 'Off']], default: true },
    { key: 'filter', label: 'Output', choices: [['nes', 'NES filters'], ['clean', 'Clean']], default: 'nes' },
  ];

  constructor(host) {
    this.h = host;
    this.apu = new APU();
    this.drv = new Driver(host, { fps: NES_CPU / NES_FRAME, pulses: 2, bass: true, noise: true });
    this.rs = new Resampler(IRATE, host.sampleRate);
    this.dpcm = true; this.filter = 'nes';
    const dt = 1 / IRATE, hp = (f) => { const rc = 1 / (2 * Math.PI * f); return rc / (rc + dt); };
    this.a90 = hp(90); this.a440 = hp(440); this.a37 = hp(37);
    { const rc = 1 / (2 * Math.PI * 14000); this.b14 = dt / (rc + dt); }
    this.f = new Float64Array(6);                      // filter states
    this.gain = 3.1;
    // DPCM sample ROM at $C000: [kick, snare, tom] × [hard, soft]
    this.smp = {};
    let addr = 0xC000;
    for (const k of ['kick', 'snare', 'tom']) for (const [vk, amp] of [['h', 80], ['s', 46]]) {
      const b = synthDrum(k, 15, amp);
      this.apu.mem.set(b, addr - 0x8000);
      const L = Math.min(255, Math.ceil((b.length - 1) / 16));
      this.smp[k + vk] = { a: (addr - 0xC000) >> 6, l: L };
      addr += Math.ceil((L * 16 + 1) / 64) * 64;
    }
    // per-voice shadow registers (what the driver last wrote)
    this.sh = new Int32Array(16).fill(-1); this.pend = new Uint8Array(4);
    this.drum = { on: false, def: null, f: 0, lvl: 0, ch: 9 };
    this.hits = []; this.fpos = 0; this.flush = false;
    this.reset();
  }

  w(a, v) { this.apu.write(a, v); }
  reset() {
    this.apu.reset();
    this.drv.reset();
    this.sh.fill(-1); this.pend.fill(0);
    this.drum.on = false; this.hits.length = 0; this.dmcT = 0; this.dmcCh = 9;
    this.w(0x4015, 0x0F); this.w(0x4017, 0x40);
    this.w(0x4000, 0x30); this.w(0x4004, 0x30); this.w(0x4001, 0x08); this.w(0x4005, 0x08);
    this.w(0x4008, 0x80); this.w(0x400C, 0x30); this.w(0x4011, 0x00);
  }
  setOption(k, v) {
    if (k === 'arp') this.drv.arp = !!v;
    else if (k === 'dpcm') this.dpcm = !!v;
    else if (k === 'filter') this.filter = v === 'clean' ? 'clean' : 'nes';
  }

  // ---------------------------------------------------------------- MIDI
  noteOn(c, note, vel) {
    if (this.h.ch[c].drum) { if (!this.h.mute[c]) this.hits.push(c, note, vel); return; }
    this.drv.noteOn(c, note, vel);
  }
  noteOff(c, note) { if (!this.h.ch[c].drum) this.drv.noteOff(c, note); }
  sustainOff(c) { this.drv.sustainOff(c); }
  allOff(c, hard) { this.drv.allOff(c, hard); if (hard) { if (this.drum.ch === c) this.drum.on = false; this.flush = true; } }
  pitch() {}                                          // the driver re-reads bend every frame
  ctrl(c) { if (this.h.mute[c]) this.flush = true; }

  // ---------------------------------------------------------------- driver → registers, once per frame
  frame() {
    const drv = this.drv; drv.tick();
    const [p1, p2] = drv.pulses;
    this.pulse(p1, 0); this.pulse(p2, 1);
    this.tri(drv.bassV);
    this.drums(drv.noiseV);
    const m = this.h.meter;
    for (const v of drv.voices) if (v.on && v.vol > 0) { const g = v.kind === 'bass' ? 0.8 : v.vol / 15; if (g > m[v.ch]) m[v.ch] = g; }
  }
  pulse(v, i) {
    const sh = this.sh, b = 0x4000 + 4 * i, k = i * 4;
    const vol = v.on ? v.vol : 0;
    let t = -1;
    if (vol > 0) {
      t = Math.round(NES_CPU / (16 * midiHz(v.note))) - 1;
      while (t > 2047) t = ((t + 1) >> 1) - 1;
    }
    const r0 = (v.duty << 6) | 0x30 | (t >= 8 ? vol : 0);
    if (r0 !== sh[k]) { this.w(b, r0); sh[k] = r0; }
    if (v.trig) this.pend[i] = 1;
    if (t < 8) return;
    const lo = t & 0xFF, hi = t >> 8;
    if (lo !== sh[k + 1]) { this.w(b + 2, lo); sh[k + 1] = lo; }
    if (this.pend[i] || hi !== sh[k + 2]) { this.w(b + 3, 0x08 | hi); sh[k + 2] = hi; this.pend[i] = 0; }   // resets duty phase, like real engines
  }
  tri(v) {
    const sh = this.sh;
    let t = -1;
    if (v.on && v.amp >= 0.05) {
      t = Math.round(NES_CPU / (32 * midiHz(v.note))) - 1;
      while (t > 2047) t = ((t + 1) >> 1) - 1;
    }
    if (t < 2) { if (sh[8] !== 0x80) { this.w(0x4008, 0x80); sh[8] = 0x80; } return; }   // linear counter → 0: halts at current step
    const lo = t & 0xFF, hi = t >> 8;
    if (lo !== sh[9]) { this.w(0x400A, lo); sh[9] = lo; }
    if (v.trig || hi !== sh[10]) { this.w(0x400B, 0x08 | hi); sh[10] = hi; }
    if (sh[8] !== 0xFF) { this.w(0x4008, 0xFF); sh[8] = 0xFF; }
  }
  drums(nv) {
    const h = this.h, d = this.drum;
    // new hits this frame: the most important one takes the noise channel; DPCM takes kick/snare/toms
    for (let i = 0; i < this.hits.length; i += 3) {
      const c = this.hits[i], note = this.hits[i + 1], vel = this.hits[i + 2];
      let def = DRUMS[note];
      const lvl = chipLevel(h.ch[c], vel);
      if (def.dmc && this.dpcm) {
        const s = this.smp[def.dmc + (vel >= 80 ? 'h' : 's')];
        this.w(0x4015, 0x0F);                                   // stop, then restart the DMC
        this.w(0x4010, def.rate); this.w(0x4012, s.a); this.w(0x4013, s.l);
        this.w(0x4015, 0x1F);
        this.dmcCh = c; this.dmcT = Math.round((s.l * 16 + 1) * 8 * DMC_P[def.rate] / NES_FRAME);
      } else if (def.alt) def = def.alt;
      const rem = d.on ? d.def.prio * (1 - d.f / d.def.n) : 0;
      if (!d.on || def.prio >= rem) { d.on = true; d.def = def; d.f = 0; d.lvl = lvl; d.ch = c; d.trig = true; }
    }
    this.hits.length = 0;
    if (this.dmcT > 0) { this.dmcT--; if (h.meter[this.dmcCh] < 0.9) h.meter[this.dmcCh] = 0.9; }

    const sh = this.sh;
    let r0 = 0x30, re = -1, trig = false;
    if (d.on && h.mute[d.ch]) d.on = false;
    if (d.on) {
      const df = d.def, x = d.f / df.n;
      let vol = df.vol * d.lvl * Math.pow(1 - x, df.curve);
      if (df.pat) vol *= df.pat[Math.min(d.f, df.pat.length - 1)];
      const pi = Math.round(df.p0 + (df.p1 - df.p0) * x);
      const mode = df.then === 0 && d.f >= 3 ? 0 : df.mode;
      r0 = 0x30 | Math.min(15, Math.round(vol)); re = (mode << 7) | pi; trig = d.trig; d.trig = false;
      if (r0 > 0x30 && h.meter[d.ch] < vol / 15) h.meter[d.ch] = vol / 15;
      if (++d.f >= df.n) d.on = false;
    } else if (nv && nv.on) {
      if (nv.vol > 0) { r0 = 0x30 | nv.vol; re = noiseIndex(nv.note); }
      trig = nv.trig;
    }
    if (trig) this.pend[3] = 1;
    if (r0 !== sh[12]) { this.w(0x400C, r0); sh[12] = r0; }
    if (re >= 0 && re !== sh[14]) { this.w(0x400E, re); sh[14] = re; }
    if (this.pend[3] && r0 > 0x30) { this.w(0x400F, 0x08); this.pend[3] = 0; }      // length load + envelope restart
  }

  // ---------------------------------------------------------------- audio
  render(L, R, n) {
    const apu = this.apu, rs = this.rs, f = this.f, g = this.gain;
    const a90 = this.a90, a440 = this.a440, b14 = this.b14, a37 = this.a37, nes = this.filter === 'nes';
    for (let i = 0; i < n; i++) {
      for (let k = rs.advance(); k > 0; k--) {
        if (this.flush) { this.flush = false; this.frame(); }
        this.fpos += D;
        if (this.fpos >= NES_FRAME) { this.fpos -= NES_FRAME; this.frame(); }
        const x = apu.sample(D);
        let y;
        if (nes) {
          f[1] = a90 * (f[1] + x - f[0]); f[0] = x;               // HP 90 Hz
          f[3] = a440 * (f[3] + f[1] - f[2]); f[2] = f[1];        // HP 440 Hz
          f[4] += b14 * (f[3] - f[4]);                            // LP 14 kHz
          y = f[4];
        } else { f[5] = a37 * (f[5] + x - f[0]); f[0] = x; y = f[5]; f[1] = f[2] = f[3] = f[4] = 0; }
        rs.push(y, y);
      }
      const o = rs.out();
      L[i] = o[0] * g; R[i] = o[0] * g;
    }
  }
  activeCount() {
    let k = 0;
    for (const v of this.drv.voices) if (v.on && v.vol > 0) k++;
    if (this.drum.on) k++;
    if (this.dmcT > 0) k++;
    return Math.min(5, k);
  }
  maxVoices() { return 5; }
}
