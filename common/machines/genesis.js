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
// Driver (a period-style sound driver ticking at 60 Hz like a VBlank-driven engine), played through native
// instruments (genesis-bank.js; Interface v2): each MIDI channel uses its Arranger instrument, or Auto = the
// GM mapping (gmPreset / the drum kit). Instrument kinds:
//   fm    FM channels 1-5 (6 too until the DAC is first used), allocated free → oldest released → PSG overflow
//         (with the instrument's psgEnv) → steal lowest priority (Bass > Lead > others > Pad/Strings); patches
//         written as registers (shadowed: only changed registers are written), key-off before every retrigger
//         with the busy-timed write queue guaranteeing the chip sees it for a full sample. Velocity × CC7 ×
//         CC11 → carrier TL; CC10 → L/R bits; bend → F-number/block; CC1 and the instrument's PMS (after
//         vibDelay frames) → LFO PMS; the instrument's lfo sets the global LFO rate; sustain pedal.
//         Lead instruments are doubled an octave up on a free PSG channel.
//   psg   PSG tone 1-3 with frame macros: volume (4-bit attenuator), arpeggio, pitch (10-bit periods).
//   noise the noise channel with volume and noise-mode macros (mode 3/7 borrows PSG 3's period for pitch).
//   dac   FM 6 in DAC mode streaming original 8-bit samples (genesis-drums.js) at 13.3 kHz × rate, one voice,
//         newest hit wins — classic Genesis style.
//   Voices can be pinned per MIDI channel (Arranger) to a specific chip channel of a compatible kind.

import { OPN2, ym3438_mode_ym2612, ym3438_mode_readmode, warmUp } from './nuked-opn2.js';
import { SN76489, PSG_CLOCK } from './sn76489.js';
import { Resampler, DCBlock } from './util.js';
import { CARRIERS, PRESETS, GM_PRESET, gmDrumPreset, autoDrumFine } from './genesis-bank.js';
import { SAMPLES, DAC_RATE } from './genesis-drums.js';

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
const V_NOISE = 9;                        // index of the noise voice in static voices

const PRIO = { Bass: 3, Lead: 2, Pad: 0, Strings: 0, Ensemble: 0 };
const priority = (inst) => inst ? (PRIO[inst.category] ?? 1) : 1;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const DEFAULT_ENV = [0.01, 0.4, 0.6, 0.2];

/** FamiTracker-style macro stepping: { values, loop, release }; st.i is the position. Returns the current value. */
function macroVal(m, st, held) {
  if (!m || !m.values || !m.values.length) return null;
  const n = m.values.length;
  if (st.i >= n) st.i = n - 1;
  const v = m.values[st.i];
  st.i++;
  if (held) {
    const end = m.release >= 0 && m.release < n ? m.release : n;
    if (st.i >= end) st.i = m.loop >= 0 && m.loop < end ? m.loop : end - 1;
  } else if (st.i >= n) {
    st.i = m.loop >= 0 && m.release >= 0 && m.loop > m.release ? m.loop : n - 1;
  }
  return v;
}

class FMVoice {
  constructor(i) {
    this.i = i; this.part = i < 3 ? 0 : 1; this.cc = i % 3; this.kc = this.cc | (this.part << 2);
    this.active = false; this.on = false; this.sus = false;
    this.midi = 0; this.note = 0; this.vel = 0; this.age = 0; this.t = 0; this.idx = -1; this.patch = null;
    this.vibOn = false; this.dbl = null; this.lvl = 0;
  }
}
class PSGVoice {
  constructor(i) {
    this.i = i; this.active = false; this.on = false; this.sus = false; this.midi = 0; this.note = 0; this.vel = 0; this.age = 0;
    this.idx = -1; this.inst = null; this.stage = 4; this.level = 0; this.env = null; this.gain = 1; this.att = 15; this.period = -1;
    this.vib = 0; this.dblOf = null; this.shift = 0; this.tr = 0; this.lvl = 0; this.borrowed = false;
    this.mv = { i: 0 }; this.ma = { i: 0 }; this.mp = { i: 0 }; this.volv = 15; this.arpv = 0; this.pitv = 0;
  }
}

