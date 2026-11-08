// Game Boy (DMG) APU — cycle-exact, event-driven emulation written for RetroSynths from public
// documentation (Pan Docs "Audio" / "Audio details", gbdev wiki "Gameboy sound hardware").
//
// Time is counted in T-cycles (4.194304 MHz). The core jumps between internal clock events
// (pulse/wave/noise period dividers, the 512 Hz frame sequencer) and integrates the piecewise-
// constant DAC outputs exactly; `sample(D)` returns the mean left/right mixer output over D cycles.
// Static channels are parked and caught up lazily (duty position, wave position, LFSR are kept).

export const GB_CLOCK = 4194304;
export const GB_FRAME = 70224;                         // T-cycles per LCD frame (59.73 Hz)

const DUTY = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0]);
const NOISE_DIV = [8, 16, 32, 48, 64, 80, 96, 112];
const INF = Infinity;
// DAC: digital 0..15 → analog +1..-1 (negative slope, Pan Docs); disabled DAC → 0
const DAC = new Float32Array(16); for (let i = 0; i < 16; i++) DAC[i] = 1 - 2 * i / 15;

class Sq {
  constructor(sweep) {
    this.sweep = sweep;
    this.duty = 0; this.len = 0; this.lenEn = false; this.ev = 0; this.ed = 0; this.ep = 0;
    this.vol = 0; this.et = 8; this.freq = 0; this.pos = 0; this.on = false; this.dac = false;
    this.sp = 0; this.sn = false; this.ss = 0; this.st = 8; this.sen = false; this.shadow = 0;
  }
}

export class GBAPU {
  constructor() {
    this.wave = new Uint8Array(16);
    this.T = new Float64Array(5);                       // ch1 ch2 ch3 ch4 frame-sequencer
    this.idle = new Uint8Array(4); this.idleAt = new Float64Array(4); this.rem = new Float64Array(4);
    this.o = [0, 0];
    this.reset();
  }
  reset() {
    this.now = 0;
    this.c1 = new Sq(true); this.c2 = new Sq(false);
    this.c3 = { dac: false, len: 0, lenEn: false, lvl: 0, freq: 0, pos: 0, buf: 0, on: false };
    this.c4 = { len: 0, lenEn: false, ev: 0, ed: 0, ep: 0, vol: 0, et: 8, s: 0, w: 0, r: 0, lfsr: 0x7FFF, on: false, dac: false };
    this.nr50 = 0x77; this.nr51 = 0xF3; this.power = true; this.fs = 0;
    const T = this.T; T[0] = T[1] = T[2] = T[3] = INF; T[4] = 8192;
    for (let i = 0; i < 4; i++) { this.idle[i] = 1; this.idleAt[i] = 0; this.rem[i] = 1; }
    this.recalc();
  }

  // ------------------------------------------------------------ parking
  period(i) {
    if (i < 2) return 4 * (2048 - (i ? this.c2 : this.c1).freq);
    if (i === 2) return 2 * (2048 - this.c3.freq);
    const c = this.c4; return c.s >= 14 ? INF : NOISE_DIV[c.r] << c.s;
  }
  isStatic(i) {
    if (i < 2) { const c = i ? this.c2 : this.c1; return !c.on || c.vol === 0; }
    if (i === 2) return !this.c3.on;
    const c = this.c4; return !c.on || c.vol === 0 || c.s >= 14;
  }
  park(i) { if (!this.idle[i]) { this.idle[i] = 1; this.idleAt[i] = this.now; this.rem[i] = this.T[i] - this.now; this.T[i] = INF; } }
  wake(i) {
    if (!this.idle[i]) return;
    this.idle[i] = 0;
    const P = this.period(i);
    if (P === INF) { this.T[i] = INF; this.idle[i] = 1; return; }
    const el = this.now - this.idleAt[i], r = this.rem[i];
    if (!(r < INF)) { this.T[i] = this.now + P; return; }
    if (el < r) { this.T[i] = this.now + r - el; return; }
    const x = el - r, k = 1 + Math.floor(x / P);
    this.T[i] = this.now + P - (x % P);
    if (i < 2) { const c = i ? this.c2 : this.c1; c.pos = (c.pos + k) & 7; }
    else if (i === 3) { for (let j = 0; j < k; j++) this.lfsr(); }
  }
  upd(i) { if (this.isStatic(i)) this.park(i); else this.wake(i); }
  lfsr() {
    const c = this.c4, l = c.lfsr, x = (l ^ (l >> 1)) & 1;
    let n = (l >> 1) | (x << 14);
    if (c.w) n = (n & ~0x40) | (x << 6);
    c.lfsr = n;
  }
  waveStep() { const c = this.c3; c.pos = (c.pos + 1) & 31; const b = this.wave[c.pos >> 1]; c.buf = c.pos & 1 ? b & 15 : b >> 4; }

