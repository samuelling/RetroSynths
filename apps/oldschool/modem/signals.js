// Signal generators for every handshake segment. Each returns an object with next() -> one 8 kHz sample.
import {
  FS, TAU, dBm0, dB, Osc, MultiTone, Cadence, AnswerTone, FSK, QAMMod, Scrambler, Rng, Reson, Biquad,
  asyncBits, crc16bits, hdlcBits, FLAG_BITS, cycleBits, DTMF, PROBE_PERIOD, DiffQPSK, V22bisQAM, V32_ABCD, GridQAM,
  ucodeLevel,
} from './dsp.js';

export const SILENCE = { next: () => 0 };

// ------------------------------------------------------------------ call progress
export const toneGen = (freqs, db) => new MultiTone(freqs, dBm0(db));
export const cadenceGen = (spec, offset = 0) => new Cadence(spec.f, dBm0(spec.db), spec.pat, offset);
/** DTMF digit: low group -7 dBm0, high group -5 dBm0 (positive twist), short ramps */
export function dtmfGen(d, n) {
  const p = DTMF[d] || DTMF['0']; const lo = new Osc(p[0], dBm0(-7)), hi = new Osc(p[1], dBm0(-5)); let i = 0; const r = 24;
  return { next() { const e = Math.min(1, i / r, (n - i) / r); i++; return (lo.next() + hi.next()) * Math.max(0, e); } };
}
/** Special Information Tone (vacant code): 913.8, 1370.6, 1776.7 Hz */
export function sitGen() {
  const seg = [[913.8, 274], [1370.6, 274], [1776.7, 380]]; let k = 0, i = 0; let o = new Osc(seg[0][0], dBm0(-14));
  return { next() { if (k >= 3) return 0; const n = seg[k][1] * 8; const y = o.next() * Math.min(1, i / 16, (n - i) / 16); if (++i >= n) { k++; i = 0; if (k < 3) o = new Osc(seg[k][0], dBm0(-14)); } return y; } };
}
/** off-hook "howler" (receiver off hook): 1400+2060+2450+2600 Hz, 0.1 s on / 0.1 s off */
export const howlerGen = () => new Cadence([1400, 2060, 2450, 2600], dBm0(-6), [0.1, 0.1]);

// ------------------------------------------------------------------ answer tones
export const ansGen = (db, opt = {}) => new AnswerTone({ amp: dBm0(db), reversals: !!opt.rev, am: !!opt.am });
export const bellAnsGen = (db) => new Osc(2225, dBm0(db));
export const cngGen = () => new Cadence([1100], dBm0(-12), [0.5, 3.0]);

// ------------------------------------------------------------------ FSK
export const FSKP = {
  v21L: { mark: 980, space: 1180 },   // V.21 channel 1 (calling)
  v21H: { mark: 1650, space: 1850 },  // V.21 channel 2 (answering)
  b103o: { mark: 1270, space: 1070 }, // Bell 103 originate
  b103a: { mark: 2225, space: 2025 }, // Bell 103 answer
};
export const fskGen = (kind, db, bits) => new FSK({ ...FSKP[kind], baud: 300, amp: dBm0(db), bits });

// ------------------------------------------------------------------ V.8
export const V8 = {
  // CM/JM: ten ones, then sync octet 0xE0 (framed), then category octets (each with start/stop bits)
  callFunction: (6 << 5) | 0x01,
  modOctets(caps) {
    let m0 = 0x05; if (caps.has('V34')) m0 |= 0x40; if (caps.has('V90') || caps.has('P56X') || caps.has('P56F')) m0 |= 0x20;
    let m1 = 0x10; if (caps.has('V32') || caps.has('V32bis')) m1 |= 0x01; if (caps.has('V22') || caps.has('V22bis')) m1 |= 0x02;
    let m2 = 0x10; if (caps.has('V21')) m2 |= 0x80;
    return [m0, m1, m2];
  },
  message(caps, opt = {}) {
    const oct = [0xE0, V8.callFunction, ...V8.modOctets(caps)];
    if (opt.lapm) oct.push(0x4A);                                  // protocols: LAPM
    oct.push(0x0D | 0x20);                                         // PSTN access: call DCE on analogue line
    if (opt.pcm) oct.push(0x07 | (opt.digital ? 0x40 : 0x20));     // PCM modem availability (V.90 analogue / digital)
    if (opt.nsf) oct.push(0x0F, opt.nsf & 255);                    // a "proprietary" octet for pre-standard 56K flavours
    const bits = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    for (const o of oct) bits.push(...asyncBits(o));
    return bits;
  },
  cj() { return [...asyncBits(0), ...asyncBits(0), ...asyncBits(0)]; },
};

