/*
 * OPL2 / OPL3 machine core — a register-level period driver over the bit-exact Nuked OPL3 port
 * (opl-nuked3.js, LGPL-2.1) running at the chip's native 49,716 Hz, through the YM3014-style
 * floating-point DAC, a band-limited resampler and the cards' analog output stage. Ported from Blasta's OPLCore.
 *
 * OPL2 mode (YM3812): 9 two-operator channels, 4 waveforms, mono DAC.
 * OPL3 mode (YMF262, NEW=1): 18 channels, 8 waveforms, L/R pan bits, and 4-op channel pairs
 * (1+4, 2+5, 3+6, 10+13, 11+14, 12+15) switched per note through register $104.
 *
 * Instruments (opl-bank.js) are played through the Arranger / GM mapping; voice allocation: free → oldest
 * released → oldest. A channel that was keyed during the current chip sample is re-keyed one sample later
 * (the chip only retriggers after it has seen the key released).
 */
import { OPL3 } from './opl-nuked3.js';
import { Resampler } from './util.js';

const OPL_RATE = 49716;                  // 14.31818 MHz / 288
const OP_OFF = [0, 1, 2, 8, 9, 10, 16, 17, 18];
const PAIR_A = [0, 1, 2, 9, 10, 11];     // 4-op pair first channels (second = +3)

function dacFloat(x) {                   // YM3014 / YAC512 floating-point DAC: 10-bit mantissa, 3-bit exponent
  const a = x < 0 ? -x : x;
  if (a < 512) return x;
  let sh = 1;
  while ((a >> sh) >= 512) sh++;
  return ((x >> sh) << sh);
}
// carriers of a note: indices into its ops
const carriers2 = (cnt) => (cnt ? [0, 1] : [1]);
const carriers4 = (cnt, cnt2) => [[3], [1, 3], [0, 3], [0, 2, 3]][(cnt << 1) | cnt2];   // FM-FM, FM-AM, AM-FM, AM-AM

class Chan {
  constructor(c) {
    this.c = c; this.bit = 1 << c;
    this.hi = c >= 9 ? 0x100 : 0; this.ch = c % 9; this.mop = OP_OFF[this.ch]; this.cop = this.mop + 3;
    this.active = false; this.on = false; this.sus = false;
    this.midi = 0; this.note = 0; this.vel = 0; this.age = 0; this.idx = -1; this.ins = null;
    this.part = null; this.four = false; this.slave = null; this.master = null;
    this.pitch = 60; this.fixed = false; this.offset = 0; this.detune = 0;
    this.fnum = 0; this.block = 0; this.pan = 0x30; this.offTick = -1;
  }
}

export class OPLMachine {
  constructor(host, kind) {
    this.h = host; this.kind = kind;
    this.nv = kind ? 18 : 9;
    this.stereo = kind === 1;
    this.chip = new OPL3();
    this.v = []; for (let i = 0; i < this.nv; i++) this.v.push(new Chan(i));
    // 2-op allocation order: on OPL3 keep 4-op-capable pairs free as long as possible
    this.order = kind ? [6, 7, 8, 15, 16, 17, 0, 3, 1, 4, 2, 5, 9, 12, 10, 13, 11, 14].map(i => this.v[i]) : this.v.slice();
    this.table = this.constructor.presets.slice();
    this.arr = Array.from({ length: 16 }, () => ({ inst: -1, voice: 'auto' }));
    this.kit = {}; this.vmute = 0; this.pinned = new Set();
    this.fourMask = 0;
    this.age = 0; this.deferred = []; this.tick = 0;
    this.rs = new Resampler(OPL_RATE, host.sampleRate);
    const SR = host.sampleRate;
    this.cbuf = [0, 0];
    this.lpA = 1 - Math.exp(-2 * Math.PI * (kind ? 14000 : 8500) / SR);
    this.lp2A = 1 - Math.exp(-2 * Math.PI * (kind ? 18000 : 12000) / SR);
    this.lL = 0; this.lR = 0; this.l2L = 0; this.l2R = 0;
    this.hiss = kind ? 0.00004 : 0.00016;
    this.seed = 12345 + kind;
    this.analog = 1;
    this.scale = 2.6 / 32768;
    this.vs = new Float32Array(this.nv * 4);
    this.initChip();
  }
  w(reg, v) { this.chip.writeReg(reg, v & 0xff); }
  initChip() {
    this.chip.reset();
    if (this.kind === 1) this.w(0x105, 0x01);    // OPL3 mode (NEW=1); OPL2 machine stays in OPL2-compatible mode
    this.w(0x01, 0x20);                           // waveform select enable
    this.w(0xBD, 0xC0);                           // deep tremolo + deep vibrato, melodic mode
    this.w(0x08, 0x00);
    this.fourMask = 0; if (this.kind === 1) this.w(0x104, 0);
  }

