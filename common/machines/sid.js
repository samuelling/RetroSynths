// MOS 6581 / 8580 SID — register-level emulation, clocked at the chip's native rate (~1 MHz).
//
// Written for RetroSynths from public documentation only: the MOS 6581 data sheet, the Commodore 64
// Programmer's Reference Guide (register map, ADSR table, frequency formula), and published hardware
// analyses (codebase64 notes on the noise LFSR, the envelope rate / exponential counters and the
// ADSR delay bug; published measurements of the 6581 and 8580 filter cutoff curves). No code from
// reSID / libsidplayfp (GPL) or any other emulator was used.
//
// What is modelled exactly (cycle by cycle):
//   - 24-bit phase accumulators, 16-bit frequency (Fout = Fn × clock / 2^24), hard sync, ring modulation,
//     test bit;
//   - sawtooth, triangle (bits 22..11 folded by bit 23), 12-bit pulse comparator, 23-bit noise LFSR
//     (taps 22 ⊕ 17, clocked by accumulator bit 19, output bits 20,18,14,11,9,5,2,0 → wave bits 11..4);
//   - envelope: 15-bit rate counter with the 16 documented periods (attack 2 ms … 8 s at 1 MHz),
//     linear attack, exponential decay/release via the exponential counter (breakpoints 255/93/54/26/14/6
//     → periods 1/2/4/8/16/30), sustain = nibble × 17, freeze at zero, and (optional) the ADSR delay bug:
//     the rate counter is compared for equality, so lowering the period below the running count makes it
//     wrap round 2^15 (up to ~33 ms) before the next step;
//   - 12-bit waveform × 8-bit envelope; voice routing, 3OFF, LP/BP/HP mode bits, 4-bit master volume.
// What is approximated (documented):
//   - combined waveforms are the bitwise AND of the selected waveforms (the real chip's analog
//     interaction makes them weaker/odder); noise combined with another waveform writes the zeros back
//     into the LFSR (the "noise lock-up"), as on the real chip;
//   - with no waveform selected the waveform DAC holds its last value;
//   - the filter is a two-integrator state-variable filter run at the chip clock. 6581: an S-shaped,
//     non-linear cutoff curve (~220 Hz floor, steep rise through the middle of the range, ~16 kHz top)
//     and a soft-saturating summer for its distortion; 8580: a near-linear 30 Hz – 12 kHz curve, clean.
//     Resonance maps the 4-bit value onto Q ≈ 0.7 … 2.7;
//   - 6581 DC offsets: each voice's DAC "zero" is below mid-scale, so the envelope itself carries DC
//     (attack thumps), and the mixer has a DC term scaled by the master volume (the $D418 click that digi
//     players exploit). The 8580 has both nearly removed.
//   - C64 output stage: one-pole 16 kHz low-pass (10 kΩ / 1 nF) and a 16 Hz high-pass (coupling cap).

export const PAL_CLOCK = 985248, NTSC_CLOCK = 1022727;

/** Envelope rate counter periods (cycles per step) for the 16 rate nibbles. Attack time = period × 255. */
export const RATE_PERIOD = new Int32Array([9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251]);
/** Data sheet ADSR times in ms (attack; decay/release are 3×). */
export const ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];

const ATTACK = 0, DECAY = 1, RELEASE = 2;
const SRC = [2, 0, 1];          // sync / ring source of voice 1, 2, 3
export const MAXN = 4096;      // most cycles per run() call

/** 6581 cutoff (Hz) for an 11-bit register value: log-domain S-curve, approximate. */
export function cutoff6581(fc) {
  const x = fc / 2047, sg = (u) => 1 / (1 + Math.exp(-(u - 0.55) * 9));
  const t = (sg(x) - sg(0)) / (sg(1) - sg(0));
  return 220 * Math.pow(16000 / 220, t);
}
/** 8580 cutoff (Hz): close to linear. */
export const cutoff8580 = (fc) => 30 + fc * (12000 / 2047);

/** Inverse: register value (0..2047) giving the nearest cutoff to hz for a model. */
export function cutoffReg(model, hz) {
  if (model === '8580') return Math.max(0, Math.min(2047, Math.round((hz - 30) * 2047 / 12000)));
  let lo = 0, hi = 2047;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cutoff6581(m) < hz) lo = m + 1; else hi = m; }
  return lo;
}

