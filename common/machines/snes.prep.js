/*
 * SNES prep (main thread): build the per-song "SPC RAM image" from GeneralUser GS.
 *
 * Like a game's sound programmer, it takes the instruments in use (table indices `used`; without them,
 * the presets the song's GM programs/drums map to), keeps one to three
 * samples per instrument (sparse key splits), resamples them, cuts attacks, replaces long loops with
 * a few pitch periods aligned to 16-sample BRR blocks, folds the discarded natural decay into the
 * hardware ADSR, BRR-encodes them and fits all of it into the 64 KB audio RAM:
 *
 *   $0000-$1BFF  driver code / sequence data (reserved)       $1C00-$1FFF  sample directory (DIR=$1C)
 *   $2000-ESA    BRR samples                                   ESA-$FFFF    echo buffer (EDL × 2 KB)
 *
 * When everything doesn't fit it squeezes progressively harder: lower rates, shorter attacks and
 * loops, fewer key splits, and finally a shorter echo buffer. That per-song squeeze is the sound.
 */
import { parseSF2, toWorkletBank } from '../sf2.js';
import { brrEncode, brrDecode } from './snes-brr.js';
import { PRESETS, gmPreset, gmDrum } from './snes-presets.js';
import { RATE_PERIOD } from './snes-dsp.js';

const DIR_ADDR = 0x1C00, SAMPLE_BASE = 0x2000;
const MAX_SAMPLES = 256;

// squeeze ladder: [rate Hz, attack kept (s), loop target (s), one-shot length (s)]
const LEVELS = [
  [32000, 0.30, 0.050, 0.80],
  [32000, 0.20, 0.030, 0.55],
  [28000, 0.15, 0.022, 0.45],
  [24000, 0.12, 0.016, 0.36],
  [20000, 0.09, 0.012, 0.28],
  [16000, 0.07, 0.009, 0.22],
  [14000, 0.055, 0.007, 0.17],
  [12000, 0.045, 0.005, 0.14],
  [10000, 0.035, 0.004, 0.11],
  [8000, 0.025, 0.003, 0.09],
  [8000, 0.016, 0.002, 0.07],
  [6000, 0.010, 0.001, 0.05],
];
const LMAX = LEVELS.length - 1;
const STAGES = [
  { K: 3, edl: 5, maxL: 4 }, { K: 2, edl: 5, maxL: 6 }, { K: 2, edl: 4, maxL: 7 }, { K: 1, edl: 4, maxL: 8 },
  { K: 1, edl: 3, maxL: 9 }, { K: 1, edl: 2, maxL: 10 }, { K: 1, edl: 1, maxL: LMAX }, { K: 1, edl: 0, maxL: LMAX },
];


const loopTime = (P) => (P.loop ? (P.pad + P.att) / P.rate : 0);
const tc2s = (tc) => (tc <= -12000 ? 0 : Math.pow(2, tc / 1200));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---------------------------------------------------------------- envelope mapping
const EXP_DB_PER_TICK = 20 * Math.log10(256 / 255);         // exponential mode: env −= env/256 per tick
const expRate = (dbps) => {                                    // rate index giving ≈ dbps (exp decrease)
  if (dbps <= 0.2) return 0;
  const period = EXP_DB_PER_TICK * 32000 / dbps;
  let best = 1, be = Infinity;
  for (let r = 1; r < 32; r++) { const e = Math.abs(Math.log(RATE_PERIOD[r] / period)); if (e < be) { be = e; best = r; } }
  return best;
};
const attackTime = (ar) => (ar === 15 ? 2 / 32000 : 64 * RATE_PERIOD[2 * ar + 1] / 32000);

