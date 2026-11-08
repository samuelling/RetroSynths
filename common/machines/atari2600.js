// Atari 2600 (VCS) — TIA audio driven by a 2-voice, frame-rate music driver.
//
// The TIA can only make a few dozen pitches per distortion mode (31.4 kHz ÷ (AUDF+1) ÷ the mode's
// pattern length), so — like 2600 composers working from pitch charts — the driver picks, per note,
// the AUDC/AUDF pair nearest in pitch among the timbres the patch allows (optionally an octave away),
// and lives with the error. Voice 0/1 go to melody and bass; drums (poly-noise and pitch-dropping
// div-31 tones) interrupt the bass for a few frames and the bass resumes.
// Original code for RetroSynths.
import { Resampler, DCBlock, drumKind, TOM_NOTE } from './util.js';
import { TIA, TIA_RATE, TIA_FRAME_CLOCKS, MODE_PERIOD, tiaHz } from './tia.js';
import { Driver, DRUM_PRIO } from './atari-driver.js';

// timbre class → AUDC modes to try, in order of preference
const MODES = {
  piano: [12, 4, 6], epiano: [12, 4, 6], harpsi: [1, 12], clav: [1, 12], bell: [4, 12], vibes: [4, 12], mallet: [12, 4],
  organ: [12, 6, 4], reed: [1, 12, 6], pluck: [12, 1, 6], dist: [7, 1], bass: [6, 14, 1], synbass: [1, 6, 15],
  string: [1, 12, 6], pad: [12, 6], voice: [12, 6], hit: [1, 12], brass: [1, 12, 6], flute: [12, 4, 6], square: [12, 4, 6],
  saw: [1, 12, 6], bird: [4, 12], phone: [4, 12], timpani: [6, 14], tomperc: [6, 14, 12], block: [4, 12],
};
const RANK_CENTS = 14;     // cost of using a less-preferred timbre, in cents of pitch error
const OCT_CENTS = 40;      // cost of substituting an octave

/** Nearest AUDF in one mode for a frequency; returns error in cents via out[1]. */
function nearestF(mode, hz, out) {
  const P = MODE_PERIOD[mode];
  let F = Math.round(TIA_RATE / (P * hz)) - 1;
  F = F < 0 ? 0 : F > 31 ? 31 : F;
  let best = F, be = Infinity;
  for (let f = Math.max(0, F - 1); f <= Math.min(31, F + 1); f++) {
    const e = Math.abs(1200 * Math.log2(tiaHz(mode, f) / hz));
    if (e < be) { be = e; best = f; }
  }
  out[0] = best; out[1] = be;
  return out;
}

/** Choose AUDC/AUDF (and octave substitution) for a MIDI pitch. → { audc, audf, oct, cents } */
export function pickTone(modes, semis, allowOct = true) {
  const hz = 440 * Math.pow(2, (semis - 69) / 12), tmp = [0, 0];
  let best = null, bc = Infinity;
  for (let r = 0; r < modes.length; r++) {
    for (const oct of allowOct ? [0, -12, 12] : [0]) {
      nearestF(modes[r], hz * Math.pow(2, oct / 12), tmp);
      const cost = tmp[1] + r * RANK_CENTS + (oct ? OCT_CENTS : 0);
      if (cost < bc) { bc = cost; best = { audc: modes[r], audf: tmp[0], oct, cents: tmp[1] }; }
    }
  }
  return best;
}

