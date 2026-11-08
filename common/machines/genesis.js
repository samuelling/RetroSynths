// Sega Genesis / Mega Drive machine for RetroSynths.
//
// Sound hardware
//   YM2612 (or YM3438) FM: cycle-accurate port of Nuked OPN2 (nuked-opn2.js, LGPL-2.1), clocked at the NTSC
//     master clock / 7 = 7.670454 MHz; one stereo sample per 144 clocks (≈ 53,267 Hz), each sample the sum of
//     the chip's 24 internal MOL/MOR pin states, as in the Genesis Plus GX integration of Nuked OPN2.
//   SN76489 PSG (Sega VDP variant, sn76489.js): master / 15 = 3.579545 MHz, tick / 16, integrated exactly onto
//     the FM sample grid (box filter), mono.
//   Mix: FM channels hard-panned L / R / both by the chip; PSG centred, one PSG tone at full volume peaking
//     at ~45% of one full-scale FM channel. Output stage: a one-pole low-pass (Model 1 / YM2612: 3 dB at
//     7.2 kHz, a mild stand-in for the console's RC output filtering, not a measured curve; YM3438 /
//     Model 2 setting: 15 kHz), DC blocker, then util.Resampler to the host rate.
//
// Driver (a period-style GM → Genesis sound driver, ticking at 60 Hz like a VBlank-driven engine)
//   FM channels 1-5 melodic (6 too until drums are first used; then channel 6 is the DAC), voices allocated
//   free → oldest released → PSG overflow → steal lowest priority (bass > lead > others > pads), patches from
//   genesis-bank.js written as registers (shadowed, only changed registers are written), key-off before every
//   retrigger with the busy-timed register writes guaranteeing the chip sees it for a full sample.
//   Velocity × CC7 × CC11 → carrier TL; CC10 → L/R bits; pitch bend → F-number/block; CC1 → LFO PMS
//   (hardware vibrato, LFO at 5.56 Hz), patches with built-in vibrato get it after a delay; sustain pedal.
//   PSG: 3 tone voices take overflow notes with software envelopes / vibrato (60 Hz frames, quantised to the
//   4-bit attenuators and 10-bit periods), and double lead-synth notes an octave up when free; the noise channel
//   plays hi-hats, cymbals and shakers.
//   Drums: FM channel 6 in DAC mode streaming original 8-bit samples (genesis-drums.js) at 13.3 kHz
//   (pitched by rate), one voice, newest hit wins — classic Genesis style.

import { OPN2, ym3438_mode_ym2612, ym3438_mode_readmode, warmUp } from './nuked-opn2.js';
import { SN76489, PSG_CLOCK } from './sn76489.js';
import { Resampler, DCBlock } from './util.js';
import { MELODIC, CARRIERS } from './genesis-bank.js';
import { SAMPLES, DAC_RATE, drumFor } from './genesis-drums.js';

const MASTER = 53693175;                  // NTSC master clock
const YM_CLOCK = MASTER / 7;              // 7.670454 MHz
const FS = YM_CLOCK / 144;                // ≈ 53,267 Hz chip sample rate
const PSG_UNITS = 1008;                   // master clocks per FM sample (7 × 144); a PSG tick is 15 × 16 = 240
const FRAME_HZ = 60;
const OPOFF = [0, 8, 4, 12];              // register offsets of OP1..OP4
const SLOT = [0, 12, 6, 18];              // Nuked slot index of OP1..OP4 for chip channel 0 (+ channel)
const DT = 1 / FRAME_HZ;
const DAC_STEP = DAC_RATE / FS;           // DAC sample index advance per chip sample at rate 1

const FM_GAIN = 1 / 2000;                 // chip pin-sum → float
const PSG_GAIN = 0.45 * 777 * FM_GAIN;    // one PSG tone at 0 dB vs one full-scale FM channel (±777)
const CARRIER_COMP = [0, 0, 4, 7, 8];     // TL added per carrier count so multi-carrier algorithms match

