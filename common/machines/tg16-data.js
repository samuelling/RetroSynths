// TurboGrafx-16 driver data: an original 32-step × 5-bit wave set for the GM families, and DDA drum
// samples synthesised (5-bit, at the 6.99 kHz timer-IRQ rate games streamed DDA with). All designs are
// RetroSynths' own.
import { TOM_NOTE, drumKind, Rand } from './util.js';
import { PSG_CLOCK, PSG_TIMER_CYCLES } from './tg16-psg.js';

export const DDA_RATE = PSG_CLOCK / PSG_TIMER_CYCLES;

const q5 = (x) => { const v = Math.round(x); return v < 0 ? 0 : v > 31 ? 31 : v; };
/** Normalise a 32-point shape to the full 0..31 range. */
function norm(a) {
  let lo = Infinity, hi = -Infinity;
  for (const x of a) { if (x < lo) lo = x; if (x > hi) hi = x; }
  return Uint8Array.from(a, (x) => q5((x - lo) / (hi - lo || 1) * 31));
}
/** Additive wave from harmonic amplitudes (negative amplitude = cosine phase). */
const add = (h) => norm(Array.from({ length: 32 }, (_, i) => {
  const ph = 2 * Math.PI * (i + 0.5) / 32;
  let s = 0; h.forEach((a, k) => { s += a >= 0 ? a * Math.sin((k + 1) * ph) : -a * Math.cos((k + 1) * ph); });
  return s;
}));
const shape = (f) => norm(Array.from({ length: 32 }, (_, i) => f(i)));

export const WAVES = {
  SINE: add([1]),
  TRI: shape((i) => (i < 16 ? i : 31 - i)),
  SAW: shape((i) => i),
  SQUARE: shape((i) => (i < 16 ? 1 : 0)),
  PULSE25: shape((i) => (i < 8 ? 1 : 0)),
  PULSE12: shape((i) => (i < 4 ? 1 : 0)),
  ORGAN: add([1, 0.75, 0.5, 0.35, 0, 0.22, 0, 0.25]),
  BRASS: add([1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.26, 0.18, 0.12, 0.08]),
  STRING: add([1, 0.45, 0.3, 0.22, 0.17, 0.13, 0.1, 0.08, 0.06]),
  BASS: add([1, 0.55, 0.2, 0.1]),
  SYNBASS: shape((i) => (i < 16 ? i * 2 : i * 2 - 32) + (i < 16 ? 6 : 0)),
  EPIANO: add([1, 0.3, 0, 0.18, 0, 0, 0.1]),
  CLAV: add([1, 0.9, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25, 0.2, 0.15]),
  HARPSI: add([0.7, 1, 0.6, 0.65, 0.4, 0.45, 0.25, 0.3]),
  FLUTE: add([1, 0.22, 0.07]),
  REED: add([1, 0, 0.6, 0, 0.4, 0, 0.26, 0, 0.15]),
  SAX: add([1, 0.85, 0.7, 0.45, 0.35, 0.25, 0.2, 0.12]),
  VOICE: add([0.55, 1, 0.6, 0.2, 0.15, 0.1]),
  PIANO: add([1, 0.6, 0.35, 0.25, 0.15, 0.1, 0.08]),
  BELL: add([1, 0, 0.45, 0.6, 0, 0.3, 0, 0.2]),
  MALLET: add([1, 0, 0, 0.35]),
  PLUCK: add([1, -0.7, 0.5, -0.4, 0.3, -0.2, 0.15, -0.1]),
  PAD: add([1, 0.35, 0.2, 0.1]),
  DIST: shape((i) => Math.tanh(3 * (Math.sin(2 * Math.PI * i / 32) + 0.6 * Math.sin(4 * Math.PI * i / 32 + 0.6)))),
};
export const WAVE_LIST = Object.keys(WAVES);

