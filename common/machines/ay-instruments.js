// Native AY-3-8910 / YM2149 instrument library (own designs), in tracker terms (Vortex Tracker / Arkos style):
//
//   vol     volume macro, 4-bit levels 0–15 per driver frame (volSpeed = frames per step)
//   arp     arpeggio macro in semitones (arpMode 'rel' = added to the note, 'fixed' = absolute MIDI notes)
//   pitch   pitch macro: tone-period offset in register units (+ = lower), per frame
//   noise   noise-period macro 0–31 (noiseRel: added to a period that follows the note)
//   mixer   mixer macro per frame: bit0 = tone (T), bit1 = noise (N) — R7, inverted
//   env     hardware envelope: shape −1 (off) or R13 0–15; mode 'note' (cycle = note frequency × ratio,
//           the buzzer trick) or 'abs' (16-bit period R11/R12). While it is on, the channel's M bit is set.
//   vib     driver vibrato: depth (cents), delay (frames), speed (frames per cycle)
//   slide   driver pitch slide: speed (cents per frame), limit (cents)
//   transpose (semitones), role (allocation priority class), prio (drums)
//
// Every macro is { values, loop, release } with FamiTracker semantics: loop until note-off, then continue
// from the release index.
//
// The designs are converted from ay-patches.js (frame-stepped log envelopes, pitch macros) and
// ayDrumMacro() (per-frame drum programs), so the GM mapping sounds as before.

import { PATCHES, ENV_RANGE_DB } from './ay-patches.js';
import { AY_DAC } from './ay.js';
import { ayDrumMacro, DRUM_PRIO } from './ay-driver-drums.js';
import { drumKind } from './util.js';

const M = (values, loop = -1, release = -1) => ({ values, loop, release });
const ampToLevel = (a) => {           // nearest AY fixed level for an amplitude (log domain)
  if (a <= 0.004) return 0;
  let best = 0, bd = Infinity;
  for (let v = 1; v < 16; v++) { const d = Math.abs(Math.log(AY_DAC[v * 2 + 1]) - Math.log(a)); if (d < bd) { bd = d; best = v; } }
  return best;
};
const eToLevel = (e) => e <= 0 ? 0 : ampToLevel(Math.pow(10, (e - 1) * ENV_RANGE_DB / 20));