const priority = (prog) => { const f = prog >> 3; return f === 4 ? 3 : f === 10 ? 2 : (f === 5 || f === 6 || f === 11) ? 0 : 1; };
const isLead = (prog) => (prog >> 3) === 10;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;

class FMVoice {
  constructor(i) {
    this.i = i; this.part = i < 3 ? 0 : 1; this.cc = i % 3; this.kc = this.cc | (this.part << 2);
    this.active = false; this.on = false; this.sus = false;
    this.midi = 0; this.note = 0; this.vel = 0; this.age = 0; this.t = 0; this.prog = -1; this.patch = null;
    this.vibOn = false; this.dbl = null;
  }
}
class PSGVoice {
  constructor(i) { this.i = i; this.active = false; this.on = false; this.sus = false; this.midi = 0; this.note = 0; this.vel = 0; this.age = 0;
    this.stage = 4; this.level = 0; this.env = null; this.gain = 1; this.att = 15; this.period = -1; this.vib = 0; this.dblOf = null; this.shift = 0; }
}

export default class Genesis {
  static info = {
    id: 'genesis', name: 'Genesis / Mega Drive', maker: 'Sega', year: 1988,
    chip: 'Yamaha YM2612 + TI SN76489', voices: '6 × 4-op FM (ch 6 = DAC drums) · 3 square + noise',
    spec: 'Nuked OPN2 (cycle-accurate YM2612/YM3438) + SN76489 PSG, period GM driver with DAC drums',
  };
  static options = [{ key: 'chip', label: 'Chip', choices: [['ym2612', 'YM2612 (Model 1)'], ['ym3438', 'YM3438 (Model 2)']], default: 'ym2612' }];

  constructor(host) {
    this.h = host;
    warmUp();                                // JIT warm-up of the chip's generated fast path (once per module)
    this.chipType = 'ym2612';
    this.chip = new OPN2(ym3438_mode_ym2612 | ym3438_mode_readmode);
    this.psg = new SN76489(240);
    this.rs = new Resampler(FS, host.sampleRate);
    this.dc = new DCBlock(host.sampleRate, 15); this.dcR = new DCBlock(host.sampleRate, 15);
    this.lpA = 0; this.setLPF(7200); this.lp = 0; this.lpR = 0;
    this.fm = []; for (let i = 0; i < 6; i++) this.fm.push(new FMVoice(i));
    this.pv = []; for (let i = 0; i < 3; i++) this.pv.push(new PSGVoice(i));
    this.shadow = new Int16Array(512);
    this.CL = new Int32Array(8192); this.CR = new Int32Array(8192); this.cnt = new Uint8Array(8192);
    this.frameAcc = 0; this.age = 0; this.time = 0;
    this.reset();
  }

  setLPF(hz) { this.lpA = 1 - Math.exp(-2 * Math.PI * hz / FS); }
  setOption(key, value) {
    if (key !== 'chip' || (value !== 'ym2612' && value !== 'ym3438')) return;
    this.chipType = value;
    this.chip.setChipType(value === 'ym2612' ? (ym3438_mode_ym2612 | ym3438_mode_readmode) : ym3438_mode_readmode);
    this.setLPF(value === 'ym2612' ? 7200 : 15000);
    this.settle();
  }
  /** Pre-charge the output stage to the idle level (the YM2612's ladder effect gives idle channels a small DC). */
  settle() {
    const idle = this.chipType === 'ym2612' ? 72 * FM_GAIN : 0;
    this.lp = this.lpR = idle;
    for (let i = 0; i < 128; i++) this.rs.push(idle, idle);
    for (const d of [this.dc, this.dcR]) { d.x1 = idle; d.y1 = 0; }
  }

