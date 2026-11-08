/*
 * Sony S-DSP (SNES APU sound generator) — sample-level emulation at the native 32 kHz.
 *
 * Written for RetroSynths from public hardware documentation: "fullsnes" by Martin Korth (nocash),
 * anomie's S-DSP notes, and the SNESdev wiki. Behaviour emulated:
 *   - 64 KB audio RAM, 128 DSP registers, 8 voices
 *   - BRR decoding (9-byte blocks → 16 samples, 4 prediction filters, shift 13..15 clamping,
 *     15-bit sample path stored doubled), 12-sample decode ring refilled 4 samples at a time
 *   - 14-bit pitch (0x1000 = 1:1 at 32 kHz), PMON pitch modulation, 4-point Gaussian interpolation
 *   - ADSR and GAIN envelopes (11-bit), the 32-entry rate table on the shared 32 kHz counter
 *     (with its per-rate phase offsets), KON 5-sample delay, KOFF release (−8/sample),
 *     END-without-LOOP immediate silence, FLG soft reset / mute
 *   - noise generator (15-bit LFSR clocked from the rate table)
 *   - signed 8-bit VOL/MVOL/EVOL/EFB/FIR, 16-bit clamping on every mix stage
 *   - echo: ESA/EDL ring buffer in audio RAM (EDL × 2 KB, 16 ms steps), 8-tap FIR with the
 *     hardware's wrap-then-clamp summing, EFB feedback, FLG echo-write disable, EON per voice
 * KON/KOFF are sampled every other sample, as on hardware. Bus/timing details below the sample
 * level (which register is read in which of the 32 DSP clock slots) are not modelled.
 *
 * Gaussian table: generated with the formula from ares (ares/sfc/dsp/gaussian.cpp),
 * Copyright (c) 2004-2025 ares team, Near et al — ISC licence, see /LICENSES/ares-ISC.txt.
 * The generator reproduces the documented 512-entry hardware table.
 */

export const DSP_RATE = 32000;

// ---- Gaussian interpolation table (ISC-licensed generator from ares) ----
export const GAUSS = (() => {
  const table = new Float64Array(512), g = new Int16Array(512);
  for (let n = 0; n < 512; n++) {
    const k = 0.5 + n;
    const s = Math.sin(Math.PI * k * 1.280 / 1024);
    const t = (Math.cos(Math.PI * k * 2.000 / 1023) - 1) * 0.50;
    const u = (Math.cos(Math.PI * k * 4.000 / 1023) - 1) * 0.08;
    table[511 - n] = s * (t + u + 1.0) / k;
  }
  for (let p = 0; p < 128; p++) {
    const sum = table[p] + table[p + 256] + table[511 - p] + table[255 - p];
    const sc = 2048 / sum;
    for (const i of [p, p + 256, 511 - p, 255 - p]) g[i] = Math.trunc(table[i] * sc + 0.5);
  }
  return g;
})();

// ---- envelope / noise rate table: period in 32 kHz samples, and phase offset on the shared counter ----
const COUNTER_RANGE = 2048 * 5 * 3;           // 30720
export const RATE_PERIOD = new Int32Array([COUNTER_RANGE + 1,
  2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80, 64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1]);
const RATE_OFFSET = new Int32Array(32);
for (let r = 0; r < 32; r++) RATE_OFFSET[r] = r === 0 ? 1 : r >= 30 ? 0 : [1040, 536, 0][r % 3];

// envelope modes
const ATTACK = 0, DECAY = 1, SUSTAIN = 2, RELEASE = 3;

// register addresses
export const R = {
  VOLL: 0, VOLR: 1, PL: 2, PH: 3, SRCN: 4, ADSR1: 5, ADSR2: 6, GAIN: 7, ENVX: 8, OUTX: 9,
  MVOLL: 0x0C, MVOLR: 0x1C, EVOLL: 0x2C, EVOLR: 0x3C, KON: 0x4C, KOFF: 0x5C, FLG: 0x6C, ENDX: 0x7C,
  EFB: 0x0D, PMON: 0x2D, NON: 0x3D, EON: 0x4D, DIR: 0x5D, ESA: 0x6D, EDL: 0x7D, FIR: 0x0F,
};

const s8 = (x) => (x << 24) >> 24;
const clamp16 = (x) => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);