  // ---------------------------------------------------------------- v2 interface
  setOption(key, value) { if (key === 'analog') this.analog = value === true || value === 1 || value === '1' ? 1 : 0; }
  setInstruments(list) { if (Array.isArray(list) && list.length) this.table = list; }
  updateInstrument(i, inst) {
    if (!inst) return;
    this.table[i] = inst;
    // live: re-program operators of sounding notes that use it (envelope/level/waveform changes are heard at once)
    for (const v of this.v) if (v.active && !v.master && v.idx === i && v.part) { v.ins = inst; this.program(v, inst, v.part); this.level(v); this.panOf(v); }
  }
  setArrangement(arr) {
    if (!Array.isArray(arr)) return;
    this.arr = Array.from({ length: 16 }, (_, c) => arr[c] ? { inst: arr[c].inst | 0, voice: arr[c].voice || 'auto' } : { inst: -1, voice: 'auto' });
    this.pinned = new Set(this.arr.map(a => this.voiceIndex(a.voice)).filter(i => i >= 0));
  }
  setKit(kit) { this.kit = kit && typeof kit === 'object' ? kit : {}; }
  setVoiceMute(mask) { this.vmute = mask | 0; for (const v of this.v) if (v.active && !v.master) this.level(v); }
  voiceIndex(id) { const m = /^c(\d+)$/.exec(id || ''); const i = m ? +m[1] - 1 : -1; return i >= 0 && i < this.nv ? i : -1; }
  voiceState() {
    const vs = this.vs;
    for (const v of this.v) {
      const k = v.c * 4;
      if (!v.active) { vs[k] = 0; vs[k + 1] = -1; vs[k + 2] = -1; vs[k + 3] = -1; continue; }
      const car = this.chip.channel[v.c].slotz[1];
      vs[k] = Math.pow(10, -Math.min(511, car.eg_out) * 0.1875 / 20); vs[k + 1] = v.midi; vs[k + 2] = v.note; vs[k + 3] = v.idx;
    }
    return vs;
  }
  reset() {
    for (const v of this.v) {
      v.active = false; v.on = false; v.master = null; v.slave = null; v.four = false;
      this.w(v.hi + 0xB0 + v.ch, 0);
      this.w(v.hi + 0x80 + v.mop, 0x0f); this.w(v.hi + 0x80 + v.cop, 0x0f);   // fastest release
    }
    this.deferred.length = 0;
  }
  activeCount() { let n = 0; for (const v of this.v) if (v.active) n++; return n; }
  maxVoices() { return this.nv; }

  // ---------------------------------------------------------------- allocation
  instIndex(c, note) {
    const a = this.arr[c], ch = this.h.ch[c];
    if (a && a.inst >= 0 && a.inst < this.table.length) return a.inst;
    if (ch.drum) { const k = this.kit[note]; return k != null && k >= 0 ? k : this.constructor.gmDrum(note); }
    return this.constructor.gmPreset(ch.program);
  }
  pick(list) {
    let best = null, ba = Infinity;
    for (const v of list) if (!v.active) return v;
    for (const v of list) if (!v.on && v.age < ba) { best = v; ba = v.age; }
    if (best) return best;
    for (const v of list) if (v.age < ba) { best = v; ba = v.age; }
    return best;
  }
  pool() { return this.pinned.size ? this.order.filter(v => !this.pinned.has(v.c)) : this.order; }
  /** stop whatever note occupies channel v (both halves of a 4-op pair) */
  evict(v) {
    const m = v.master || v;
    for (const x of [m, m.slave]) {
      if (!x) continue;
      this.dropDeferred(x);
      if (x.active) this.w(x.hi + 0xB0 + x.ch, (x.block << 2) | (x.fnum >> 8));
      x.offTick = this.tick;
      x.active = false; x.on = false; x.master = null; x.slave = null; x.four = false;
    }
  }
  setFour(a, on) {
    const bit = 1 << (a < 9 ? a : a - 6);
    const m = on ? this.fourMask | bit : this.fourMask & ~bit;
    if (m !== this.fourMask) { this.fourMask = m; this.w(0x104, m); }
  }
  pairOf(c) { const ch = c % 9; if (ch > 5) return -1; const a = ch < 3 ? c : c - 3; return a; }