export class SID {
  constructor(clock = PAL_CLOCK, model = '6581') {
    this.acc = new Int32Array(3); this.freq = new Int32Array(3); this.pw = new Int32Array(3);
    this.ctrl = new Int32Array(3); this.ad = new Int32Array(3); this.sr = new Int32Array(3);
    this.lfsr = new Int32Array(3); this.nout = new Int32Array(3); this.wout = new Int32Array(3);
    this.env = new Int32Array(3); this.state = new Int32Array(3);
    this.rc = new Int32Array(3); this.rper = new Int32Array(3);
    this.ec = new Int32Array(3); this.eper = new Int32Array(3); this.hold = new Int32Array(3);
    this.done = new Uint8Array(3); this.dec = 8; this.obuf = new Float64Array(MAXN);
    this.vbuf = [0, 1, 2].map(() => new Float64Array(MAXN));
    this.accBuf = [0, 1, 2].map(() => new Int32Array(MAXN));
    this.riseBuf = [0, 1, 2].map(() => new Uint8Array(MAXN));
    this.reg = new Uint8Array(32);
    this.adsrBug = true;
    this.w = new Float64Array(2048); this.damp = new Float64Array(16);
    this.setClock(clock); this.setModel(model);
    this.reset();
  }
  setClock(clock) { this.clock = clock; this.lpA = 1 - Math.exp(-2 * Math.PI * 15915 / clock); this.aaA = 1 - Math.exp(-2 * Math.PI * 21000 / clock); this.tables(); }
  setModel(model) {
    this.model = model === '8580' ? '8580' : '6581';
    const m = this.model === '6581';
    this.zero = m ? 0x800 - 0x200 : 0x800 - 0x20;   // waveform DAC zero level → per-voice DC × envelope (approx.)
    this.mixDC = m ? 0.6 : 0.03;                     // mixer DC, scaled by the volume register
    this.sat = m ? 0.22 : 0;                         // summer saturation (6581 filter distortion)
    this.tables();
  }
  tables() {
    if (!this.model) return;
    const f = this.model === '6581' ? cutoff6581 : cutoff8580;
    for (let i = 0; i < 2048; i++) this.w[i] = 2 * Math.sin(Math.PI * Math.min(f(i), 20000) / this.clock);
    for (let r = 0; r < 16; r++) {
      const q = this.model === '6581' ? 0.707 + r * 0.13 : 0.707 * Math.pow(2, r / 7.8);
      this.damp[r] = 1 / q;
    }
    this.updFilter();
  }
  reset() {
    this.acc.fill(0); this.freq.fill(0); this.pw.fill(0); this.ctrl.fill(0); this.ad.fill(0); this.sr.fill(0);
    this.lfsr.fill(0x7ffff8); this.wout.fill(0); this.env.fill(0); this.state.fill(RELEASE);
    this.rc.fill(0); this.rper.fill(RATE_PERIOD[0]); this.ec.fill(0); this.eper.fill(1); this.hold.fill(1);
    for (let i = 0; i < 3; i++) this.nout[i] = this.noiseOut(i);
    this.reg.fill(0);
    this.fc = 0; this.res = 0; this.filt = 0; this.mode = 0; this.vol = 0;
    this.bp = 0; this.lp = 0; this.olp = 0; this.oaa = 0;
    this.updFilter();
  }
  noiseOut(i) { return noiseBits(this.lfsr[i]); }
  /** steady-state output DC for the current registers (used to pre-settle the output high-pass) */
  get dcLevel() { return this.mixDC * this.vol / 15; }
  updFilter() { this.wc = this.w[this.fc & 2047]; this.dmp = this.damp[this.res & 15]; }
  setPeriod(i) {
    const s = this.state[i];
    const p = RATE_PERIOD[s === ATTACK ? this.ad[i] >> 4 : s === DECAY ? this.ad[i] & 15 : this.sr[i] & 15];
    this.rper[i] = p;
    if (!this.adsrBug && this.rc[i] >= p) this.rc[i] = 0;
  }