class Voice {
  constructor(i) {
    this.i = i; this.bit = 1 << i;
    this.buf = new Int32Array(24);   // 12-sample decode ring, stored twice so reads never wrap
    this.bufPos = 0;
    this.interp = 0;                 // 15-bit position: bits 12..14 = sample index in window, 4..11 = Gaussian phase
    this.brrAddr = 0; this.brrOff = 1;
    this.env = 0; this.hidden = 0; this.mode = RELEASE;
    this.konDelay = 0;
    this.out = 0;                    // last enveloped output (for PMON / OUTX)
  }
}

export class SDSP {
  constructor() {
    this.ram = new Uint8Array(65536);
    this.regs = new Uint8Array(128);
    this.v = [];
    for (let i = 0; i < 8; i++) this.v.push(new Voice(i));
    this.echoHistL = new Int32Array(16); this.echoHistR = new Int32Array(16);   // 8 taps, stored twice
    this.reset();
  }

  reset() {
    this.regs.fill(0);
    this.regs[R.FLG] = 0xE0;          // power-on: soft reset, mute, echo writes disabled
    for (const v of this.v) {
      v.buf.fill(0); v.bufPos = 0; v.interp = 0; v.brrAddr = 0; v.brrOff = 1;
      v.env = 0; v.hidden = 0; v.mode = RELEASE; v.konDelay = 0; v.out = 0;
    }
    this.counter = 0; this.noise = 0x4000; this.everyOther = 1;
    this.newKon = 0; this.kon = 0; this.koff = 0; this.endx = 0;
    this.echoOff = 0; this.echoLen = 0; this.echoHistPos = 0;
    this.echoHistL.fill(0); this.echoHistR.fill(0);
    this.l = 0; this.r = 0;
  }

  /** Clear the echo region of RAM (what a driver does before enabling echo writes). */
  clearEcho() {
    const esa = this.regs[R.ESA] << 8, len = Math.max(4, (this.regs[R.EDL] & 15) * 0x800);
    for (let i = 0; i < len; i++) this.ram[(esa + i) & 0xFFFF] = 0;
  }

  write(a, x) {
    a &= 0x7F; x &= 0xFF;
    if (a === R.KON) this.newKon |= x;
    if (a === R.ENDX) { this.endx = 0; this.regs[a] = 0; return; }   // any write clears ENDX
    this.regs[a] = x;
  }
  read(a) {
    a &= 0x7F;
    const lo = a & 15, v = this.v[a >> 4];
    if (lo === R.ENVX) return v.env >> 4;
    if (lo === R.OUTX) return (v.out >> 8) & 0xFF;
    if (a === R.ENDX) return this.endx;
    return this.regs[a];
  }

  // envelope rate counter: true when a rate event fires this sample
  fire(rate) { return (this.counter + RATE_OFFSET[rate]) % RATE_PERIOD[rate] === 0; }

  // decode the next 4 samples of a voice's current BRR block into its ring buffer
  decode4(v) {
    const ram = this.ram, addr = v.brrAddr;
    const header = ram[addr], shift = header >> 4, filter = (header >> 2) & 3;
    const nyb = (ram[(addr + v.brrOff) & 0xFFFF] << 8) | ram[(addr + v.brrOff + 1) & 0xFFFF];
    const buf = v.buf;
    let pos = v.bufPos;
    for (let k = 0; k < 4; k++) {
      let s = ((nyb << (16 + 4 * k)) >> 28);          // signed 4-bit, high nibble first
      s = shift <= 12 ? (s << shift) >> 1 : (s < 0 ? -2048 : 0);
      // previous two decoded samples (stored as doubled 15-bit values)
      const p1 = buf[pos + 11], p2 = buf[pos + 10] >> 1;   // pos+11 ≡ pos-1 (ring of 12, doubled)
      if (filter === 1) {
        s += (p1 >> 1) + ((-p1) >> 5);                                  // ×15/16
      } else if (filter === 2) {
        s += p1 - p2 + (p2 >> 4) + ((p1 * -3) >> 6);                    // ×61/32, −×15/16
      } else if (filter === 3) {
        s += p1 - p2 + ((p1 * -13) >> 7) + ((p2 * 3) >> 4);             // ×115/64, −×13/16
      }
      s = clamp16(s);
      s = (s << 17) >> 16;                            // 15-bit sample path: double and wrap to 16 bits
      buf[pos] = buf[pos + 12] = s;
      pos = pos + 1 === 12 ? 0 : pos + 1;
    }
    v.bufPos = pos;
  }