// ---- drums: per-frame [AUDC, AUDF, level] macros, like a 2600 driver's drum tables ----
const dec = (c, f, v0, n, k = 0.72, df = 0) => Array.from({ length: n }, (_, i) => [c, Math.min(31, Math.round(f + df * i)), v0 * Math.pow(k, i)]);
function drumMacro(note) {
  const kind = drumKind(note);
  let fr;
  switch (kind) {
    case 'kick': fr = [[6, 6, 1], [6, 9, 0.92], [6, 13, 0.78], [6, 17, 0.62], [6, 22, 0.46], [6, 27, 0.3], [6, 31, 0.17], [6, 31, 0.08]];
      if (note === 35) fr = fr.map(([c, f, v]) => [c, Math.min(31, f + 2), v]); break;
    case 'snare': fr = [[8, 6, 1], [8, 7, 0.86], [8, 8, 0.7], [8, 9, 0.55], [8, 10, 0.42], [8, 11, 0.3], [8, 12, 0.2], [8, 13, 0.12], [8, 14, 0.06]];
      if (note === 40) fr.unshift([12, 7, 0.9]); break;
    case 'clap': fr = [[8, 3, 0.9], [8, 3, 0.3], [8, 3, 0.85], [8, 3, 0.3], ...dec(8, 4, 0.75, 7, 0.68)]; break;
    case 'stick': fr = [[8, 1, 1], [4, 6, 0.7], [4, 6, 0.35]]; break;
    case 'hatClosed': fr = [[8, 0, 0.85], [8, 0, 0.45], [8, 0, 0.18]]; break;
    case 'hatPedal': fr = [[8, 0, 0.7], [8, 0, 0.35], [8, 0, 0.14]]; break;
    case 'hatOpen': fr = dec(8, 0, 0.55, 18, 0.86); break;
    case 'crash': fr = dec(8, 1, 0.85, 48, 0.94); if (note === 55) fr = dec(8, 0, 0.75, 26, 0.9); break;
    case 'ride': fr = [[4, 3, 0.45], ...dec(8, 0, 0.4, 24, 0.9)]; break;
    case 'bell': fr = dec(4, 8, 0.7, 22, 0.88); break;
    case 'shaker': fr = [[8, 0, 0.28], [8, 0, 0.36], [8, 0, 0.2], [8, 0, 0.08]]; if (note === 54) fr = [[4, 1, 0.3], ...dec(8, 0, 0.42, 7, 0.75)]; break;
    case 'cowbell': fr = note === 56 ? dec(4, 19, 0.8, 9, 0.75) : dec(4, note === 67 ? 14 : 18, 0.75, 8, 0.74); break;
    case 'triangle': fr = dec(4, 3, 0.55, note === 81 ? 36 : 6, note === 81 ? 0.93 : 0.7); break;
    case 'block': fr = [[4, note === 76 ? 8 : note === 77 ? 12 : 10, 0.75], [4, 10, 0.3], [4, 10, 0.1]]; break;
    case 'tom': case 'conga': {
      const t = pickTone(kind === 'tom' ? [6, 14] : [12, 4], TOM_NOTE[note] || 60, false);
      fr = kind === 'tom' ? dec(t.audc, t.audf, 1, 12, 0.78, 0.5) : dec(t.audc, t.audf, 0.85, 6, 0.65);
      break;
    }
    default:
      if (note === 58) fr = dec(9, 4, 0.7, 20, 0.88);                                      // vibraslap
      else if (note === 71 || note === 72) fr = Array.from({ length: note === 72 ? 18 : 8 }, () => [4, note === 71 ? 5 : 6, 0.5]);
      else if (note === 73 || note === 74) fr = Array.from({ length: note === 74 ? 14 : 6 }, (_, i) => [8, 5, i & 1 ? 0.1 : 0.55]);
      else if (note === 78 || note === 79) fr = dec(12, note === 78 ? 10 : 6, 0.7, 8, 0.8, -0.6);   // cuica
      else { const t = pickTone([12, 4], note, false); fr = dec(t.audc, t.audf, 0.7, 6, 0.7); }
  }
  return { kind, prio: DRUM_PRIO[kind] ?? 46, len: fr.length, fr, choke: kind.startsWith('hat') ? 'hat' : null };
}

