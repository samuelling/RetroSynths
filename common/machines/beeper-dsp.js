// Shared DSP for the AY and 1-bit machines (own code).
//
// Blep: band-limited step synthesis. Retro sound chips produce piecewise-constant outputs that change
// only at clock edges. Instead of rendering at the chip clock and filtering, every change of the output
// level is written as a band-limited step (a windowed-sinc impulse, integrated on readout) at its exact
// fractional position in output-sample time. The result is the chip's output convolved with a
// ~20 kHz low-pass, so ultrasonic content (AY tone periods of 1, noise at clock/16, 1-bit edges)
// averages out correctly instead of folding back as aliases.
//
// Biquad: RBJ cookbook filters for loudspeaker models.

function besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-12 * s) break; }
  return s;
}

const KERNELS = {};
function makeKernel(sr, taps, phases) {
  // cutoff 0.45·sr (19.8 kHz at 44.1 kHz), Kaiser β = 9 (≈ 90 dB stopband)
  const fc = Math.min(0.45, 20000 / sr), beta = 9, i0b = besselI0(beta);
  const h = new Float32Array((phases + 2) * taps);
  for (let p = 0; p <= phases + 1; p++) {
    let sum = 0;
    const frac = p / phases;
    for (let k = 0; k < taps; k++) {
      const x = (k - taps / 2 + 1) - frac;                  // distance from the step position
      const s = Math.abs(x) < 1e-9 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const r = x / (taps / 2);
      const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      h[p * taps + k] = s * w; sum += s * w;
    }
    for (let k = 0; k < taps; k++) h[p * taps + k] /= sum;   // each impulse sums to 1 → exact steps
  }
  return h;
}

export class Blep {
  /**
   * @param {number} sr       output sample rate
   * @param {number} taps     impulse length in output samples (even)
   * @param {number} phases   sub-sample time resolution
   * @param {number} maxBlock largest n passed to read()
   */
  constructor(sr, taps = 48, phases = 512, maxBlock = 4096) {
    this.T = taps; this.P = phases;
    const key = sr + ':' + taps + ':' + phases;
    this.h = KERNELS[key] || (KERNELS[key] = makeKernel(sr, taps, phases));
    this.buf = new Float64Array(maxBlock + taps + 2);
    this.max = maxBlock;
    this.acc = 0;
  }
  /** Add a level change of `delta` at time t (output samples from the start of the current block, 0 ≤ t < n). */
  add(t, delta) {
    const i = t | 0, fp = (t - i) * this.P, p = fp | 0, w1 = (fp - p) * delta, w0 = delta - w1;
    const T = this.T, h = this.h, b = this.buf, h0 = p * T, h1 = h0 + T;
    for (let k = 0; k < T; k++) b[i + k] += w0 * h[h0 + k] + w1 * h[h1 + k];   // phase-interpolated kernel
  }
  /** Integrate n samples into out[off..off+n) (adds `gain`·signal) and advance. */
  read(out, n, gain = 1, off = 0) {
    const b = this.buf, T = this.T;
    let acc = this.acc;
    for (let i = 0; i < n; i++) { acc += b[i]; out[off + i] += acc * gain; }
    this.acc = acc;
    b.copyWithin(0, n, n + T + 2);
    b.fill(0, T + 2, n + T + 2);
  }
  /** Same as read() but writes into a scratch array (overwrite). */
  readTo(out, n) {
    const b = this.buf, T = this.T;
    let acc = this.acc;
    for (let i = 0; i < n; i++) { acc += b[i]; out[i] = acc; }
    this.acc = acc;
    b.copyWithin(0, n, n + T + 2);
    b.fill(0, T + 2, n + T + 2);
  }
  clear() { this.buf.fill(0); this.acc = 0; }
}

export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  _set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; return this; }
  lowpass(sr, f, q) { const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
  highpass(sr, f, q) { const w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
  peak(sr, f, q, db) {
    const A = Math.pow(10, db / 40), w = 2 * Math.PI * f / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  run(x) {   // transposed direct form II
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  clear() { this.z1 = this.z2 = 0; }
}