  // ------------------------------------------------------------ output
  recalc() {
    const c1 = this.c1, c2 = this.c2, c3 = this.c3, c4 = this.c4;
    const a1 = c1.dac ? DAC[c1.on && DUTY[c1.duty * 8 + c1.pos] ? c1.vol : 0] : 0;
    const a2 = c2.dac ? DAC[c2.on && DUTY[c2.duty * 8 + c2.pos] ? c2.vol : 0] : 0;
    const a3 = c3.dac ? DAC[c3.on && c3.lvl ? c3.buf >> (c3.lvl - 1) : 0] : 0;
    const a4 = c4.dac ? DAC[c4.on && !(c4.lfsr & 1) ? c4.vol : 0] : 0;
    const m = this.nr51;
    let l = 0, r = 0;
    if (m & 0x10) l += a1; if (m & 0x20) l += a2; if (m & 0x40) l += a3; if (m & 0x80) l += a4;
    if (m & 0x01) r += a1; if (m & 0x02) r += a2; if (m & 0x04) r += a3; if (m & 0x08) r += a4;
    this.L = this.power ? l * (((this.nr50 >> 4) & 7) + 1) / 8 : 0;
    this.R = this.power ? r * ((this.nr50 & 7) + 1) / 8 : 0;
    this.dacs = c1.dac || c2.dac || c3.dac || c4.dac;
  }

  // ------------------------------------------------------------ frame sequencer (512 Hz)
  sweepCalc() {
    const c = this.c1; let n = c.shadow >> c.ss; n = c.sn ? c.shadow - n : c.shadow + n;
    if (n > 2047) c.on = false;
    return n;
  }
  env(c) {
    if (c.ep === 0) return;
    if (--c.et <= 0) { c.et = c.ep; if (c.ed && c.vol < 15) c.vol++; else if (!c.ed && c.vol > 0) c.vol--; }
  }
  seqEvent() {
    const s = this.fs;
    if ((s & 1) === 0) for (const c of [this.c1, this.c2, this.c3, this.c4]) if (c.lenEn && c.len > 0 && --c.len === 0) c.on = false;
    if (s === 2 || s === 6) {
      const c = this.c1;
      if (--c.st <= 0) {
        c.st = c.sp || 8;
        if (c.sen && c.sp) {
          const n = this.sweepCalc();
          if (n <= 2047 && c.ss) { this.wake(0); c.freq = c.shadow = n; this.sweepCalc(); }
        }
      }
    }
    if (s === 7) { this.env(this.c1); this.env(this.c2); this.env(this.c4); }
    this.fs = (s + 1) & 7;
    for (let i = 0; i < 4; i++) this.upd(i);
  }