/** Convert an ay-patches.js design to a native instrument. fps = the machine's driver rate. */
function convert(p, name, category, fps, extra = {}) {
  const dt = 1 / fps;
  // ---- volume macro from the log envelope (+ tremolo)
  const tremAt = (f) => p.trem ? p.trem[0] * 0.5 * (1 + Math.sin(2 * Math.PI * f * dt * p.trem[1])) : 0;
  const frames = [];
  let e = p.a > 0 ? 0 : 1, f = 0;
  if (p.a > 0) while (e < 1 && f < 400) { frames.push(eToLevel(e - tremAt(f))); e = Math.min(1, e + dt / p.a); f++; }
  const s = p.d > 0 ? p.s : (p.d <= 0 ? p.s : 1);
  if (p.d > 0) { while (e > s && f < 2000) { frames.push(eToLevel(e - tremAt(f))); e -= dt / p.d; f++; if (e <= 0.001) { e = 0; break; } } }
  e = Math.max(0, Math.min(e, s));
  let loop = -1;
  if (s > 0.001) {
    loop = frames.length;
    const cyc = p.trem ? Math.max(2, Math.round(fps / p.trem[1])) : 1;
    for (let k = 0; k < cyc; k++) frames.push(eToLevel(s - (p.trem ? p.trem[0] * 0.5 * (1 + Math.sin(2 * Math.PI * k / cyc)) : 0)));
  } else frames.push(0);
  const release = frames.length;
  let er = s > 0.001 ? s : 1;
  const rr = Math.max(dt, p.r);
  while (er > 0) { er -= dt / rr; frames.push(eToLevel(er)); }
  if (frames[frames.length - 1] !== 0) frames.push(0);
  // compress long macros with a step speed (Arkos-style), keeping loop/release aligned
  let speed = 1;
  while (frames.length / speed > 96) speed++;
  const ds = (i) => Math.floor(i / speed);
  const vals = [];
  for (let i = 0; i < frames.length; i += speed) vals.push(frames[i]);
  let lp = loop >= 0 ? ds(loop) : -1, rl = ds(release);
  if (lp >= 0 && lp >= rl) lp = rl - 1;
  if (vals[vals.length - 1] !== 0) vals.push(0);
  const vol = M(vals, lp, rl);

  // ---- arpeggio (integer) + pitch (fractional detune → period offsets at middle C)
  const A = p.arp0 ? p.arp0.length : 0, L = p.loop ? p.loop.length : 0;
  let arp = M([0]), pitch = M([0]);
  if (A || L) {
    const len = L ? Math.ceil(A / L) * L + L : A + 1;
    const av = [], pv = [];
    const tpRef = 424;   // C4 on a 1.77 MHz AY; period offsets are what a tracker would store
    for (let i = 0; i < len; i++) {
      const v = (i < A ? p.arp0[i] : 0) + (L ? p.loop[i % L] : 0);
      const iv = Math.round(v), fr = v - iv;
      av.push(iv);
      pv.push(Math.round(-tpRef * (1 - Math.pow(2, -fr / 12))));
    }
    const lp2 = L ? len - L : -1;
    arp = M(av, lp2);
    if (pv.some(x => x)) pitch = M(pv, lp2);
  }
  // ---- mixer + noise
  const base = p.mix === 2 ? 2 : p.mix === 1 ? 3 : 1;
  let mixer = M([base]), noise = M([p.np >= 0 ? p.np : 0]);
  if (p.atkN > 0 && p.mix === 0) {
    mixer = M([...Array(p.atkN).fill(3), base], p.atkN);
    noise = M([...Array(p.atkN).fill(p.atkNp), p.atkNp], p.atkN);
  }
  const inst = {
    name, category, kind: 'ay', role: p.role,
    vol, volSpeed: speed, arp, arpMode: 'rel', pitch, noise, noiseRel: p.np < 0 && p.mix ? 1 : 0, mixer,
    env: { shape: -1, mode: 'note', ratio: 1, period: 1000 },
    vib: p.vib ? { depth: Math.round(p.vib[0] * 100), delay: Math.round(p.vib[1] * fps), speed: Math.max(2, Math.round(fps / p.vib[2])) } : { depth: 0, delay: 0, speed: 8 },
    slide: p.sweep ? { speed: Math.round(p.sweep * 100 / fps), limit: Math.round(p.sweepMax * 100) } : { speed: 0, limit: 0 },
    transpose: p.oct * 12, prio: 0,
  };
  if (p.buzz) {
    inst.env = { shape: p.buzz === 'tri' ? 10 : p.buzz === 'sync' ? 12 : 8, mode: 'note', ratio: 1, period: 1000 };
    inst.mixer = M([p.buzz === 'sync' ? 1 : 0]);
  }
  return Object.assign(inst, extra);
}

/** Drum program (ayDrumMacro frames) → native instrument. rel: pitch relative to the GM drum note. */
function drum(n, name, rel = false) {
  const fr = ayDrumMacro(n);
  const hzToNote = (hz) => 69 + 12 * Math.log2(hz / 440);
  const vol = fr.map(x => x[0]), mixer = fr.map(x => x[1] === 0 ? 1 : x[1] === 1 ? 3 : 2), noise = fr.map(x => x[2]);
  const notes = fr.map((x, i) => x[3] > 0 ? hzToNote(x[3]) : (i ? hzToNote(fr[i - 1][3] || 440) : 69));
  const arp = notes.map(v => rel ? Math.round(v - n) : Math.round(v));
  vol.push(0);
  return {
    name, category: 'Drums', kind: 'ay', role: 'drum', prio: DRUM_PRIO[drumKind(n)] || 3,
    vol: M(vol), volSpeed: 1, arp: M(arp), arpMode: rel ? 'rel' : 'fixed', pitch: M([0]), noise: M(noise), noiseRel: 0, mixer: M(mixer),
    env: { shape: -1, mode: 'abs', ratio: 1, period: 1000 }, vib: { depth: 0, delay: 0, speed: 8 }, slide: { speed: 0, limit: 0 }, transpose: 0,
  };
}