const NOISE_AUDC = { heli: 3, sea: 8, gun: 8, applause: 8, fret: 8, breath: 8, cymbal: 8, hiss: 8 };

export default class Atari2600 extends Driver {
  static info = {
    id: 'atari2600', name: 'Atari 2600', maker: 'Atari', year: 1977,
    chip: 'TIA (Television Interface Adaptor)', voices: '2 × 5-bit divider · 4/5/9-bit polys',
    spec: 'two TIA channels at 31.4 kHz; nearest-pitch AUDC/AUDF tables, out of tune by design',
  };
  static options = [
    { key: 'oct', label: 'Octave substitution', choices: [[true, 'On'], [false, 'Off']], default: true },
  ];

  constructor(host) {
    super(host, 2, TIA_RATE / TIA_FRAME_CLOCKS);
    this.tia = new TIA();
    this.rs = new Resampler(TIA_RATE, host.sampleRate);
    this.dc = new DCBlock(host.sampleRate, 12);
    this.fc = 0; this.allowOct = true;
    this.gain = 0.8;
    this.drums = {};
    for (let n = 27; n <= 87; n++) this.drums[n] = drumMacro(n);
    this.cache = [[-1, -1, -1], [-1, -1, -1]];
  }
  setOption(key, value) { if (key === 'oct') this.allowOct = !!value; }
  maxVoices() { return 2; }
  reset() { this.resetDriver(); this.tia.reset(); this.cache = [[-1, -1, -1], [-1, -1, -1]]; }

  w(vi, audc, audf, audv) {
    const c = this.cache[vi];
    if (c[0] !== audc) { c[0] = audc; this.tia.write(0x15 + vi, audc); }
    if (c[1] !== audf) { c[1] = audf; this.tia.write(0x17 + vi, audf); }
    if (c[2] !== audv) { c[2] = audv; this.tia.write(0x19 + vi, audv); }
  }
  drumFor(note) { return this.drums[note] || this.drums[Math.max(27, Math.min(87, note))]; }

  vol(amp) { const v = Math.round(15 * Math.min(1, 1.4 * amp)); return v < 0 ? 0 : v; }

  program(vi, vn) {
    if (vn.isDrum) return;
    const p = vn.p;
    if (p.noise) { vn.tm = NOISE_AUDC[p.noise] || 8; vn.toct = 0; return; }
    const ch = this.h.ch[vn.ch];
    const t = pickTone(MODES[p.cls] || MODES.square, vn.note + ch.bend * ch.bendRange, this.allowOct);
    vn.tm = t.audc; vn.toct = t.oct;
  }
  update(vi, vn) {
    if (vn.isDrum) {
      const f = vn.dd.fr[Math.min(vn.frames, vn.len - 1)];
      this.w(vi, f[0], f[1], this.vol(vn.amp * f[2] * 2.1));
      return;
    }
    let audf;
    if (vn.p.noise) audf = Math.max(0, Math.min(31, Math.round((96 - vn.pitch) / 2.5)));
    else {
      const hz = 440 * Math.pow(2, (vn.pitch + vn.toct - 69) / 12);
      audf = nearestF(vn.tm, hz, this.tmp || (this.tmp = [0, 0]))[0];
    }
    this.w(vi, vn.tm, audf, this.vol(vn.amp));
  }
  silence(vi) { this.w(vi, this.cache[vi][0] < 0 ? 0 : this.cache[vi][0], Math.max(0, this.cache[vi][1]), 0); }

  render(L, R, n) {
    const rs = this.rs, tia = this.tia, g = this.gain;
    for (let i = 0; i < n; i++) {
      for (let k = rs.advance(); k > 0; k--) {
        const y = tia.clock();
        rs.push(y, y);
        if (++this.fc >= TIA_FRAME_CLOCKS) { this.fc = 0; this.frame(); }
      }
      const v = this.dc.run(rs.out()[0]) * g;
      L[i] = v; R[i] = v;
    }
  }
}