  // ---------------------------------------------------------------- register access
  w(part, reg, val) {
    const k = (part << 8) | reg;
    if (this.shadow[k] === val) return;
    this.shadow[k] = val;
    this.chip.writeReg(part, reg, val);
  }
  wForce(part, reg, val) { this.shadow[(part << 8) | reg] = val; this.chip.writeReg(part, reg, val); }
  key(v, onMask) { this.chip.writeReg(0, 0x28, (onMask << 4) | v.kc); }
  psgW(b) { this.psg.write(b); }

  reset() {
    this.chip.reset();
    this.psg.reset();
    this.shadow.fill(-1);
    this.wForce(0, 0x22, 0x09);             // LFO on, 5.56 Hz
    this.wForce(0, 0x27, 0x00);             // normal channel 3, timers off
    this.wForce(0, 0x2b, 0x00);             // DAC off
    for (const v of this.fm) {
      Object.assign(v, { active: false, on: false, sus: false, prog: -1, patch: null, dbl: null });
      this.key(v, 0);
      for (let o = 0; o < 4; o++) this.w(v.part, 0x80 + v.cc + OPOFF[o], 0x0f);
      this.w(v.part, 0xb4 + v.cc, 0xc0);
    }
    for (const p of this.pv) { Object.assign(p, { active: false, on: false, sus: false, stage: 4, level: 0, att: 15, period: -1, dblOf: null }); this.psgW(0x90 | (p.i << 5) | 15); }
    this.psgW(0xff);
    this.noise = { active: false, level: 0, k: 0, att: 15, midi: 9, mode: -1 };
    this.dacOn = false; this.fmCount = 6;
    this.dacv = { active: false, s: null, pos: 0, step: 1, end: 0, gain: 1, midi: 9, lvl: 0 };
    this.frameAcc = 0;
    this.settle();
  }

  // ---------------------------------------------------------------- level / pitch helpers
  attDb(c, vel) {
    const ch = this.h.ch[c];
    const v = Math.max(1, vel) / 127, ve = Math.max(1, ch.vol * ch.expr) / 16129;
    return -40 * Math.log10(v) * 0.6 - 40 * Math.log10(ve);
  }
  fmLevel(v) {
    const P = v.patch, car = CARRIERS[P.alg];
    let add = Math.round((this.attDb(v.midi, v.vel) - (P.lvl || 0)) / 0.75) + CARRIER_COMP[car.length];
    if (this.h.mute[v.midi]) add = 127;
    for (let o = 0; o < 4; o++) {
      const isCar = car.indexOf(o) >= 0;
      this.w(v.part, 0x40 + v.cc + OPOFF[o], isCar ? clamp(P.op[o].tl + add, 0, 127) : P.op[o].tl);
    }
  }
  panBits(c) { const p = this.h.ch[c].pan; return p < 43 ? 0x80 : p > 85 ? 0x40 : 0xc0; }
  fmPan(v) {
    const P = v.patch, ch = this.h.ch[v.midi];
    const ccP = ch.mod ? Math.min(5, Math.ceil(ch.mod * 5 / 127)) : 0;
    const pms = Math.max(ccP, v.vibOn ? (P.pms || 0) : 0);
    this.w(v.part, 0xb4 + v.cc, this.panBits(v.midi) | ((P.ams || 0) << 4) | pms);
  }
  noteFreq(c, note, tr) { const ch = this.h.ch[c]; return 440 * Math.pow(2, (note + tr + ch.bend * ch.bendRange - 69) / 12); }
  fmFreq(v) {
    const P = v.patch;
    const f = P.fixed ? 440 * Math.pow(2, (P.fixed - 69) / 12) : this.noteFreq(v.midi, v.note, P.tr || 0);
    let block = 0, fnum = 0;
    for (block = 0; block < 8; block++) { fnum = Math.round(f * Math.pow(2, 21 - block) / FS); if (fnum < 2048) break; }
    if (block > 7) { block = 7; fnum = 2047; }
    if (fnum < 1) fnum = 1;
    const hi = (block << 3) | (fnum >> 8), lo = fnum & 0xff;
    const kHi = (v.part << 8) | (0xa4 + v.cc);
    if (this.shadow[kHi] !== hi || this.shadow[(v.part << 8) | (0xa0 + v.cc)] !== lo) {
      this.wForce(v.part, 0xa4 + v.cc, hi);           // A4 latches, A0 commits both
      this.wForce(v.part, 0xa0 + v.cc, lo);
    }
  }
  loadPatch(v, P) {
    for (let o = 0; o < 4; o++) {
      const p = P.op[o], r = v.cc + OPOFF[o];
      this.w(v.part, 0x30 + r, ((p.dt & 7) << 4) | (p.mul & 15));
      this.w(v.part, 0x50 + r, ((p.ks & 3) << 6) | (p.ar & 31));
      this.w(v.part, 0x60 + r, ((p.am & 1) << 7) | (p.d1r & 31));
      this.w(v.part, 0x70 + r, p.d2r & 31);
      this.w(v.part, 0x80 + r, ((p.sl & 15) << 4) | (p.rr & 15));
      this.w(v.part, 0x90 + r, p.ssg & 15);
    }
    this.w(v.part, 0xb0 + v.cc, ((P.fb & 7) << 3) | (P.alg & 7));
  }
  fmCarrierOut(v) {
    let m = 1023; const car = CARRIERS[v.patch.alg], eo = this.chip.eg_out, base = v.i;
    for (const o of car) { const e = eo[base + SLOT[o]]; if (e < m) m = e; }
    return m;
  }