// melodic presets: [name, category, design program, GM programs mapped to it]
const MELODIC = [
  ['Square Piano', 'Piano', 0, [0, 1, 2, 3]],
  ['Tine EP Trem', 'Piano', 4, [4, 5]],
  ['Harpsi Octave Pluck', 'Piano', 6, [6, 7]],
  ['Celesta Chime', 'Chromatic', 8, [8, 9, 10, 13, 14, 112]],
  ['Vibes Trem', 'Chromatic', 11, [11]],
  ['Marimba Knock', 'Chromatic', 12, [12, 15, 108]],
  ['Organ Square', 'Organ', 16, [16, 17, 20]],
  ['Organ Octave Arp', 'Organ', 18, [18, 19]],
  ['Accordion Vib', 'Organ', 21, [21, 22, 23]],
  ['Nylon Pluck', 'Guitar', 24, [24, 46, 105, 106, 107]],
  ['Steel Pluck +12', 'Guitar', 25, [25, 26, 27, 31]],
  ['Muted Pluck', 'Guitar', 28, [28, 45]],
  ['Overdrive Octave Arp', 'Guitar', 29, [29, 84]],
  ['Power Chord Arp', 'Guitar', 30, [30]],
  ['Finger Bass Square', 'Bass', 33, [32]],
  ['Buzzer Bass Tri', 'Bass', 33, [33, 35]],
  ['Buzzer Bass Saw', 'Bass', 34, [34, 38]],
  ['Slap Bass Arp', 'Bass', 36, [36, 37]],
  ['Synth Bass Square', 'Bass', 38, []],
  ['Env-Sync Bass', 'Bass', 39, [39]],
  ['Violin Vib', 'Strings', 40, [40, 41, 42, 110]],
  ['Contrabass', 'Strings', 43, [43, 58]],
  ['Timpani Slide', 'Strings', 47, [47, 116, 117, 118]],
  ['String Pad', 'Ensemble', 48, [44, 48, 49, 50, 51, 92]],
  ['Choir Vib', 'Ensemble', 52, [52, 53, 54, 85, 91]],
  ['Trumpet Scoop', 'Brass', 56, [56, 57, 59, 60]],
  ['Brass Section', 'Brass', 61, [55, 61, 62, 63]],
  ['Sax Breath', 'Reed', 65, [64, 65, 66, 67]],
  ['Reed Vib', 'Reed', 68, [68, 69, 70, 71, 111]],
  ['Flute Chiff', 'Pipe', 73, [72, 73, 74, 77, 78, 79]],
  ['Pan Flute T+N', 'Pipe', 75, [75, 76]],
  ['Square Lead', 'Lead', 80, [80, 82]],
  ['Chorus Lead', 'Lead', 81, [81, 83]],
  ['Fifths Arp Lead', 'Lead', 86, [86, 87, 109]],
  ['Warm Pad', 'Pad', 88, [88, 89, 90, 94, 95, 97, 99]],
  ['Metallic Arp', 'Pad', 93, [93, 98, 100, 104]],
  ['Sci-Fi Wobble', 'FX', 103, [101, 103]],
  ['Echo Drops', 'FX', 102, [96, 102]],
  ['Steel Drum', 'Percussive', 114, [113, 114, 115]],
  ['Noise Swell', 'SFX', 119, [119]],
  ['Breath Noise', 'SFX', 121, [120, 121]],
  ['Surf Noise', 'SFX', 122, [122, 125, 126]],
  ['Bird Arp', 'SFX', 123, [123, 124]],
];
// drums: [GM note used for the design, name, relative pitch, GM notes mapped to it]
const DRUMS = [
  [36, 'Kick Tone Sweep', false, [35, 36]],
  [38, 'Noise Snare', false, [38]],
  [40, 'Snare Tight', false, [40]],
  [37, 'Side Stick', false, [37]],
  [39, 'Noise Clap', false, [39]],
  [42, 'Hat Closed', false, [42, 44]],
  [46, 'Hat Open', false, [46]],
  [49, 'Crash Noise', false, [49, 52, 55, 57]],
  [51, 'Ride T+N', false, [51, 53, 59]],
  [45, 'Tom Sweep', true, [41, 43, 45, 47, 48, 50]],
  [63, 'Conga', true, [60, 61, 62, 63, 64, 65, 66, 78, 79]],
  [56, 'Cowbell 2-Tone', false, [56, 67, 68]],
  [54, 'Shaker', false, [54, 58, 69, 70, 73, 74, 82]],
  [76, 'Woodblock', true, [75, 76, 77]],
  [81, 'Triangle', false, [71, 72, 80, 81]],
];
const GM_TO_DRUM = { 127: 'Noise Snare' };   // melodic programs best played by a drum instrument

