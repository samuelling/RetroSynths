// Shared helpers for machine modules. Keep this file dependency-free; it runs in the worklet and main thread.

export const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);

/** Note number including pitch bend for a MIDI channel state. */
export const bentNote = (ch, note) => note + ch.bend * ch.bendRange;

/** Overall linear loudness 0..1 for a note: velocity × CC7 × CC11 on a 40·log10 (squared) curve. */
export function gmLevel(ch, vel) {
  const v = (vel / 127) * (ch.vol / 127) * (ch.expr / 127);
  return v * v;
}

/** GM pan (0..127) → [left, right] equal-power gains. */
export function panGains(ch) {
  const p = Math.max(0, Math.min(1, (ch.pan - 1) / 126));
  return [Math.cos(p * Math.PI / 2), Math.sin(p * Math.PI / 2)];
}

export const FAMILY = ['piano', 'chromatic', 'organ', 'guitar', 'bass', 'strings', 'ensemble', 'brass',
  'reed', 'pipe', 'lead', 'pad', 'fx', 'ethnic', 'percussive', 'sfx'];
export const family = (prog) => FAMILY[(prog >> 3) & 15];

/** Coarse class of a GM percussion note. */
export function drumKind(n) {
  switch (n) {
    case 35: case 36: return 'kick';
    case 38: case 40: return 'snare';
    case 37: return 'stick';
    case 39: return 'clap';
    case 42: return 'hatClosed';
    case 44: return 'hatPedal';
    case 46: return 'hatOpen';
    case 41: case 43: case 45: case 47: case 48: case 50: return 'tom';
    case 49: case 52: case 55: case 57: return 'crash';
    case 51: case 59: return 'ride';
    case 53: return 'bell';
    case 54: case 69: case 70: case 82: return 'shaker';
    case 56: case 67: case 68: return 'cowbell';
    case 60: case 61: case 62: case 63: case 64: case 65: case 66: return 'conga';
    case 75: case 76: case 77: return 'block';
    case 80: case 81: return 'triangle';
    default: return 'perc';
  }
}
/** Approximate pitch (MIDI note) of a tom/conga hit for melodic-percussion chips. */
export const TOM_NOTE = { 41: 41, 43: 45, 45: 48, 47: 52, 48: 55, 50: 59, 60: 72, 61: 67, 62: 70, 63: 67, 64: 62, 65: 64, 66: 57 };

/**
 * Calls back at a fixed rate (e.g. 60 Hz) in step with rendering.
 *   const clk = new FrameClock(sr, 60);
 *   for (i...) { if (clk.next()) driverTick(); ... }
 */
export class FrameClock {
  constructor(sampleRate, hz = 60) { this.step = hz / sampleRate; this.acc = 0; this.hz = hz; }
  next() { this.acc += this.step; if (this.acc >= 1) { this.acc -= 1; return true; } return false; }
}

/**
 * Software ADSR stepped at frame rate (like a sound driver), output 0..1.
 * Times in seconds; sustain 0..1. Call tick(dt) once per frame.
 */
export class SoftEnv {
  constructor() { this.set(0.005, 0.2, 0.7, 0.15); this.level = 0; this.stage = 4; }
  set(a, d, s, r) { this.a = a; this.d = d; this.s = s; this.r = r; return this; }
  on() { this.stage = 0; }
  off() { if (this.stage < 3) this.stage = 3; }
  get done() { return this.stage === 4; }
  tick(dt) {
    switch (this.stage) {
      case 0: this.level += this.a > 0 ? dt / this.a : 1; if (this.level >= 1) { this.level = 1; this.stage = 1; } break;
      case 1: this.level -= this.d > 0 ? (dt / this.d) * (1 - this.s) : 1; if (this.level <= this.s) { this.level = this.s; this.stage = 2; } break;
      case 2: if (this.s <= 0.001) this.stage = 4; break;
      case 3: this.level -= this.r > 0 ? dt / this.r : 1; if (this.level <= 0) { this.level = 0; this.stage = 4; } break;
    }
    return this.level;
  }
}

/**
 * Simple voice allocator with stealing (free → oldest released → oldest).
 * Voices are your own objects; each needs: active, on (key held), age.
 */
export function allocVoice(voices) {
  let best = null, ba = Infinity;
  for (const v of voices) if (!v.active) return v;
  for (const v of voices) if (!v.on && v.age < ba) { best = v; ba = v.age; }
  if (best) return best;
  for (const v of voices) if (v.age < ba) { best = v; ba = v.age; }
  return best;
}

/** Band-limited polyphase resampler (64-tap Blackman-Harris) for chips that run at a native rate. */
export class Resampler {
  constructor(inRate, outRate, taps = 64, phases = 1024) {
    this.step = inRate / outRate; this.T = taps; this.P = phases;
    const fc = 0.5 * Math.min(1, outRate / inRate) * 0.9;
    this.h = new Float32Array(phases * taps);
    for (let p = 0; p < phases; p++) {
      let sum = 0;
      for (let k = 0; k < taps; k++) {
        const x = (k - taps / 2 + 1) - p / phases;
        const s = Math.abs(x) < 1e-9 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const nn = (x + taps / 2) / taps;
        const w = nn <= 0 || nn >= 1 ? 0 : 0.35875 - 0.48829 * Math.cos(2 * Math.PI * nn) + 0.14128 * Math.cos(4 * Math.PI * nn) - 0.01168 * Math.cos(6 * Math.PI * nn);
        this.h[p * taps + k] = s * w; sum += s * w;
      }
      for (let k = 0; k < taps; k++) this.h[p * taps + k] /= sum;
    }
    this.bL = new Float32Array(taps * 2); this.bR = new Float32Array(taps * 2);
    this.idx = 0; this.frac = 0; this.o = [0, 0];
  }
  push(l, r) { const T = this.T, i = this.idx; this.bL[i] = this.bL[i + T] = l; this.bR[i] = this.bR[i + T] = r; this.idx = i + 1 === T ? 0 : i + 1; }
  /** number of new input samples to push before calling out() */
  advance() { this.frac += this.step; const n = Math.floor(this.frac); this.frac -= n; return n; }
  out() {
    const T = this.T, base = this.idx, h = this.h, hp = ((this.frac * this.P) | 0) * T;
    let l = 0, r = 0;
    for (let k = 0; k < T; k++) { const c = h[hp + k]; l += this.bL[base + k] * c; r += this.bR[base + k] * c; }
    this.o[0] = l; this.o[1] = r; return this.o;
  }
}

/** One-pole lowpass and DC blocker, for analog output stages. */
export class OnePole {
  constructor(sampleRate, hz) { this.set(sampleRate, hz); this.y = 0; }
  set(sampleRate, hz) { this.a = 1 - Math.exp(-2 * Math.PI * hz / sampleRate); }
  run(x) { this.y += this.a * (x - this.y); return this.y; }
}
export class DCBlock {
  constructor(sampleRate, hz = 20) { this.r = Math.exp(-2 * Math.PI * hz / sampleRate); this.x1 = 0; this.y1 = 0; }
  run(x) { const y = x - this.x1 + this.r * this.y1; this.x1 = x; this.y1 = y; return y; }
}

/** Cheap deterministic PRNG for noise/hiss. */
export class Rand {
  constructor(seed = 1) { this.s = seed >>> 0 || 1; }
  next() { let s = this.s; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.s = s >>> 0; return this.s / 4294967296; }
}