// ------------------------------------------------------------------ V.34 phase 2 (INFO frames, tones A/B) on one DPSK modulator
/** INFO frame: fill 1111, sync 01110010, info bits, CRC-16 (over info bits), fill 1111 */
export function infoBits(nInfo, rng) {
  const info = []; for (let i = 0; i < nInfo; i++) info.push(rng.bit());
  const c = crc16bits(info), crc = []; for (let i = 15; i >= 0; i--) crc.push((c >> i) & 1);
  return [1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 1, 0, ...info, ...crc, 1, 1, 1, 1];
}
export const INFO_LEN = { INFO0: 17, INFO1c: 77, INFO1a: 38 }; // info bit counts -> 49, 109, 70 bits in all
/** 600 baud DPSK carrier (caller 1200 Hz, answerer 2400 Hz). A "1" flips the carrier phase by 180°. */
export class Phase2Pump {
  constructor(fc, db) { this.mod = new QAMMod({ baud: 600, fc, beta: 0.75, span: 4, amp: dBm0(db) }); this.p = 1; this.bits = null; this.i = 0; this.mod.src = () => this.sym(); }
  sym() { if (this.bits && this.i < this.bits.length) { if (this.bits[this.i++]) this.p = -this.p; } return [this.p, 0]; }
  info(bits) { this.bits = bits; this.i = 0; }    // send these bits, then continue as a steady tone
  tone() { this.bits = null; }
  reverse() { this.p = -this.p; }
  next() { return this.mod.next(); }
}
/** L1/L2 line probe: 21 tones; L1 is 6 dB above nominal */
export function probeGen(db, plusDb = 0) { const a = dBm0(db + plusDb); let i = 0; return { next() { const y = PROBE_PERIOD[i] * a; i = (i + 1) % 160; return y; } }; }

// ------------------------------------------------------------------ QAM pumps (V.32, V.34, V.22 family)
/**
 * One modulator per side; segments re-point its symbol source, so carrier and pulse tails stay continuous.
 * Symbol sources are factories taking (pump) and returning a function -> [re, im].
 */
export class QAMPump {
  constructor({ baud, fc, beta, db, scr }) {
    this.mod = new QAMMod({ baud, fc, beta, span: 5, amp: dBm0(db) }); this.scr = scr; this.src = null;
    this.mod.src = () => (this.src ? this.src() : [0, 0]);
    this.guard = null;
  }
  use(src) { this.src = src; }
  setGuard(f, rel) { this.guard = f ? new Osc(f, this.mod.amp * dB(rel)) : null; }
  next() { const y = this.mod.next(); return this.guard ? y + this.guard.next() : y; }
}
const norm = (p, k) => [p[0] / k, p[1] / k];
const V32K = Math.sqrt(40);
export const SRC = {
  zero: () => () => [0, 0],
  constPt: (p) => () => p,
  alt: (p, q) => { let k = 0; return () => ((k++ & 1) ? q : p); },
  // V.32 states
  v32: (name) => norm(V32_ABCD[name], V32K),
  // scrambled ones / data through a scrambler into a mapper
  scrambled: (scr, bitsFn, mapperCtor, ...args) => { const m = new mapperCtor(() => scr.bit(bitsFn()), ...args); return () => m.sym(); },
  unscrambled: (bitsFn, mapperCtor, ...args) => { const m = new mapperCtor(bitsFn, ...args); return () => m.sym(); },
  /** 4-point, absolute, dibit -> A,B,C,D (V.32 TRN) */
  v32trn4: (scr, bitsFn = () => 1) => { const P = ['A', 'B', 'D', 'C'].map(n => norm(V32_ABCD[n], V32K)); return () => P[(scr.bit(bitsFn()) << 1) | scr.bit(bitsFn())]; },
  /** 4-point QPSK at 45° (V.34 TRN / MP / J) */
  qpsk4: (scr, bitsFn = () => 1) => { const P = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(p => norm(p, Math.SQRT2)); return () => P[(scr.bit(bitsFn()) << 1) | scr.bit(bitsFn())]; },
  /** differentially encoded 4-point pattern from a 16-bit word (V.32 R1/R2/R3/E, V.34 J/J'/E), scrambled */
  word16: (scr, word, once = false) => {
    let i = 0, q = 0; const D = { 0: 1, 1: 0, 3: 3, 2: 2 };
    return () => { if (once && i >= 16) return [0, 0]; const b1 = (word >> (15 - (i % 16))) & 1, b2 = (word >> (15 - ((i + 1) % 16))) & 1; i += 2;
      const d = (scr ? (scr.bit(b1) << 1) | scr.bit(b2) : (b1 << 1) | b2); q = (q + D[d]) & 3; const a = Math.PI / 4 + q * Math.PI / 2; return [Math.cos(a), Math.sin(a)]; };
  },
  /** V.34 PP: 6 periods of a 48-symbol constant-amplitude zero-autocorrelation sequence (Chu form used here) */
  pp: () => { let k = 0; return () => { const a = Math.PI * (k % 48) * (k % 48) / 48; k++; return [Math.cos(a), Math.sin(a)]; }; },
};

