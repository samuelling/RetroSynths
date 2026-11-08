// "ROM budget" — squeeze a modern General MIDI SoundFont into the shape of a mid-90s
// sound-card bank: lower sample rates, mono, a single velocity layer, sparser multisamples,
// short loops and truncated one-shots. This is where most of the AWE32 / early-Live
// character comes from.

export const BUDGETS = {
  awe: { label: 'AWE-style ROM', maxRate: 22050, mono: true, oneLayer: true, thin: true, gmOnly: true, maxAttack: 0.09, maxLoop: 0.04, maxOneShot: 0.35, maxTail: 0.06 },
  live: { label: 'Live!-style bank', maxRate: 32000, mono: false, oneLayer: false, thin: false, maxAttack: 0.35, maxLoop: 0.22, maxOneShot: 1.6, maxTail: 0.4 },
};

function windowedSincResample(src, s0, s1, ratio, periodic, ls, le) {
  // src region [s0, s1). Output length ceil((s1-s0)*ratio). If periodic, reads inside [ls, le) wrap.
  const n = Math.max(1, Math.ceil((s1 - s0) * ratio));
  const out = new Float32Array(n);
  const cut = Math.min(1, ratio) * 0.92;
  const T = 12, TAPS = 2 * T, PH = 512;
  const tab = new Float32Array(PH * TAPS);
  for (let p = 0; p < PH; p++) {
    const fr = p / PH; let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      const x = (k - T + 1) - fr, a = x * cut;
      const s = Math.abs(a) < 1e-9 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
      const c = s * (0.5 + 0.5 * Math.cos(Math.PI * x / T));
      tab[p * TAPS + k] = c; sum += c;
    }
    for (let k = 0; k < TAPS; k++) tab[p * TAPS + k] /= sum;
  }
  const L = le - ls;
  const read = (i) => {
    if (periodic && i >= le) i = ls + ((i - ls) % L);
    if (i < s0 || i >= s1) return 0;
    return src[i];
  };
  for (let j = 0; j < n; j++) {
    const p = s0 + j / ratio;
    const ip = Math.floor(p), o = (((p - ip) * PH) | 0) * TAPS, b0 = ip - T + 1;
    let acc = 0;
    if (b0 >= s0 && b0 + TAPS < s1 && (!periodic || b0 + TAPS < le)) {
      for (let k = 0; k < TAPS; k++) acc += src[b0 + k] * tab[o + k];
    } else {
      for (let k = 0; k < TAPS; k++) acc += read(b0 + k) * tab[o + k];
    }
    out[j] = acc;
  }
  return out;
}