  // ---------------------------------------------------------------- allocation
  allocFM(prog) {
    let best = null, ba = Infinity;
    for (let i = 0; i < this.fmCount; i++) if (!this.fm[i].active) return this.fm[i];
    for (let i = 0; i < this.fmCount; i++) { const v = this.fm[i]; if (!v.on && v.age < ba) { best = v; ba = v.age; } }
    return best;
  }
  allocPSG(free) {
    let best = null, ba = Infinity;
    for (const p of this.pv) if (!p.active) return p;
    if (free) return null;
    for (const p of this.pv) if (!p.on && p.age < ba) { best = p; ba = p.age; }
    return best;
  }
  stealFM() {
    let best = null, bs = Infinity;
    for (let i = 0; i < this.fmCount; i++) { const v = this.fm[i]; const s = priority(v.prog) * 1e9 + v.age; if (s < bs) { bs = s; best = v; } }
    return best;
  }

  // ---------------------------------------------------------------- MIDI
  noteOn(c, note, vel) {
    const ch = this.h.ch[c];
    if (ch.drum) { this.drum(c, note, vel); return; }
    const prog = ch.program & 127, P = MELODIC[prog];
    let v = this.allocFM(prog);
    if (!v && prog >> 3 !== 4) { const p = this.allocPSG(false); if (p) { this.psgOn(p, c, note, vel, P, 0); return; } }
    if (!v) {
      v = this.stealFM();
      if (priority(prog) < priority(v.prog)) { const p = this.allocPSG(false) || this.oldestPSG(); if (p) { this.psgOn(p, c, note, vel, P, 0); return; } }
    }
    this.fmOn(v, c, note, vel, prog, P);
    if (isLead(prog)) { const p = this.allocPSG(true); if (p) { this.psgOn(p, c, note, vel, P, 12); p.dblOf = v; v.dbl = p; } }
  }
  oldestPSG() { let b = null; for (const p of this.pv) if (!b || p.age < b.age) b = p; return b; }