  // ------------------------------------------------------------ registers $FF10-$FF3F
  trigger(i) {
    this.wake(i);
    if (i < 2) {
      const c = i ? this.c2 : this.c1;
      c.on = c.dac; if (c.len === 0) c.len = 64;
      this.T[i] = this.now + this.period(i); this.idle[i] = 0;
      c.et = c.ep || 8; c.vol = c.ev;
      if (c.sweep) { c.shadow = c.freq; c.st = c.sp || 8; c.sen = !!(c.sp || c.ss); if (c.ss) this.sweepCalc(); }
    } else if (i === 2) {
      const c = this.c3; c.on = c.dac; if (c.len === 0) c.len = 256;
      c.pos = 0;                                          // sample buffer is not refilled (first nibble plays last)
      this.T[2] = this.now + this.period(2) + 6; this.idle[2] = 0;
    } else {
      const c = this.c4; c.on = c.dac; if (c.len === 0) c.len = 64;
      c.lfsr = 0x7FFF; c.et = c.ep || 8; c.vol = c.ev;
      const P = this.period(3); this.T[3] = this.now + P; this.idle[3] = P === INF ? 1 : 0;
      if (P === INF) { this.idleAt[3] = this.now; this.rem[3] = INF; }
    }
  }
  write(a, v) {
    v &= 0xFF;
    if (a >= 0xFF30 && a < 0xFF40) { this.wave[a - 0xFF30] = v; return; }
    if (!this.power && a !== 0xFF26) return;
    switch (a) {
      case 0xFF10: { const c = this.c1; c.sp = (v >> 4) & 7; c.sn = !!(v & 8); c.ss = v & 7; break; }
      case 0xFF11: case 0xFF16: { const i = a === 0xFF16 ? 1 : 0, c = i ? this.c2 : this.c1; this.wake(i); c.duty = v >> 6; c.len = 64 - (v & 63); break; }
      case 0xFF12: case 0xFF17: { const i = a === 0xFF17 ? 1 : 0, c = i ? this.c2 : this.c1; c.ev = v >> 4; c.ed = (v >> 3) & 1; c.ep = v & 7; c.dac = (v & 0xF8) !== 0; if (!c.dac) c.on = false; this.upd(i); break; }
      case 0xFF13: case 0xFF18: { const i = a === 0xFF18 ? 1 : 0, c = i ? this.c2 : this.c1; this.wake(i); c.freq = (c.freq & 0x700) | v; this.upd(i); break; }
      case 0xFF14: case 0xFF19: {
        const i = a === 0xFF19 ? 1 : 0, c = i ? this.c2 : this.c1; this.wake(i);
        c.freq = (c.freq & 0xFF) | ((v & 7) << 8); c.lenEn = !!(v & 0x40);
        if (v & 0x80) this.trigger(i);
        this.upd(i); break;
      }
      case 0xFF1A: { const c = this.c3; this.wake(2); c.dac = !!(v & 0x80); if (!c.dac) c.on = false; this.upd(2); break; }
      case 0xFF1B: this.c3.len = 256 - v; break;
      case 0xFF1C: this.c3.lvl = (v >> 5) & 3; break;
      case 0xFF1D: this.wake(2); this.c3.freq = (this.c3.freq & 0x700) | v; this.upd(2); break;
      case 0xFF1E: { const c = this.c3; this.wake(2); c.freq = (c.freq & 0xFF) | ((v & 7) << 8); c.lenEn = !!(v & 0x40); if (v & 0x80) this.trigger(2); this.upd(2); break; }
      case 0xFF20: this.c4.len = 64 - (v & 63); break;
      case 0xFF21: { const c = this.c4; c.ev = v >> 4; c.ed = (v >> 3) & 1; c.ep = v & 7; c.dac = (v & 0xF8) !== 0; if (!c.dac) c.on = false; this.upd(3); break; }
      case 0xFF22: { const c = this.c4; this.wake(3); c.s = v >> 4; c.w = (v >> 3) & 1; c.r = v & 7; this.upd(3); break; }
      case 0xFF23: { const c = this.c4; c.lenEn = !!(v & 0x40); if (v & 0x80) this.trigger(3); this.upd(3); break; }
      case 0xFF24: this.nr50 = v; break;
      case 0xFF25: this.nr51 = v; break;
      case 0xFF26: if (!(v & 0x80) && this.power) { const w = this.wave.slice(); this.reset(); this.wave.set(w); this.power = false; } else if (v & 0x80) this.power = true; break;
    }
    this.recalc();
  }

  // ------------------------------------------------------------ run D T-cycles → this.o = [meanL, meanR]
  sample(D) {
    const T = this.T, end = this.now + D, c1 = this.c1, c2 = this.c2, c4 = this.c4;
    let al = 0, ar = 0;
    for (;;) {
      let nt = end;
      if (T[0] < nt) nt = T[0]; if (T[1] < nt) nt = T[1]; if (T[2] < nt) nt = T[2];
      if (T[3] < nt) nt = T[3]; if (T[4] < nt) nt = T[4];
      const dt = nt - this.now; al += this.L * dt; ar += this.R * dt;
      this.now = nt;
      let ch = false;
      if (T[0] === nt) { c1.pos = (c1.pos + 1) & 7; T[0] += 4 * (2048 - c1.freq); ch = true; }
      if (T[1] === nt) { c2.pos = (c2.pos + 1) & 7; T[1] += 4 * (2048 - c2.freq); ch = true; }
      if (T[2] === nt) { this.waveStep(); T[2] += 2 * (2048 - this.c3.freq); ch = true; }
      if (T[3] === nt) { this.lfsr(); T[3] += NOISE_DIV[c4.r] << c4.s; ch = true; }
      if (T[4] === nt) { this.seqEvent(); T[4] += 8192; ch = true; }
      if (ch) this.recalc();
      if (nt === end) break;
    }
    this.o[0] = al / D; this.o[1] = ar / D;
    return this.o;
  }
}