/** SF2 volume envelope (+ natural decay, dB/s) → ADSR1, ADSR2, release GAIN (used to derive the preset defaults). */
export function mapEnv1(g, natural, maxAttack = 10) {
  const A = Math.min(tc2s(g[34]), maxAttack);
  let ar = 15;
  if (A > 0.004) { let be = Infinity; for (let a = 0; a < 16; a++) { const e = Math.abs(Math.log(attackTime(a) / A)); if (e < be) { be = e; ar = a; } } }
  const D = tc2s(g[36]), S = clamp(g[37], 0, 1000) / 10;      // S = sustain attenuation in dB
  const ddb = D > 0.001 ? 100 / D : 2000;
  let dr = 7, sl = 7, sr = 0;
  if (S >= 60) {                                               // percussive: decays toward silence
    sl = 7; sr = expRate(ddb + natural);
    if (sr === 0 && natural + ddb > 0.05) sr = 1;
  } else {
    if (S > 0.5) {
      sl = clamp(Math.round(8 * Math.pow(10, -S / 20)) - 1, 0, 7);
      // decay rates are 16 + 2·DR
      let be = Infinity;
      for (let d = 0; d < 8; d++) { const e = Math.abs(Math.log(RATE_PERIOD[16 + 2 * d] / (EXP_DB_PER_TICK * 32000 / ddb))); if (e < be) { be = e; dr = d; } }
    }
    sr = expRate(natural);
  }
  const R = Math.max(0.001, tc2s(g[38]));
  const rdb = 100 / R;
  const rel = rdb > 330 ? 0 : 0xA0 | Math.max(1, expRate(rdb));   // 0 → plain KOFF (8 ms linear release)
  return { adsr1: 0x80 | (dr << 4) | ar, adsr2: (sl << 5) | sr, rel };
}

// ---------------------------------------------------------------- zone choice
export function pickZone(zones, key, vel = 100) {
  if (!zones || !zones.length) return null;
  let c = zones.filter(z => z.kl <= key && key <= z.kh && z.vl <= vel && vel <= z.vh);
  if (!c.length) c = zones.filter(z => z.kl <= key && key <= z.kh);
  if (!c.length) {
    let bd = Infinity;
    for (const z of zones) { const d = key < z.kl ? z.kl - key : key - z.kh; if (d < bd) { bd = d; c = [z]; } }
  }
  const mono = c.filter(z => !(z.type & 2));
  if (mono.length) c = mono;
  c.sort((a, b) => a.g[48] - b.g[48]);
  return c[0];
}
/** SF2 filter cutoff (cents) as heard ~0.3 s into a velocity-100 note: initial fc + mod envelope + velocity mods */
function effectiveFc(z) {
  const g = z.g;
  let fc = g[8];
  if (g[11]) {
    const modD = Math.max(0.001, tc2s(g[28])), drop = clamp(g[29], 0, 1000) / 1000;
    fc += g[11] * (1 - drop * Math.min(1, 0.3 / modD));
  }
  for (const m of z.mods) {
    if (m[1] !== 8 || m[3] !== 0 || (m[0] & 0xFF) !== 2) continue;    // velocity → fc, no secondary source
    const x = m[0] & 0x100 ? 1 - 100 / 127 : 100 / 127;
    fc += m[2] * x;
  }
  return fc;
}
// actual pitch (MIDI note, fractional) a zone is tuned to
const zoneRoot = (z) => z.root - (z.g[51] * 100 + z.g[52] - z.corr) / 100;

// ---------------------------------------------------------------- sample analysis
function analyse(s, pool) {
  if (s.env) return;
  const w = Math.max(16, Math.round(s.sr * 0.01));
  const n = Math.floor((s.end - s.start) / w);
  const E = new Float32Array(Math.max(1, n));
  let pk = -Infinity, pki = 0;
  for (let k = 0; k < n; k++) {
    let q = 0; const a = s.start + k * w;
    for (let i = a; i < a + w; i++) q += pool[i] * pool[i];
    E[k] = 10 * Math.log10(q / w + 1);
    if (E[k] > pk) { pk = E[k]; pki = k; }
  }
  s.env = E; s.win = w; s.peakFrac = n ? pki / n : 0; s.peakIdx = s.start + pki * w;
  // brightness: zero-crossing rate over the first 150 ms → minimum useful sample rate
  let zc = 0, prev = 0;
  const zEnd = Math.min(s.end, s.start + Math.round(0.15 * s.sr)), thr = 64;
  for (let i = s.start; i < zEnd; i++) { const x = pool[i]; const sg = x > thr ? 1 : x < -thr ? -1 : 0; if (sg && prev && sg !== prev) zc++; if (sg) prev = sg; }
  s.bright = clamp(0.8 * zc / Math.max(1e-3, (zEnd - s.start) / s.sr), 0, 20000);
  // time at which the sound has reached (peak − 6 dB) within its first second / before the loop
  const lim = Math.min(n, Math.ceil(((s.looped ? s.ls : s.end) - s.start) / w), Math.ceil(s.sr / w));
  let p2 = -Infinity; for (let k = 0; k < lim; k++) if (E[k] > p2) p2 = E[k];
  let reach = 0; for (let k = 0; k < lim; k++) if (E[k] >= p2 - 6) { reach = k; break; }
  s.reachT = (reach + 2) * w / s.sr;
}
/** natural decay (dB/s) of the source between two sample indices */
function decayRate(s, iFrom, iTo) {
  const E = s.env, w = s.win;
  const k0 = Math.floor((iFrom - s.start) / w), k1 = Math.min(E.length - 1, Math.floor((iTo - s.start) / w) - 1);
  if (k1 - k0 < 4) return 0;
  const ref = Math.max(E[k0], E[k0 + 1], E[k0 + 2]);
  for (let k = k0 + 3; k <= k1; k++) if (E[k] < ref - 20) return clamp(20 / ((k - k0) * w / s.sr), 0, 200);
  const last = (E[k1] + E[k1 - 1] + E[k1 - 2]) / 3;
  return clamp((ref - last) / ((k1 - k0) * w / s.sr), 0, 200);
}