  fmOn(v, c, note, vel, prog, P) {
    if (v.active) {
      this.key(v, 0);                                   // key off first; the busy-timed queue keeps it ≥ 1 sample
      if (v.on) for (let o = 0; o < 4; o++) this.w(v.part, 0x80 + v.cc + OPOFF[o], (P.op[o].sl << 4) | 15);
      if (v.dbl) { this.psgOff(v.dbl, true); v.dbl = null; }
    }
    v.active = true; v.on = true; v.sus = false; v.midi = c; v.note = note; v.vel = vel; v.age = ++this.age; v.t = 0;
    v.vibOn = false;
    if (v.patch !== P) { this.loadPatch(v, P); v.patch = P; }
    else for (let o = 0; o < 4; o++) { const p = P.op[o]; this.w(v.part, 0x80 + v.cc + OPOFF[o], ((p.sl & 15) << 4) | (p.rr & 15)); }
    v.prog = prog;
    this.fmLevel(v); this.fmPan(v); this.fmFreq(v);
    this.key(v, 15);
  }
  fmOff(v) {
    v.on = false; v.sus = false;
    this.key(v, 0);
    if (v.dbl) { this.psgOff(v.dbl, false); v.dbl = null; }
  }

  psgOn(p, c, note, vel, P, shift) {
    if (p.dblOf) { p.dblOf.dbl = null; p.dblOf = null; }
    p.active = true; p.on = true; p.sus = false; p.midi = c; p.note = note; p.vel = vel; p.age = ++this.age; p.shift = shift;
    p.env = P.psg || [0.005, 0.3, 0.6, 0.2]; p.stage = 0; p.level = 0; p.vib = 0; p.tr = P.tr || 0;
    p.gain = Math.pow(10, -(this.attDb(c, vel) + (shift ? 6 : 0)) / 20);
    this.psgUpdate(p, true);
  }
  psgOff(p, hard) {
    p.on = false; p.sus = false; p.dblOf = null;
    if (hard) { p.stage = 4; p.level = 0; p.active = false; this.psgUpdate(p, true); } else p.stage = 3;
  }
  psgUpdate(p, force) {
    const ch = this.h.ch[p.midi];
    let att = 15;
    if (p.active && !this.h.mute[p.midi]) {
      const g = p.level * p.gain;
      att = g > 1e-5 ? clamp(Math.round(-20 * Math.log10(g) / 2), 0, 15) : 15;
    }
    if (att !== p.att || force) { p.att = att; this.psgW(0x90 | (p.i << 5) | att); }
    if (!p.active) return;
    const vibC = ch.mod ? (ch.mod / 127) * 45 * Math.sin(p.vib) : 0;
    let f = this.noteFreq(p.midi, p.note + p.shift, p.tr) * Math.pow(2, vibC / 1200);
    let n = Math.round(PSG_CLOCK / (32 * f));
    while (n > 1023) { f *= 2; n = Math.round(PSG_CLOCK / (32 * f)); }   // below the PSG's range: fold up an octave
    n = clamp(n, 2, 1023);
    if (n !== p.period || force) { p.period = n; this.psgW(0x80 | (p.i << 5) | (n & 15)); this.psgW((n >> 4) & 0x3f); }
  }
  psgEnv(p) {
    const [a, d, s, r] = p.env;
    switch (p.stage) {
      case 0: p.level += a > 0 ? DT / a : 1; if (p.level >= 1) { p.level = 1; p.stage = 1; } break;
      case 1: p.level -= (DT / Math.max(0.01, d)) * (1 - s); if (p.level <= s) { p.level = s; p.stage = 2; if (s <= 0.001) { p.stage = 4; } } break;
      case 2: break;
      case 3: p.level -= p.level * (1 - Math.exp(-DT * 4.6 / Math.max(0.02, r))) + 0.004; if (p.level <= 0.01) { p.level = 0; p.stage = 4; } break;
    }
    if (p.stage === 4) { p.level = 0; p.active = false; p.on = false; if (p.dblOf) { p.dblOf.dbl = null; p.dblOf = null; } }
  }

