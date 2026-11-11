// Modem DSP primitives. Pure JS, no DOM: runs in the AudioWorklet and in Node (tests).
// Everything here works at the telephone rate FS = 8000 Hz, sample by sample.

export const FS = 8000;
export const TAU = Math.PI * 2;
export const ms = (x) => Math.round(x * FS / 1000);           // milliseconds -> samples @ 8 kHz
export const dB = (x) => Math.pow(10, x / 20);
// dBm0 -> peak amplitude of a sine, with 1.0 = G.711 full scale (+3.14 dBm0 for a full-scale sine)
export const dBm0 = (x) => Math.pow(10, (x - 3.14) / 20);

/** xorshift PRNG (deterministic, seedable) */
export class Rng {
  constructor(seed = 1) { this.s = (seed >>> 0) || 0x9e3779b9; }
  u32() { let s = this.s; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.s = s >>> 0; return this.s; }
  next() { return this.u32() / 4294967296; }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
  bit() { return this.u32() >>> 31; }
  gauss() { let u = 0; for (let i = 0; i < 4; i++) u += this.next(); return (u - 2) * 1.732; }
}
export const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** RBJ biquad */
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  _set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; return this; }
  lp(f, q = 0.7071, fs = FS) { const w = TAU * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
  hp(f, q = 0.7071, fs = FS) { const w = TAU * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
  bp(f, q = 1, fs = FS) { const w = TAU * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q); return this._set(al, 0, -al, 1 + al, -2 * c, 1 - al); }
  peak(f, q, g, fs = FS) { const A = Math.pow(10, g / 40), w = TAU * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A); }
  run(x) { const y = this.b0 * x + this.z1; this.z1 = this.b1 * x - this.a1 * y + this.z2; this.z2 = this.b2 * x - this.a2 * y; return y; }
  reset() { this.z1 = this.z2 = 0; }
}
/** a chain of biquads */
export class Chain {
  constructor(list = []) { this.f = list; }
  run(x) { for (let i = 0; i < this.f.length; i++) x = this.f[i].run(x); return x; }
}

// ------------------------------------------------------------------ G.711 companding (bit-exact tables)
const MU_DEC = new Float32Array(256), A_DEC = new Float32Array(256);
for (let c = 0; c < 256; c++) {
  // μ-law (G.711): invert, sign, exponent, mantissa; decoded to ±8031 then scaled to ±1
  const u = ~c & 0xff, sign = u & 0x80, e = (u >> 4) & 7, m = u & 15;
  let mag = (((m << 3) + 0x84) << e) - 0x84;
  MU_DEC[c] = (sign ? -mag : mag) / 32124;
  // A-law: even bits inverted
  const a = c ^ 0x55, s2 = a & 0x80, e2 = (a >> 4) & 7, m2 = a & 15;
  let mag2 = e2 === 0 ? (m2 << 4) + 8 : ((m2 << 4) + 0x108) << (e2 - 1);
  A_DEC[c] = (s2 ? mag2 : -mag2) / 32256;
}
export function muEncode(x) { // x in ±1 -> 8-bit code
  let s = Math.round(Math.max(-1, Math.min(1, x)) * 32124);
  const sign = s < 0 ? 0x80 : 0; if (s < 0) s = -s;
  s += 0x84; if (s > 0x7fff) s = 0x7fff;
  let e = 7; for (let mask = 0x4000; (s & mask) === 0 && e > 0; mask >>= 1) e--;
  const m = (s >> (e + 3)) & 15;
  return ~(sign | (e << 4) | m) & 0xff;
}
export function aEncode(x) {
  let s = Math.round(Math.max(-1, Math.min(1, x)) * 32256) >> 3; // 13-bit
  const sign = s >= 0 ? 0x80 : 0; if (s < 0) s = -s - 1; if (s < 0) s = 0;
  let code;
  if (s < 32) code = s >> 1; else { let e = 1; while ((s >> (e + 5)) && e < 7) e++; code = (e << 4) | ((s >> e) & 15); }
  return (sign | code) ^ 0x55;
}
export const muDecode = (c) => MU_DEC[c & 255];
export const aDecode = (c) => A_DEC[c & 255];
export const muQuant = (x) => MU_DEC[muEncode(x)];
export const aQuant = (x) => A_DEC[aEncode(x)];
/** μ-law code for a "Ucode" 0..127 (V.90 convention: magnitude index, 0 = smallest) with sign */
export const ucodeLevel = (u, neg) => { const code = (neg ? 0x00 : 0x80) | (127 - (u & 127)); return MU_DEC[code]; };

