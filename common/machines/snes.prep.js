/*
 * SNES prep (main thread): build the per-song "SPC RAM image" from GeneralUser GS.
 *
 * Like a game's sound programmer, it picks the instruments the song uses, keeps one to three
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
import { brrEncode } from './snes-brr.js';
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

// GM programs prepared for live play (no song): one or two per family; the rest fall back by family.
const LIVE_SET = [0, 2, 4, 6, 8, 11, 12, 16, 19, 21, 24, 25, 27, 29, 30, 32, 33, 35, 38, 40, 42, 45, 46, 47, 48, 50,
  52, 55, 56, 57, 60, 61, 62, 65, 66, 68, 71, 73, 75, 78, 80, 81, 84, 87, 88, 89, 91, 95, 98, 100, 104, 105, 108, 114, 115, 117, 118, 122, 127];
// key-split centre per family (piano, chromatic, organ, guitar, bass, strings, ensemble, brass,
// reed, pipe, lead, pad, fx, ethnic, percussive, sfx)
const FAM_CENTER = [60, 72, 60, 57, 40, 62, 62, 60, 64, 74, 67, 60, 64, 64, 60, 60];

const maxAtt = (P) => (P.loop ? 10 : 0.3 * P.shot / P.rate);
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

/**
 * SF2 volume envelope → ADSR1, ADSR2, release GAIN. The natural decay of a truncated sample (dB/s)
 * is folded into a second ADSR2 that the driver writes at the moment playback reaches the loop
 * (swTicks, 60 Hz frames) — before that point the sample itself still carries its own decay.
 */