// ------------------------------------------------------------------ V.29 (fax 9600): 8 phases, 4 amplitudes, 2400 baud, 1700 Hz
export class V29Mapper {
  constructor(bits) { this.bits = bits; this.ph = 0; }
  sym() {
    const q1 = this.bits(), d = (this.bits() << 2) | (this.bits() << 1) | this.bits();
    const DPH = [1, 0, 2, 3, 6, 7, 5, 4];                      // Gray-coded phase change in 45° steps
    this.ph = (this.ph + DPH[d]) & 7; const diag = this.ph & 1;
    const r = diag ? (q1 ? 3 * Math.SQRT2 : Math.SQRT2) : (q1 ? 5 : 3);
    const a = this.ph * Math.PI / 4; return [r * Math.cos(a) / 3.6, r * Math.sin(a) / 3.6];
  }
}

// ------------------------------------------------------------------ V.90 PCM (digital modem: exact μ-law codes at 8000 symbols/s)
/** TRN1d-style: scrambled ones choose the sign of a fixed Ucode */
export function pcmTrnGen(scr, ucode) { return { next: () => ucodeLevel(ucode, scr.bit(1)) }; }
/** Sd / S̄d: a fixed 6-symbol sign pattern at one level */
export function pcmSdGen(ucode, inv) { const sp = [0, 1, 0, 1, 1, 0]; let i = 0; return { next() { const s = sp[i % 6] ^ (inv ? 1 : 0); i++; return ucodeLevel(ucode, s); } }; }
/**
 * DIL (digital impairment learning). A sequence of segments; within a segment a sign pattern of length Lsp
 * and a training pattern of length Ltp choose, symbol by symbol, between a reference Ucode and the Ucode under test.
 * `flavor` changes the pattern lengths and level ladder (standard V.90 vs the two pre-standard camps).
 */
export function dilGen(flavor, nSeg, segSyms, rng) {
  const F = { V90: { lsp: 6, ltp: 12, ref: 40, lo: 16, hi: 112 }, P56X: { lsp: 8, ltp: 16, ref: 48, lo: 24, hi: 120 }, P56F: { lsp: 6, ltp: 24, ref: 32, lo: 8, hi: 104 } }[flavor] || { lsp: 6, ltp: 12, ref: 40, lo: 16, hi: 112 };
  const sp = []; for (let i = 0; i < F.lsp; i++) sp.push(rng.bit());
  const tp = []; for (let i = 0; i < F.ltp; i++) tp.push((i * 5 + 3) % 7 < 3 ? 1 : 0);
  let n = 0;
  return { next() {
    const seg = Math.floor(n / segSyms) % nSeg, k = n % segSyms; n++;
    const u = F.lo + Math.round((F.hi - F.lo) * ((seg * 37) % nSeg) / Math.max(1, nSeg - 1));
    const code = tp[k % F.ltp] ? u : F.ref;
    return ucodeLevel(code, sp[k % F.lsp] ^ (seg & 1));
  } };
}
/** PCM data: sign + magnitude from a constellation of Ucodes */
export function pcmDataGen(bitsFn, scr, maxU) { return { next() { let u = 0; for (let i = 0; i < 6; i++) u = (u << 1) | scr.bit(bitsFn()); const neg = scr.bit(bitsFn()); return ucodeLevel(Math.round(u * maxU / 63), neg); } }; }

// ------------------------------------------------------------------ voice: a formant blip saying "hello?"
/**
 * Tiny cascade formant synthesiser: glottal pulse train (f0 rising for a question) + aspiration,
 * through 3 resonators following h-e-l-o formant targets.
 */