export default class Genesis {
  static info = {
    id: 'genesis', name: 'Genesis / Mega Drive', maker: 'Sega', year: 1988,
    chip: 'Yamaha YM2612 + TI SN76489', voices: '6 × 4-op FM (FM 6 = DAC drums) · 3 square + noise',
    spec: 'Nuked OPN2 (cycle-accurate YM2612/YM3438) + SN76489 PSG, period driver with DAC drums',
  };
  static options = [{ key: 'chip', label: 'Chip', choices: [['ym2612', 'YM2612 (Model 1)'], ['ym3438', 'YM3438 (Model 2)']], default: 'ym2612' }];
  static voices = [
    { id: 'fm1', name: 'FM 1', kind: 'fm' }, { id: 'fm2', name: 'FM 2', kind: 'fm' }, { id: 'fm3', name: 'FM 3', kind: 'fm' },
    { id: 'fm4', name: 'FM 4', kind: 'fm' }, { id: 'fm5', name: 'FM 5', kind: 'fm' }, { id: 'fm6', name: 'FM 6 / DAC', kind: 'fm' },
    { id: 'psg1', name: 'PSG 1', kind: 'psg' }, { id: 'psg2', name: 'PSG 2', kind: 'psg' }, { id: 'psg3', name: 'PSG 3', kind: 'psg' },
    { id: 'noise', name: 'Noise', kind: 'noise' },
  ];
  static presets = PRESETS;
  static gmPreset(program) { return GM_PRESET[program & 127]; }
  static gmDrum(note) { return gmDrumPreset(note); }

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
    this.vs = new Float32Array(Genesis.voices.length * 4);
    this.frameAcc = 0; this.age = 0;
    this.table = PRESETS;
    this.arr = Array.from({ length: 16 }, () => ({ inst: -1, voice: 'auto' }));
    this.kit = {};
    this.vmute = 0;
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