// ------------------------------------------------------------------ oscillators & tones
export class Osc {
  constructor(f, amp = 1, ph = 0) { this.w = TAU * f / FS; this.ph = ph; this.amp = amp; }
  setF(f) { this.w = TAU * f / FS; }
  next() { const y = this.amp * Math.cos(this.ph); this.ph += this.w; if (this.ph > TAU) this.ph -= TAU; return y; }
}
/** sum of steady tones */
export class MultiTone {
  constructor(freqs, amps) { this.o = freqs.map((f, i) => new Osc(f, Array.isArray(amps) ? amps[i] : amps, i * 1.3)); }
  next() { let s = 0; for (const o of this.o) s += o.next(); return s; }
}
/** cadenced tone: pattern = [on_s, off_s, on_s, off_s ...], repeats; offset in seconds into the cadence */
export class Cadence {
  constructor(freqs, amp, pattern, offset = 0) {
    this.t = new MultiTone(freqs, amp); this.p = pattern.map(x => Math.round(x * FS)); this.per = this.p.reduce((a, b) => a + b, 0);
    this.n = Math.round(offset * FS) % this.per; this.env = 0;
  }
  next() {
    let acc = 0, on = false, k = this.n;
    for (let i = 0; i < this.p.length; i++) { if (k < acc + this.p[i]) { on = (i & 1) === 0; break; } acc += this.p[i]; }
    this.n = (this.n + 1) % this.per;
    this.env += ((on ? 1 : 0) - this.env) * 0.08;                // ~1.5 ms ramps, no clicks
    return this.t.next() * this.env;
  }
}
/** V.25 / V.8 answer tone: 2100 Hz, optional phase reversals every 450 ms, optional 15 Hz AM (ANSam, ±20 %) */
export class AnswerTone {
  constructor({ f = 2100, amp, reversals = false, am = false, revEvery = 0.45 }) {
    this.w = TAU * f / FS; this.ph = 0; this.amp = amp; this.rev = reversals ? Math.round(revEvery * FS) : 0; this.am = am; this.n = 0; this.flip = 1;
    this.amw = TAU * 15 / FS;
  }
  next() {
    if (this.rev && this.n > 0 && this.n % this.rev === 0) this.ph += Math.PI;   // abrupt 180° reversal, as specified
    const env = this.am ? 1 + 0.2 * Math.sin(this.amw * this.n) : 1;
    const y = this.amp * env * Math.cos(this.ph); this.ph += this.w; if (this.ph > TAU) this.ph -= TAU; this.n++;
    return y;
  }
}
export class Silence { next() { return 0; } }

// ------------------------------------------------------------------ FSK (continuous phase)
export class FSK {
  constructor({ mark, space, baud, amp, bits }) {
    this.wm = TAU * mark / FS; this.ws = TAU * space / FS; this.step = baud / FS; this.amp = amp;
    this.bits = bits; this.bit = 1; this.acc = 1; this.ph = 0;
  }
  next() {
    this.acc += this.step;
    if (this.acc >= 1) { this.acc -= 1; this.bit = this.bits ? this.bits() : 1; }
    this.ph += this.bit ? this.wm : this.ws; if (this.ph > TAU) this.ph -= TAU;
    return this.amp * Math.cos(this.ph);
  }
}

// ------------------------------------------------------------------ pulse-shaped passband modulator (PSK/QAM)
const RRC_CACHE = new Map();
/** square-root raised cosine table over x in [-span, span] symbols */
function rrcTable(beta, span, res = 512) {
  const key = beta + ':' + span; if (RRC_CACHE.has(key)) return RRC_CACHE.get(key);
  const n = 2 * span * res + 1, t = new Float32Array(n + 2);
  for (let i = 0; i < n; i++) {
    const x = i / res - span; let v;
    if (Math.abs(x) < 1e-8) v = 1 - beta + 4 * beta / Math.PI;
    else if (beta > 0 && Math.abs(Math.abs(x) - 1 / (4 * beta)) < 1e-6)
      v = beta / Math.SQRT2 * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * beta)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * beta)));
    else v = (Math.sin(Math.PI * x * (1 - beta)) + 4 * beta * x * Math.cos(Math.PI * x * (1 + beta))) / (Math.PI * x * (1 - Math.pow(4 * beta * x, 2)));
    const w = 0.5 + 0.5 * Math.cos(Math.PI * x / span); // gentle window on the truncation
    t[i] = v * w;
  }
  const o = { t, res, span }; RRC_CACHE.set(key, o); return o;
}
/**
 * Quadrature modulator: s(t) = Re{ Σ a_k g(t - kT) e^{j2πfc t} }, g = SRRC.
 * `src()` returns the next complex symbol as [re, im] (any scale); set it between segments for continuity.
 */