// ---------------------------------------------------------------- layout planning (cheap, no audio)
function plan(s, L) {
  const [rateL, attT, loop0, shot0] = LEVELS[L];
  // per-instrument budget hints cap the ladder (max rate, max loop, max one-shot length)
  const loopT = Math.min(loop0, s.capLoop);
  const shotT = Math.min(s.drum ? Math.max(shot0, 0.12) : shot0, s.capLen);   // short percussion keeps its body
  const sr = s.sr;
  const rate0 = Math.max(2000, Math.min(Math.max(rateL, (s.bright || 0) * (1 - 0.5 * L / LMAX)), 32000, s.rateCap, s.capRate, sr));
  const P = { L, rate: rate0, pad: 0, att: 0, loop: 0, shot: 0, mode: 'shot', srcLoop: 0, unit: 0, q: 0, natural: 0, fade: 0 };
  const chooseLoop = (unit, target, origUnit) => {
    let best = null, bs = Infinity;
    for (let q = 1; q <= 96; q++) {
      const dur = q * unit;
      if (q > 1 && dur > Math.max(target * 2, unit)) break;
      let m = Math.max(1, Math.round(dur * rate0 / 16)), r = 16 * m / dur;
      if (r > 32000) { m = Math.floor(dur * 32000 / 16); if (m < 1) continue; r = 16 * m / dur; }
      if (r > s.rateCap * 1.02 && m > 1) { m = Math.max(1, Math.floor(dur * s.rateCap / 16)); r = 16 * m / dur; }
      const score = Math.abs(Math.log2(r / rate0)) * 3 + Math.abs(Math.log2(dur / target)) + (origUnit ? 0 : 0.01 * q);
      if (score < bs) { bs = score; best = { q, m, r, dur }; }
    }
    return best;
  };
  if (s.looped) {
    const attSrc = s.ls - s.start, loopSrc = s.le - s.ls;
    const cutT = Math.max(attT, s.reachT || 0);
    const keepAttack = attSrc / sr <= cutT + 0.02;
    // keep the original loop when it is already short; otherwise loop a few pitch periods
    const orig = keepAttack && loopSrc / sr <= Math.max(loopT * 1.3, 32 / rate0);
    const unit = orig ? loopSrc / sr : 1 / s.f0;
    const lp = chooseLoop(unit, orig ? unit : loopT, orig);
    P.rate = lp.r; P.loop = 16 * lp.m; P.q = lp.q; P.unit = unit; P.mode = orig ? 'orig' : 'period';
    if (keepAttack) P.srcLoop = s.ls;
    else {
      // long attack: keep the first cutT seconds and loop the periods just before the cut
      const cut = s.start + cutT * sr;
      P.srcLoop = Math.max(s.start, cut - lp.dur * sr);
      P.natural = decayRate(s, cut, s.ls);
    }
    const attOut = Math.round((P.srcLoop - s.start) * P.rate / sr);
    P.pad = (16 - (attOut % 16)) % 16;
    P.att = attOut;
    P.total = P.pad + P.att + P.loop;
    P.blocks = P.total / 16;
  } else {
    const lenT = (s.end - s.start) / sr;
    if (lenT <= shotT * 1.25) {
      P.shot = Math.ceil(lenT * rate0);
    } else if (s.tailLoop) {
      // decaying one-shot: keep the hit, then loop a short piece and let the ADSR do the decay
      const cutT = Math.max(shotT * 0.6, s.reachT || 0, attT);
      const unit = s.pitched ? 1 / s.f0 : Math.max(16 / rate0, loopT * 2);
      const lp = chooseLoop(unit, s.pitched ? loopT : Math.max(loopT * 4, 0.004), false);
      P.rate = lp.r; P.loop = 16 * lp.m; P.q = lp.q; P.unit = unit; P.mode = 'tail';
      const cut = s.start + cutT * sr;
      P.srcLoop = Math.max(s.start, cut - lp.dur * sr);
      P.natural = Math.max(3, decayRate(s, cut, s.end));
      const attOut = Math.round((P.srcLoop - s.start) * P.rate / sr);
      P.pad = (16 - (attOut % 16)) % 16; P.att = attOut;
      P.total = P.pad + P.att + P.loop; P.blocks = P.total / 16;
      return P;
    } else {
      P.shot = Math.ceil(shotT * rate0); P.fade = Math.round(P.shot * 0.25);
      if (s.peakFrac > 0.5) {               // swell (reverse cymbal, risers): keep the end, not the quiet start
        P.off = Math.max(0, s.peakIdx + 0.05 * sr - shotT * sr - s.start);
        P.fadeIn = Math.round(0.006 * rate0);
      }
    }
    P.total = Math.ceil(P.shot / 16) * 16;
    P.blocks = P.total / 16 + 1;
  }
  return P;
}

