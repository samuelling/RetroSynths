// Hudson HuC6280 PSG — original implementation for RetroSynths, written from the public PSG
// documentation (David Michel's psg.txt, Charles MacDonald's PC Engine notes, the pcedev wiki).
//
//   clock 3.579545 MHz · 6 channels · 32 × 5-bit waveform RAM per channel
//   R0 channel select · R1 main L/R volume (4+4 bit) · R2/R3 12-bit period: f = clock / (32 × period)
//   R4 bit7 on · bit6 DDA · bits4–0 channel volume · (on=0, DDA=1 resets the wave index)
//   R5 channel L/R balance (4+4 bit) · R6 wave data / DDA sample (5 bit)
//   R7 noise (ch 5–6): bit7 on, bits4–0 frequency · R8 LFO frequency · R9 LFO control
// Volume is logarithmic, 1.5 dB per step: the 5-bit channel volume and the doubled 4-bit balance and
// main volume are added as attenuations, (31−2·bal) + (31−vol) + (31−2·main), saturating at 31 = off.
// LFO: channel 2's waveform (signed, shifted 0/4/8) is added to channel 1's period, channel 2 muted.
// Noise: an 18-bit LFSR clocked every 64·(31−nf) cycles (32 cycles at nf = 31), output 0 or 31.
//
// Rendering: each channel's 5-bit output is box-integrated exactly over 32-cycle chunks
// (111.86 kHz), then band-limited resampled by the machine.

export const PSG_CLOCK = 3579545;
export const PSG_CHUNK = 32;
export const PSG_RATE = PSG_CLOCK / PSG_CHUNK;
export const PSG_FRAME_CYCLES = 1365 * 263 / 6;     // one NTSC frame: 263 lines × 1365 master clocks ÷ 6
export const PSG_TIMER_CYCLES = 512;                // HuC6280 timer prescaler: 7.16 MHz ÷ 1024 ≈ 6991 Hz

/** Attenuation step → linear gain (1.5 dB/step, 31 = silent). */
export const VOL_TABLE = new Float32Array(32);
for (let i = 0; i < 31; i++) VOL_TABLE[i] = Math.pow(10, -1.5 * i / 20);
VOL_TABLE[31] = 0;

class PSGChannel {
  constructor(i) { this.i = i; this.wave = new Uint8Array(32); this.reset(); }
  reset() {
    this.freq = 0; this.ctl = 0; this.bal = 0; this.wave.fill(0); this.idx = 0;
    this.cnt = 4096; this.cur = 0; this.dda = 0; this.noise = 0; this.lfsr = 1; this.ncnt = 32; this.ncur = 0;
    this.gL = 0; this.gR = 0; this.eff = 4096; this.mute = this.mute | 0;
  }
}

export class PSG {
  constructor() {
    this.ch = Array.from({ length: 6 }, (_, i) => new PSGChannel(i));
    this.off = 16;        // 16: centred DAC (HuC6280A); 0: unsigned output with DC steps (HuC6280)
    this.reset();
  }
  reset() {
    for (const c of this.ch) c.reset();
    this.sel = 0; this.main = 0; this.lfoFreq = 0; this.lfoCtl = 0; this.lfoCnt = 0;
  }
  gains(c) {
    const al = c.ctl & 31;
    let aL = (31 - ((c.bal >> 4) << 1)) + (31 - al) + (31 - ((this.main >> 4) << 1));
    let aR = (31 - ((c.bal & 15) << 1)) + (31 - al) + (31 - ((this.main & 15) << 1));
    c.gL = VOL_TABLE[aL > 31 ? 31 : aL]; c.gR = VOL_TABLE[aR > 31 ? 31 : aR];
  }
  /** Write PSG register 0–9 ($0800–$0809). */
  w(r, v) {
    v &= 255;
    if (r === 0) { this.sel = v & 7; return; }
    if (r === 1) { this.main = v; for (const c of this.ch) this.gains(c); return; }
    if (r === 8) { this.lfoFreq = v; return; }
    if (r === 9) { this.lfoCtl = v; if (v & 0x80) this.ch[1].idx = 0; this.ch[0].eff = this.ch[0].freq || 4096; return; }
    if (this.sel > 5) return;
    const c = this.ch[this.sel];
    switch (r) {
      case 2: c.freq = (c.freq & 0xf00) | v; c.eff = c.freq || 4096; break;
      case 3: c.freq = (c.freq & 0xff) | ((v & 15) << 8); c.eff = c.freq || 4096; break;
      case 4:
        if (!(v & 0x80) && (v & 0x40)) c.idx = 0;            // on=0, DDA=1: reset the wave index
        c.ctl = v; this.gains(c); break;
      case 5: c.bal = v; this.gains(c); break;
      case 6:
        if (c.ctl & 0x40) c.dda = v & 31;                    // DDA: straight to the DAC
        else if (!(c.ctl & 0x80)) { c.wave[c.idx] = v & 31; c.idx = (c.idx + 1) & 31; }
        break;
      case 7: if (this.sel >= 4) c.noise = v; break;
    }
  }
  /** Advance one 32-cycle chunk; writes the averaged L/R output (≈ ±1 per full-scale channel) to o. */
  chunk(o) {
    const off = this.off, T = PSG_CHUNK;
    let sL = 0, sR = 0;
    const lfo = (this.lfoCtl & 3) && !(this.lfoCtl & 0x80);
    if (lfo) {                                                // channel 2 as FM source for channel 1
      const m = this.ch[1], car = this.ch[0], sh = [0, 0, 4, 8][this.lfoCtl & 3];
      const per = (m.freq || 4096) * (this.lfoFreq || 256);
      this.lfoCnt -= T;
      while (this.lfoCnt <= 0) {
        this.lfoCnt += per; m.idx = (m.idx + 1) & 31;
        let e = (car.freq || 4096) + ((m.wave[m.idx] - 16) << sh);
        car.eff = e < 1 ? 1 : e > 4095 ? 4095 : e;
      }
    }
    for (let k = 0; k < 6; k++) {
      const c = this.ch[k];
      if (!(c.ctl & 0x80) || (k === 1 && lfo) || c.mute) continue;      // mute: tracker-style, not a PSG feature
      let acc;
      if (c.ctl & 0x40) acc = (c.dda - off) * T;
      else if (k >= 4 && (c.noise & 0x80)) {
        const nf = (c.noise & 31) ^ 31, per = nf ? nf << 6 : 32;
        let rem = T, cur = c.ncur; acc = 0;
        while (rem >= c.ncnt) {
          acc += cur * c.ncnt; rem -= c.ncnt; c.ncnt = per;
          let l = c.lfsr;
          const fb = (l ^ (l >> 1) ^ (l >> 11) ^ (l >> 12) ^ (l >> 17)) & 1;
          l = (l >> 1) | (fb << 17); c.lfsr = l;
          cur = (l & 1 ? 31 : 0) - off;
        }
        acc += cur * rem; c.ncnt -= rem; c.ncur = cur;
      } else {
        const w = c.wave, per = c.eff;
        let rem = T, cur = c.cur; acc = 0;
        while (rem >= c.cnt) {
          acc += cur * c.cnt; rem -= c.cnt; c.cnt = per;
          c.idx = (c.idx + 1) & 31; cur = w[c.idx] - off;
        }
        acc += cur * rem; c.cnt -= rem; c.cur = cur;
      }
      sL += acc * c.gL; sR += acc * c.gR;
    }
    const s = 1 / (T * 16);
    o[0] = sL * s; o[1] = sR * s;
  }
}