  write(r, v) {
    v &= 255; r &= 31; this.reg[r] = v;
    if (r < 21) {
      const i = (r / 7) | 0, o = r - i * 7;
      switch (o) {
        case 0: this.freq[i] = (this.freq[i] & 0xff00) | v; break;
        case 1: this.freq[i] = (this.freq[i] & 0xff) | (v << 8); break;
        case 2: this.pw[i] = (this.pw[i] & 0xf00) | v; break;
        case 3: this.pw[i] = (this.pw[i] & 0xff) | ((v & 15) << 8); break;
        case 4: {
          const old = this.ctrl[i]; this.ctrl[i] = v;
          if ((v & 1) && !(old & 1)) { this.state[i] = ATTACK; this.hold[i] = 0; this.setPeriod(i); }
          else if (!(v & 1) && (old & 1)) { this.state[i] = RELEASE; this.setPeriod(i); }
          if (v & 8) { this.acc[i] = 0; this.lfsr[i] = 0x7fffff; this.nout[i] = this.noiseOut(i); }
          break;
        }
        case 5: this.ad[i] = v; this.setPeriod(i); break;
        case 6: this.sr[i] = v; this.setPeriod(i); break;
      }
      return;
    }
    switch (r) {
      case 21: this.fc = (this.fc & 0x7f8) | (v & 7); this.updFilter(); break;
      case 22: this.fc = (this.fc & 7) | (v << 3); this.updFilter(); break;
      case 23: this.res = v >> 4; this.filt = v & 15; this.updFilter(); break;
      case 24: this.mode = v & 0xf0; this.vol = v & 15; break;
    }
  }
  read(r) {
    switch (r & 31) {
      case 27: return this.wout[2] >> 4;   // OSC3
      case 28: return this.env[2];         // ENV3
      case 25: case 26: return 0xff;       // pots (unconnected)
      default: return 0;                   // write-only registers read back as 0 here
    }
  }