export function helloGen({ dur = 0.62, f0 = 190, rise = 1.3, amp = dBm0(-14), seed = 3 } = {}) {
  const rng = new Rng(seed), N = Math.round(dur * FS);
  const R = [new Reson(500, 80), new Reson(1800, 100), new Reson(2600, 160)];
  // [time fraction, F1, F2, F3, voicing, aspiration, loudness]
  const K = [[0, 500, 1800, 2600, 0, 1, 0.5], [0.13, 520, 1850, 2600, 1, 0.25, 1], [0.38, 420, 1300, 2700, 1, 0, 0.8],
             [0.5, 380, 1050, 2600, 1, 0, 0.75], [0.62, 520, 950, 2450, 1, 0, 1], [1, 450, 820, 2400, 1, 0.05, 0.6]];
  let ph = 0, i = 0; const hp = new Biquad().hp(250);
  return { next() {
    if (i >= N) return 0;
    const x = i / N; let a = K[0], b = K[K.length - 1];
    for (let k = 0; k < K.length - 1; k++) if (x >= K[k][0] && x <= K[k + 1][0]) { a = K[k]; b = K[k + 1]; break; }
    const u = (x - a[0]) / Math.max(1e-6, b[0] - a[0]), L = (j) => a[j] + (b[j] - a[j]) * u;
    if ((i & 31) === 0) { R[0].set(L(1), 90); R[1].set(L(2), 120); R[2].set(L(3), 170); }
    const f = f0 * (1 + (rise - 1) * Math.pow(x, 2)) * (1 + 0.01 * Math.sin(i / 90));
    ph += f / FS; let src = 0; if (ph >= 1) { ph -= 1; src = 1; }
    const s = src * L(4) * 6 + (rng.next() - 0.5) * L(5) * 0.9;
    let y = R[0].run(s) * 1.0 + R[1].run(s) * 0.55 + R[2].run(s) * 0.25;
    const env = Math.min(1, i / 300, (N - i) / 500) * L(6);
    i++; return hp.run(y) * env * amp * 9;
  } };
}
/** a few seconds of recorded-announcement-like babble (for the intercept) */
export function babbleGen(secs, seed = 9) {
  const rng = new Rng(seed); const syl = []; let t = 0;
  while (t < secs) { const d = rng.range(0.14, 0.3); syl.push([t, helloGen({ dur: d, f0: rng.range(150, 175), rise: rng.range(0.85, 1.12), amp: dBm0(-18), seed: rng.u32() })]); t += d + rng.range(0.02, 0.12); }
  let i = 0, k = 0, cur = null;
  return { next() { const ts = i / FS; while (k < syl.length && syl[k][0] <= ts) cur = syl[k++][1]; i++; return cur ? cur.next() : 0; } };
}

// ------------------------------------------------------------------ the house phone's bell (room sound, incoming calls)
export function ringerGen(pattern) {
  const per = pattern.reduce((a, b) => a + b, 0) * FS; let n = 0;
  const modes = [[1046, 0.0028], [1310, 0.0024], [2740, 0.0012], [3360, 0.0009]].map(([f, d]) => ({ r: new Reson(f, 1 / (Math.PI * 0.18 * (1 + d * 100))), f }));
  const strikeEvery = Math.round(FS / 20);  // 20 Hz ringing current: hammer hits the gongs alternately
  return { next() {
    const t = n % per; let acc = 0, on = false;
    for (let i = 0; i < pattern.length; i++) { if (t < acc + pattern[i] * FS) { on = (i & 1) === 0; break; } acc += pattern[i] * FS; }
    let x = 0; if (on && t % strikeEvery === 0) x = 1;
    const side = Math.floor(t / strikeEvery) & 1;
    let y = 0; for (let k = 0; k < modes.length; k++) y += modes[k].r.run((k & 1) === side ? x : x * 0.3);
    n++; return y * 0.9;
  } };
}

// ------------------------------------------------------------------ async/HDLC data pump
/**
 * Feeds bits to a modulator. 'async': start/stop framed characters, idle marks. 'hdlc': LAPM-like frames
 * with zero-bit stuffing and flag fill. onByte(byte) fires when a byte has been put on the line.
 */
export class DataPump {
  constructor(mode = 'async', onByte = null) { this.mode = mode; this.q = []; this.bits = []; this.bi = 0; this.onByte = onByte; this.pend = []; this.frameNo = 0; this.flagI = 0; }
  push(bytes) { for (const b of bytes) this.q.push(b & 255); }
  get idle() { return this.q.length === 0 && this.bi >= this.bits.length; }
  _load() {
    this.bits = []; this.bi = 0; this.pend = [];
    if (this.mode === 'async') {
      if (this.q.length) { const b = this.q.shift(); this.bits = asyncBits(b); this.pend = [b]; }
    } else if (this.q.length) {
      const pay = this.q.splice(0, 32);
      this.bits = [...FLAG_BITS, ...hdlcBits([0x03, (this.frameNo++ << 1) & 0xfe, ...pay]), ...FLAG_BITS]; this.pend = pay;
    }
  }
  bit() {
    if (this.bi >= this.bits.length) {
      if (this.pend.length && this.onByte) for (const b of this.pend) this.onByte(b);
      this.pend = []; this._load();
      if (!this.bits.length) { if (this.mode === 'async') return 1; const b = FLAG_BITS[this.flagI]; this.flagI = (this.flagI + 1) & 7; return b; }
    }
    return this.bits[this.bi++];
  }
}
export { Scrambler, cycleBits, DiffQPSK, V22bisQAM, GridQAM, Rng };