  // ---------------------------------------------------------------- Interface v2
  setInstruments(list) {
    this.table = Array.isArray(list) && list.length ? list : PRESETS;
    for (const v of this.fm) if (v.active && v.idx >= 0) { const P = this.table[v.idx]; if (P && P.kind === 'fm') this.refreshFM(v, P); }
    for (const p of this.pv) if (p.active && p.idx >= 0 && this.table[p.idx] && this.table[p.idx].kind === 'psg') p.inst = this.table[p.idx];
    if (this.noise.active && this.noise.idx >= 0) this.noise.inst = this.table[this.noise.idx] || this.noise.inst;
  }
  updateInstrument(i, inst) {
    if (!inst || i < 0) return;
    if (this.table === PRESETS) this.table = PRESETS.slice();
    this.table[i] = inst;
    for (const v of this.fm) if (v.active && v.idx === i && inst.kind === 'fm') this.refreshFM(v, inst);
    for (const p of this.pv) if (p.active && p.idx === i) {
      if (inst.kind === 'psg') p.inst = inst;
      else if (inst.kind === 'fm' && !p.inst) { p.env = inst.psgEnv || DEFAULT_ENV; p.tr = inst.tr || 0; }
    }
    if (this.noise.active && this.noise.idx === i && inst.kind === 'noise') this.noise.inst = inst;
    const dv = this.dacv;
    if (dv.active && dv.idx === i && inst.kind === 'dac') { dv.gain = (inst.gain ?? 1) * dv.g; dv.step = DAC_STEP * dv.rateK * (inst.rate || 1); }
  }
  refreshFM(v, P) {
    v.patch = P; this.loadPatch(v, P); this.fmLevel(v); this.fmPan(v); this.fmFreq(v); this.setLFO(P);
  }
  setArrangement(arr) {
    if (!Array.isArray(arr)) return;
    for (let c = 0; c < 16; c++) { const a = arr[c] || {}; this.arr[c] = { inst: Number.isInteger(a.inst) ? a.inst : -1, voice: a.voice || 'auto' }; }
  }
  setKit(kit) { this.kit = kit && typeof kit === 'object' ? kit : {}; }
  setVoiceMute(mask) {
    this.vmute = mask | 0;
    for (const v of this.fm) if (v.active) this.fmLevel(v);
    for (const p of this.pv) if (p.active) this.psgUpdate(p, false);
    this.noiseAtt(false);
    if ((this.vmute & 32) && this.dacv.active) { this.dacv.active = false; this.chip.dac(0x80); }
  }
  voiceState() {
    const s = this.vs;
    for (let i = 0; i < 6; i++) {
      const v = this.fm[i], o = i * 4;
      if (i === 5 && this.dacOn) {
        const d = this.dacv;
        s[o] = d.active ? d.lvl : 0; s[o + 1] = d.active ? d.midi : -1; s[o + 2] = d.active ? d.note : -1; s[o + 3] = d.active ? d.idx : -1;
      } else { s[o] = v.active ? v.lvl : 0; s[o + 1] = v.active ? v.midi : -1; s[o + 2] = v.active ? v.note : -1; s[o + 3] = v.active ? v.idx : -1; }
    }
    for (let i = 0; i < 3; i++) {
      const p = this.pv[i], o = (6 + i) * 4;
      s[o] = p.active ? p.lvl : 0; s[o + 1] = p.active ? p.midi : -1; s[o + 2] = p.active ? p.note + p.shift : -1; s[o + 3] = p.active ? p.idx : -1;
    }
    const nz = this.noise, o = V_NOISE * 4;
    s[o] = nz.active ? nz.level : 0; s[o + 1] = nz.active ? nz.midi : -1; s[o + 2] = nz.active ? nz.note : -1; s[o + 3] = nz.active ? nz.idx : -1;
    return s;
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
    this.lfoReg = 0x09;
    this.wForce(0, 0x27, 0x00);             // normal channel 3, timers off
    this.wForce(0, 0x2b, 0x00);             // DAC off
    for (const v of this.fm) {
      Object.assign(v, { active: false, on: false, sus: false, idx: -1, patch: null, dbl: null, lvl: 0 });
      this.key(v, 0);
      for (let o = 0; o < 4; o++) this.w(v.part, 0x80 + v.cc + OPOFF[o], 0x0f);
      this.w(v.part, 0xb4 + v.cc, 0xc0);
    }
    for (const p of this.pv) { Object.assign(p, { active: false, on: false, sus: false, stage: 4, level: 0, att: 15, period: -1, dblOf: null, inst: null, idx: -1, borrowed: false, lvl: 0 }); this.psgW(0x90 | (p.i << 5) | 15); }
    this.psgW(0xff);
    this.noise = { active: false, on: false, level: 0, att: 15, midi: 9, note: -1, idx: -1, inst: null, mv: { i: 0 }, mn: { i: 0 }, mode: -1, g: 1, sus: false };
    this.dacOn = false; this.fmCount = 6;
    this.dacv = { active: false, s: null, pos: 0, step: 1, end: 0, gain: 1, g: 1, rateK: 1, midi: 9, note: -1, idx: -1, lvl: 0 };
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
    const P = v.patch, car = CARRIERS[P.alg & 7];
    let add = Math.round(this.attDb(v.midi, v.vel) / 0.75) + CARRIER_COMP[car.length];
    if (this.h.mute[v.midi] || (this.vmute >> v.i) & 1) add = 127;
    for (let o = 0; o < 4; o++) {
      const isCar = car.indexOf(o) >= 0;
      this.w(v.part, 0x40 + v.cc + OPOFF[o], isCar ? clamp(P.op[o].tl + add, 0, 127) : clamp(P.op[o].tl, 0, 127));
    }
  }
  panBits(c) { const p = this.h.ch[c].pan; return p < 43 ? 0x80 : p > 85 ? 0x40 : 0xc0; }
  fmPan(v) {
    const P = v.patch, ch = this.h.ch[v.midi];
    const ccP = ch.mod ? Math.min(5, Math.ceil(ch.mod * 5 / 127)) : 0;
    const pms = Math.max(ccP, v.vibOn ? (P.pms || 0) & 7 : 0);
    this.w(v.part, 0xb4 + v.cc, this.panBits(v.midi) | (((P.ams || 0) & 3) << 4) | pms);
  }
  setLFO(P) {
    const l = P.lfo ?? 1;
    const reg = l < 0 ? 0x00 : 0x08 | (l & 7);
    if (reg !== this.lfoReg) { this.lfoReg = reg; this.wForce(0, 0x22, reg); }
  }
  noteFreq(c, note, tr) { const ch = this.h.ch[c]; return 440 * Math.pow(2, (note + tr + ch.bend * ch.bendRange - 69) / 12); }
  fmFreq(v) {
    const f = this.noteFreq(v.midi, v.note, v.patch.tr || 0);
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
      this.w(v.part, 0x90 + r, p.ssg ? (p.ssg & 15) | 8 : 0);
    }
    this.w(v.part, 0xb0 + v.cc, ((P.fb & 7) << 3) | (P.alg & 7));
  }
  fmCarrierOut(v) {
    let m = 1023; const car = CARRIERS[v.patch.alg & 7], eo = this.chip.eg_out, base = v.i;
    for (const o of car) { const e = eo[base + SLOT[o]]; if (e < m) m = e; }
    return m;
  }

  // ---------------------------------------------------------------- allocation
  allocFM() {
    let best = null, ba = Infinity;
    for (let i = 0; i < this.fmCount; i++) if (!this.fm[i].active) return this.fm[i];
    for (let i = 0; i < this.fmCount; i++) { const v = this.fm[i]; if (!v.on && v.age < ba) { best = v; ba = v.age; } }
    return best;
  }
  allocPSG(free) {
    let best = null, ba = Infinity;
    for (const p of this.pv) if (!p.active && !p.borrowed) return p;
    if (free) return null;
    for (const p of this.pv) if (!p.borrowed && !p.on && p.age < ba) { best = p; ba = p.age; }
    return best;
  }
  oldestPSG() { let b = null; for (const p of this.pv) if (!p.borrowed && (!b || p.age < b.age)) b = p; return b; }
  stealFM() {
    let best = null, bs = Infinity;
    for (let i = 0; i < this.fmCount; i++) { const v = this.fm[i]; const s = priority(v.patch) * 1e9 + v.age; if (s < bs) { bs = s; best = v; } }
    return best;
  }
  /** Which instrument a note on MIDI channel c uses: [tableIndex, autoDrumFine | null]. */
  instFor(c, note) {
    const a = this.arr[c], ch = this.h.ch[c];
    if (a.inst >= 0 && this.table[a.inst]) return [a.inst, null];
    if (ch.drum) {
      const k = this.kit[note];
      if (k != null && this.table[k]) return [k, null];
      const i = gmDrumPreset(note);
      return [i, i >= 0 ? autoDrumFine(note) : null];
    }
    return [GM_PRESET[ch.program & 127], null];
  }

  // ---------------------------------------------------------------- MIDI
  noteOn(c, note, vel) {
    const [idx, fine] = this.instFor(c, note);
    const inst = idx >= 0 ? this.table[idx] : null;
    if (!inst) return;
    const pin = this.arr[c].voice || 'auto', drum = this.h.ch[c].drum;
    switch (inst.kind) {
      case 'fm': this.fmNote(c, note, vel, idx, inst, pin); break;
      case 'psg': this.psgNote(c, note, vel, idx, inst, pin); break;
      case 'noise': this.noiseNote(c, note, vel, idx, inst, fine); break;
      case 'dac': this.dacNote(c, note, vel, idx, inst, fine, drum); break;
    }
  }
  fmNote(c, note, vel, idx, P, pin) {
    let v = null;
    if (pin.startsWith('fm')) { const i = +pin.slice(2) - 1; if (i >= 0 && i < this.fmCount) v = this.fm[i]; }
    if (!v) {
      v = this.allocFM();
      if (!v && P.category !== 'Bass') { const p = this.allocPSG(false); if (p) { this.psgEnvOn(p, c, note, vel, idx, P, 0); return; } }
      if (!v) {
        v = this.stealFM();
        if (priority(P) < priority(v.patch)) { const p = this.allocPSG(false) || this.oldestPSG(); if (p) { this.psgEnvOn(p, c, note, vel, idx, P, 0); return; } }
      }
    }
    this.fmOn(v, c, note, vel, idx, P);
    if (P.category === 'Lead' && pin === 'auto') { const p = this.allocPSG(true); if (p) { this.psgEnvOn(p, c, note, vel, idx, P, 12); p.dblOf = v; v.dbl = p; } }
  }
  fmOn(v, c, note, vel, idx, P) {
    if (v.active) {
      this.key(v, 0);                                   // key off first; the busy-timed queue keeps it ≥ 1 sample
      if (v.on) for (let o = 0; o < 4; o++) this.w(v.part, 0x80 + v.cc + OPOFF[o], ((P.op[o].sl & 15) << 4) | 15);
      if (v.dbl) { this.psgOff(v.dbl, true); v.dbl = null; }
    }
    v.active = true; v.on = true; v.sus = false; v.midi = c; v.note = note; v.vel = vel; v.age = ++this.age; v.t = 0; v.idx = idx;
    v.vibOn = !(P.vibDelay > 0);
    if (v.patch !== P) { this.loadPatch(v, P); v.patch = P; }
    else for (let o = 0; o < 4; o++) { const p = P.op[o]; this.w(v.part, 0x80 + v.cc + OPOFF[o], ((p.sl & 15) << 4) | (p.rr & 15)); }
    this.setLFO(P);
    this.fmLevel(v); this.fmPan(v); this.fmFreq(v);
    this.key(v, 15);
  }
  fmOff(v) {
    v.on = false; v.sus = false;
    this.key(v, 0);
    if (v.dbl) { this.psgOff(v.dbl, false); v.dbl = null; }
  }

  // PSG tone voices: macro instruments (kind 'psg') or envelope-driven overflow / doubling of FM instruments
  psgNote(c, note, vel, idx, inst, pin) {
    let p = null;
    if (pin.startsWith('psg')) { const i = +pin.slice(3) - 1; if (i >= 0 && i < 3 && !this.pv[i].borrowed) p = this.pv[i]; }
    if (!p) p = this.allocPSG(false) || this.oldestPSG();
    if (!p) return;
    this.psgStart(p, c, note, vel, idx, 0);
    p.inst = inst; p.env = null; p.tr = inst.tr || 0;
    p.mv.i = 0; p.ma.i = 0; p.mp.i = 0;
    this.psgMacros(p);
    this.psgUpdate(p, true);
  }
  psgEnvOn(p, c, note, vel, idx, P, shift) {
    this.psgStart(p, c, note, vel, idx, shift);
    p.inst = null; p.env = P.psgEnv || DEFAULT_ENV; p.stage = 0; p.level = 0; p.tr = P.tr || 0;
    this.psgUpdate(p, true);
  }
  psgStart(p, c, note, vel, idx, shift) {
    if (p.dblOf) { p.dblOf.dbl = null; p.dblOf = null; }
    p.active = true; p.on = true; p.sus = false; p.midi = c; p.note = note; p.vel = vel; p.age = ++this.age; p.shift = shift; p.idx = idx;
    p.vib = 0; p.arpv = 0; p.pitv = 0; p.volv = 15;
    p.gain = Math.pow(10, -(this.attDb(c, vel) + (shift ? 6 : 0)) / 20);
  }
  psgOff(p, hard) {
    p.on = false; p.sus = false; p.dblOf = null;
    if (hard) { this.psgKill(p); return; }
    if (p.inst) { const m = p.inst.vol; if (m && m.release >= 0 && m.release < m.values.length) { p.mv.i = m.release; p.ma.i = p.inst.arp && p.inst.arp.release >= 0 ? p.inst.arp.release : p.ma.i; } else this.psgKill(p); }
    else p.stage = 3;
  }
  psgKill(p) { p.stage = 4; p.level = 0; p.active = false; p.on = false; if (p.dblOf) { p.dblOf.dbl = null; p.dblOf = null; } this.psgUpdate(p, true); }
  psgMacros(p) {
    const I = p.inst;
    const v = macroVal(I.vol, p.mv, p.on); if (v != null) p.volv = clamp(v, 0, 15);
    const a = macroVal(I.arp, p.ma, p.on); if (a != null) p.arpv = a;
    const q = macroVal(I.pitch, p.mp, p.on); if (q != null) p.pitv = q;
    if (I.vol && p.volv === 0 && p.mv.i >= I.vol.values.length - 1 && (!p.on || I.vol.loop < 0)) { p.active = false; p.on = false; }
  }
  psgUpdate(p, force) {
    const ch = this.h.ch[p.midi];
    let att = 15;
    if (p.active && !this.h.mute[p.midi] && !((this.vmute >> (6 + p.i)) & 1)) {
      if (p.inst) {
        att = clamp((15 - p.volv) + Math.round(-20 * Math.log10(Math.max(1e-6, p.gain)) / 2), 0, 15);
        if (p.volv === 0) att = 15;
      } else {
        const g = p.level * p.gain;
        att = g > 1e-5 ? clamp(Math.round(-20 * Math.log10(g) / 2), 0, 15) : 15;
      }
    }
    p.lvl = att >= 15 ? 0 : Math.pow(10, -att / 10);
    if (att !== p.att || force) { p.att = att; this.psgW(0x90 | (p.i << 5) | att); }
    if (!p.active) return;
    const vibC = (ch.mod ? (ch.mod / 127) * 45 * Math.sin(p.vib) : 0) + (p.inst ? p.pitv : 0);
    let f = this.noteFreq(p.midi, p.note + p.shift + (p.inst ? p.arpv : 0), p.tr) * Math.pow(2, vibC / 1200);
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

  // noise channel: volume + noise-mode macros
  noiseNote(c, note, vel, idx, inst, fine) {
    const nz = this.noise;
    nz.active = true; nz.on = true; nz.sus = false; nz.midi = c; nz.note = note; nz.idx = idx; nz.inst = inst; nz.mv.i = 0; nz.mn.i = 0; nz.mode = -1;
    nz.g = Math.pow(10, -0.7 * this.attDb(c, vel) / 20) * (this.h.mute[c] ? 0 : 1);
    nz.fineG = fine ? fine[1] : 1;
    this.noiseFrame(true);
  }
  noiseFrame(start) {
    const nz = this.noise, I = nz.inst;
    if (!nz.active || !I) return;
    const v = macroVal(I.vol, nz.mv, nz.on);
    nz.vol = v == null ? 15 : clamp(v, 0, 15);
    const md = macroVal(I.noise, nz.mn, nz.on);
    const mode = md == null ? 4 : md & 7;
    if (mode !== nz.mode || start) { this.psgW(0xe0 | mode); nz.mode = mode; }   // writing the noise register resets the LFSR
    const p3 = this.pv[2];
    if ((mode & 3) === 3) {                                   // clocked by PSG 3: borrow its period for the pitch
      if (!p3.borrowed) { if (p3.active) this.psgKill(p3); p3.borrowed = true; }
      const f = this.noteFreq(nz.midi, nz.note, I.tr || 0);
      const n = clamp(Math.round(PSG_CLOCK / (512 * f)), 1, 1023);
      this.psgW(0xc0 | (n & 15)); this.psgW((n >> 4) & 0x3f); this.psgW(0xdf);
    } else if (p3.borrowed) p3.borrowed = false;
    nz.level = nz.vol === 0 ? 0 : Math.pow(10, -(15 - nz.vol) / 10) * nz.g * (nz.fineG || 1);
    if (!nz.on && I.vol && nz.mv.i >= I.vol.values.length - 1 && nz.vol === 0) nz.active = false;
    this.noiseAtt(start);
  }
  noiseOff(hard) {
    const nz = this.noise;
    nz.on = false; nz.sus = false;
    const m = nz.inst && nz.inst.vol;
    if (hard || !m) { nz.active = false; nz.level = 0; }
    else if (m.release >= 0 && m.release < m.values.length) nz.mv.i = m.release;
    else if (nz.inst.category !== 'Drums') { nz.active = false; nz.level = 0; }   // drums ring out; tones stop
    this.noiseAtt(true);
  }
  noiseAtt(force) {
    const nz = this.noise;
    const on = nz.active && nz.level > 1e-4 && !((this.vmute >> V_NOISE) & 1);
    const att = on ? clamp(Math.round(-20 * Math.log10(nz.level) / 2), 0, 15) : 15;
    if (att !== nz.att || force) { nz.att = att; this.psgW(0xf0 | att); }
    if (!nz.active && this.pv[2].borrowed) this.pv[2].borrowed = false;
  }

  dacNote(c, note, vel, idx, inst, fine, drum) {
    if ((this.vmute >> 5) & 1) return;
    if (!this.dacOn) this.enableDAC();
    const s = SAMPLES[inst.sample] || SAMPLES.kick, dv = this.dacv;
    let rateK = fine ? fine[0] : 1;
    if (!drum && inst.keyTrack) rateK *= Math.pow(2, (note - 60) / 12);
    const g = Math.pow(10, -0.7 * this.attDb(c, vel) / 20) * (this.h.mute[c] ? 0 : 1) * (fine ? fine[1] : 1);
    dv.active = true; dv.s = s; dv.pos = 0; dv.rateK = rateK; dv.step = DAC_STEP * rateK * (inst.rate || 1);
    dv.end = Math.max(2, Math.floor(s.length * clamp((inst.len ?? 1) * (fine ? fine[2] : 1), 0.01, 1)));
    dv.g = g; dv.gain = (inst.gain ?? 1) * g; dv.midi = c; dv.note = note; dv.idx = idx; dv.lvl = dv.gain;
    this.w(1, 0xb6, this.panBits(c));
    this.chip.dac(this.dacSample(0));
  }
  dacSample(i) { const dv = this.dacv; return clamp(Math.round(128 + (dv.s[i] - 128) * dv.gain), 0, 255); }
  enableDAC() {
    this.dacOn = true; this.fmCount = 5;
    const v = this.fm[5];
    if (v.active) { this.key(v, 0); for (let o = 0; o < 4; o++) this.w(1, 0x80 + 2 + OPOFF[o], 0xff); v.active = false; v.on = false; if (v.dbl) { this.psgOff(v.dbl, true); v.dbl = null; } }
    v.patch = null; v.idx = -1;
    this.wForce(0, 0x2b, 0x80);
  }

  noteOff(c, note) {
    const sus = this.h.ch[c].sustain;
    for (let i = 0; i < 6; i++) { const v = this.fm[i]; if (v.active && v.on && v.midi === c && v.note === note) { if (sus) v.sus = true; else this.fmOff(v); } }
    for (const p of this.pv) if (p.active && p.on && !p.dblOf && p.midi === c && p.note === note) { if (sus) p.sus = true; else this.psgOff(p, false); }
    const nz = this.noise;
    if (nz.active && nz.on && nz.midi === c && nz.note === note) { if (sus) nz.sus = true; else this.noiseOff(false); }
  }
  sustainOff(c) {
    for (const v of this.fm) if (v.active && v.on && v.sus && v.midi === c) this.fmOff(v);
    for (const p of this.pv) if (p.active && p.on && p.sus && p.midi === c) this.psgOff(p, false);
    if (this.noise.active && this.noise.sus && this.noise.midi === c) this.noiseOff(false);
  }
  allOff(c, hard) {
    for (const v of this.fm) if (v.active && v.midi === c) {
      if (v.on) this.fmOff(v);
      if (hard) for (let o = 0; o < 4; o++) this.w(v.part, 0x80 + v.cc + OPOFF[o], 0xff);
    }
    for (const p of this.pv) if (p.active && p.midi === c) this.psgOff(p, hard);
    if (this.noise.active && this.noise.midi === c) this.noiseOff(hard);
    if (hard && this.dacv.active && this.dacv.midi === c) { this.dacv.active = false; this.chip.dac(0x80); }
  }
  pitch(c) {
    for (const v of this.fm) if (v.active && v.midi === c) this.fmFreq(v);
    for (const p of this.pv) if (p.active && p.midi === c) this.psgUpdate(p, false);
  }
  ctrl(c) {
    for (const v of this.fm) if (v.active && v.midi === c) { this.fmLevel(v); this.fmPan(v); }
    for (const p of this.pv) if (p.active && p.midi === c) { p.gain = Math.pow(10, -(this.attDb(c, p.vel) + (p.shift ? 6 : 0)) / 20); this.psgUpdate(p, false); }
    if (this.dacv.midi === c) { this.w(1, 0xb6, this.panBits(c)); if (this.h.mute[c] && this.dacv.active) { this.dacv.active = false; this.chip.dac(0x80); } }
    if (this.h.mute[c] && this.noise.active && this.noise.midi === c) { this.noise.active = false; this.noiseAtt(true); }
  }

  // ---------------------------------------------------------------- 60 Hz driver frame
  frame() {
    const met = this.h.meter;
    for (let i = 0; i < 6; i++) {
      const v = this.fm[i];
      if (!v.active) { v.lvl = 0; continue; }
      v.t += DT;
      const eo = this.fmCarrierOut(v);
      if (!v.on && eo >= 0x3e0 && v.t > 0.05) { v.active = false; v.lvl = 0; continue; }
      if (!v.vibOn && v.patch.pms && v.t >= (v.patch.vibDelay || 0) * DT) { v.vibOn = true; this.fmPan(v); }
      const g = (this.vmute >> i) & 1 ? 0 : Math.pow(10, -eo * 0.09375 / 20);
      v.lvl = g;
      if (g > met[v.midi]) met[v.midi] = g;
    }
    for (const p of this.pv) {
      if (!p.active) continue;
      if (p.inst) this.psgMacros(p); else this.psgEnv(p);
      p.vib += 2 * Math.PI * 5.5 * DT;
      this.psgUpdate(p, false);
      const g = p.lvl; if (g > met[p.midi]) met[p.midi] = g;
    }
    const nz = this.noise;
    if (nz.active) { this.noiseFrame(false); if (nz.level > met[nz.midi]) met[nz.midi] = nz.level; }
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
    const psg = this.psg, a = this.lpA, dc = this.dc, dcR = this.dcR;
    let lp = this.lp, lpR = this.lpR, j = 0;
    for (let i = 0; i < n; i++) {
      for (let k = cnt[i]; k > 0; k--, j++) {
        const ps = psg.run(PSG_UNITS) * PSG_GAIN;
        lp += a * (CL[j] * FM_GAIN + ps - lp);
        lpR += a * (CR[j] * FM_GAIN + ps - lpR);
        rs.push(lp, lpR);
      }
      const o = rs.out();
      L[i] = dc.run(o[0]); R[i] = dcR.run(o[1]);
    }
    this.lp = lp; this.lpR = lpR;
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