  /**
   * Run n chip cycles (n ≤ MAXN, a multiple of this.dec). Writes n / dec output samples — each the mean of
   * dec cycles of the C64 output stage — to this.obuf[0..). Voices are computed one at a time over the
   * whole chunk (sync / ring sources first, from their recorded accumulator trajectories), then mixed and
   * filtered cycle by cycle. Registers can only change between calls, so this equals cycle-by-cycle stepping.
   */
  run(n) {
    const done = this.done; done[0] = done[1] = done[2] = 0;
    const ctrl = this.ctrl;
    for (let pass = 0; pass < 3; pass++)
      for (let i = 0; i < 3; i++) if (!done[i] && (!(ctrl[i] & 6) || done[SRC[i]] || SRC[i] === i)) { this.voice(i, n); done[i] = 1; }
    for (let i = 0; i < 3; i++) if (!done[i]) { this.predict(SRC[i], n); this.voice(i, n); done[i] = 1; }   // all three sync/ring-linked
    this.mix(n);
    return n / this.dec;
  }
  /** a source voice's free-running trajectory (used only when sync/ring sources form a loop) */
  predict(i, n) {
    const ab = this.accBuf[i], rb = this.riseBuf[i], f = this.freq[i], test = this.ctrl[i] & 8;
    let a = this.acc[i];
    for (let c = 0; c < n; c++) { if (test) { ab[c] = 0; rb[c] = 0; continue; } const na = (a + f) & 0xffffff; rb[c] = (~a & na & 0x800000) ? 1 : 0; ab[c] = a = na; }
  }
  voice(i, n) {
    const cr = this.ctrl[i], wf = cr >> 4, test = cr & 8, sync = cr & 2, ring = cr & 4;
    const fq = this.freq[i], pwv = this.pw[i], zero = this.zero;
    const susL = (this.sr[i] >> 4) * 17, decP = RATE_PERIOD[this.ad[i] & 15];
    const s = SRC[i], sAcc = this.accBuf[s], sRise = this.riseBuf[s];
    const ab = this.accBuf[i], rb = this.riseBuf[i], vb = this.vbuf[i];
    let a = this.acc[i], l = this.lfsr[i], no = this.nout[i], wo = this.wout[i];
    let e = this.env[i], st = this.state[i], r = this.rc[i], rp = this.rper[i], ec = this.ec[i], ep = this.eper[i], hold = this.hold[i];
    for (let c = 0; c < n; c++) {
      // oscillator
      if (!test) {
        const na = (a + fq) & 0xffffff, up = ~a & na;
        if (up & 0x80000) { l = ((l << 1) | (((l >> 22) ^ (l >> 17)) & 1)) & 0x7fffff; no = noiseBits(l); }
        a = na;
        if (sync && sRise[c]) { a = 0; rb[c] = 0; } else rb[c] = (up & 0x800000) ? 1 : 0;
      } else rb[c] = 0;
      ab[c] = a;
      // waveform (combined waveforms: AND)
      if (wf) {
        let o = 0xfff;
        if (wf & 1) { const m = ring ? (a ^ sAcc[c]) & 0x800000 : a & 0x800000; o &= ((m ? ~a : a) >> 11) & 0xfff; }
        if (wf & 2) o &= a >> 12;
        if ((wf & 4) && !test && (a >> 12) < pwv) o = 0;
        if (wf & 8) {
          o &= no;
          if (wf & 7) {                         // noise lock-up: zeros written back into the LFSR
            const z = ~o;
            l &= ~(((z & 0x800) << 9) | ((z & 0x400) << 8) | ((z & 0x200) << 5) | ((z & 0x100) << 3)
              | ((z & 0x080) << 2) | ((z & 0x040) >> 1) | ((z & 0x020) >> 3) | ((z & 0x010) >> 4));
            no = noiseBits(l);
          }
        }
        wo = o;
      }
      // envelope: 15-bit rate counter, equality compare
      r = (r + 1) & 0x7fff;
      if (r === rp) {
        r = 0;
        let ne = -1;
        if (st === ATTACK) {                    // linear attack
          ne = e < 0xff ? e + 1 : 0xff; ec = 0;
          if (ne === 0xff) { st = DECAY; rp = decP; }
        } else if (!hold && ++ec >= ep) {       // exponential decay / release
          ec = 0;
          if (st === RELEASE || e !== susL) { ne = e - 1; if (ne === 0) hold = 1; }
        }
        if (ne >= 0) {
          e = ne;
          switch (e) {
            case 255: ep = 1; break; case 93: ep = 2; break; case 54: ep = 4; break;
            case 26: ep = 8; break; case 14: ep = 16; break; case 6: ep = 30; break; case 0: ep = 1; break;
          }
        }
      }
      vb[c] = (wo - zero) * e;
    }
    this.acc[i] = a; this.lfsr[i] = l; this.nout[i] = no; this.wout[i] = wo;
    this.env[i] = e; this.state[i] = st; this.rc[i] = r; this.rper[i] = rp; this.ec[i] = ec; this.eper[i] = ep; this.hold[i] = hold;
  }
  mix(n) {
    const filt = this.filt, mode = this.mode, kV = 1 / (2048 * 255);
    const off3 = (mode & 0x80) && !(filt & 4);
    const f0 = filt & 1 ? kV : 0, f1 = filt & 2 ? kV : 0, f2 = filt & 4 ? kV : 0;
    const d0 = filt & 1 ? 0 : kV, d1 = filt & 2 ? 0 : kV, d2 = (filt & 4) || off3 ? 0 : kV;
    const gl = mode & 0x10 ? 1 : 0, gb = mode & 0x20 ? 1 : 0, gh = mode & 0x40 ? 1 : 0;
    const v0 = this.vbuf[0], v1 = this.vbuf[1], v2 = this.vbuf[2], ob = this.obuf, dec = this.dec, inv = 1 / dec;
    const wc = this.wc, dmp = this.dmp, sat = this.sat, gain = this.vol / 15, dc = this.mixDC * gain;
    const lpA = this.lpA, aaA = this.aaA;
    let bp = this.bp, lp = this.lp, olp = this.olp, oaa = this.oaa;
    if (!filt && (bp < 0 ? -bp : bp) + (lp < 0 ? -lp : lp) < 1e-7) {   // nothing routed and filter at rest
      bp = lp = 0;
      for (let j = 0, c = 0; c < n; j++) {
        let sum = 0;
        for (let k = 0; k < dec; k++, c++) {
          const out = (v0[c] + v1[c] + (off3 ? 0 : v2[c])) * kV * gain + dc;
          olp += lpA * (out - olp); oaa += aaA * (olp - oaa);
          sum += oaa;
        }
        ob[j] = sum * inv;
      }
      this.bp = 0; this.lp = 0; this.olp = olp; this.oaa = oaa;
      return;
    }
    for (let j = 0, c = 0; c < n; j++) {
      let sum = 0;
      for (let k = 0; k < dec; k++, c++) {
        const x0 = v0[c], x1 = v1[c], x2 = v2[c];
        const fin = x0 * f0 + x1 * f1 + x2 * f2, dir = x0 * d0 + x1 * d1 + x2 * d2;
        let hp = fin - lp - bp * dmp;                     // state-variable filter at chip rate
        if (sat) hp = hp / (1 + sat * (hp < 0 ? -hp : hp)); // 6581: saturating summer
        bp += wc * hp; lp += wc * bp;
        const out = (lp * gl + bp * gb + hp * gh + dir) * gain + dc;
        olp += lpA * (out - olp); oaa += aaA * (olp - oaa);   // C64 output RC + anti-alias pole
        sum += oaa;
      }
      ob[j] = sum * inv;
    }
    this.bp = bp; this.lp = lp; this.olp = olp; this.oaa = oaa;
  }
}

function noiseBits(n) {
  return ((n >> 9) & 0x800) | ((n >> 8) & 0x400) | ((n >> 5) & 0x200) | ((n >> 3) & 0x100)
    | ((n >> 2) & 0x080) | ((n << 1) & 0x040) | ((n << 3) & 0x020) | ((n << 4) & 0x010);
}
