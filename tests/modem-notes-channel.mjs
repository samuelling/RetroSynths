// Acoustic channel simulator for Secret Notes tests: speaker band-pass, synthetic room reverb (exponential tail,
// RT60 0.3–0.6 s), clock skew (±0.5 %), random gain, leading/trailing silence, a clap mid-packet, additive noise.
import { synthesize } from '../apps/oldschool/modem/notes-core.js';

export class Rand { constructor(s = 1) { this.s = s >>> 0 || 1; } next() { let s = this.s; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.s = s >>> 0; return this.s / 4294967296; }
  range(a, b) { return a + (b - a) * this.next(); } gauss() { let u = 0; for (let i = 0; i < 6; i++) u += this.next(); return (u - 3) * Math.SQRT2; } }

function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
/** linear convolution by FFT overlap-add */
export function convolve(x, h) {
  let N = 1; while (N < 2 * h.length) N <<= 1; const L = N - h.length + 1;
  const Hr = new Float64Array(N), Hi = new Float64Array(N); Hr.set(h); fft(Hr, Hi, false);
  const y = new Float32Array(x.length + h.length - 1);
  const br = new Float64Array(N), bi = new Float64Array(N);
  for (let s = 0; s < x.length; s += L) {
    br.fill(0); bi.fill(0); for (let i = 0; i < L && s + i < x.length; i++) br[i] = x[s + i];
    fft(br, bi, false);
    for (let i = 0; i < N; i++) { const r = br[i] * Hr[i] - bi[i] * Hi[i], im = br[i] * Hi[i] + bi[i] * Hr[i]; br[i] = r; bi[i] = im; }
    fft(br, bi, true);
    for (let i = 0; i < N && s + i < y.length; i++) y[s + i] += br[i];
  }
  return y;
}
function biquad(type, f, q, fs) {
  const w = 2 * Math.PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q); let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al; let z1 = 0, z2 = 0;
  return (x) => { const y = (b0 / a0) * x + z1; z1 = (b1 / a0) * x - (a1 / a0) * y + z2; z2 = (b2 / a0) * x - (a2 / a0) * y; return y; };
}
export function filt(x, specs, fs) { const fl = specs.map(([t, f, q]) => biquad(t, f, q, fs)); const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { let v = x[i]; for (const f of fl) v = f(v); y[i] = v; } return y; }

/** synthetic room impulse response: direct path, a few early reflections, exponentially decaying noise tail */
export function roomIR(fs, rt60, drrDb, rng) {
  const n = Math.round(rt60 * 1.1 * fs), h = new Float32Array(n); h[0] = 1;
  for (let k = 0; k < 5; k++) h[Math.round(rng.range(0.002, 0.02) * fs)] += rng.range(0.2, 0.5) * (rng.next() < 0.5 ? -1 : 1);
  const tail = new Float32Array(n); let e = 0; const t0 = Math.round(0.004 * fs);
  for (let i = t0; i < n; i++) { const v = rng.gauss() * Math.exp(-6.91 * (i / fs) / rt60); tail[i] = v; e += v * v; }
  const g = Math.sqrt(Math.pow(10, -drrDb / 10) / e); for (let i = 0; i < n; i++) h[i] += tail[i] * g;
  return filt(h, [['lp', 6000, 0.7]], fs); // air & wall absorption darken the tail a little
}

/**
 * One transmission through the room (noise-free part): returns { clean, sigPower, segment } at `fs`.
 * opts: skew (fraction), rt60, drr, gainDb, lead, trail, clap
 */
export function throughRoom(payload, flags, mode, fs, rng, opts = {}) {
  const skew = opts.skew ?? rng.range(-0.005, 0.005);
  const tx = synthesize(payload, flags, mode, { fs: fs * (1 + skew), amp: 0.5, intro: !!opts.intro }); // sender's clock runs fast/slow
  let y = filt(tx, [['hp', 300, 0.7], ['hp', 300, 0.7], ['lp', 7000, 0.7]], fs);           // phone speaker 300 Hz – 7 kHz
  const rt60 = opts.rt60 ?? rng.range(0.3, 0.6), drr = opts.drr ?? rng.range(2, 10);
  y = convolve(y, roomIR(fs, rt60, drr, rng));
  const gain = Math.pow(10, (opts.gainDb ?? rng.range(-35, 0)) / 20);
  const lead = Math.round((opts.lead ?? rng.range(0.2, 2.5)) * fs), trail = Math.round((opts.trail ?? rng.range(0.3, 1.0)) * fs);
  const out = new Float32Array(lead + y.length + trail);
  let p = 0, cnt = 0; for (let i = 0; i < y.length; i++) { const v = y[i] * gain; out[lead + i] = v; if (i < tx.length) { p += v * v; cnt++; } }
  const sigPower = p / cnt;
  if (opts.clap !== false) {                         // a clap: 30–80 ms of decaying broadband noise, ~20 dB above the signal
    const at = lead + Math.round(rng.range(0.35, 0.8) * tx.length), L = Math.round(rng.range(0.03, 0.08) * fs), A = Math.sqrt(sigPower) * 10;
    for (let i = 0; i < L && at + i < out.length; i++) out[at + i] += A * rng.gauss() * Math.exp(-i / (0.25 * L));
  }
  return { clean: out, sigPower, skew, rt60, drr, segment: [lead, lead + tx.length] };
}
/** add band-limited (100 Hz – 8 kHz) white noise at a given SNR (signal power over the packet vs noise power) */
export function addNoise(x, sigPower, snrDb, fs, rng) {
  const raw = new Float32Array(x.length); for (let i = 0; i < x.length; i++) raw[i] = rng.gauss();
  const nb = filt(raw, [['hp', 100, 0.7], ['lp', 8000, 0.7]], fs); let p = 0; for (const v of nb) p += v * v; p /= nb.length;
  const g = Math.sqrt(sigPower / Math.pow(10, snrDb / 10) / p); const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] + nb[i] * g; return y;
}

/** any audio through the speaker + room (no clap), with leading/trailing silence; returns { y, sigPower } */
export function roomAudio(x, fs, rng, { rt60 = 0.4, drr = 8, gainDb = -8, lead = 1.0, trail = 1.5 } = {}) {
  let y = filt(x, [['hp', 300, 0.7], ['hp', 300, 0.7], ['lp', 7000, 0.7]], fs);
  y = convolve(y, roomIR(fs, rt60, drr, rng));
  const g = Math.pow(10, gainDb / 20), L = Math.round(lead * fs), out = new Float32Array(L + y.length + Math.round(trail * fs));
  let p = 0; for (let i = 0; i < y.length; i++) { out[L + i] = y[i] * g; if (i < x.length) p += (y[i] * g) ** 2; }
  return { y: out, sigPower: p / x.length };
}