function mapEnvelope(g, natural, loopTime, maxAttack) {
  const a = mapEnv1(g, 0, maxAttack), b = natural > 0.2 ? mapEnv1(g, natural, maxAttack) : a;
  return { adsr1: a.adsr1, adsr2: a.adsr2, rel: a.rel, adsr2b: b.adsr2, swTicks: b.adsr2 !== a.adsr2 ? Math.max(1, Math.round(loopTime * 60)) : 0 };
}
function mapEnv1(g, natural, maxAttack = 10) {
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
function pickZone(zones, key, vel = 100) {
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
  const [rateL, attT, loopT, shot0] = LEVELS[L];
  const shotT = s.drum ? Math.max(shot0, 0.12) : shot0;     // short percussion keeps its body
  const sr = s.sr;
  const rate0 = Math.max(2000, Math.min(Math.max(rateL, (s.bright || 0) * (1 - 0.5 * L / LMAX)), 32000, s.rateCap, sr));
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
export async function prepare({ fetchSF2, song }) {
  const t0 = Date.now();
  const sf = toWorkletBank(parseSF2(await fetchSF2()));
  const pool = sf.pool;
  const wanted = song ? [...new Set(song.programs || [])].filter(p => p >= 0 && p < 128).sort((a, b) => a - b) : LIVE_SET;
  const wantDrums = song ? !!song.drums : true;
  const kit = sf.presets[128 * 128] || [];
  const nProg = wanted.length;
  const Kmax = nProg <= 6 ? 3 : nProg <= 14 ? 2 : 1;

  const sampleMap = new Map();
  const getSample = (z, drum, kind) => {
    const fcC = effectiveFc(z);
    const fc = fcC < 13400 ? Math.max(400, 8.176 * Math.pow(2, fcC / 1200)) : 0;
    const looped = (z.g[54] & 1) === 1 && z.le > z.ls + 8 && z.ls >= z.start && z.le <= z.end;
    const key = `${z.start}:${z.end}:${looped ? z.ls + ':' + z.le : '-'}:${Math.round(fc)}`;
    let s = sampleMap.get(key);
    if (!s) {
      const f0 = 440 * Math.pow(2, (z.root + z.corr / 100 - 69) / 12);
      s = { key, start: z.start, end: z.end, ls: z.ls, le: z.le, sr: z.sr, looped, f0: clamp(f0, 20, 8000), fc, fq: Math.max(0.707, Math.pow(10, z.g[9] / 200)),
        drum, pitched: !drum, tailLoop: false, rateCap: 32000, lvl: 0 };
      analyse(s, pool);
      s.tailLoop = !looped && s.peakFrac < 0.3 && (!drum || /crash|ride|hatOpen|bell|triangle|cowbell/.test(kind || ''));
      sampleMap.set(key, s);
    }
    return s;
  };

  // build instruments for K splits; returns { progs, drums, samples }
  const build = (K) => {
    sampleMap.forEach(s => { s.rateCap = 32000; s.used = false; });
    const progs = new Array(128).fill(null), drums = new Array(128).fill(null);
    for (const p of wanted) {
      const zones = sf.presets[p] || sf.presets[0];
      const c = FAM_CENTER[p >> 3];
      const centers = K === 1 ? [c] : K === 2 ? [c - 9, c + 12] : [c - 16, c, c + 16];
      const splits = [];
      for (const ce of centers) {
        const z = pickZone(zones, ce); if (!z) continue;
        if (splits.length && splits[splits.length - 1].z === z) continue;
        splits.push({ z, ce });
      }
      progs[p] = splits.map((sp, i) => {
        const hi = i === splits.length - 1 ? 127 : Math.floor((sp.ce + splits[i + 1].ce) / 2);
        const s = getSample(sp.z, false); s.used = true;
        const root = zoneRoot(sp.z);
        const up = Math.min(Math.max(0, Math.min(hi, 108) - root), 30);
        s.rateCap = Math.min(s.rateCap, Math.max(4000, 128000 / Math.pow(2, up / 12)));
        return { z: sp.z, s, hi, root, scale: sp.z.g[56] / 100 };
      });
    }
    if (wantDrums) {
      for (let n = 35; n <= 81; n++) {
        const z = pickZone(kit.filter(zz => zz.kl <= n && n <= zz.kh), n);
        if (!z) continue;
        const kind = drumKindName(n);
        const s = getSample(z, true, kind); s.used = true;
        const cents = (n - z.root) * z.g[56] + z.g[51] * 100 + z.g[52] - z.corr;
        const ratio = Math.pow(2, cents / 1200);              // playback ratio relative to the source rate
        s.rateCap = Math.min(s.rateCap, Math.max(4000, 0x3FFF * 32000 / 4096 / ratio));
        drums[n] = { z, s, ratio };
      }
    }
    const samples = [...sampleMap.values()].filter(s => s.used);
    return { progs, drums, samples };
  };

  // ---- squeeze until it fits ----
  let chosen = null;
  for (const st of STAGES) {
    const K = Math.min(st.K, Kmax);
    const b = build(K);
    if (b.samples.length > MAX_SAMPLES) continue;
    const budget = (st.edl ? 0x10000 - st.edl * 0x800 : 0xFF00) - SAMPLE_BASE;
    for (const s of b.samples) { s.lvl = 0; s.P = plan(s, 0); }
    let total = b.samples.reduce((a, s) => a + s.P.blocks * 9, 0);
    while (total > budget) {
      let big = null;
      for (const s of b.samples) if (s.lvl < st.maxL && (!big || s.P.blocks > big.P.blocks)) big = s;
      if (!big) break;
      total -= big.P.blocks * 9; big.lvl++; big.P = plan(big, big.lvl); total += big.P.blocks * 9;
    }
    chosen = { ...b, st, K, budget, total };
    if (total <= budget) break;
  }

  // ---- render, encode, lay out RAM ----
  const ram = new Uint8Array(0x10000);
  const sig = 'RetroSynths SNES sound driver (GM) - RAM image built from GeneralUser GS';
  for (let i = 0; i < sig.length; i++) ram[0x200 + i] = sig.charCodeAt(i);
  const { progs, drums, samples, st } = chosen;
  const edl = st.edl, esa = edl ? (0x10000 - edl * 0x800) >> 8 : 0xFF;
  let addr = SAMPLE_BASE;
  samples.forEach((s, i) => {
    const r = renderSample(s, s.P, pool);
    const brr = brrEncode(r.pcm, r.loopBlock);
    if (addr + brr.length > esa << 8) { s.srcn = -1; return; }   // (should not happen: budget checked)
    ram.set(brr, addr);
    const loopAddr = r.loopBlock >= 0 ? addr + r.loopBlock * 9 : addr;
    const d = DIR_ADDR + i * 4;
    ram[d] = addr & 0xFF; ram[d + 1] = addr >> 8; ram[d + 2] = loopAddr & 0xFF; ram[d + 3] = loopAddr >> 8;
    s.srcn = i; s.addr = addr; s.bytes = brr.length; s.gain = r.gain;
    addr += brr.length;
  });
  const atten = (z) => Math.pow(10, -0.4 * z.g[48] / 200);
  const programs = new Array(128).fill(null);
  for (let p = 0; p < 128; p++) {
    if (!progs[p]) continue;
    const splits = progs[p].filter(sp => sp.s.srcn >= 0).map(sp => {
      const env = mapEnvelope(sp.z.g, sp.s.P.natural, loopTime(sp.s.P), maxAtt(sp.s.P));
      return { hi: sp.hi, srcn: sp.s.srcn, root: sp.root, scale: sp.scale, base: 4096 * sp.s.P.rate / 32000,
        gain: sp.s.gain * atten(sp.z), ...env };
    });
    if (splits.length) programs[p] = { splits, own: true };
  }
  // fill every GM program: same family first, then the nearest prepared program
  const have = programs.map((x, i) => (x ? i : -1)).filter(i => i >= 0);
  if (have.length) for (let p = 0; p < 128; p++) {
    if (programs[p]) continue;
    let best = have[0], bd = Infinity;
    for (const h of have) { const d = Math.abs(h - p) + ((h >> 3) === (p >> 3) ? 0 : 1000); if (d < bd) { bd = d; best = h; } }
    programs[p] = { splits: programs[best].splits, own: false, from: best };
  }
  const drumMap = new Array(128).fill(null);
  for (let n = 0; n < 128; n++) {
    const d = drums[n]; if (!d || d.s.srcn < 0) continue;
    const env = mapEnvelope(d.z.g, d.s.P.natural, loopTime(d.s.P), maxAtt(d.s.P));
    drumMap[n] = { srcn: d.s.srcn, pitch: clamp(Math.round(4096 * d.s.P.rate / 32000 * d.ratio), 1, 0x3FFF),
      gain: d.s.gain * atten(d.z), pan: clamp(d.z.g[17], -500, 500) / 500, excl: d.z.g[57], ...env };
  }
  const levels = samples.map(s => s.lvl);
  return {
    ram, dir: DIR_ADDR >> 8, esa, edl, programs, drums: drumMap,
    info: {
      samples: samples.length, bytes: addr - SAMPLE_BASE, budget: chosen.budget, splits: chosen.K, edl,
      echoBytes: edl * 2048, minLevel: Math.min(...levels), maxLevel: Math.max(...levels),
      meanRate: Math.round(samples.reduce((a, s) => a + s.P.rate, 0) / Math.max(1, samples.length)),
      ms: Date.now() - t0,
    },
  };
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
