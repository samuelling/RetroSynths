// General Instrument AY-3-8910 / AY-3-8912 and Yamaha YM2149 PSG.
//
// Written from the GI AY-3-8910 and Yamaha YM2149 data sheets:
//   · master clock ÷ 8 drives every counter (one "tick" below); a tone channel flips its output each time
//     its 12-bit counter reaches TP, so f_tone = clock / (16·TP)  (TP = 0 behaves as 1)
//   · noise: 5-bit period, counted at clock/16, shifting a 17-bit LFSR (taps 0 and 3 → bit 16),
//     period 2^17 − 1, f_shift = clock / (16·NP)
//   · mixer R7: bit = 1 disables; channel out = (tone | toneOff) & (noise | noiseOff)
//   · amplitude R8–R10: 4-bit level or M bit (envelope); logarithmic DAC
//   · envelope: 16-bit EP, one full ramp = 256·EP clocks; R13 bits CONT ATT ALT HOLD give the 10 distinct
//     shapes; writing R13 restarts it. The YM2149 ramps in 32 steps, the AY in 16 (each step lasts twice
//     as long), so the generator is modelled in 32-step units and the AY DAC table repeats each level.
//
// DAC curves: measured tables from Ayumi by Peter Sovietov (MIT licence, see /LICENSES/Ayumi-MIT.txt).
// The register-level core is our own code.
//
// Output: each change of the summed level is written as a band-limited step (beeper-dsp.js Blep) at its
// exact tick time, so the chip runs at its native clock/8 rate and is band-limited to the output rate.

/* Ayumi DAC tables — Copyright (c) Peter Sovietov, MIT licence. */
export const AY_DAC = new Float64Array([
  0.0, 0.0,
  0.00999465934234, 0.00999465934234,
  0.0144502937362, 0.0144502937362,
  0.0210574502174, 0.0210574502174,
  0.0307011520562, 0.0307011520562,
  0.0455481803616, 0.0455481803616,
  0.0644998855573, 0.0644998855573,
  0.107362478065, 0.107362478065,
  0.126588845655, 0.126588845655,
  0.20498970016, 0.20498970016,
  0.292210269322, 0.292210269322,
  0.372838941024, 0.372838941024,
  0.492530708782, 0.492530708782,
  0.635324635691, 0.635324635691,
  0.805584802014, 0.805584802014,
  1.0, 1.0,
]);
export const YM_DAC = new Float64Array([
  0.0, 0.0,
  0.00465400167849, 0.00772106507973,
  0.0109559777218, 0.0139620050355,
  0.0169985503929, 0.0200198367285,
  0.024368657969, 0.029694056611,
  0.0350652323186, 0.0403906309606,
  0.0485389486534, 0.0583352407111,
  0.0680552376593, 0.0777752346075,
  0.0925154497597, 0.111085679408,
  0.129747463188, 0.148485542077,
  0.17666895552, 0.211551079576,
  0.246387426566, 0.281101701381,
  0.333730067903, 0.400427252613,
  0.467383840696, 0.53443198291,
  0.635172045472, 0.75800717174,
  0.879926756695, 1.0,
]);

// envelope segment actions
const DOWN = 0, UP = 1, HOLD_TOP = 2, HOLD_BOT = 3;
/** [first ramp, what follows] for each R13 value (from the CONT/ATT/ALT/HOLD bit definitions). */
function shapeSegments(s) {
  const cont = s & 8, att = s & 4, alt = s & 2, hold = s & 1;
  const first = att ? UP : DOWN;
  let second;
  if (!cont) second = HOLD_BOT;
  else if (hold) second = (alt ? !att : att) ? HOLD_TOP : HOLD_BOT;
  else if (alt) second = att ? DOWN : UP;
  else second = first;
  return [first, second];
}
export const ENV_SEGMENTS = Array.from({ length: 16 }, (_, s) => shapeSegments(s));