export const CLASS_WAVE = {
  piano: 'PIANO', epiano: 'EPIANO', harpsi: 'HARPSI', clav: 'CLAV', bell: 'BELL', vibes: 'SINE', mallet: 'MALLET',
  organ: 'ORGAN', reed: 'REED', pluck: 'PLUCK', dist: 'DIST', bass: 'BASS', synbass: 'SYNBASS', string: 'STRING',
  pad: 'PAD', voice: 'VOICE', hit: 'BRASS', brass: 'BRASS', flute: 'FLUTE', square: 'SQUARE', saw: 'SAW',
  bird: 'SINE', phone: 'PULSE25', timpani: 'SINE', tomperc: 'TRI', block: 'SINE',
};
export const PROG_WAVE = {
  6: 'HARPSI', 16: 'ORGAN', 18: 'PULSE25', 39: 'PULSE25', 50: 'SAW', 51: 'SAW', 62: 'SAW', 63: 'PULSE25',
  64: 'SAX', 65: 'SAX', 66: 'SAX', 67: 'SAX', 68: 'PULSE12', 69: 'PULSE25', 70: 'REED',
  84: 'DIST', 86: 'SAW', 88: 'PAD', 90: 'SAW', 104: 'PULSE12', 109: 'PULSE12', 111: 'PULSE12',
};

// ---- DDA drum samples ----
function render(dur, fn) {
  const n = Math.round(dur * DDA_RATE), a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = q5(15.5 + 15.5 * Math.max(-1, Math.min(1, fn(i / DDA_RATE, i))));
  return a;
}
const hz = (n) => 440 * Math.pow(2, (n - 69) / 12);

/** Synthesised DDA sample for a GM drum note (null = played on the noise channel instead). */
export function ddaSample(note) {
  const kind = drumKind(note), r = new Rand(note * 7919 + 13);
  const nz = () => r.next() * 2 - 1;
  let ph = 0, ph2 = 0;
  const osc = (f) => { ph += 2 * Math.PI * f / DDA_RATE; return Math.sin(ph); };
  switch (kind) {
    case 'kick': {
      const top = note === 35 ? 95 : 125, bot = note === 35 ? 40 : 48;
      return render(0.32, (t) => 1.25 * osc(bot + top * Math.exp(-t / 0.028)) * Math.exp(-t / 0.13) + (t < 0.003 ? 0.5 : 0));
    }
    case 'snare': {
      let lp = 0;
      return render(0.26, (t) => { const n0 = nz(); lp += 0.55 * (n0 - lp);
        const noise = note === 40 ? n0 : lp * 1.4;
        return 0.7 * osc(note === 40 ? 210 : 185) * Math.exp(-t / 0.045) + 0.95 * noise * Math.exp(-t / (note === 40 ? 0.07 : 0.09)); });
    }
    case 'clap':
      return render(0.24, (t) => { const b = [0, 0.011, 0.022].reduce((s, t0) => s + (t >= t0 ? Math.exp(-(t - t0) / 0.004) : 0), 0);
        return nz() * Math.min(1, b + (t > 0.028 ? 0.7 * Math.exp(-(t - 0.028) / 0.07) : 0)); });
    case 'stick': { let prev = 0; return render(0.06, (t) => { const n0 = nz(), d = n0 - prev; prev = n0; return (0.6 * d + 0.6 * osc(1650)) * Math.exp(-t / 0.012); }); }
    case 'tom': {
      const f0 = hz(TOM_NOTE[note] || 48);
      return render(0.42, (t) => 1.15 * osc(f0 * (1 + 0.6 * Math.exp(-t / 0.025))) * Math.exp(-t / 0.17) + 0.25 * nz() * Math.exp(-t / 0.01));
    }
    case 'conga': {
      const f0 = hz(TOM_NOTE[note] || 64), slap = note === 62;
      return render(0.25, (t) => osc(f0 * (1 + 0.15 * Math.exp(-t / 0.01))) * Math.exp(-t / (slap ? 0.04 : 0.09)) + (slap ? 0.6 : 0.2) * nz() * Math.exp(-t / 0.008));
    }
    case 'cowbell': {
      const a = note === 56 ? 540 : note === 67 ? 760 : 580, b = a * 1.48;
      return render(0.3, (t) => { ph += a / DDA_RATE; ph2 += b / DDA_RATE; return 0.55 * ((ph % 1 < 0.5 ? 1 : -1) + (ph2 % 1 < 0.5 ? 1 : -1)) * Math.exp(-t / 0.08); });
    }
    case 'block': { const f = note === 76 ? 1900 : note === 77 ? 1250 : 1550; return render(0.07, (t) => osc(f) * Math.exp(-t / 0.018)); }
    case 'bell': return render(0.9, (t) => { ph += 1; const x = 2 * Math.PI * ph / DDA_RATE;
      return (0.5 * Math.sin(x * 820) + 0.35 * Math.sin(x * 1235) + 0.3 * Math.sin(x * 2150)) * Math.exp(-t / 0.35); });
    case 'triangle': return render(note === 81 ? 1.2 : 0.15, (t) => 0.9 * osc(2950) * Math.exp(-t / (note === 81 ? 0.45 : 0.04)));
    case 'hatClosed': case 'hatPedal': case 'hatOpen': case 'crash': case 'ride': case 'shaker': return null;
    default: {
      if (note === 58) return render(0.6, (t) => nz() * osc(900) * Math.exp(-t / 0.2) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 28 * t)));
      if (note === 71 || note === 72) return render(note === 72 ? 0.35 : 0.14, (t) => 0.8 * osc(note === 71 ? 2500 : 2250) * Math.min(1, t * 80));
      if (note === 73 || note === 74) return render(note === 74 ? 0.32 : 0.12, (t) => nz() * (Math.sin(2 * Math.PI * 45 * t) > 0 ? 0.8 : 0.1));
      if (note === 78 || note === 79) return render(0.2, (t) => osc((note === 78 ? 600 : 900) * (1 + 1.2 * t)) * Math.exp(-t / 0.08));
      const f = hz(Math.max(48, Math.min(96, note)));
      return render(0.18, (t) => (0.7 * osc(f) + 0.3 * nz()) * Math.exp(-t / 0.05));
    }
  }
}