  noteOn(c, note, vel) {
    const idx = this.instIndex(c, note), ins = this.table[idx];
    if (!ins || !ins.ops || ins.ops.length < 2) return;
    const parts = [];
    if (ins.four && ins.ops.length >= 4) {
      if (this.kind === 1) parts.push({ four: true, ops: ins.ops, fb: ins.fb, cnt: ins.cnt, cnt2: ins.cnt2, offset: ins.offset || 0, detune: 0 });
      else {   // OPL2: play the 4-op patch as its two 2-op halves
        parts.push({ ops: [ins.ops[2], ins.ops[3]], fb: ins.fb, cnt: ins.cnt2, offset: ins.offset || 0, detune: 0 });
        if (ins.cnt === 0 && ins.cnt2 === 1) parts.push({ ops: [ins.ops[0], ins.ops[1]], fb: ins.fb, cnt: 0, offset: ins.offset || 0, detune: 0 });
      }
    } else {
      parts.push({ ops: [ins.ops[0], ins.ops[1]], fb: ins.fb, cnt: ins.cnt, offset: ins.offset || 0, detune: 0 });
      if (ins.dual && ins.ops.length >= 4) parts.push({ ops: [ins.ops[2], ins.ops[3]], fb: ins.fb2 || 0, cnt: ins.cnt2 || 0, offset: ins.offset2 || 0, detune: ins.detune || 0 });
    }
    const pin = this.voiceIndex(this.arr[c] && this.arr[c].voice);
    parts.forEach((part, k) => {
      let v;
      if (part.four) {
        // choose a pair: pinned, else best by the same free → released → oldest rule over pair masters
        let a;
        if (pin >= 0 && k === 0 && this.pairOf(pin) >= 0) a = this.pairOf(pin);
        else {
          const cands = PAIR_A.filter(x => !this.pinned.has(x) && !this.pinned.has(x + 3)).map(x => this.v[x]);
          const score = (x) => { const b = this.v[x.c + 3]; return (x.active ? 2 : 0) + (b.active ? 2 : 0) - ((x.active && !x.on) || (b.active && !b.on) ? 1 : 0); };
          let best = null, bs = Infinity, ba = Infinity;
          for (const x of (cands.length ? cands : PAIR_A.map(i => this.v[i]))) {
            const s = score(x), age = Math.max(x.active ? x.age : 0, this.v[x.c + 3].active ? this.v[x.c + 3].age : 0);
            if (s < bs || (s === bs && age < ba)) { best = x; bs = s; ba = age; }
          }
          a = best.c;
        }
        v = this.v[a];
        const b = this.v[a + 3];
        const wasKeyed = (v.active && (v.on || v.offTick === this.tick)) || (b.active && (b.on || b.offTick === this.tick)) || v.offTick === this.tick;
        this.evict(v); this.evict(b);
        this.setFour(a, true);
        this.start(v, c, note, vel, idx, ins, part, wasKeyed);
        b.active = true; b.on = true; b.master = v; b.midi = c; b.note = note; b.idx = idx; b.age = v.age; v.slave = b; v.four = true;
      } else {
        v = (pin >= 0 && k === 0) ? this.v[pin] : this.pick(this.pool());
        const wasKeyed = v.active && (v.on || v.offTick === this.tick);
        if (v.active || v.master) this.evict(v);
        if (this.kind === 1) { const a = this.pairOf(v.c); if (a >= 0 && (this.fourMask & (1 << (a < 9 ? a : a - 6)))) { this.evict(this.v[a]); this.evict(this.v[a + 3]); this.setFour(a, false); } }
        this.start(v, c, note, vel, idx, ins, part, wasKeyed || v.offTick === this.tick);
      }
    });
  }
  program(v, ins, part) {
    const op20 = (p) => ((p.am & 1) << 7) | ((p.vib & 1) << 6) | ((p.egt & 1) << 5) | ((p.ksr & 1) << 4) | (p.mult & 15);
    const regs = part.four ? [[v, v.mop, 0], [v, v.cop, 1], [this.v[v.c + 3], this.v[v.c + 3].mop, 2], [this.v[v.c + 3], this.v[v.c + 3].cop, 3]]
      : [[v, v.mop, 0], [v, v.cop, 1]];
    for (const [x, off, k] of regs) {
      const p = part.ops[k];
      this.w(x.hi + 0x20 + off, op20(p));
      this.w(x.hi + 0x60 + off, ((p.ar & 15) << 4) | (p.dr & 15));
      this.w(x.hi + 0x80 + off, ((p.sl & 15) << 4) | (p.rr & 15));
      this.w(x.hi + 0xE0 + off, p.ws & (this.kind ? 7 : 3));
    }
  }
  start(v, c, note, vel, idx, ins, part, wasKeyed) {
    this.dropDeferred(v);
    v.active = true; v.on = true; v.sus = false; v.master = null; v.slave = null; v.four = !!part.four;
    v.midi = c; v.note = note; v.vel = vel; v.age = ++this.age; v.idx = idx; v.ins = ins; v.part = part;
    v.fixed = !!ins.fixed;
    v.pitch = ins.fixed ? (ins.note | 0) : note;
    v.offset = part.offset || 0; v.detune = part.detune || 0;
    this.program(v, ins, part);
    this.panOf(v);
    this.level(v);
    this.freq(v, false);
    const keyOn = [v.hi + 0xB0 + v.ch, 0x20 | (v.block << 2) | (v.fnum >> 8)];
    if (wasKeyed) this.deferred.push([v, keyOn[0], keyOn[1]]); else this.w(keyOn[0], keyOn[1]);
  }
  panOf(v) {
    let pan = 0x30;
    if (this.stereo) { const p = this.h.ch[v.midi].pan; pan = p < 43 ? 0x10 : p > 85 ? 0x20 : 0x30; }
    v.pan = pan;
    const part = v.part;
    this.w(v.hi + 0xC0 + v.ch, pan | ((part.fb & 7) << 1) | (part.cnt & 1));
    if (part.four) { const b = this.v[v.c + 3]; this.w(b.hi + 0xC0 + b.ch, pan | (part.cnt2 & 1)); }
  }
  freq(v, write = true) {
    const ch = this.h.ch[v.midi];
    let n = v.pitch + v.offset + v.detune;
    if (!v.fixed) n += ch.bend * ch.bendRange;
    let f = 440 * Math.pow(2, (n - 69) / 12);
    if (f < 1) f = 1;
    let block = 0, fnum = 0;
    for (block = 0; block < 8; block++) { fnum = Math.round(f * Math.pow(2, 20 - block) / OPL_RATE); if (fnum < 1024) break; }
    if (block > 7) { block = 7; fnum = 1023; }
    v.fnum = fnum; v.block = block;
    this.w(v.hi + 0xA0 + v.ch, fnum & 0xff);
    if (write) this.w(v.hi + 0xB0 + v.ch, (v.on ? 0x20 : 0) | (block << 2) | (fnum >> 8));
  }
  level(v) {
    const ch = this.h.ch[v.midi], part = v.part;
    const vel = Math.max(1, v.vel) / 127;
    const vol = Math.max(1, ch.vol * ch.expr) / 16129;
    const db = -40 * Math.log10(vel) * 0.55 - 40 * Math.log10(vol) * 0.75;
    let add = Math.min(63, Math.round(db / 0.75));
    if (this.h.mute[v.midi] || (this.vmute & v.bit)) add = 63;
    const tl = (x, off, p, isCar) => this.w(x.hi + 0x40 + off, ((p.ksl & 3) << 6) | Math.min(63, (p.tl & 63) + (isCar ? add : 0)));
    if (part.four) {
      const car = carriers4(part.cnt & 1, part.cnt2 & 1), b = this.v[v.c + 3];
      const slots = [[v, v.mop], [v, v.cop], [b, b.mop], [b, b.cop]];
      slots.forEach(([x, off], k) => tl(x, off, part.ops[k], car.includes(k)));
    } else {
      const car = carriers2(part.cnt & 1);
      tl(v, v.cop, part.ops[1], true);
      tl(v, v.mop, part.ops[0], car.includes(0));
    }
  }
  release(v) { v.on = false; v.sus = false; v.offTick = this.tick; if (v.slave) { v.slave.on = false; } this.dropDeferred(v); this.w(v.hi + 0xB0 + v.ch, (v.block << 2) | (v.fnum >> 8)); }
  dropDeferred(v) { if (this.deferred.length) this.deferred = this.deferred.filter(d => d[0] !== v); }
  noteOff(c, note) {
    const ch = this.h.ch[c];
    for (const v of this.v) if (v.active && !v.master && v.on && v.midi === c && v.note === note) {
      if (ch.sustain) v.sus = true; else this.release(v);
    }
  }
  sustainOff(c) { for (const v of this.v) if (v.active && !v.master && v.on && v.sus && v.midi === c) this.release(v); }
  allOff(c, hard) {
    for (const v of this.v) if (v.active && !v.master && v.midi === c) {
      this.release(v);
      if (hard) for (const x of [v, v.slave]) if (x) { this.w(x.hi + 0x80 + x.mop, 0x0f); this.w(x.hi + 0x80 + x.cop, 0x0f); }
    }
  }
  pitch(c) { for (const v of this.v) if (v.active && !v.master && v.midi === c) this.freq(v); }
  ctrl(c) { for (const v of this.v) if (v.active && !v.master && v.midi === c) { this.level(v); this.panOf(v); } }