  drum(c, note, vel) {
    const d = drumFor(note);
    const g = Math.pow(10, -0.7 * this.attDb(c, vel) / 20) * (this.h.mute[c] ? 0 : 1);   // drums: gentler curve
    if (d.psg) {
      const nz = this.noise;
      nz.active = true; nz.midi = c; nz.level = d.level * g; nz.k = Math.exp(-DT * Math.log(31.6) / d.decay);
      this.psgW(0xe0 | d.mode);                         // writing the noise register also resets the LFSR
      nz.mode = d.mode; this.noiseAtt(true);
      return;
    }
    if (!this.dacOn) this.enableDAC();
    const s = SAMPLES[d.dac], dv = this.dacv;
    dv.active = true; dv.s = s; dv.pos = 0; dv.step = DAC_STEP * d.rate; dv.end = Math.max(2, Math.floor(s.length * d.len));
    dv.gain = d.gain * g; dv.midi = c; dv.lvl = dv.gain;
    this.w(1, 0xb6, this.panBits(c));
    this.chip.dac(this.dacSample(0));
  }
  dacSample(i) { const dv = this.dacv; return clamp(Math.round(128 + (dv.s[i] - 128) * dv.gain), 0, 255); }
  noiseAtt(force) {
    const nz = this.noise;
    const att = nz.active && nz.level > 1e-4 ? clamp(Math.round(-20 * Math.log10(nz.level) / 2), 0, 15) : 15;
    if (att !== nz.att || force) { nz.att = att; this.psgW(0xf0 | att); }
    if (att === 15) nz.active = false;
  }
  enableDAC() {
    this.dacOn = true; this.fmCount = 5;
    const v = this.fm[5];
    if (v.active) { this.key(v, 0); for (let o = 0; o < 4; o++) this.w(1, 0x80 + 2 + OPOFF[o], 0xff); v.active = false; v.on = false; if (v.dbl) { this.psgOff(v.dbl, true); v.dbl = null; } }
    v.patch = null; v.prog = -1;
    this.wForce(0, 0x2b, 0x80);
  }

  noteOff(c, note) {
    const sus = this.h.ch[c].sustain;
    for (let i = 0; i < 6; i++) { const v = this.fm[i]; if (v.active && v.on && v.midi === c && v.note === note) { if (sus) v.sus = true; else this.fmOff(v); } }
    for (const p of this.pv) if (p.active && p.on && !p.dblOf && p.midi === c && p.note === note) { if (sus) p.sus = true; else this.psgOff(p, false); }
  }
  sustainOff(c) {
    for (const v of this.fm) if (v.active && v.on && v.sus && v.midi === c) this.fmOff(v);
    for (const p of this.pv) if (p.active && p.on && p.sus && p.midi === c) this.psgOff(p, false);
  }
  allOff(c, hard) {
    for (const v of this.fm) if (v.active && v.midi === c) {
      if (v.on) this.fmOff(v);
      if (hard) for (let o = 0; o < 4; o++) this.w(v.part, 0x80 + v.cc + OPOFF[o], 0xff);
    }
    for (const p of this.pv) if (p.active && p.midi === c) this.psgOff(p, hard);
    if (hard) {
      if (this.dacv.active && this.dacv.midi === c) { this.dacv.active = false; this.chip.dac(0x80); }
      if (this.noise.active && this.noise.midi === c) { this.noise.active = false; this.noiseAtt(true); }
    }
  }
  pitch(c) {
    for (const v of this.fm) if (v.active && v.midi === c) this.fmFreq(v);
    for (const p of this.pv) if (p.active && p.midi === c) this.psgUpdate(p, false);
  }
  ctrl(c) {
    for (const v of this.fm) if (v.active && v.midi === c) { this.fmLevel(v); this.fmPan(v); }
    for (const p of this.pv) if (p.active && p.midi === c) { p.gain = Math.pow(10, -(this.attDb(c, p.vel) + (p.shift ? 6 : 0)) / 20); this.psgUpdate(p, false); }
    if (this.dacv.midi === c && this.h.ch[c].drum) { this.w(1, 0xb6, this.panBits(c)); if (this.h.mute[c] && this.dacv.active) { this.dacv.active = false; this.chip.dac(0x80); } }
    if (this.h.mute[c] && this.noise.active && this.noise.midi === c) { this.noise.active = false; this.noiseAtt(true); }
  }