/** Named DDA sample bank: name → [label, GM note it is synthesised from, pitch (MIDI) it plays at rate 1]. */
export const DDA_BANK = {
  kick: ['Kick (sine drop)', 36, 36], kickDeep: ['Kick deep', 35, 35], snare: ['Snare (tone+noise)', 38, 38], snareBright: ['Snare bright', 40, 40],
  clap: ['Clap', 39, 39], stick: ['Side stick', 37, 37], tom: ['Tom', 45, 48], conga: ['Conga', 63, 67], congaSlap: ['Conga slap', 62, 70],
  cowbell: ['Cowbell', 56, 73], agogo: ['Agogo', 67, 79], block: ['Wood block', 76, 94], rideBell: ['Ride bell', 53, 80],
  triangle: ['Triangle', 80, 102], triangleOpen: ['Triangle open', 81, 102], vibraslap: ['Vibraslap', 58, 81],
  whistle: ['Whistle', 72, 99], guiro: ['Guiro', 74, 60], cuica: ['Cuica', 78, 74],
};
/** Synthesise the whole DDA bank (worklet side). */
export function buildDDA() { const b = {}; for (const [k, v] of Object.entries(DDA_BANK)) b[k] = ddaSample(v[1]); return b; }

/** Noise-channel drum macros: per frame [noise frequency 0–31, level 0..1]. */
export function noiseMacro(note) {
  const kind = drumKind(note);
  const dec = (nf, l0, n, k) => Array.from({ length: n }, (_, i) => [nf, l0 * Math.pow(k, i)]);
  switch (kind) {
    case 'hatClosed': return [[31, 1], [31, 0.6], [31, 0.3], [31, 0.12]];
    case 'hatPedal': return [[30, 0.9], [30, 0.5], [30, 0.22]];
    case 'hatOpen': return dec(31, 0.75, 22, 0.87);
    case 'crash': return note === 55 ? dec(31, 0.8, 30, 0.9) : [[28, 1], ...dec(30, 0.95, 60, 0.95)];
    case 'ride': return [[27, 0.5], ...dec(31, 0.45, 30, 0.92)];
    case 'shaker': return note === 54 ? [[29, 0.5], ...dec(31, 0.6, 8, 0.76)] : [[30, 0.35], [30, 0.5], [30, 0.3], [30, 0.12]];
    default: return null;
  }
}