  /** Run one 32 kHz sample. Output in this.l / this.r (signed 16-bit). */
  sample() {
    const regs = this.regs, ram = this.ram, G = GAUSS;
    if (--this.counter < 0) this.counter = COUNTER_RANGE - 1;

    // KON/KOFF are polled every other sample
    this.everyOther ^= 1;
    if (this.everyOther) {
      this.kon = this.newKon; this.newKon = 0;
      this.koff = regs[R.KOFF];
    } else this.kon = 0;

    // noise LFSR
    const flg = regs[R.FLG];
    if (this.fire(flg & 0x1F)) {
      const fb = (this.noise << 13) ^ (this.noise << 14);
      this.noise = (fb & 0x4000) ^ (this.noise >> 1);
    }

    const pmon = regs[R.PMON] & 0xFE, non = regs[R.NON], eon = regs[R.EON];
    const dirBase = regs[R.DIR] << 8;
    let mainL = 0, mainR = 0, echoL = 0, echoR = 0, prevOut = 0;

    for (let i = 0; i < 8; i++) {
      const v = this.v[i], vb = v.bit, base = i << 4;
      // idle voice: nothing audible and nothing pending — skip the work
      if (v.mode === RELEASE && v.env === 0 && v.konDelay === 0 && !(this.kon & vb)) { v.out = 0; prevOut = 0; continue; }

      let pitch = regs[base + R.PL] | ((regs[base + R.PH] & 0x3F) << 8);
      if (pmon & vb) pitch += ((prevOut >> 5) * pitch) >> 10;

      if (v.konDelay) {
        if (v.konDelay === 5) {
          const e = (dirBase + (regs[base + R.SRCN] << 2)) & 0xFFFF;
          v.brrAddr = ram[e] | (ram[(e + 1) & 0xFFFF] << 8);
          v.brrOff = 1; v.bufPos = 0;
          this.endx &= ~vb;
        }
        v.env = 0; v.hidden = 0; v.interp = 0;
        if (--v.konDelay & 3) v.interp = 0x4000;    // decodes 3 groups (12 samples) before playback starts
        pitch = 0;
      }

      // Gaussian interpolation of 4 consecutive samples
      let out;
      if (non & vb) {
        out = (this.noise << 17) >> 16;
      } else {
        const ip = v.interp, ph = (ip >> 4) & 0xFF, idx = v.bufPos + (ip >> 12), b = v.buf;
        out = (G[255 - ph] * b[idx]) >> 11;
        out += (G[511 - ph] * b[idx + 1]) >> 11;
        out += (G[256 + ph] * b[idx + 2]) >> 11;
        out = (out << 16) >> 16;                    // the first three products wrap at 16 bits
        out += (G[ph] * b[idx + 3]) >> 11;
        out = clamp16(out) & ~1;
      }
      out = ((out * v.env) >> 11) & ~1;
      v.out = out;

      // END block without LOOP, or soft reset: immediate silence
      const header = ram[v.brrAddr];
      if ((flg & 0x80) || (header & 3) === 1) { v.mode = RELEASE; v.env = 0; }
      if (this.everyOther) {
        if (this.koff & vb) v.mode = RELEASE;
        if (this.kon & vb) { v.konDelay = 5; v.mode = ATTACK; }
      }
      if (!v.konDelay) this.envelope(v, base);

      // BRR decode as the interpolation window advances
      if (v.interp >= 0x4000) {
        this.decode4(v);
        v.brrOff += 2;
        if (v.brrOff >= 9) {
          v.brrAddr = (v.brrAddr + 9) & 0xFFFF;
          if (header & 1) {
            const e = (dirBase + (regs[base + R.SRCN] << 2) + 2) & 0xFFFF;
            v.brrAddr = ram[e] | (ram[(e + 1) & 0xFFFF] << 8);
            this.endx |= vb;
          }
          v.brrOff = 1;
        }
      }
      let ip = (v.interp & 0x3FFF) + pitch;
      v.interp = ip > 0x7FFF ? 0x7FFF : ip;

      // per-voice volume, mixed with 16-bit clamping
      const l = (out * s8(regs[base + R.VOLL])) >> 7, r = (out * s8(regs[base + R.VOLR])) >> 7;
      mainL = clamp16(mainL + l); mainR = clamp16(mainR + r);
      if (eon & vb) { echoL = clamp16(echoL + l); echoR = clamp16(echoR + r); }
      prevOut = out;
    }

    // ---- echo ----
    const esa = regs[R.ESA] << 8;
    if (this.echoOff === 0) this.echoLen = (regs[R.EDL] & 15) << 11;
    const ea = (esa + this.echoOff) & 0xFFFF;
    const rdL = (ram[ea] | (ram[(ea + 1) & 0xFFFF] << 8)) << 16 >> 16;
    const rdR = (ram[(ea + 2) & 0xFFFF] | (ram[(ea + 3) & 0xFFFF] << 8)) << 16 >> 16;
    let hp = this.echoHistPos = (this.echoHistPos + 1) & 7;
    const HL = this.echoHistL, HR = this.echoHistR;
    HL[hp] = HL[hp + 8] = rdL >> 1; HR[hp] = HR[hp + 8] = rdR >> 1;
    // tap 0 → oldest sample, tap 7 → newest
    let fl = 0, fr = 0;
    for (let t = 0; t < 7; t++) {
      const c = s8(regs[R.FIR + (t << 4)]);
      fl += (HL[hp + 1 + t] * c) >> 6; fr += (HR[hp + 1 + t] * c) >> 6;
    }
    fl = (fl << 16) >> 16; fr = (fr << 16) >> 16;
    const c7 = s8(regs[R.FIR + 0x70]);
    fl = clamp16(fl + ((HL[hp + 8] * c7) >> 6)) & ~1;
    fr = clamp16(fr + ((HR[hp + 8] * c7) >> 6)) & ~1;

    // main output
    let ol = clamp16(((mainL * s8(regs[R.MVOLL])) >> 7) + ((fl * s8(regs[R.EVOLL])) >> 7));
    let or = clamp16(((mainR * s8(regs[R.MVOLR])) >> 7) + ((fr * s8(regs[R.EVOLR])) >> 7));
    if (flg & 0x40) { ol = 0; or = 0; }
    this.l = ol; this.r = or;

    // echo feedback write
    if (!(flg & 0x20)) {
      const efb = s8(regs[R.EFB]);
      const wl = clamp16(echoL + ((fl * efb) >> 7)) & ~1, wr = clamp16(echoR + ((fr * efb) >> 7)) & ~1;
      ram[ea] = wl & 0xFF; ram[(ea + 1) & 0xFFFF] = (wl >> 8) & 0xFF;
      ram[(ea + 2) & 0xFFFF] = wr & 0xFF; ram[(ea + 3) & 0xFFFF] = (wr >> 8) & 0xFF;
    }
    this.echoOff += 4;
    if (this.echoOff >= this.echoLen) this.echoOff = 0;
  }