  // ---------------------------------------------------------------- 60 Hz driver frame
  frame() {
    const met = this.h.meter;
    for (let i = 0; i < 6; i++) {
      const v = this.fm[i];
      if (!v.active) continue;
      v.t += DT;
      const eo = this.fmCarrierOut(v);
      if (!v.on && eo >= 0x3e0 && v.t > 0.05) { v.active = false; continue; }
      if (!v.vibOn && v.patch.pms && v.t > 0.28) { v.vibOn = true; this.fmPan(v); }
      const g = Math.pow(10, -eo * 0.09375 / 20);
      if (g > met[v.midi]) met[v.midi] = g;
    }
    for (const p of this.pv) {
      if (!p.active) continue;
      this.psgEnv(p);
      p.vib += 2 * Math.PI * 5.5 * DT;
      this.psgUpdate(p, false);
      const g = p.level * p.gain; if (g > met[p.midi]) met[p.midi] = g;
    }
    const nz = this.noise;
    if (nz.active) { nz.level *= nz.k; this.noiseAtt(false); if (nz.level > met[nz.midi]) met[nz.midi] = nz.level; }
    const dv = this.dacv;
    if (dv.active) { dv.lvl *= 0.9; if (dv.lvl > met[dv.midi]) met[dv.midi] = dv.lvl; }
  }

  // ---------------------------------------------------------------- audio
  render(L, R, n) {
    if (n > 2048) { for (let o = 0; o < n; o += 2048) this.render(L.subarray(o, Math.min(n, o + 2048)), R.subarray(o, Math.min(n, o + 2048)), Math.min(2048, n - o)); return; }
    const rs = this.rs, cnt = this.cnt;
    // driver frames for this block, then the number of chip samples each output sample needs
    this.frameAcc += n * FRAME_HZ / this.h.sampleRate;
    while (this.frameAcc >= 1) { this.frameAcc -= 1; this.frame(); }
    let total = 0;
    for (let i = 0; i < n; i++) { const k = rs.advance(); cnt[i] = k; total += k; }
    // run the chip in segments, streaming DAC samples at their write times
    const CL = this.CL, CR = this.CR, chip = this.chip, dv = this.dacv;
    let done = 0;
    while (done < total) {
      let seg = total - done;
      if (dv.active) {
        const idx = Math.floor(dv.pos);
        const until = Math.max(1, Math.ceil((idx + 1 - dv.pos) / dv.step));
        if (until < seg) seg = until;
      }
      chip.render(CL, CR, seg, null, done);
      done += seg;
      if (dv.active) {
        const before = Math.floor(dv.pos);
        dv.pos += dv.step * seg;
        const idx = Math.floor(dv.pos);
        if (idx >= dv.end) { dv.active = false; chip.dac(0x80); }
        else if (idx !== before) chip.dac(this.dacSample(idx));
      }
    }
    // mix FM + PSG at the chip rate, output stage, resample
    const psg = this.psg, a = this.lpA, dc = this.dc;
    let lp = this.lp, lpR = this.lpR, j = 0;
    for (let i = 0; i < n; i++) {
      for (let k = cnt[i]; k > 0; k--, j++) {
        const ps = psg.run(PSG_UNITS) * PSG_GAIN;
        lp += a * (CL[j] * FM_GAIN + ps - lp);
        lpR += a * (CR[j] * FM_GAIN + ps - lpR);
        rs.push(lp, lpR);
      }
      const o = rs.out();
      L[i] = o[0]; R[i] = o[1];
    }
    this.lp = lp; this.lpR = lpR;
    const dcR = this.dcR;
    for (let i = 0; i < n; i++) { L[i] = dc.run(L[i]); R[i] = dcR.run(R[i]); }
  }

  activeCount() {
    let k = 0;
    for (const v of this.fm) if (v.active) k++;
    for (const p of this.pv) if (p.active) k++;
    if (this.noise.active) k++;
    if (this.dacv.active) k++;
    return k;
  }
  maxVoices() { return 10; }
}