// ---------------------------------------------------------------- rendering
const KT = 8, KRES = 256;
const KERNEL = (() => {
  const k = new Float32Array(KT * KRES + 2);
  for (let i = 0; i <= KT * KRES + 1; i++) {
    const u = i / KRES, a = Math.PI * u * 0.9;
    k[i] = u > KT ? 0 : (u === 0 ? 1 : Math.sin(a) / a) * (0.5 + 0.5 * Math.cos(Math.PI * u / KT));
  }
  return k;
})();
/** band-limited read of the source at fractional index t; rho = output/input rate */
function readAt(pool, s, t, rho, periodic) {
  const sc = Math.min(1, rho), W = KT / sc;
  const i0 = Math.ceil(t - W), i1 = Math.floor(t + W);
  const L = s.le - s.ls;
  let acc = 0, ws = 0;
  for (let i = i0; i <= i1; i++) {
    const u = Math.abs(i - t) * sc * KRES, ui = u | 0;
    const w = KERNEL[ui] + (KERNEL[ui + 1] - KERNEL[ui]) * (u - ui);
    let j = i;
    if (periodic && j >= s.le) j = s.ls + ((j - s.ls) % L);
    if (j >= s.start && j < s.end) acc += pool[j] * w;
    ws += w;
  }
  return ws > 0 ? acc / ws : 0;
}
function biquadLP(x, a, b, fc, rate, q, st) {
  const w0 = 2 * Math.PI * fc / rate, al = Math.sin(w0) / (2 * q), c = Math.cos(w0), a0 = 1 + al;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  for (let i = a; i < b; i++) {
    const y = b0 * x[i] + b1 * st[0] + b2 * st[1] - a1 * st[2] - a2 * st[3];
    st[1] = st[0]; st[0] = x[i]; st[3] = st[2]; st[2] = y; x[i] = y;
  }
}