  envelope(v, base) {
    const regs = this.regs;
    let env = v.env;
    if (v.mode === RELEASE) {
      env -= 8; v.env = env < 0 ? 0 : env;
      return;
    }
    const adsr1 = regs[base + R.ADSR1];
    let rate, data;
    if (adsr1 & 0x80) {
      data = regs[base + R.ADSR2];
      if (v.mode >= DECAY) {
        env--; env -= env >> 8;                        // exponential decrease
        rate = v.mode === DECAY ? ((adsr1 >> 3) & 0x0E) + 0x10 : data & 0x1F;
      } else {
        rate = ((adsr1 & 0x0F) << 1) + 1;
        env += rate < 31 ? 0x20 : 0x400;
      }
    } else {
      data = regs[base + R.GAIN];
      const gm = data >> 5;
      if (gm < 4) { env = data << 4; rate = 31; }      // direct
      else {
        rate = data & 0x1F;
        if (gm === 4) env -= 0x20;                       // linear decrease
        else if (gm === 5) { env--; env -= env >> 8; }   // exponential decrease
        else {
          env += 0x20;                                   // linear increase
          if (gm === 7 && v.hidden >= 0x600) env += 0x8 - 0x20;   // bent line
        }
      }
    }
    if ((env >> 8) === (data >> 5) && v.mode === DECAY) v.mode = SUSTAIN;
    v.hidden = env;
    if (env < 0 || env > 0x7FF) {
      env = env < 0 ? 0 : 0x7FF;
      if (v.mode === ATTACK) v.mode = DECAY;
    }
    if (this.fire(rate)) v.env = env;
  }
}