export class QAMMod {
  constructor({ baud, fc, beta = 0.25, span = 5, amp = 1 }) {
    this.tab = rrcTable(beta, span); this.span = span; this.L = 2 * span + 1;
    this.re = new Float32Array(this.L); this.im = new Float32Array(this.L); this.head = 0;
    this.amp = amp; this.ph = 0; this.src = null; this.frac = 0; this.symbols = 0;
    this.set(baud, fc);
  }
  set(baud, fc) { this.baud = baud; this.step = baud / FS; this.w = TAU * fc / FS; this.fc = fc; }
  push(re, im) { this.head = (this.head + 1) % this.L; this.re[this.head] = re; this.im[this.head] = im; this.symbols++; }
  next() {
    this.frac += this.step;
    while (this.frac >= 1) { this.frac -= 1; const s = this.src ? this.src() : null; if (s) this.push(s[0], s[1]); else this.push(0, 0); }
    const t = this.tab.t, res = this.tab.res, sp = this.span, L = this.L;
    let br = 0, bi = 0;
    for (let i = 0; i < L; i++) {
      const x = this.frac + i - sp;                   // time from symbol (head - i) center, delayed by span
      const fi = (x + sp) * res, i0 = fi | 0;
      if (i0 < 0 || i0 >= t.length - 1) continue;
      const g = t[i0] + (t[i0 + 1] - t[i0]) * (fi - i0);
      const k = (this.head - i + L) % L;
      br += this.re[k] * g; bi += this.im[k] * g;
    }
    const c = Math.cos(this.ph), s = Math.sin(this.ph);
    this.ph += this.w; if (this.ph > TAU) this.ph -= TAU;
    return this.amp * (br * c - bi * s);
  }
}

// ------------------------------------------------------------------ scramblers
/**
 * Self-synchronising scrambler 1 + x^-a + x^-b (out = in ^ out[n-a] ^ out[n-b]).
 *  V.22 / V.22bis / Bell 212A: (14, 17)   V.32/V.34 calling: (18, 23)   answering: (5, 23)   V.29/V.27ter: (18, 23)
 * `guard64` enables the V.22 rule: after 64 consecutive output ones, invert the next input bit.
 */
export class Scrambler {
  constructor(a, b, guard64 = false) { this.a = a; this.b = b; this.r = 0; this.guard = guard64; this.ones = 0; }
  bit(x) {
    if (this.guard && this.ones >= 64) { x ^= 1; this.ones = 0; }
    const out = (x ^ (this.r >>> (this.a - 1)) ^ (this.r >>> (this.b - 1))) & 1;
    this.r = ((this.r << 1) | out) & 0x7fffff;
    this.ones = out ? this.ones + 1 : 0;
    return out;
  }
}