function renderSample(s, P, pool) {
  const out = new Float32Array(P.total);
  const step = s.sr / P.rate, rho = P.rate / s.sr;
  if (P.loop) {
    const ls2 = P.pad + P.att;
    const periodic = P.mode === 'orig';
    for (let j = P.pad; j < P.total; j++) out[j] = readAt(pool, s, P.srcLoop + (j - ls2) * step, rho, periodic && j >= ls2);
    if (!periodic) {
      // bake a crossfade so loop end → loop start is seamless
      const X = Math.min(P.loop >> 1, ls2 - P.pad);
      for (let i = 0; i < X; i++) {
        const w = (i + 1) / (X + 1), j = ls2 + P.loop - X + i;
        out[j] = out[j] * (1 - w) + out[ls2 - X + i] * w;
      }
    }
  } else {
    const off = s.start + (P.off || 0);
    for (let j = 0; j < P.shot; j++) out[j] = readAt(pool, s, off + j * step, rho, false);
    if (P.fade) for (let i = 0; i < P.fade; i++) out[P.shot - P.fade + i] *= 1 - (i + 1) / P.fade;
    if (P.fadeIn) for (let i = 0; i < P.fadeIn; i++) out[i] *= i / P.fadeIn;
  }
  // SF2 initial low-pass baked in (the S-DSP has no filter)
  if (s.fc && s.fc < 0.45 * P.rate) {
    const st = new Float64Array(4), q = s.fq;
    if (P.loop) {
      const ls2 = P.pad + P.att;
      biquadLP(out, 0, ls2, s.fc, P.rate, q, st);
      const tmp = out.slice(ls2, P.total);
      for (let pass = 0; pass < 3; pass++) { const c = tmp.slice(); biquadLP(c, 0, c.length, s.fc, P.rate, q, st); if (pass === 2) out.set(c, ls2); }
    } else biquadLP(out, 0, P.total, s.fc, P.rate, q, st);
  }
  let pk = 1;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > pk) pk = a; }
  const k = Math.min(16, 26000 / pk);
  // loudness lost to the lower rate / filtering (e.g. hats at 8 kHz): compensate about half of it in dB,
  // as a sound designer would by turning the instrument up
  const ta = Math.min(0.12, (P.total - P.pad) / P.rate);
  let so = 0, ss = 0;
  const no = Math.max(1, Math.round(ta * P.rate)), ns = Math.max(1, Math.round(ta * s.sr)), o0 = s.start + (P.off || 0);
  for (let i = 0; i < no; i++) { const x = out[P.pad + i] || 0; so += x * x; }
  for (let i = 0; i < ns && o0 + i < s.end; i++) ss += pool[o0 + i] * pool[o0 + i];
  const lost = Math.sqrt((ss / ns + 1) / (so / no + 1));
  const comp = clamp(Math.pow(lost, 0.7), 1, 6);
  const pcm = new Int16Array(P.total);
  for (let i = 0; i < out.length; i++) pcm[i] = Math.round(out[i] * k);
  return { pcm, gain: pk / 26000 * comp, loopBlock: P.loop ? (P.pad + P.att) >> 4 : -1 };
}

// ---------------------------------------------------------------- main
let SF = null;                         // parsed GeneralUser GS, kept across preps (the app re-preps often)
let CACHE = { key: null, data: null };
/** Last prep, for the editor: per instrument name → squeezed sample info + decoded BRR preview. */
export const prepView = { byName: {}, info: null, seq: 0 };
export const prepEvents = typeof EventTarget !== 'undefined' ? new EventTarget() : null;

const sampleParams = (x) => x && [x.src && x.src.bank, x.src && x.src.prog, x.src && x.src.key, x.src && x.src.vel, x.splits, !!x.fixed, x.rate, x.loop, x.len, !!x.noise];

function defaultUsed(table, song) {
  const used = new Set();
  if (!song) { table.forEach((_, i) => used.add(i)); return [...used]; }
  for (const p of song.programs || []) { const i = gmPreset(p); if (i >= 0) used.add(i); }
  if (song.drums) for (let n = 27; n <= 87; n++) { const i = gmDrum(n); if (i >= 0) used.add(i); }
  return [...used];
}
const cloneData = (d) => ({ ...d, ram: d.ram.slice() });

