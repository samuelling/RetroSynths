// SN76489 PSG, Sega VDP variant (Master System / Mega Drive), written for RetroSynths from the
// publicly documented behaviour of the chip (SMS Power! "SN76489" development notes and the TI data sheet).
// Original code written for RetroSynths (no third-party code). Copyright (C) 2026 Sam Ling.
//
//   clock 3.579545 MHz (NTSC), internal tick = clock / 16 (≈ 223.7 kHz)
//   3 square tone generators: 10-bit down-counters reloaded from the tone register; output toggles on reload.
//     A register value of 0 or 1 gives a constant +1 output (Sega chips; used for sample playback).
//   noise: 16-bit LFSR, Sega taps (bits 0 and 3 → bit 15), reset to 0x8000 on any write to the noise
//     register; shifts on each low→high edge of the noise counter's square; rates N/512, N/1024, N/2048
//     or tone 3's register; white (feedback = parity of taps) or periodic (feedback = bit 0). Output = bit 0.
//   4-bit attenuation per channel, 2 dB per step, 15 = off.
//   Write format: latch/data byte 1 cc t dddd (cc channel, t 1 = volume), data byte 0 x dddddd
//     (upper 6 bits of a tone register; for volume / noise latches the low 4 / 3 bits).
//
// Output is bipolar (±level per channel, like most emulators; the real pins are unipolar and the
// console AC-couples them). Rendering integrates the output exactly over arbitrary intervals measured
// in master-clock units, so the host can box-filter it onto any sample grid.

export const PSG_CLOCK = 3579545;

const VOL = new Float32Array(16);
for (let i = 0; i < 15; i++) VOL[i] = Math.pow(10, -0.1 * i);   // 2 dB per step
VOL[15] = 0;

export class SN76489 {
  /** unitsPerTick: length of one internal tick (clock / 16) in the caller's time units. */
  constructor(unitsPerTick = 16) {
    this.upt = unitsPerTick;
    this.tone = new Uint16Array(4);       // [3] = noise control (3 bits)
    this.att = new Uint8Array(4);
    this.cnt = new Int32Array(4);
    this.out = new Int8Array(4);          // tone polarity (+1/-1); [3] = noise square used for edge detection
    this.reset();
  }

  reset() {
    this.tone.fill(0); this.att.fill(15); this.cnt.fill(0);
    this.out[0] = this.out[1] = this.out[2] = 1; this.out[3] = -1;
    this.lfsr = 0x8000; this.latch = 0;
    this.phase = this.upt;                // units left until the next tick
    this.level = 0; this.calcLevel();
  }

  write(b) {
    b &= 0xff;
    if (b & 0x80) {
      this.latch = (b >> 4) & 7;
      const ch = this.latch >> 1;
      if (this.latch & 1) this.att[ch] = b & 0x0f;
      else if (ch < 3) this.tone[ch] = (this.tone[ch] & 0x3f0) | (b & 0x0f);
      else { this.tone[3] = b & 0x07; this.lfsr = 0x8000; }
    } else {
      const ch = this.latch >> 1;
      if (this.latch & 1) this.att[ch] = b & 0x0f;
      else if (ch < 3) this.tone[ch] = (this.tone[ch] & 0x00f) | ((b & 0x3f) << 4);
      else { this.tone[3] = b & 0x07; this.lfsr = 0x8000; }
    }
    this.calcLevel();
  }

  /** Convenience for drivers: set a tone period (0..1023) with the two-byte sequence. */
  setTone(ch, n) { this.write(0x80 | (ch << 5) | (n & 0x0f)); this.write((n >> 4) & 0x3f); }
  setAtt(ch, a) { this.write(0x90 | (ch << 5) | (a & 0x0f)); }
  setNoise(mode) { this.write(0xe0 | (mode & 0x07)); }

  calcLevel() {
    let s = 0;
    for (let ch = 0; ch < 3; ch++) s += (this.tone[ch] <= 1 ? 1 : this.out[ch]) * VOL[this.att[ch]];
    s += ((this.lfsr & 1) ? 1 : -1) * VOL[this.att[3]];
    this.level = s;
  }

  tick() {
    for (let ch = 0; ch < 3; ch++) {
      if (--this.cnt[ch] <= 0) { this.cnt[ch] = this.tone[ch]; this.out[ch] = -this.out[ch]; }
    }
    if (--this.cnt[3] <= 0) {
      const r = this.tone[3] & 3;
      this.cnt[3] = r === 3 ? this.tone[2] : (0x10 << r);
      this.out[3] = -this.out[3];
      if (this.out[3] > 0) {                                   // low → high edge: shift the LFSR
        const fb = (this.tone[3] & 4) ? ((this.lfsr ^ (this.lfsr >> 3)) & 1) : (this.lfsr & 1);
        this.lfsr = (this.lfsr >> 1) | (fb << 15);
      }
    }
    this.calcLevel();
  }

  /** Advance by `units` and return the mean output over that interval (sum of 4 channels, each ±1 at 0 dB). */
  run(units) {
    let acc = 0, left = units;
    while (left >= this.phase) {
      acc += this.level * this.phase; left -= this.phase;
      this.tick(); this.phase = this.upt;
    }
    acc += this.level * left; this.phase -= left;
    return acc / units;
  }
}
