// Genesis machine: original 8-bit DAC drum samples, synthesised at load time (no recorded or vendor data),
// plus the General MIDI percussion map for the period-style driver (DAC on FM channel 6, cymbals and
// shakers on the PSG noise channel).

export const DAC_RATE = 7670454 / 144 / 4;      // 13,317 Hz: one DAC write every 4 chip samples, as a Z80 loop would

let seed = 0x1234567;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
const SR = DAC_RATE;

function make(sec, fn) {
  const n = Math.round(sec * SR), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = fn(i / SR, i);
  return x;
}
// one-pole helpers for shaping noise
function hp(x, hz) { const a = Math.exp(-2 * Math.PI * hz / SR); let y = 0, p = 0; for (let i = 0; i < x.length; i++) { y = a * (y + x[i] - p); p = x[i]; x[i] = y; } return x; }
function lp(x, hz) { const a = 1 - Math.exp(-2 * Math.PI * hz / SR); let y = 0; for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; } return x; }
function noise(sec) { return make(sec, () => rnd()); }
function env(x, f) { for (let i = 0; i < x.length; i++) x[i] *= f(i / SR); return x; }
function add(a, b, g = 1) { for (let i = 0; i < a.length && i < b.length; i++) a[i] += b[i] * g; return a; }
function sweep(sec, f0, f1, tau, dec) {
  let ph = 0;
  return make(sec, (t) => { const f = f1 + (f0 - f1) * Math.exp(-t / tau); ph += 2 * Math.PI * f / SR; return Math.sin(ph) * Math.exp(-t / dec); });
}
const ex = (d) => (t) => Math.exp(-t / d);

/** Quantise to the 8-bit unsigned format written to register 0x2A (peak-normalised). */
function u8(x, peak = 0.97) {
  let m = 1e-9; for (const v of x) m = Math.max(m, Math.abs(v));
  const o = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = Math.max(0, Math.min(255, Math.round(128 + 127 * peak * x[i] / m)));
  // trim the silent tail
  let end = o.length; while (end > 1 && Math.abs(o[end - 1] - 128) <= 1) end--;
  return o.subarray(0, end);
}

function build() {
  const S = {};
  // kick: pitch-swept sine with a short click
  { const k = sweep(0.32, 190, 46, 0.035, 0.11); add(k, env(lp(noise(0.32), 3000), ex(0.004)), 0.5); S.kick = u8(k); }
  // snare: two body modes + bright noise
  { const b = sweep(0.25, 260, 185, 0.02, 0.05); add(b, sweep(0.25, 400, 330, 0.02, 0.03), 0.5);
    const n = env(hp(noise(0.25), 1200), ex(0.07)); add(b, n, 1.4); S.snare = u8(b); }
  // hand clap: three quick bursts and a tail, band-limited noise
  { const n = lp(hp(noise(0.28), 700), 3800);
    env(n, (t) => { let e = 0; for (const o of [0, 0.011, 0.023]) if (t >= o) e = Math.max(e, Math.exp(-(t - o) / 0.006)); return t >= 0.033 ? Math.max(e, 0.6 * Math.exp(-(t - 0.033) / 0.07)) : e; });
    S.clap = u8(n); }
  // tom: swept sine with a little skin noise (pitched by playback rate)
  { const t = sweep(0.5, 210, 140, 0.05, 0.17); add(t, env(lp(noise(0.5), 2000), ex(0.012)), 0.3); S.tom = u8(t); }
  // side stick / rim
  { const r = make(0.08, (t) => Math.sin(2 * Math.PI * 1750 * t) * Math.exp(-t / 0.008)); add(r, env(hp(noise(0.08), 2000), ex(0.006)), 0.7); S.rim = u8(r); }
  // cowbell: two detuned squares through a band-pass
  { const c = make(0.4, (t) => ((Math.sin(2 * Math.PI * 562 * t) > 0 ? 1 : -1) + (Math.sin(2 * Math.PI * 845 * t) > 0 ? 1 : -1)) * (0.3 * Math.exp(-t / 0.02) + 0.7 * Math.exp(-t / 0.13)));
    S.cowbell = u8(lp(hp(c, 450), 2600)); }
  // conga / bongo
  { const c = sweep(0.3, 330, 290, 0.01, 0.09); add(c, env(hp(noise(0.3), 1500), ex(0.005)), 0.5); S.conga = u8(c); }
  // wood block / claves
  { S.block = u8(make(0.09, (t) => Math.sin(2 * Math.PI * 1150 * t) * Math.exp(-t / 0.018) + 0.3 * Math.sin(2 * Math.PI * 2650 * t) * Math.exp(-t / 0.008))); }
  // agogo / ride-bell type bell
  { S.bell = u8(make(0.6, (t) => (Math.sin(2 * Math.PI * 920 * t) + 0.6 * Math.sin(2 * Math.PI * 1380 * t + 1) + 0.35 * Math.sin(2 * Math.PI * 2310 * t)) * Math.exp(-t / 0.16))); }
  // triangle
  { S.triangle = u8(make(1.0, (t) => (Math.sin(2 * Math.PI * 2650 * t) + 0.5 * Math.sin(2 * Math.PI * 4130 * t + 0.4)) * Math.exp(-t / 0.35))); }
  // whistle
  { S.whistle = u8(make(0.45, (t) => Math.sin(2 * Math.PI * (2150 * t + 6 * Math.sin(2 * Math.PI * 28 * t))) * Math.min(1, t / 0.01) * (t < 0.38 ? 1 : Math.max(0, 1 - (t - 0.38) / 0.07)))); }
  // guiro: train of short scrapes
  { const g = lp(hp(noise(0.42), 1500), 4500); env(g, (t) => { const p = (t * 38) % 1; return (p < 0.45 ? 1 : 0.15) * Math.min(1, (0.42 - t) / 0.05); }); S.guiro = u8(g); }
  // cuica: pitch glides
  { let ph = 0; S.cuica = u8(make(0.35, (t) => { const f = 330 + 420 * Math.min(1, t / 0.12) - 260 * Math.max(0, (t - 0.12) / 0.23); ph += 2 * Math.PI * f / SR; return Math.sin(ph) * (1 - Math.exp(-t / 0.01)) * Math.exp(-t / 0.15); })); }
  // vibraslap: rattling noise
  { const v = hp(noise(0.8), 1800); env(v, (t) => (0.6 + 0.4 * Math.sin(2 * Math.PI * 24 * t)) * Math.exp(-t / 0.25)); S.vibraslap = u8(v); }
  // timbale: bright ringing shell
  { const tb = sweep(0.4, 520, 470, 0.01, 0.12); add(tb, make(0.4, (t) => Math.sin(2 * Math.PI * 1310 * t) * Math.exp(-t / 0.08)), 0.35);
    add(tb, env(hp(noise(0.4), 2500), ex(0.02)), 0.4); S.timbale = u8(tb); }
  return S;
}