// ------------------------------------------------------------------ bit sources
/** async framing: start 0, 8 data LSB first, stop 1 */
export const asyncBits = (byte) => { const b = [0]; for (let i = 0; i < 8; i++) b.push((byte >> i) & 1); b.push(1); return b; };
/** CRC-16 ITU (x^16+x^12+x^5+1), MSB-first over a bit array, init 0xFFFF */
export function crc16bits(bits) {
  let c = 0xffff;
  for (const b of bits) { const fb = ((c >> 15) ^ b) & 1; c = (c << 1) & 0xffff; if (fb) c ^= 0x1021; }
  return c;
}
/** HDLC FCS-16 (reflected 0x8408), over bytes; returns 16-bit FCS (complemented) */
export function fcs16(bytes) {
  let c = 0xffff;
  for (const by of bytes) { c ^= by; for (let i = 0; i < 8; i++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1; }
  return (~c) & 0xffff;
}
/** HDLC frame bits with zero-bit stuffing (flags not included) */
export function hdlcBits(bytes) {
  const all = bytes.concat([0, 0]); const f = fcs16(bytes); all[all.length - 2] = f & 255; all[all.length - 1] = f >> 8;
  const out = []; let ones = 0;
  for (const by of all) for (let i = 0; i < 8; i++) {
    const b = (by >> i) & 1; out.push(b);
    if (b) { if (++ones === 5) { out.push(0); ones = 0; } } else ones = 0;
  }
  return out;
}
export const FLAG_BITS = [0, 1, 1, 1, 1, 1, 1, 0];

/** cyclic bit pattern source */
export const cycleBits = (arr) => { let i = 0; return () => { const b = arr[i]; i = (i + 1) % arr.length; return b; }; };
/** one-shot bit list then a fallback source */
export const listThen = (arr, then) => { let i = 0; return () => (i < arr.length ? arr[i++] : then()); };
export const ones = () => 1;

// ------------------------------------------------------------------ constellations
const R45 = Math.SQRT1_2;
/** V.22 / Bell 212A dibit -> quadrant phase change (quarter turns): 00:+90°, 01:0°, 11:+270°, 10:+180° */
export const V22_DPHASE = { 0b00: 1, 0b01: 0, 0b11: 3, 0b10: 2 };
/** differential quadrant QPSK at 45° points (V.22 1200 bit/s, Bell 212A) */
export class DiffQPSK {
  constructor(bits) { this.bits = bits; this.q = 0; }
  sym() { const d = (this.bits() << 1) | this.bits(); this.q = (this.q + V22_DPHASE[d]) & 3; const a = Math.PI / 4 + this.q * Math.PI / 2; return [Math.cos(a), Math.sin(a)]; }
}
/** V.22bis 16-point: Q1Q2 differential quadrant, Q3Q4 point within the quadrant */
const V22B_IN = [[1, 1], [3, 1], [1, 3], [3, 3]];
export class V22bisQAM {
  constructor(bits) { this.bits = bits; this.q = 0; }
  sym() {
    const d = (this.bits() << 1) | this.bits(); this.q = (this.q + V22_DPHASE[d]) & 3;
    const p = V22B_IN[(this.bits() << 1) | this.bits()]; let x = p[0], y = p[1];
    for (let i = 0; i < this.q; i++) { const t = x; x = -y; y = t; }
    return [x / 3, y / 3];
  }
}
/** V.32 training points A, B, C, D (from the 32-point TCM lattice), scaled */
export const V32_ABCD = { A: [-6, -2], B: [2, -6], C: [6, 2], D: [-2, 6] };
/** square/rectangular QAM mapper for data mode: b bits per symbol, differential quadrant on the first 2 bits */
export class GridQAM {
  constructor(bits, b, shaped = false) {
    this.bits = bits; this.b = b; this.q = 0; this.shaped = shaped;
    const rb = b - 2; this.ib = Math.ceil(rb / 2); this.qb = rb - this.ib;
  }
  sym() {
    const d = (this.bits() << 1) | this.bits(); this.q = (this.q + V22_DPHASE[d]) & 3;
    let xi = 0, yi = 0; for (let i = 0; i < this.ib; i++) xi = (xi << 1) | this.bits(); for (let i = 0; i < this.qb; i++) yi = (yi << 1) | this.bits();
    const mx = 1 << this.ib, my = 1 << this.qb;
    let x = (2 * xi + 1) / (2 * mx), y = (2 * yi + 1) / (2 * my);   // within the first quadrant, 0..1
    if (this.shaped) { x = x * x * 0.6 + x * 0.4; y = y * y * 0.6 + y * 0.4; } // crude shell-like shaping: more small points
    for (let i = 0; i < this.q; i++) { const t = x; x = -y; y = t; }
    return [x * 1.3, y * 1.3];
  }
}

// ------------------------------------------------------------------ DTMF
export const DTMF = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633],
};

// ------------------------------------------------------------------ V.34 line probe (L1/L2)
// 21 tones, 150 Hz apart from 150 to 3750 Hz, with 900, 1200, 1800 and 2400 Hz omitted.
export const PROBE_TONES = []; for (let k = 1; k <= 25; k++) if (![6, 8, 12, 16].includes(k)) PROBE_TONES.push(k * 150);
// 0°/180° assignment: a low-crest-factor set found by search (crest ≈ 1.75); V.34's own Table is not reproduced
const PROBE_MASK = 1893699;
export const PROBE_PERIOD = new Float32Array(160); // 20 ms = 3 whole periods of 150 Hz at 8 kHz
{ let p = 0; for (let n = 0; n < 160; n++) { let s = 0; for (let i = 0; i < PROBE_TONES.length; i++) s += ((PROBE_MASK >> i) & 1 ? -1 : 1) * Math.cos(TAU * PROBE_TONES[i] * n / FS); PROBE_PERIOD[n] = s; p += s * s; }
  const rms = Math.sqrt(p / 160); for (let n = 0; n < 160; n++) PROBE_PERIOD[n] /= rms * Math.SQRT2; } // normalised to a sine of peak 1's power

// ------------------------------------------------------------------ simple resonator for clicks and voice
export class Reson {
  constructor(f, bw, fs = FS) { this.set(f, bw, fs); this.y1 = 0; this.y2 = 0; }
  set(f, bw, fs = FS) { const r = Math.exp(-Math.PI * bw / fs); this.a1 = 2 * r * Math.cos(TAU * f / fs); this.a2 = -r * r; this.g = (1 - r * r) * 0.5; }
  run(x) { const y = this.g * x + this.a1 * this.y1 + this.a2 * this.y2; this.y2 = this.y1; this.y1 = y; return y; }
}