export class AYChip {
  /**
   * @param {object} o
   *   clock      master clock in Hz (e.g. 1773400)
   *   variant    'AY' (16-step envelope, AY DAC) or 'YM' (32-step envelope, YM DAC)
   *   sampleRate output rate
   *   outL/outR  Blep buffers (outR may be null for mono)
   *   pan        [[gL, gR] × 3] per-channel gains into outL / outR
   */
  constructor(o) {
    this.clock = o.clock; this.variant = o.variant || 'AY';
    this.dac = this.variant === 'YM' ? YM_DAC : AY_DAC;
    this.outL = o.outL; this.outR = o.outR || null;
    this.setPan(o.pan || [[1, 0], [1, 0], [1, 0]]);
    this.setRate(o.sampleRate);
    this.reg = new Uint8Array(16);
    this.reset();
  }
  setRate(sr) { this.sr = sr; this.dt = sr * 8 / this.clock; }   // output samples per chip tick
  setPan(p) { this.gL = p.map(x => x[0]); this.gR = p.map(x => x[1]); this.prevL = this.prevL || 0; this.dirty = true; }
  /** Fixed-volume DAC amplitude of 4-bit level v (as it appears at the channel output). */
  levelAmp(v) { return this.dac[v * 2 + 1]; }
  reset() {
    this.reg.fill(0);
    this.tp = [1, 1, 1]; this.tc = [0, 0, 0]; this.to = [0, 0, 0];
    this.np = 1; this.nc = 0; this.lfsr = 1; this.nout = 1;
    this.ep = 1; this.ec = 0; this.env = 31; this.seg = 0; this.shape = 0; this.segs = ENV_SEGMENTS[0];
    this.tOff = [1, 1, 1]; this.nOff = [1, 1, 1]; this.vol = [0, 0, 0]; this.eOn = [0, 0, 0];
    this.t = 0; this.prevL = 0; this.prevR = 0;
    this.shapeEnv(0);
  }
  shapeEnv(s) {
    this.shape = s & 15; this.segs = ENV_SEGMENTS[this.shape]; this.seg = 0; this.ec = 0;
    const a = this.segs[0];
    this.env = (a === DOWN || a === HOLD_TOP) ? 31 : 0;
  }
  write(r, v) {
    r &= 15; v &= 255;
    this.reg[r] = v;
    this.dirty = true;
    const R = this.reg;
    switch (r) {
      case 0: case 1: case 2: case 3: case 4: case 5: {
        const c = r >> 1, p = ((R[c * 2 + 1] & 15) << 8) | R[c * 2];
        this.tp[c] = p || 1; break;
      }
      case 6: this.np = (v & 31) || 1; break;
      case 7: for (let c = 0; c < 3; c++) { this.tOff[c] = (v >> c) & 1; this.nOff[c] = (v >> (c + 3)) & 1; } break;
      case 8: case 9: case 10: { const c = r - 8; this.vol[c] = v & 15; this.eOn[c] = (v >> 4) & 1; break; }
      case 11: case 12: this.ep = ((R[12] << 8) | R[11]) || 1; break;
      case 13: this.shapeEnv(v); break;
    }
  }
  /** Run the chip for n output samples, writing level changes into the Blep buffers. */
  render(n) {
    const dt = this.dt, dac = this.dac, gL = this.gL, gR = this.gR, outL = this.outL, outR = this.outR;
    const tp = this.tp, tOff = this.tOff, nOff = this.nOff, vol = this.vol, eOn = this.eOn;
    let tc0 = this.tc[0], tc1 = this.tc[1], tc2 = this.tc[2];
    let to0 = this.to[0], to1 = this.to[1], to2 = this.to[2];
    const tp0 = tp[0], tp1 = tp[1], tp2 = tp[2];
    const np2 = this.np * 2, ep = this.ep;
    let nc = this.nc, lfsr = this.lfsr, nout = this.nout, ec = this.ec, env = this.env, seg = this.seg;
    const segs = this.segs;
    let act = segs[seg];
    let pL = this.prevL, pR = this.prevR;
    let t = this.t;
    let dirty = this.dirty ? 1 : 0;
    this.dirty = false;
    while (t < n) {
      if (++tc0 >= tp0) { tc0 = 0; to0 ^= 1; dirty = 1; }
      if (++tc1 >= tp1) { tc1 = 0; to1 ^= 1; dirty = 1; }
      if (++tc2 >= tp2) { tc2 = 0; to2 ^= 1; dirty = 1; }
      if (++nc >= np2) {
        nc = 0;
        lfsr = (lfsr >> 1) | (((lfsr ^ (lfsr >> 3)) & 1) << 16);
        if ((lfsr & 1) !== nout) { nout = lfsr & 1; dirty = 1; }
      }
      if (++ec >= ep) {
        ec = 0;
        if (act === DOWN) {
          if (--env < 0) { seg ^= 1; act = segs[seg]; env = (act === DOWN || act === HOLD_TOP) ? 31 : 0; }
          dirty = 1;
        } else if (act === UP) {
          if (++env > 31) { seg ^= 1; act = segs[seg]; env = (act === DOWN || act === HOLD_TOP) ? 31 : 0; }
          dirty = 1;
        }
      }
      if (dirty) {
        dirty = 0;
        const a0 = ((to0 | tOff[0]) & (nout | nOff[0])) ? dac[eOn[0] ? env : vol[0] * 2 + 1] : 0;
        const a1 = ((to1 | tOff[1]) & (nout | nOff[1])) ? dac[eOn[1] ? env : vol[1] * 2 + 1] : 0;
        const a2 = ((to2 | tOff[2]) & (nout | nOff[2])) ? dac[eOn[2] ? env : vol[2] * 2 + 1] : 0;
        const l = a0 * gL[0] + a1 * gL[1] + a2 * gL[2];
        if (l !== pL) { outL.add(t, l - pL); pL = l; }
        if (outR) { const r = a0 * gR[0] + a1 * gR[1] + a2 * gR[2]; if (r !== pR) { outR.add(t, r - pR); pR = r; } }
      }
      t += dt;
    }
    this.t = t - n;
    this.tc[0] = tc0; this.tc[1] = tc1; this.tc[2] = tc2;
    this.to[0] = to0; this.to[1] = to1; this.to[2] = to2;
    this.nc = nc; this.lfsr = lfsr; this.nout = nout; this.ec = ec; this.env = env; this.seg = seg;
    this.prevL = pL; this.prevR = pR;
  }
  // --- helpers for drivers ---
  /** Tone period register value for a frequency (clamped to 1..4095). */
  periodFor(hz) { const p = Math.round(this.clock / (16 * hz)); return p < 1 ? 1 : p > 4095 ? 4095 : p; }
  toneHz(tp) { return this.clock / (16 * (tp || 1)); }
  /** Envelope period for a sawtooth (one ramp per cycle) or triangle (two ramps) at hz. */
  envPeriodFor(hz, tri) { const p = Math.round(this.clock / ((tri ? 512 : 256) * hz)); return p < 1 ? 1 : p > 65535 ? 65535 : p; }
}