export async function prepare({ fetchSF2, song, instruments, used }) {
  const t0 = Date.now();
  const table = instruments && instruments.length ? instruments : PRESETS;
  let use = (used && used.length ? used : defaultUsed(table, song)).filter(i => i >= 0 && i < table.length && table[i]);
  use = [...new Set(use)].sort((a, b) => a - b);
  const key = JSON.stringify(use.map(i => [i, sampleParams(table[i])]));
  if (CACHE.key === key) return cloneData(CACHE.data);    // only voice params changed: same RAM image
  if (!SF) SF = toWorkletBank(parseSF2(await fetchSF2()));
  const sf = SF, pool = sf.pool;
  const kit = sf.presets[128 * 128] || [];
  const nMel = use.filter(i => !table[i].noise && table[i].src.bank < 128 && !table[i].fixed).length;
  const Kmax = nMel <= 6 ? 3 : nMel <= 14 ? 2 : 1;

  const sampleMap = new Map();
  const getSample = (z, drum, kind) => {
    const fcC = effectiveFc(z);
    const fc = fcC < 13400 ? Math.max(400, 8.176 * Math.pow(2, fcC / 1200)) : 0;
    const looped = (z.g[54] & 1) === 1 && z.le > z.ls + 8 && z.ls >= z.start && z.le <= z.end;
    const k = `${z.start}:${z.end}:${looped ? z.ls + ':' + z.le : '-'}:${Math.round(fc)}`;
    let s = sampleMap.get(k);
    if (!s) {
      const f0 = 440 * Math.pow(2, (z.root + z.corr / 100 - 69) / 12);
      s = { key: k, start: z.start, end: z.end, ls: z.ls, le: z.le, sr: z.sr, looped, f0: clamp(f0, 20, 8000), fc, fq: Math.max(0.707, Math.pow(10, z.g[9] / 200)),
        drum, pitched: !drum, tailLoop: false, rateCap: 32000, capRate: 32000, capLoop: 1, capLen: 10, lvl: 0, users: [] };
      analyse(s, pool);
      s.tailLoop = !looped && s.peakFrac < 0.3 && (!drum || /crash|ride|hatOpen|bell|triangle|cowbell/.test(kind || ''));
      sampleMap.set(k, s);
    }
    return s;
  };
  // SF2 pitch (cents relative to the source rate) of a zone played at note n
  const centsOf = (z, n) => (n - z.root) * z.g[56] + z.g[51] * 100 + z.g[52] - z.corr;

  const build = (Kst) => {
    sampleMap.forEach(s => { s.rateCap = 32000; s.capRate = 32000; s.capLoop = 1; s.capLen = 10; s.used = false; });
    const insts = new Array(table.length).fill(null);
    for (const idx of use) {
      const ins = table[idx], src = ins.src || { bank: 0, prog: 0, key: 60, vel: 100 };
      if (ins.noise) { insts[idx] = { noise: true, splits: [] }; continue; }
      const drumBank = src.bank >= 128;
      const zones = drumBank ? kit.filter(z => z.kl <= src.key && src.key <= z.kh) : (sf.presets[src.prog & 127] || sf.presets[0]);
      const key = clamp(src.key | 0, 0, 127), vel = clamp(src.vel || 100, 1, 127);
      const K = ins.fixed || drumBank ? 1 : clamp(Math.min(ins.splits || 1, Kst, Kmax), 1, 3);
      const centers = K === 1 ? [key] : K === 2 ? [key - 9, key + 12] : [key - 16, key, key + 16];
      const sp = [];
      for (const ce of centers) {
        const z = pickZone(zones.length ? zones : kit, ce, vel); if (!z) continue;
        if (sp.length && sp[sp.length - 1].z === z) continue;
        sp.push({ z, ce });
      }
      insts[idx] = { splits: sp.map((x, i) => {
        const hi = i === sp.length - 1 ? 127 : Math.floor((x.ce + sp[i + 1].ce) / 2);
        const s = getSample(x.z, drumBank, drumKindName(key)); s.used = true; s.users.push(ins.name);
        const top = ins.fixed ? key : Math.min(hi, 108, Math.round(zoneRoot(x.z)) + 30);
        s.rateCap = Math.min(s.rateCap, Math.max(4000, 128000 / Math.pow(2, centsOf(x.z, top) / 1200)));
        s.capRate = Math.min(s.capRate, clamp(ins.rate || 32000, 2000, 32000));
        s.capLoop = Math.min(s.capLoop, clamp((ins.loop || 50) / 1000, 0.0005, 1));
        s.capLen = Math.min(s.capLen, clamp((ins.len || 800) / 1000, 0.02, 10));
        return { z: x.z, s, hi };
      }) };
    }
    const samples = [...sampleMap.values()].filter(s => s.used);
    return { insts, samples };
  };

  // ---- squeeze until it fits ----
  let chosen = null;
  for (const st of STAGES) {
    const b = build(st.K);
    if (b.samples.length > MAX_SAMPLES - 1) continue;
    const budget = (st.edl ? 0x10000 - st.edl * 0x800 : 0xFF00) - SAMPLE_BASE - 9;
    for (const s of b.samples) { s.lvl = 0; s.P = plan(s, 0); }
    let total = b.samples.reduce((a, s) => a + s.P.blocks * 9, 0);
    while (total > budget) {
      let big = null;
      for (const s of b.samples) if (s.lvl < st.maxL && (!big || s.P.blocks > big.P.blocks)) big = s;
      if (!big) break;
      total -= big.P.blocks * 9; big.lvl++; big.P = plan(big, big.lvl); total += big.P.blocks * 9;
    }
    chosen = { ...b, st, budget, total };
    if (total <= budget) break;
  }

  // ---- render, encode, lay out RAM ----
  const ram = new Uint8Array(0x10000);
  const sig = 'RetroSynths SNES sound driver (GM) - RAM image built from GeneralUser GS';
  for (let i = 0; i < sig.length; i++) ram[0x200 + i] = sig.charCodeAt(i);
  const { insts, samples, st } = chosen;
  const edl = st.edl, esa = edl ? (0x10000 - edl * 0x800) >> 8 : 0xFF;
  // srcn 0: one silent looping block (noise instruments still need a running BRR stream)
  ram[SAMPLE_BASE] = 0x03;
  ram[DIR_ADDR] = SAMPLE_BASE & 0xFF; ram[DIR_ADDR + 1] = SAMPLE_BASE >> 8; ram[DIR_ADDR + 2] = SAMPLE_BASE & 0xFF; ram[DIR_ADDR + 3] = SAMPLE_BASE >> 8;
  let addr = SAMPLE_BASE + 9;
  const view = {};
  samples.forEach((s, i) => {
    const r = renderSample(s, s.P, pool);
    const brr = brrEncode(r.pcm, r.loopBlock);
    if (addr + brr.length > esa << 8) { s.srcn = -1; return; }
    ram.set(brr, addr);
    const n = i + 1, loopAddr = r.loopBlock >= 0 ? addr + r.loopBlock * 9 : addr;
    const d = DIR_ADDR + n * 4;
    ram[d] = addr & 0xFF; ram[d + 1] = addr >> 8; ram[d + 2] = loopAddr & 0xFF; ram[d + 3] = loopAddr >> 8;
    s.srcn = n; s.addr = addr; s.bytes = brr.length; s.gain = r.gain;
    s.view = { rate: Math.round(s.P.rate), samples: s.P.total, bytes: brr.length, addr, loopStart: s.P.loop ? s.P.pad + s.P.att : -1, loopLen: s.P.loop,
      level: s.lvl, levels: LMAX, mode: s.P.mode, pcm: brrDecode(brr), shared: s.users.length };
    addr += brr.length;
  });
  const atten = (z) => Math.pow(10, -0.4 * z.g[48] / 200);
  const out = insts.map((I, idx) => {
    if (!I) return null;
    if (I.noise) return { noise: true, splits: [{ hi: 127, srcn: 0, zroot: 60, scale: 100, off: 0, base: 4096, gain: 0.6, natural: 0, loopT: 0 }] };
    const splits = I.splits.filter(x => x.s.srcn >= 0).map(x => ({
      hi: x.hi, srcn: x.s.srcn, zroot: x.z.root, scale: x.z.g[56], off: x.z.g[51] * 100 + x.z.g[52] - x.z.corr,
      base: 4096 * x.s.P.rate / 32000, gain: x.s.gain * atten(x.z), natural: x.s.P.natural, loopT: loopTime(x.s.P),
    }));
    view[table[idx].name] = { splits: I.splits.map(x => ({ hi: x.hi, ...(x.s.view || {}) })) };
    return splits.length ? { splits } : null;
  });
  const info = {
    samples: samples.length, bytes: addr - SAMPLE_BASE, budget: chosen.budget, edl, echoBytes: edl * 2048, instruments: use.length,
    meanRate: Math.round(samples.reduce((a, s) => a + s.P.rate, 0) / Math.max(1, samples.length)),
    maxLevel: Math.max(0, ...samples.map(s => s.lvl)), ms: Date.now() - t0,
  };
  for (const i of use) if (table[i].noise) view[table[i].name] = { noise: true };
  prepView.byName = view; prepView.info = info; prepView.seq++;
  if (prepEvents) try { prepEvents.dispatchEvent(new Event('prep')); } catch {}
  const data = { key, ram, dir: DIR_ADDR >> 8, esa, edl, insts: out, info };
  CACHE = { key, data: cloneData(data) };
  return data;
}
export const transfer = (data) => (data && data.ram ? [data.ram.buffer] : []);

function drumKindName(n) {
  if (n === 49 || n === 52 || n === 55 || n === 57) return 'crash';
  if (n === 51 || n === 59 || n === 53) return 'ride';
  if (n === 46) return 'hatOpen';
  if (n === 80 || n === 81) return 'triangle';
  if (n === 56) return 'cowbell';
  if (n === 58) return 'bell';
  return 'perc';
}
