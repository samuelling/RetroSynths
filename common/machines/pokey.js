// Atari POKEY (C012294) audio section — original implementation for RetroSynths, written from the
// public POKEY datasheet, De Re Atari and the Altirra Hardware Reference Manual descriptions.
//
//   clock      NTSC 1.7897725 MHz machine clock; base clocks 64 kHz (÷28) or 15 kHz (÷114)
//   AUDF1–4    8-bit dividers: period (N+1) base ticks, or N+4 cycles when clocked at 1.79 MHz;
//              joined pairs (1+2, 3+4) form 16-bit dividers: (N+1) base ticks, or N+7 cycles at 1.79 MHz
//   AUDC1–4    bits 7–5 distortion, bit 4 volume-only, bits 3–0 volume
//              bit7=0: the divider pulse only passes when the 5-bit poly is 1
//              bit5=1: pure tone (output flip-flop toggles) · bit5=0: output = 4-bit poly (bit6=1)
//              or 17-bit poly (bit6=0; 9-bit when AUDCTL bit 7)
//   AUDCTL     7 poly9 · 6 ch1 @1.79 · 5 ch3 @1.79 · 4 join 1+2 · 3 join 3+4 · 2 HPF ch1 by ch3 ·
//              1 HPF ch2 by ch4 · 0 15 kHz base
// The polynomial counters free-run at the machine clock, so a channel samples the poly at the moment
// of its divider underflow: poly index = absolute cycle mod sequence length. That is what gives
// POKEY's characteristic AUDF-dependent noise colours and the "distortion C" (poly4) buzz bass.
//
// Rendering is event-driven: underflows are processed at their exact cycle, and the output level is
// box-integrated over 14-cycle chunks (127.8 kHz) before band-limited resampling.

import { polySeq } from './tia.js';

export const POKEY_CLOCK = 1789772.5;
export const POKEY_CHUNK = 14;
export const POKEY_RATE = POKEY_CLOCK / POKEY_CHUNK;
export const POKEY_FRAME_CYCLES = 114 * 262;               // one NTSC frame (262 lines × 114 cycles)

export const P4 = polySeq(4, 3);       // 15
export const P5 = polySeq(5, 3);       // 31
export const P9 = polySeq(9, 5);       // 511
export const P17 = polySeq(17, 12);    // 131071

export class POKEY {
  constructor() {
    this.f = new Uint8Array(4); this.c = new Uint8Array(4);
    this.nx = new Float64Array(4); this.o = new Uint8Array(4);
    this.lv = new Float64Array(4);
    this.reset();
  }
  reset() {
    this.f.fill(0); this.c.fill(0); this.o.fill(0); this.lv.fill(0);
    this.audctl = 0; this.t = 0; this.l1 = 0; this.l2 = 0; this.level = 0;
    for (let i = 0; i < 4; i++) this.nx[i] = this.per(i);
  }
  /** Divider period of channel i in machine cycles (Infinity: low half of a joined pair). */
  per(i) {
    const a = this.audctl, base = a & 1 ? 114 : 28, f = this.f;
    switch (i) {
      case 0: return a & 0x10 ? Infinity : a & 0x40 ? f[0] + 4 : (f[0] + 1) * base;
      case 1: return a & 0x10 ? (a & 0x40 ? f[1] * 256 + f[0] + 7 : (f[1] * 256 + f[0] + 1) * base) : (f[1] + 1) * base;
      case 2: return a & 0x08 ? Infinity : a & 0x20 ? f[2] + 4 : (f[2] + 1) * base;
      default: return a & 0x08 ? (a & 0x20 ? f[3] * 256 + f[2] + 7 : (f[3] * 256 + f[2] + 1) * base) : (f[3] + 1) * base;
    }
  }
  /** Register write: 0/2/4/6 AUDF1–4, 1/3/5/7 AUDC1–4, 8 AUDCTL, 9 STIMER. */
  write(reg, v) {
    v &= 255;
    if (reg < 8) {
      const i = reg >> 1;
      if (reg & 1) { this.c[i] = v; this.levels(); }
      else this.f[i] = v;                   // takes effect at the next reload, as on hardware
    } else if (reg === 8) {
      if (v === this.audctl) return;
      const old = this.audctl; this.audctl = v;
      for (let i = 0; i < 4; i++) {
        const p = this.per(i);
        if (p === Infinity) this.nx[i] = Infinity;
        else if (this.nx[i] === Infinity || ((old ^ v) & (i < 2 ? 0x51 : 0x29))) this.nx[i] = this.align(i) + p;
      }
      this.levels();
    } else if (reg === 9) {                 // STIMER: restart all dividers
      for (let i = 0; i < 4; i++) { const p = this.per(i); this.nx[i] = p === Infinity ? Infinity : this.t + p; }
    }
  }
  align(i) {   // next base-clock edge for base-clocked channels
    const a = this.audctl, fast = i < 2 ? a & 0x40 : a & 0x20;
    if (fast) return this.t;
    const b = a & 1 ? 114 : 28;
    return Math.ceil(this.t / b) * b;
  }
  levels() {
    const c = this.c, o = this.o, a = this.audctl;
    let s = 0;
    for (let i = 0; i < 4; i++) {
      let bit = o[i];
      if (i === 0 && (a & 4)) bit ^= this.l1;
      if (i === 1 && (a & 2)) bit ^= this.l2;
      const v = c[i] & 15;
      s += (c[i] & 0x10) ? v : bit ? v : 0;
    }
    this.level = s;
  }
  event(i, te) {
    const p = this.per(i);
    this.nx[i] = te + p;
    const c = this.c[i];
    if ((c & 0x80) || P5[te % 31]) {
      if (c & 0x20) this.o[i] ^= 1;
      else if (c & 0x40) this.o[i] = P4[te % 15];
      else this.o[i] = this.audctl & 0x80 ? P9[te % 511] : P17[te % 131071];
    }
    // high-pass flip-flops: latch ch1 (ch2) output on ch3 (ch4) underflow
    if (i === 2 && (this.audctl & 4)) this.l1 = this.o[0];
    if (i === 3 && (this.audctl & 2)) this.l2 = this.o[1];
    this.levels();
  }
  /** Advance one chunk; returns the box-averaged output 0..60. */
  chunk() {
    const nx = this.nx;
    let tc = this.t;
    const tEnd = tc + POKEY_CHUNK;
    let acc = 0;
    for (;;) {
      let i = 0, m = nx[0];
      if (nx[1] < m) { m = nx[1]; i = 1; }
      if (nx[2] < m) { m = nx[2]; i = 2; }
      if (nx[3] < m) { m = nx[3]; i = 3; }
      if (m > tEnd) break;
      acc += this.level * (m - tc); tc = m;
      this.event(i, m);
    }
    acc += this.level * (tEnd - tc);
    this.t = tEnd;
    return acc / POKEY_CHUNK;
  }
}
