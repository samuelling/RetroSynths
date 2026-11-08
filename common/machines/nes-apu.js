// Ricoh 2A03 (NTSC) APU — cycle-exact, event-driven emulation written for RetroSynths from the
// NESdev wiki hardware documentation (APU, APU Pulse/Sweep/Envelope/Length Counter, Triangle,
// Noise, DMC, Frame Counter, APU Mixer pages).
//
// Time is counted in CPU cycles (1.789773 MHz). Instead of stepping every cycle, the core jumps
// from one internal clock event to the next (timer expiries, frame-counter steps) and integrates the
// piecewise-constant mixer output exactly, so `sample()` returns the true average of the DAC output
// over D CPU cycles. Channels whose output cannot change (muted / halted) are parked and caught up
// lazily, preserving their sequencer / LFSR phase.

export const NES_CPU = 39375000 / 22;                 // 1,789,772.727 Hz (21.477272 MHz / 12)
export const NES_FRAME = 29780.5;                     // CPU cycles per NTSC video frame (60.0988 Hz)

const LEN = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const DUTY = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1]);
const TRI = new Uint8Array([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
export const NOISE_P = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
export const DMC_P = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
// frame counter: [cycle, quarter, half] per step; last entry is the period
const FC4 = [[7457, 1, 0], [14913, 1, 1], [22371, 1, 0], [29829, 1, 1]], FC4P = 29830;
const FC5 = [[7457, 1, 0], [14913, 1, 1], [22371, 1, 0], [29829, 0, 0], [37281, 1, 1]], FC5P = 37282;

// NESdev nonlinear mixer, exact formulas, tabulated
const PULSE_TAB = new Float32Array(31);
for (let i = 1; i < 31; i++) PULSE_TAB[i] = 95.88 / (8128 / i + 100);
const TND_TAB = new Float32Array(16 * 16 * 128);
for (let t = 0; t < 16; t++) for (let n = 0; n < 16; n++) for (let d = 0; d < 128; d++) {
  const s = t / 8227 + n / 12241 + d / 22638;
  TND_TAB[(t * 16 + n) * 128 + d] = s > 0 ? 159.79 / (1 / s + 100) : 0;
}
export const mixPulse = (a, b) => PULSE_TAB[a + b];
export const mixTnd = (t, n, d) => TND_TAB[(t * 16 + n) * 128 + d];

const INF = Infinity;

class Env {
  constructor() { this.start = false; this.div = 0; this.decay = 0; }
  clock(loop, v) {
    if (this.start) { this.start = false; this.decay = 15; this.div = v; }
    else if (this.div === 0) { this.div = v; if (this.decay > 0) this.decay--; else if (loop) this.decay = 15; }
    else this.div--;
  }
}

export class APU {
  constructor() {
    this.mem = new Uint8Array(0x8000);               // CPU $8000-$FFFF as seen by the DMC reader
    this.T = new Float64Array(6);                    // next event time: p1 p2 tri noise dmc frame
    this.idle = new Uint8Array(4); this.idleAt = new Float64Array(4); this.rem = new Float64Array(4);
    this.p = [this.mkPulse(0), this.mkPulse(1)];
    this.envN = new Env();
    this.reset();
  }
  mkPulse(id) {
    return { id, duty: 0, halt: false, cv: false, vp: 0, sEn: false, sP: 0, sNeg: false, sSh: 0, sRel: false, sDiv: 0,
      t: 0, seq: 0, len: 0, env: new Env(), on: false, out: 0 };
  }
  reset() {
    this.now = 0;
    for (const p of this.p) Object.assign(p, { duty: 0, halt: false, cv: false, vp: 0, sEn: false, sP: 0, sNeg: false, sSh: 0, sRel: false, sDiv: 0, t: 0, seq: 0, len: 0, on: false, out: 0 }), p.env.start = false, p.env.div = 0, p.env.decay = 0;
    this.tr = { ctrl: false, rel: 0, t: 0, seq: 0, len: 0, lin: 0, lrf: false, on: false, out: TRI[0] };
    this.nz = { halt: false, cv: false, vp: 0, mode: 0, pi: 0, len: 0, on: false, lfsr: 1, out: 0 };
    this.envN.start = false; this.envN.div = 0; this.envN.decay = 0;
    this.dm = { irq: false, loop: false, rate: 0, level: 0, sa: 0xC000, sl: 1, addr: 0xC000, rem: 0, buf: 0, empty: true, sh: 0, bits: 8, silent: true, on: false };
    this.fcMode = 0; this.fcStep = 0; this.fcBase = 0;
    const T = this.T;
    T[0] = 2; T[1] = 2; T[2] = 1; T[3] = NOISE_P[0]; T[4] = DMC_P[0]; T[5] = FC4[0][0];
    for (let i = 0; i < 4; i++) { this.idle[i] = 0; this.park(i); }
    this.recalc();
  }

  // ------------------------------------------------------------ lazy parking of static channels
  period(i) { return i < 2 ? 2 * (this.p[i].t + 1) : i === 2 ? this.tr.t + 1 : NOISE_P[this.nz.pi]; }
  isStatic(i) {
    if (i < 2) { const p = this.p[i]; return p.len === 0 || this.muted(p) || (p.cv ? p.vp : p.env.decay) === 0; }
    if (i === 2) { const t = this.tr; return t.len === 0 || t.lin === 0 || t.t < 2; }
    const n = this.nz; return n.len === 0 || (n.cv ? n.vp : this.envN.decay) === 0;
  }
  park(i) { if (!this.idle[i]) { this.idle[i] = 1; this.idleAt[i] = this.now; this.rem[i] = this.T[i] - this.now; this.T[i] = INF; } }
  wake(i) {
    if (!this.idle[i]) return;
    this.idle[i] = 0;
    const el = this.now - this.idleAt[i], r = this.rem[i];
    if (el < r) { this.T[i] = this.now + r - el; return; }
    const P = this.period(i), x = el - r, k = 1 + Math.floor(x / P);
    this.T[i] = this.now + P - (x % P);
    if (i < 2) this.p[i].seq = (this.p[i].seq - k) & 7;          // pulse sequencer keeps running
    else if (i === 3) { let s = this.nz.lfsr; const sh = this.nz.mode ? 6 : 1; for (let j = 0; j < k; j++) s = (s >> 1) | (((s ^ (s >> sh)) & 1) << 14); this.nz.lfsr = s; }
    // triangle: sequencer was frozen; only the timer phase advanced
  }
  upd(i) { if (this.isStatic(i)) this.park(i); else this.wake(i); }

  // ------------------------------------------------------------ channel helpers
  target(p) { const c = p.t >> p.sSh; return p.sNeg ? Math.max(0, p.t - c - (p.id === 0 ? 1 : 0)) : p.t + c; }
  muted(p) { return p.t < 8 || this.target(p) > 0x7FF; }
  outPulse(i) {
    const p = this.p[i];
    p.out = this.idle[i] ? 0 : DUTY[p.duty * 8 + p.seq] ? (p.cv ? p.vp : p.env.decay) : 0;
  }
  outNoise() { const n = this.nz; n.out = this.idle[3] ? 0 : (n.lfsr & 1) ? 0 : (n.cv ? n.vp : this.envN.decay); }
  recalc() {
    this.outPulse(0); this.outPulse(1); this.outNoise();
    this.tr.out = TRI[this.tr.seq];
    this.mix = PULSE_TAB[this.p[0].out + this.p[1].out] + TND_TAB[(this.tr.out * 16 + this.nz.out) * 128 + this.dm.level];
  }

  quarter() {
    // envelopes / linear counter don't touch timer phase, so parked channels stay parked (upd() follows)
    for (let i = 0; i < 2; i++) { const p = this.p[i]; p.env.clock(p.halt, p.vp); }
    this.envN.clock(this.nz.halt, this.nz.vp);
    const t = this.tr;
    if (t.lrf) t.lin = t.rel; else if (t.lin > 0) t.lin--;
    if (!t.ctrl) t.lrf = false;
  }
  half() {
    for (let i = 0; i < 2; i++) {
      const p = this.p[i];
      if (!p.halt && p.len > 0) p.len--;
      if (p.sDiv === 0 && p.sEn && p.sSh > 0 && !this.muted(p)) { this.wake(i); p.t = this.target(p); }
      if (p.sDiv === 0 || p.sRel) { p.sDiv = p.sP; p.sRel = false; } else p.sDiv--;
    }
    if (!this.tr.ctrl && this.tr.len > 0) this.tr.len--;
    if (!this.nz.halt && this.nz.len > 0) this.nz.len--;
  }
  frameEvent() {
    const tab = this.fcMode ? FC5 : FC4, e = tab[this.fcStep];
    if (e[1]) this.quarter();
    if (e[2]) this.half();
    for (let i = 0; i < 4; i++) this.upd(i);
    if (++this.fcStep >= tab.length) { this.fcStep = 0; this.fcBase += this.fcMode ? FC5P : FC4P; }
    this.T[5] = this.fcBase + tab[this.fcStep][0];
  }
  dmcFetch() {
    const d = this.dm;
    if (d.empty && d.rem > 0) {
      d.buf = this.mem[d.addr & 0x7FFF]; d.empty = false;
      d.addr = d.addr === 0xFFFF ? 0x8000 : d.addr + 1;
      if (--d.rem === 0 && d.loop) { d.addr = d.sa; d.rem = d.sl; }
    }
  }
  dmcClock() {
    const d = this.dm;
    if (!d.silent) { if (d.sh & 1) { if (d.level <= 125) d.level += 2; } else if (d.level >= 2) d.level -= 2; }
    d.sh >>= 1;
    if (--d.bits === 0) {
      d.bits = 8;
      if (d.empty) d.silent = true; else { d.silent = false; d.sh = d.buf; d.empty = true; this.dmcFetch(); }
    }
  }

  // ------------------------------------------------------------ CPU-visible registers ($4000-$4017)
  write(a, v) {
    v &= 0xFF;
    if (a < 0x4008) {
      const i = (a >> 2) & 1, p = this.p[i]; this.wake(i);
      switch (a & 3) {
        case 0: p.duty = v >> 6; p.halt = !!(v & 0x20); p.cv = !!(v & 0x10); p.vp = v & 15; break;
        case 1: p.sEn = !!(v & 0x80); p.sP = (v >> 4) & 7; p.sNeg = !!(v & 8); p.sSh = v & 7; p.sRel = true; break;
        case 2: p.t = (p.t & 0x700) | v; break;
        case 3: p.t = (p.t & 0xFF) | ((v & 7) << 8); if (p.on) p.len = LEN[v >> 3]; p.seq = 0; p.env.start = true; break;
      }
      this.upd(i);
    } else if (a < 0x400C) {
      const t = this.tr; this.wake(2);
      switch (a) {
        case 0x4008: t.ctrl = !!(v & 0x80); t.rel = v & 0x7F; break;
        case 0x400A: t.t = (t.t & 0x700) | v; break;
        case 0x400B: t.t = (t.t & 0xFF) | ((v & 7) << 8); if (t.on) t.len = LEN[v >> 3]; t.lrf = true; break;
      }
      this.upd(2);
    } else if (a < 0x4010) {
      const n = this.nz; this.wake(3);
      switch (a) {
        case 0x400C: n.halt = !!(v & 0x20); n.cv = !!(v & 0x10); n.vp = v & 15; break;
        case 0x400E: n.mode = v >> 7; n.pi = v & 15; break;
        case 0x400F: if (n.on) n.len = LEN[v >> 3]; this.envN.start = true; break;
      }
      this.upd(3);
    } else if (a < 0x4014) {
      const d = this.dm;
      switch (a) {
        case 0x4010: d.irq = !!(v & 0x80); d.loop = !!(v & 0x40); d.rate = v & 15; break;
        case 0x4011: d.level = v & 0x7F; break;
        case 0x4012: d.sa = 0xC000 + v * 64; break;
        case 0x4013: d.sl = v * 16 + 1; break;
      }
    } else if (a === 0x4015) {
      for (let i = 0; i < 2; i++) { this.wake(i); this.p[i].on = !!(v & (1 << i)); if (!this.p[i].on) this.p[i].len = 0; this.upd(i); }
      this.wake(2); this.tr.on = !!(v & 4); if (!this.tr.on) this.tr.len = 0; this.upd(2);
      this.wake(3); this.nz.on = !!(v & 8); if (!this.nz.on) this.nz.len = 0; this.upd(3);
      const d = this.dm;
      if (v & 16) { if (d.rem === 0) { d.addr = d.sa; d.rem = d.sl; this.dmcFetch(); } } else d.rem = 0;
    } else if (a === 0x4017) {
      this.fcMode = v >> 7; this.fcStep = 0; this.fcBase = this.now;
      if (this.fcMode) { this.quarter(); this.half(); for (let i = 0; i < 4; i++) this.upd(i); }
      this.T[5] = this.fcBase + (this.fcMode ? FC5 : FC4)[0][0];
    }
    this.recalc();
  }

  // ------------------------------------------------------------ run D CPU cycles, return mean DAC output
  sample(D) {
    const T = this.T, end = this.now + D, p0 = this.p[0], p1 = this.p[1], tr = this.tr, nz = this.nz, dm = this.dm;
    let acc = 0;
    for (;;) {
      let nt = end;
      if (T[0] < nt) nt = T[0]; if (T[1] < nt) nt = T[1]; if (T[2] < nt) nt = T[2];
      if (T[3] < nt) nt = T[3]; if (T[4] < nt) nt = T[4]; if (T[5] < nt) nt = T[5];
      acc += this.mix * (nt - this.now);
      this.now = nt;
      let ch = false;
      if (T[0] === nt) { p0.seq = (p0.seq - 1) & 7; T[0] += 2 * (p0.t + 1); ch = true; }
      if (T[1] === nt) { p1.seq = (p1.seq - 1) & 7; T[1] += 2 * (p1.t + 1); ch = true; }
      if (T[2] === nt) { if (tr.lin > 0 && tr.len > 0 && tr.t >= 2) tr.seq = (tr.seq + 1) & 31; T[2] += tr.t + 1; ch = true; }
      if (T[3] === nt) { const s = nz.lfsr; nz.lfsr = (s >> 1) | (((s ^ (s >> (nz.mode ? 6 : 1))) & 1) << 14); T[3] += NOISE_P[nz.pi]; ch = true; }
      if (T[4] === nt) { this.dmcClock(); T[4] += DMC_P[dm.rate]; ch = true; }
      if (T[5] === nt) { this.frameEvent(); ch = true; }
      if (ch) this.recalc();
      if (nt === end) break;
    }
    return acc / D;
  }
}