/**
 * Build a machine's library. flavor: { fps, buzzBass (GM basses → buzzer presets), ym (YM2149), name }
 * Returns { presets, gmPreset(prog), gmDrum(note) }.
 */
export function buildAYLibrary(flavor) {
  const presets = [], gm = new Array(128).fill(0), dk = new Map();
  const add = (inst) => { presets.push(inst); return presets.length - 1; };
  for (const [name, cat, prog, progs] of MELODIC) {
    let p = PATCHES[prog];
    if (name === 'Finger Bass Square' || name === 'Synth Bass Square') p = { ...p, buzz: 0 };
    const i = add(convert(p, name, cat, flavor.fps));
    for (const g of progs) gm[g] = i;
  }
  // basses without the hardware envelope on machines whose engines didn't use the buzzer trick
  if (!flavor.buzzBass) {
    const fb = presets.findIndex(p => p.name === 'Finger Bass Square'), sb = presets.findIndex(p => p.name === 'Synth Bass Square');
    gm[33] = gm[35] = fb; gm[34] = gm[38] = gm[39] = sb;
  }
  // showcase sounds
  const show = (o) => add({ kind: 'ay', category: 'Showcase', role: 'lead', volSpeed: 1, env: { shape: -1, mode: 'note', ratio: 1, period: 1000 }, arp: M([0]), arpMode: 'rel', pitch: M([0]), noise: M([0]), noiseRel: 0,
    vib: { depth: 0, delay: 0, speed: 8 }, slide: { speed: 0, limit: 0 }, transpose: 0, prio: 0, ...o });
  show({ name: 'Env-Sync Lead (T + saw env)', vol: M([15, 15, 0], 1, 2), mixer: M([1]), env: { shape: 12, mode: 'note', ratio: 1, period: 1000 }, vib: { depth: 18, delay: 18, speed: 10 } });
  show({ name: 'Buzzer Lead Saw', vol: M([15, 0], 0, 1), mixer: M([0]), env: { shape: 8, mode: 'note', ratio: 1, period: 1000 }, transpose: -12, vib: { depth: 12, delay: 20, speed: 9 } });
  show({ name: 'Envelope Pluck (shape 9)', role: 'chord', vol: M([15, 0], 0, 1), mixer: M([1]), env: { shape: 9, mode: 'abs', ratio: 1, period: 2400 } });
  if (!flavor.ym) show({ name: 'Envelope Tremolo (shape 14)', role: 'pad', vol: M([15, 0], 0, 1), mixer: M([1]), env: { shape: 14, mode: 'abs', ratio: 1, period: 900 } });
  show({ name: 'Major Arp Chord', role: 'chord', vol: M([13, 12, 11, 0], 2, 3), mixer: M([1]), arp: M([0, 4, 7], 0) });
  if (flavor.ym) show({ name: 'YM 32-Step Saw Pad', role: 'pad', vol: M([15, 0], 0, 1), mixer: M([0]), env: { shape: 12, mode: 'note', ratio: 0.5, period: 1000 }, vib: { depth: 10, delay: 10, speed: 14 } });
  for (const [n, name, rel, notes] of DRUMS) {
    const i = add(drum(n, name, rel));
    for (const k of notes) dk.set(k, i);
  }
  for (const [prog, nm] of Object.entries(GM_TO_DRUM)) gm[prog] = presets.findIndex(p => p.name === nm);
  const perc = presets.findIndex(p => p.name === 'Side Stick');
  return {
    presets,
    gmPreset: (prog) => gm[prog & 127],
    gmDrum: (note) => dk.has(note) ? dk.get(note) : (note >= 27 && note <= 87 ? perc : -1),
  };
}

export const defaultMacro = M;
