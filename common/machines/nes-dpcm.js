// DPCM sample bank for the NES machine (original, synthesized here — no recorded samples).
// One-shots are unipolar and start/end at counter level 0, so between hits the DMC rests at 0 and the
// triangle/noise keep full loudness in the nonlinear mixer. Loops are single cycles with equal up/down
// steps (no drift), in 17/33/65-byte sizes for tuning. Shared by nes.js (worklet) and nes-editor.js (drawing).

import { DMC_P, NES_CPU } from './nes-apu.js';
const DMC_HZ = DMC_P.map(p => NES_CPU / p);

export function encode(y) {
  const n = y.length, bytes = new Uint8Array(Math.ceil(n / 8) + 1);
  let lev = 0;
  for (let i = 0; i < n; i++) {
    if (y[i] > lev) { bytes[i >> 3] |= 1 << (i & 7); if (lev <= 125) lev += 2; } else if (lev >= 2) lev -= 2;
  }
  return bytes;
}
export function synthOneShot(kind, amp) {
  const fs = DMC_HZ[15];
  const dur = { Kick: 0.2, Snare: 0.17, Tom: 0.3, Clap: 0.2 }[kind];
  const n = Math.round(dur * fs), y = new Float32Array(n);
  let ph = 0, seed = 22222, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs, att = Math.min(1, t / 0.0015);
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const rnd = seed / 0x7fffffff;
    let v;
    if (kind === 'Kick') { ph += 2 * Math.PI * (48 + 120 * Math.exp(-t / 0.022)) / fs; v = att * Math.exp(-t / 0.055) * 0.5 * (1 - Math.cos(ph)); }
    else if (kind === 'Snare') { ph += 2 * Math.PI * 185 / fs; lp += 0.6 * (rnd - lp); v = att * (0.55 * 0.5 * (1 - Math.cos(ph)) * Math.exp(-t / 0.03) + 0.6 * lp * Math.exp(-t / 0.05)); }
    else if (kind === 'Tom') { ph += 2 * Math.PI * (85 + 55 * Math.exp(-t / 0.04)) / fs; v = att * Math.exp(-t / 0.09) * 0.5 * (1 - Math.cos(ph)); }
    else { lp += 0.5 * (rnd - lp); const burst = t < 0.03 ? (Math.floor(t / 0.01) % 2 ? 0.35 : 1) : Math.exp(-(t - 0.03) / 0.04); v = att * lp * burst * 1.2; }
    y[i] = v * amp;
  }
  return encode(y);
}
export function loopBits(shape, N, A = 60) {
  const bits = new Uint8Array(N);
  if (shape === 'Saw Loop') {
    const d = A / 2, upN = N - d, ups = (upN + d) / 2;     // up section: net +A, then d straight down steps
    let acc = 0; for (let i = 0; i < upN; i++) { acc += ups; if (acc >= upN) { acc -= upN; bits[i] = 1; } }
  } else {
    const r = A / 2, pl = (N - A) / 2;                     // rise, plateau (alternating), fall, plateau
    let i = 0; for (let k = 0; k < r; k++) bits[i++] = 1;
    for (let k = 0; k < pl; k++) bits[i++] = k & 1; for (let k = 0; k < r; k++) bits[i++] = 0;
    for (let k = 0; k < pl; k++) bits[i++] = (k + 1) & 1;
  }
  const b = new Uint8Array(N / 8); for (let i = 0; i < N; i++) if (bits[i]) b[i >> 3] |= 1 << (i & 7);
  return b;
}
/** decode a delta bit stream into the 7-bit counter levels (for drawing), starting at `lev` */
export function decode(bytes, nbits, lev = 0) {
  const out = new Uint8Array(nbits);
  for (let i = 0; i < nbits; i++) { if ((bytes[i >> 3] >> (i & 7)) & 1) { if (lev <= 125) lev += 2; } else if (lev >= 2) lev -= 2; out[i] = lev; }
  return out;
}