export function romBudget(bank, opt, progress) {
  const { pool } = bank;
  const P = bank.presets;
  const outPresets = {};
  // ---- 1. zone filtering ----
  for (const key of Object.keys(P)) {
    if (opt.gmOnly && +key >= 128 && +key < 128 * 128) continue;   // ROM had the GM set only; variations fall back
    let zs = P[key].map(z => ({ ...z, g: new Int32Array(z.g) }));
    const isDrum = +key >= 128 * 128;
    if (opt.mono) {
      const hasLeft = zs.some(z => z.type & 4);
      zs = zs.filter(z => !(z.type & 2) || !hasLeft);
      for (const z of zs) if (z.type & 4) z.g[17] = 0;
    }
    if (opt.oneLayer) {
      const keep = [];
      for (const z of zs) {
        if (z.vh >= 127) { keep.push(z); continue; }
        const covered = zs.some(o => o !== z && o.inst === z.inst && o.vh >= 127 && o.kl <= z.kh && o.kh >= z.kl);
        if (!covered) keep.push(z);
      }
      zs = keep;
      for (const z of zs) { if (z.vh >= 127) z.vl = 0; }
    }
    if (opt.thin && !isDrum) {
      const groups = new Map();
      for (const z of zs) {
        const k = z.inst + ':' + z.vl + ':' + z.vh;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(z);
      }
      const keep = [];
      for (const g of groups.values()) {
        g.sort((a, b) => a.kl - b.kl);
        if (g.length < 3) { keep.push(...g); continue; }
        for (let i = 0; i < g.length; i += 2) {
          const a = g[i], b = g[i + 1];
          if (b && b.kl === a.kh + 1) a.kh = b.kh; else if (b) keep.push(b);
          keep.push(a);
        }
      }
      zs = keep;
    }
    outPresets[key] = zs;
  }
  // ---- 2. resample / reloop unique sample regions ----
  const regions = new Map();
  for (const zs of Object.values(outPresets)) for (const z of zs) {
    const k = z.start + ':' + z.end + ':' + z.ls + ':' + z.le + ':' + z.sr + ':' + (z.g[54] & 1) + ':' + z.root;
    if (!regions.has(k)) regions.set(k, []);
    regions.get(k).push(z);
  }
  const pieces = [];
  let total = 0, done = 0;
  const keys = [...regions.keys()];
  for (const k of keys) {
    const zs = regions.get(k), z = zs[0];
    const looped = (z.g[54] & 1) === 1 && z.le > z.ls + 4 && z.ls >= z.start && z.le <= z.end;
    const f0 = 440 * Math.pow(2, (z.root - 69 + z.corr / 100) / 12);
    const sr = z.sr;
    let ratio = Math.min(1, opt.maxRate / sr);
    const copy = (a, b) => Float32Array.from(pool.subarray(a, Math.min(b, z.end)));
    const resample = (a, b, r, periodic) => (r >= 0.999 && r <= 1.001) ? copy(a, b) : windowedSincResample(pool, a, Math.min(b, z.end), r, periodic, z.ls, z.le);
    const loopLen = (rate, maxLen) => {          // whole pitch periods, close to opt.maxLoop
      const P0 = rate / f0;
      let per = Math.max(1, Math.round(opt.maxLoop * f0));
      while (per > 1 && per * P0 > maxLen) per--;
      return Math.max(8, Math.min(maxLen, Math.round(per * P0)));
    };
    const fadeLoop = (out, le, ls, xf) => {      // bake a crossfade so le → ls is seamless
      for (let i = 0; i < xf; i++) { const w = (i + 1) / (xf + 1); out[le - xf + i] = out[le - xf + i] * (1 - w) + out[ls - xf + i] * w; }
    };
    let out, ls2 = 0, le2 = 0;
    // when does the attack reach full level? (don't loop a soft swell while it is still quiet)
    let cutT = opt.maxAttack;
    if (looped) {
      const win = Math.max(32, Math.round(0.01 * sr)), lv = [];
      for (let a = z.start; a + win <= z.ls; a += win) { let q = 0; for (let i = a; i < a + win; i++) q += pool[i] * pool[i]; lv.push(q / win); }
      const pk = Math.max(1, ...lv);
      const reach = lv.findIndex(v => v >= pk * 0.25);
      if (reach >= 0) cutT = Math.max(cutT, (reach + 3) * win / sr);
    }
    if (looped && (z.ls - z.start) / sr > cutT + 0.02) {
      // A) long attack: keep a short one and loop a few periods right where we cut (ROM style)
      out = resample(z.start, z.start + Math.ceil(cutT * sr) + 64, ratio, false);
      const rate = sr * ratio;
      const cutEnd = Math.min(out.length - 1, Math.round(cutT * rate));
      const Ln = loopLen(rate, Math.floor(cutEnd / 2));
      ls2 = cutEnd - Ln; le2 = cutEnd;
      fadeLoop(out, le2, ls2, Math.min(Math.floor(Ln / 2), Math.round(rate * 0.01), ls2));
      out = out.slice(0, le2);
      // natural decay of the discarded attack (dB/s), measured on the source → folded into the volume envelope
      const rms = (a, b) => { let q = 0; a = Math.max(z.start, a | 0); b = Math.min(z.end, b | 0); for (let i = a; i < b; i++) q += pool[i] * pool[i]; return Math.sqrt(q / Math.max(1, b - a)) + 1; };
      const w = Math.round(0.04 * sr), e0 = z.start + Math.round(0.02 * sr);
      const dbE = 20 * Math.log10(rms(e0, e0 + w)), dbL = 20 * Math.log10(rms(z.ls - w, z.ls));
      const dt = Math.max(0.05, (z.ls - w / 2 - (e0 + w / 2)) / sr);
      const natural = Math.max(0, Math.min(60, (dbE - dbL) / dt));
      for (const zz of zs) {
        if ((zz.g[54] & 3) === 3) zz.g[54] = 1;
        if (natural > 6) {
          // the envelope's own decay only matters if it actually decays toward a lower sustain
          const Td = Math.pow(2, zz.g[36] / 1200), rateEnv = zz.g[37] > 10 ? 100 / Math.max(0.001, Td) : 0;
          zz.g[36] = Math.round(1200 * Math.log2(100 / (rateEnv + natural)));
          if (zz.g[37] < 600) zz.g[37] = 1000;   // let it die away rather than freeze at sustain
        }
      }
    } else if (looped && (z.le - z.ls) / sr > opt.maxLoop * 1.25) {
      // B) long loop: keep the attack, loop a few periods from the original loop start
      out = resample(z.start, z.ls + Math.ceil(opt.maxLoop * 1.4 * sr) + 64, ratio, false);
      const rate = sr * ratio;
      ls2 = Math.round((z.ls - z.start) * ratio);
      const Ln = loopLen(rate, out.length - 1 - ls2);
      le2 = ls2 + Ln;
      fadeLoop(out, le2, ls2, Math.min(Math.floor(Ln / 2), Math.round(rate * 0.01), ls2));
      out = out.slice(0, le2);
      for (const zz of zs) if ((zz.g[54] & 3) === 3) zz.g[54] = 1;
    } else if (looped) {
      // C) short loop already: resample keeping the loop an exact integer length
      const L = z.le - z.ls, L2 = Math.max(4, Math.round(L * ratio));
      ratio = L2 / L;
      const s1 = (z.g[54] & 3) === 3 ? Math.min(z.end, z.le + Math.ceil(opt.maxTail * sr)) : Math.min(z.end, z.le + 16);
      out = resample(z.start, s1, ratio, true);
      ls2 = Math.round((z.ls - z.start) * ratio); le2 = ls2 + L2;
      if (le2 > out.length) { le2 = out.length; ls2 = le2 - L2; }
    } else {
      // D) one-shot: truncate with a fade
      const srcEnd = Math.min(z.end, z.start + Math.ceil(opt.maxOneShot * sr));
      out = resample(z.start, srcEnd, ratio, false);
      if (srcEnd < z.end) {
        const f = Math.min(out.length, Math.round(sr * ratio * 0.04));
        for (let i = 0; i < f; i++) out[out.length - f + i] *= 1 - (i + 1) / f;
      }
    }
    const i16 = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) { const v = Math.round(out[i]); i16[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
    pieces.push({ zs, data: i16, offset: total, looped, ls2, le2, rate: z.sr * ratio });
    total += i16.length + 8;   // guard samples between regions
    done++;
    if (progress && (done & 63) === 0) progress(done / keys.length);
  }
  const newPool = new Int16Array(total);
  for (const pc of pieces) {
    newPool.set(pc.data, pc.offset);
    for (const z of pc.zs) {
      z.start = pc.offset; z.end = pc.offset + pc.data.length;
      if (pc.looped) { z.ls = pc.offset + pc.ls2; z.le = pc.offset + pc.le2; }
      else { z.ls = z.start; z.le = z.start; }
      z.sr = pc.rate;
    }
  }
  return { name: bank.name + ' — ' + opt.label, pool: newPool, presets: outPresets, bytes: total * 2 };
}