export const SAMPLES = build();

// GM percussion map (35..81).
//   dac: sample name, rate (playback-rate factor), gain (0..1), len (fraction of the sample to play)
//   psg: noise-channel hit: mode = SN76489 noise control (4 = white, rate 0..2), level (0 dB = 1),
//        decay (seconds to -30 dB), release on note-off for 'choke' (open hat closed by pedal etc.)
const D = (sample, rate = 1, gain = 1, len = 1) => ({ dac: sample, rate, gain, len });
const N = (mode, level, decay, choke = 0) => ({ psg: true, mode, level, decay, choke });
export const DRUM_MAP = {
  35: D('kick', 0.9, 1), 36: D('kick', 1, 1),
  37: D('rim', 1, 0.8), 38: D('snare', 1, 0.95), 39: D('clap', 1, 0.9), 40: D('snare', 1.12, 0.95),
  41: D('tom', 0.72, 1), 43: D('tom', 0.82, 1), 45: D('tom', 0.93, 1), 47: D('tom', 1.04, 1), 48: D('tom', 1.18, 1), 50: D('tom', 1.33, 1),
  42: N(4, 0.55, 0.045, 1), 44: N(4, 0.45, 0.03, 1), 46: N(4, 0.55, 0.32, 1),
  49: N(4, 0.75, 1.2), 52: N(5, 0.7, 0.9), 55: N(4, 0.65, 0.6), 57: N(4, 0.75, 1.3),
  51: N(4, 0.45, 0.55), 59: N(4, 0.42, 0.5), 53: D('bell', 1.35, 0.7),
  54: N(4, 0.5, 0.11), 69: N(4, 0.4, 0.06), 70: N(4, 0.42, 0.045), 82: N(4, 0.4, 0.05),
  56: D('cowbell', 1, 0.75), 58: D('vibraslap', 1, 0.7),
  60: D('conga', 1.45, 0.85), 61: D('conga', 1.2, 0.85), 62: D('conga', 1.08, 0.8, 0.35), 63: D('conga', 1.05, 0.85), 64: D('conga', 0.85, 0.85),
  65: D('timbale', 1.1, 0.8), 66: D('timbale', 0.85, 0.8),
  67: D('bell', 1, 0.75), 68: D('bell', 0.82, 0.75),
  71: D('whistle', 1, 0.6, 0.3), 72: D('whistle', 1, 0.6),
  73: D('guiro', 1, 0.7, 0.4), 74: D('guiro', 1, 0.7),
  75: D('block', 1.6, 0.8), 76: D('block', 1.15, 0.8), 77: D('block', 0.92, 0.8),
  78: D('cuica', 1.1, 0.7, 0.45), 79: D('cuica', 0.95, 0.7),
  80: D('triangle', 1, 0.6, 0.15), 81: D('triangle', 1, 0.6),
};
/** Fallback for unmapped notes. */
export function drumFor(n) {
  if (DRUM_MAP[n]) return DRUM_MAP[n];
  if (n < 35) return D('kick', 0.8 + (n - 27) * 0.02, 0.8);
  return D('block', 0.9 + ((n * 7) % 10) * 0.06, 0.6);
}