  chipSample() {
    this.chip.generate(this.cbuf);
    this.tick++;
    if (this.deferred.length) { for (const [, r, d] of this.deferred) this.w(r, d); this.deferred.length = 0; }
    if (this.stereo) this.rs.push(dacFloat(this.cbuf[0]) * this.scale, dacFloat(this.cbuf[1]) * this.scale);
    else { const m = dacFloat(this.cbuf[0]) * this.scale; this.rs.push(m, m); }   // YM3812 → YM3014: one mono DAC
  }

  render(oL, oR, n) {
    const an = this.analog;
    const a = this.lpA * an + (1 - an), a2 = this.lp2A * an + (1 - an);
    for (let i = 0; i < n; i++) {
      for (let k = this.rs.advance(); k > 0; k--) this.chipSample();
      const o = this.rs.out();
      // analog output stage: two gentle poles + hiss
      this.lL += a * (o[0] - this.lL); this.l2L += a2 * (this.lL - this.l2L);
      this.lR += a * (o[1] - this.lR); this.l2R += a2 * (this.lR - this.l2R);
      this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
      const nz = ((this.seed / 0x7fffffff) - 0.5) * this.hiss * an;
      oL[i] = this.l2L + nz; oR[i] = this.l2R + nz;
    }
    // free finished notes; meters from the carriers' real envelope output
    const met = this.h.meter;
    for (const v of this.v) {
      if (!v.active || v.master) continue;
      const part = v.part, b = v.slave ? this.v[v.c + 3] : null;
      const slots = part.four ? [this.chip.channel[v.c].slotz[0], this.chip.channel[v.c].slotz[1], this.chip.channel[b.c].slotz[0], this.chip.channel[b.c].slotz[1]]
        : [this.chip.channel[v.c].slotz[0], this.chip.channel[v.c].slotz[1]];
      const car = part.four ? carriers4(part.cnt & 1, part.cnt2 & 1) : carriers2(part.cnt & 1);
      let done = !v.on, minOut = 511;
      for (const k of car) { const s = slots[k]; if ((s.eg_rout & 0x1f8) !== 0x1f8) done = false; if (s.eg_out < minOut) minOut = s.eg_out; }
      if (done) { v.active = false; if (v.slave) { v.slave.active = false; v.slave.master = null; v.slave = null; } continue; }
      const g = Math.pow(10, -Math.min(511, minOut) * 0.1875 / 20);
      if (g > met[v.midi]) met[v.midi] = g;
    }
  }
}
