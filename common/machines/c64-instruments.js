import { cutoffReg } from './sid.js';

// Commodore 64 native instruments (GoatTracker-style) + the GM → instrument mapping. Original designs for RetroSynths
// in the style of mid-80s C64 game music engines: wave tables, PWM, filter sweeps, Hubbard-style drums.
//
// The library below was first written in a compact authoring form (OLD / DRUMS) and is converted at load time
// into the native instrument format the driver, the Arranger and the editor use:
//
//   { name, category, kind: 'sid',
//     a, d, s, r          SID envelope nibbles 0–15 (attack 2 ms … 8 s, decay/release 6 ms … 24 s, sustain × 17)
//     hr                  1 = hard restart (gate off + ADSR $00 for two frames before the note, when the ADSR bug is on)
//     gateOff             frames after which the gate is released (0 = hold until note-off)
//     wave, loop          wave table, one row per frame: [control bits, note, abs]. Control = $10 tri | $20 saw | $40 pulse
//                         | $80 noise | $04 ring | $02 sync | $01 gate. note = semitones relative to the key, or a fixed MIDI
//                         note when abs = 1. After the last row the table jumps to row `loop` (−1 = stay on the last row)
//     pulse               { width 0–4095 (12-bit), speed (added per frame), lo, hi (bounce limits) }
//     filter              { route 0/1, mode $10 LP | $20 BP | $40 HP, res 0–15, cut → peak (11-bit cutoff register)
//                           over atk frames, then towards end by `rate` per frame; track = register units per octave of
//                           key; vel = register units for full velocity; lfo (Hz) / lfoDepth (register units) }
//     vib                 { depth (cents), delay (frames), rate (Hz) }
//     slide               { speed (semitones / frame), limit (semitones), delay (frames) }
//     src                 { ratio, to, frames } tuning of the ring / sync source voice relative to the note (swept)
//     transpose           semitones
//     drum                { prio 1–5 (who wins a clash on the drum voice), hold (frames it keeps the voice) } }
//
// Authoring-form fields (OLD, all optional except w/ad/sr):
//   w        main waveform bits ($10 tri, $20 saw, $40 pulse, $80 noise; $04 ring, $02 sync), no gate bit
//   ad, sr   SID attack/decay and sustain/release register values
//   pw       initial 12-bit pulse width; pwm = change per frame (bounces between pwlo and pwhi)
//   at       attack wave table, one entry per frame: [wave, semitone offset] or [wave, 0, fixed MIDI note]
//   arp      per-frame arpeggio offsets (semitones), cycled
//   vib/vdl/vhz   built-in vibrato depth (semitones), delay (frames), rate (Hz)
//   slide/smax    pitch slide (semitones per frame) and its limit
//   gate     auto gate-off after this many frames (percussive), chop = gate on/off period in frames
//   mod      ring/sync ratio: ring → source voice at note × mod; sync → this voice at note × mod over a
//            source at the note (modTo/modFr sweep the ratio). fw = waveform used when no source voice is free
//   oct      octave shift; nfix = fixed MIDI note for noise-based instruments (−1: follow the key)
//   f        filter mode wanted ($10 LP, $20 BP, $40 HP): f0 → f1 (Hz) over fa frames, then towards f2;
//            res = resonance 0..15; fkt = key tracking; fl/fld = filter LFO rate (Hz) / depth (octaves)

export const T = 0x10, S = 0x20, P = 0x40, N = 0x80, RING = 0x04, SYNC = 0x02;
export const LP = 0x10, BP = 0x20, HP = 0x40;

const BASE = {
  w: P, ad: 0x09, sr: 0x00, pw: 0x800, pwm: 0, pwlo: 0x100, pwhi: 0xf00, at: null, arp: null,
  vib: 0, vdl: 0, vhz: 5.5, slide: 0, smax: 24, gate: 0, chop: 0, mod: 0, modTo: 0, modFr: 1, fw: 0, oct: 0,
  f: 0, f0: 2000, f1: 0, fa: 0, f2: 0, fk: 0.12, res: 0, fkt: 0.3, fl: 0, fld: 0, nfix: -1,
};
function I(w, ad, sr, x = {}) {
  const o = { ...BASE, w, ad, sr, ...x };
  if (!o.f1) o.f1 = o.f0;
  if (!o.f2) o.f2 = o.f1;
  if (!o.fw) o.fw = w & 0xf0;
  if (!o.modTo) o.modTo = o.mod;
  o.at = o.at ? o.at.map(e => [e[0], e[1] || 0, e.length > 2 ? e[2] : -1]) : [];
  return o;
}

const OLD = [
  // --- piano 0-7
  I(P, 0x0a, 0x39, { pw: 0x500, pwm: 12, pwlo: 0x300, pwhi: 0x900, at: [[S, 0]] }),
  I(P, 0x0a, 0x49, { pw: 0x300, pwm: 16, pwlo: 0x200, pwhi: 0x700, at: [[S, 12]] }),
  I(S, 0x09, 0x58, { f: LP, f0: 6000, f1: 6000, f2: 1800, fk: 0.05, res: 2 }),
  I(P, 0x0a, 0x39, { pw: 0x600, vib: 0.12, vhz: 9, at: [[S, 0]] }),
  I(T, 0x0a, 0x58, { at: [[P, 12]] }),
  I(T | RING, 0x09, 0x48, { mod: 2, fw: T, at: [[P, 12]] }),
  I(P, 0x08, 0x08, { pw: 0x180, pwm: 6, pwlo: 0x100, pwhi: 0x300 }),
  I(P, 0x07, 0x16, { pw: 0x100, pwm: 30, pwlo: 0x080, pwhi: 0x600, f: LP, f0: 5000, f2: 900, fk: 0.2, res: 6 }),
  // --- chromatic percussion 8-15
  I(T | RING, 0x08, 0x08, { mod: 4, fw: T, oct: 1 }),
  I(T | RING, 0x08, 0x09, { mod: 3.5, fw: T, oct: 1, at: [[P, 0]] }),
  I(T | RING, 0x09, 0x09, { mod: 2, fw: T, oct: 1 }),
  I(T, 0x0a, 0x2a, { vib: 0.15, vhz: 5, at: [[P, 24]] }),
  I(T, 0x07, 0x07, { at: [[P, 12]] }),
  I(T, 0x05, 0x05, { oct: 1, at: [[N, 0, 100]] }),
  I(T | RING, 0x0b, 0x0b, { mod: 2.76, fw: T }),
  I(P, 0x09, 0x09, { pw: 0x280, pwm: 10, at: [[S, 0]] }),
  // --- organ 16-23
  I(P, 0x00, 0xf3, { pw: 0x800 }),
  I(P, 0x06, 0xa3, { pw: 0x600, at: [[P, 12], [P, 12]] }),
  I(P, 0x00, 0xf4, { pw: 0x700, vib: 0.18, vhz: 7 }),
  I(P | S, 0x40, 0xf9, { pw: 0x800, pwm: 4, pwlo: 0x700, pwhi: 0x900 }),
  I(P, 0x20, 0xe5, { pw: 0x300 }),
  I(P, 0x20, 0xd5, { pw: 0x500, pwm: 8, pwlo: 0x400, pwhi: 0x600, vib: 0.1, vhz: 6 }),
  I(P, 0x30, 0xc4, { pw: 0x200, vib: 0.25, vdl: 12 }),
  I(P, 0x10, 0xd5, { pw: 0x380, vib: 0.12, vhz: 7 }),
  // --- guitar 24-31
  I(T, 0x09, 0x08, { at: [[P, 0]] }),
  I(P, 0x09, 0x09, { pw: 0x300, pwm: 20, pwlo: 0x200, pwhi: 0x800 }),
  I(T, 0x0a, 0x18, { at: [[P, 0]] }),
  I(P, 0x0a, 0x29, { pw: 0x600, pwm: 10 }),
  I(P, 0x05, 0x04, { pw: 0x400 }),
  I(S | SYNC, 0x09, 0xa8, { mod: 1.6, modTo: 2.6, modFr: 30, fw: S, f: LP, f0: 4000, f2: 2500, res: 6, vib: 0.15, vdl: 20 }),
  I(P | SYNC, 0x09, 0xb8, { pw: 0x200, mod: 2, modTo: 3, modFr: 20, fw: S, f: LP, f0: 3500, f2: 2200, res: 8, vib: 0.2, vdl: 20 }),
  I(T, 0x06, 0x06, { oct: 1 }),
  // --- bass 32-39
  I(T, 0x09, 0x46, { at: [[P, 0]] }),
  I(P, 0x09, 0x56, { pw: 0x400, pwm: 10, pwlo: 0x300, pwhi: 0x700, f: LP, f0: 2200, f2: 700, fk: 0.15, res: 4 }),
  I(S, 0x08, 0x46, { f: LP, f0: 3000, f2: 800, fk: 0.18, res: 5 }),
  I(T, 0x19, 0x86, { vib: 0.12, vdl: 15 }),
  I(P, 0x08, 0x36, { pw: 0x300, at: [[N, 0, 90], [P, 12]] }),
  I(S, 0x08, 0x36, { at: [[P, 12]], f: LP, f0: 4000, f2: 900, fk: 0.2, res: 6 }),
  I(S, 0x0a, 0x75, { f: LP, f0: 3000, f2: 280, fk: 0.22, res: 10, fkt: 0.5 }),
  I(P, 0x09, 0x86, { pw: 0x300, pwm: 40, pwlo: 0x200, pwhi: 0xc00, f: LP, f0: 2000, f2: 400, fk: 0.15, res: 8, fkt: 0.5 }),
  // --- strings 40-47
  I(S, 0x59, 0xb8, { vib: 0.2, vdl: 15, vhz: 6, f: LP, f0: 3500, res: 1 }),
  I(S, 0x69, 0xa8, { vib: 0.18, vdl: 15, f: LP, f0: 2800, res: 1 }),
  I(S, 0x69, 0xb8, { vib: 0.15, vdl: 18, f: LP, f0: 2200, res: 1 }),
  I(S, 0x59, 0xa7, { vib: 0.1, vdl: 18, f: LP, f0: 1500, res: 2 }),
  I(S, 0x10, 0xa3, { chop: 3 }),
  I(P, 0x06, 0x05, { pw: 0x500 }),
  I(T, 0x0a, 0x0a, { at: [[P, 0]] }),
  I(T, 0x0a, 0x09, { oct: -1, at: [[N, 0, 70]], slide: -0.08, smax: 0.5 }),
  // --- ensemble 48-55
  I(P, 0x88, 0xc9, { pw: 0x400, pwm: 24, pwlo: 0x200, pwhi: 0xe00, vib: 0.1, vdl: 20 }),
  I(P, 0xa9, 0xca, { pw: 0x600, pwm: 16, pwlo: 0x300, pwhi: 0xd00 }),
  I(S, 0x89, 0xb9, { f: LP, f0: 1200, f1: 4000, fa: 25, f2: 4000, res: 3 }),
  I(P, 0x99, 0xba, { pw: 0x300, pwm: 32, pwlo: 0x200, pwhi: 0xe00 }),
  I(P | T, 0x99, 0xc9, { pw: 0x400, pwm: 6, pwlo: 0x200, pwhi: 0x800, vib: 0.15, vdl: 10 }),
  I(T, 0x89, 0xc8, { vib: 0.12, vdl: 10 }),
  I(P, 0x79, 0xb8, { pw: 0x700, pwm: 12, f: BP, f0: 1200, res: 10 }),
  I(S, 0x08, 0x08, { at: [[N, 0, 85]], arp: [0, 12, 7], f: LP, f0: 6000, f2: 1500, fk: 0.25, res: 3 }),
  // --- brass 56-63
  I(S, 0x39, 0xa6, { vib: 0.2, vdl: 18, f: LP, f0: 600, f1: 5000, fa: 4, f2: 2500, res: 4 }),
  I(S, 0x49, 0xa6, { f: LP, f0: 400, f1: 3000, fa: 5, f2: 1500, res: 4 }),
  I(S, 0x49, 0xa5, { f: LP, f0: 300, f1: 1500, fa: 5, f2: 700, res: 3, fkt: 0.5 }),
  I(P, 0x29, 0x96, { pw: 0x180, vib: 0.15, vdl: 15, f: BP, f0: 1500, res: 8 }),
  I(S, 0x69, 0xb7, { f: LP, f0: 300, f1: 1500, fa: 10, f2: 1000, res: 2 }),
  I(S, 0x39, 0xb7, { f: LP, f0: 500, f1: 6000, fa: 4, f2: 3000, res: 3 }),
  I(S, 0x29, 0xa6, { f: LP, f0: 300, f1: 6000, fa: 3, f2: 1200, res: 9 }),
  I(P, 0x29, 0xa6, { pw: 0x500, pwm: 20, f: LP, f0: 400, f1: 4000, fa: 4, f2: 1500, res: 7 }),
  // --- reed 64-71
  I(P, 0x29, 0xa6, { pw: 0x300, vib: 0.2, vdl: 15 }),
  I(P, 0x29, 0xa6, { pw: 0x380, vib: 0.2, vdl: 15, at: [[N, 0, 80]] }),
  I(P, 0x39, 0xa6, { pw: 0x400, vib: 0.18, vdl: 15, f: LP, f0: 2500, res: 2 }),
  I(P, 0x39, 0xa6, { pw: 0x500, vib: 0.15, vdl: 18, f: LP, f0: 1800, res: 2 }),
  I(P, 0x29, 0xb5, { pw: 0x180, vib: 0.15, vdl: 12 }),
  I(P, 0x39, 0xb5, { pw: 0x200, vib: 0.15, vdl: 15 }),
  I(P, 0x39, 0xb5, { pw: 0x280, f: LP, f0: 1500, res: 2 }),
  I(P, 0x29, 0xb5, { pw: 0x800, vib: 0.1, vdl: 20 }),
  // --- pipe 72-79
  I(T, 0x29, 0xb5, { oct: 1, vib: 0.15, vdl: 10 }),
  I(T, 0x39, 0xa6, { vib: 0.2, vdl: 12, at: [[N, 0, 96]] }),
  I(T, 0x29, 0xb4, { at: [[P | T, 0]] }),
  I(T, 0x49, 0xa6, { vib: 0.15, vdl: 15, at: [[N, 0, 90], [N, 0, 90]] }),
  I(T, 0x69, 0x96, { at: [[N, 0, 84], [N, 0, 84], [N, 0, 84]] }),
  I(T, 0x49, 0x96, { vib: 0.3, vdl: 6, at: [[N, 0, 88], [N, 0, 84]] }),
  I(T, 0x19, 0xc4, { oct: 1, vib: 0.2 }),
  I(T, 0x29, 0xc5, { vib: 0.1, vdl: 20 }),
  // --- lead 80-87
  I(P, 0x09, 0xa6, { pw: 0x800, vib: 0.25, vdl: 15 }),
  I(S, 0x09, 0xa6, { vib: 0.25, vdl: 15 }),
  I(T, 0x19, 0xc5, { vib: 0.2, vhz: 6 }),
  I(P, 0x09, 0x96, { pw: 0x400, pwm: 20, pwlo: 0x200, pwhi: 0xc00, at: [[N, 0, 100]] }),
  I(S | SYNC, 0x09, 0xa6, { mod: 1.0, modTo: 3.0, modFr: 25, fw: S, vib: 0.2, vdl: 20 }),
  I(T | P, 0x49, 0xb6, { pw: 0x600, pwm: 8, pwlo: 0x400, pwhi: 0x900, vib: 0.2, vdl: 12, f: LP, f0: 1400, res: 10, fkt: 0.6 }),
  I(P, 0x09, 0xa6, { pw: 0x600, arp: [0, 7] }),
  I(S, 0x09, 0xa6, { f: LP, f0: 2000, f2: 800, res: 9, fkt: 0.5 }),
  // --- pad 88-95
  I(T | RING, 0x8a, 0xab, { mod: 2, fw: T }),
  I(P, 0xaa, 0xca, { pw: 0x700, pwm: 10, f: LP, f0: 1200, res: 2 }),
  I(S, 0x49, 0x99, { f: LP, f0: 3000, f2: 1200, fk: 0.06, res: 3 }),
  I(T, 0xa9, 0xca, { vib: 0.15, vdl: 10 }),
  I(S, 0xb9, 0xba, { f: LP, f0: 800, f1: 2500, fa: 40, res: 4 }),
  I(T | RING, 0x8a, 0xab, { mod: 1.41, fw: T }),
  I(P | T, 0xba, 0xcb, { pw: 0x200, pwm: 16, pwlo: 0x100, pwhi: 0xa00, vib: 0.12, vdl: 20 }),
  I(S, 0x9a, 0xbb, { f: LP, f0: 1500, res: 7, fl: 0.4, fld: 1.8 }),
  // --- fx 96-103
  I(T | RING, 0x08, 0x09, { mod: 3, fw: T }),
  I(P, 0xaa, 0xbb, { pw: 0x400, pwm: 30, f: LP, f0: 600, f1: 3000, fa: 50, res: 3 }),
  I(T | RING, 0x0a, 0x0b, { mod: 5, fw: T, oct: 1, arp: [0, 0, 12, 12] }),
  I(P | T, 0x8a, 0xab, { pw: 0x300, pwm: 20, pwlo: 0x100, pwhi: 0xc00 }),
  I(S, 0x6a, 0xab, { f: HP, f0: 1500, res: 6 }),
  I(S | SYNC, 0xaa, 0xab, { mod: 1.5, modTo: 2.5, modFr: 80, fw: S, vib: 0.4, vhz: 1.5 }),
  I(P, 0x08, 0x08, { pw: 0x400, chop: 8 }),
  I(T, 0x6a, 0xab, { vib: 2, vhz: 3 }),
  // --- ethnic 104-111
  I(S, 0x0a, 0x0a, { f: BP, f0: 2000, res: 12, vib: 0.1, vdl: 15 }),
  I(P, 0x07, 0x06, { pw: 0x200 }),
  I(P, 0x07, 0x06, { pw: 0x100, at: [[N, 0, 90]] }),
  I(T, 0x09, 0x08, { at: [[P, 0], [P, 0]], vib: 0.1, vdl: 15 }),
  I(T, 0x06, 0x06, { at: [[P | T, 12]] }),
  I(P, 0x10, 0xf6, { pw: 0x300, vib: 0.08, vhz: 7 }),
  I(S, 0x39, 0xa6, { vib: 0.25, vdl: 8, vhz: 7 }),
  I(P, 0x29, 0xb5, { pw: 0x1a0, vib: 0.3, vdl: 5, vhz: 7 }),
  // --- percussive 112-119
  I(T | RING, 0x08, 0x09, { mod: 4.2, fw: T, oct: 1 }),
  I(T, 0x06, 0x06, { oct: 1, at: [[P, 0]] }),
  I(T | RING, 0x08, 0x08, { mod: 1.5, fw: T }),
  I(T, 0x05, 0x05, { oct: 1, at: [[N, 0, 96], [P, 0]], slide: -0.5, smax: 3 }),
  I(T, 0x08, 0x08, { oct: -1, at: [[N, 0, 80]], slide: -0.4, smax: 6 }),
  I(T, 0x08, 0x07, { at: [[N, 0, 90]], slide: -0.3, smax: 6 }),
  I(P, 0x08, 0x07, { slide: -0.6, smax: 12 }),
  I(N, 0xa0, 0x02, { nfix: 100 }),
  // --- sound effects 120-127
  I(N, 0x05, 0x05, { nfix: 84, at: [[P, 12]], slide: -1, smax: 8 }),
  I(N, 0x59, 0x86, { nfix: 70, f: BP, f0: 1500, res: 4 }),
  I(N, 0xaa, 0x8c, { nfix: 80, f: LP, f0: 1200, res: 2, fl: 0.15, fld: 1.5 }),
  I(T, 0x19, 0x86, { oct: 2, vib: 1.5, vhz: 12, slide: 0.15, smax: 3 }),
  I(P, 0x00, 0xf0, { oct: 1, arp: [0, 0, 4, 4], chop: 6 }),
  I(N, 0x00, 0xf0, { nfix: 50, chop: 3, f: LP, f0: 700, res: 4 }),
  I(N, 0x29, 0xa6, { nfix: 90, chop: 2 }),
  I(N, 0x09, 0x08, { nfix: 75, at: [[N, 0, 100]], slide: -0.5, smax: 12 }),
];

// ---------------------------------------------------------------- drums
// Each drum is a per-frame wave table on one voice, Hubbard-style:
//   seq: [[wave, MIDI note, (pulse width)] per frame]; the last entry repeats (with slide semitones/frame)
//   ad/sr: envelope; g: frames before gate-off; len: frames the drum holds its voice; prio: who wins a clash
const D = (seq, ad, sr, g, len, prio, x = {}) => ({ seq, ad, sr, g, len, prio, slide: 0, ...x });
const tom = (n) => D([[N, 92], [P, n + 14], [T, n + 12], [T, n + 11]], 0x08, 0x00, 6, 8, 3, { slide: -0.5 });
const conga = (n) => D([[P, n + 12], [T, n + 5], [T, n + 4]], 0x06, 0x00, 3, 5, 2, { slide: -0.3 });

const DRUMS = {
  35: D([[N, 94], [P, 55], [P, 47], [T, 42], [T, 38], [T, 35], [T, 33], [T, 31]], 0x08, 0x00, 6, 7, 5),
  36: D([[N, 98], [P, 58], [P, 50], [T, 45], [T, 40], [T, 37], [T, 35], [T, 33]], 0x08, 0x00, 6, 7, 5),
  37: D([[N, 100], [T, 84]], 0x03, 0x00, 2, 3, 3),
  38: D([[N, 100], [P, 64], [P, 60], [N, 92], [N, 91], [N, 90], [N, 89]], 0x08, 0x00, 5, 6, 4),
  39: D([[N, 98], [N, 92], [N, 98], [N, 94], [N, 92]], 0x06, 0x00, 4, 5, 3),
  40: D([[N, 104], [P, 67], [N, 96], [N, 95], [N, 94], [N, 93]], 0x08, 0x00, 5, 6, 4),
  41: tom(41), 43: tom(45), 45: tom(48), 47: tom(52), 48: tom(55), 50: tom(59),
  42: D([[N, 107], [N, 107]], 0x02, 0x00, 1, 2, 1),
  44: D([[N, 104], [N, 104]], 0x01, 0x00, 1, 2, 1),
  46: D([[N, 107]], 0x08, 0x08, 8, 10, 1),
  49: D([[N, 104], [N, 103]], 0x0b, 0x0a, 20, 25, 2),
  51: D([[N, 101], [N, 100]], 0x09, 0x08, 4, 8, 1),
  52: D([[N, 98], [N, 97]], 0x0a, 0x09, 12, 18, 2),
  53: D([[T, 96], [T, 96]], 0x09, 0x08, 3, 8, 1),
  54: D([[N, 107], [N, 105], [N, 107]], 0x05, 0x00, 3, 4, 1),
  55: D([[N, 105]], 0x0a, 0x09, 8, 14, 2),
  56: D([[P, 79, 0x800], [P, 86, 0x800]], 0x06, 0x00, 4, 6, 2),
  57: D([[N, 103], [N, 102]], 0x0b, 0x0a, 20, 25, 2),
  58: D([[N, 90], [N, 0], [N, 90], [N, 0], [N, 88], [N, 0], [N, 86]], 0x0a, 0x00, 7, 9, 1),
  59: D([[N, 102], [T, 98]], 0x09, 0x08, 4, 8, 1),
  60: conga(72), 61: conga(67), 62: conga(70), 63: conga(67), 64: conga(62),
  65: D([[P, 76, 0x600], [T, 76], [T, 76]], 0x07, 0x00, 3, 5, 2),
  66: D([[P, 71, 0x600], [T, 71], [T, 71]], 0x07, 0x00, 3, 5, 2),
  67: D([[P, 91, 0x300], [T, 91]], 0x06, 0x00, 3, 5, 1),
  68: D([[P, 86, 0x300], [T, 86]], 0x06, 0x00, 3, 5, 1),
  69: D([[N, 105], [N, 104]], 0x04, 0x00, 2, 3, 1),
  70: D([[N, 107]], 0x03, 0x00, 1, 2, 1),
  71: D([[T, 96]], 0x00, 0xf2, 6, 7, 1, { slide: 0.05 }),
  72: D([[T, 96]], 0x00, 0xf3, 14, 15, 1, { slide: -0.03 }),
  73: D([[N, 92], [N, 96], [N, 92], [N, 96]], 0x02, 0x00, 4, 5, 1),
  74: D([[N, 92], [N, 96], [N, 92], [N, 96], [N, 92], [N, 96], [N, 92]], 0x05, 0x00, 7, 8, 1),
  75: D([[T, 91]], 0x03, 0x00, 1, 3, 1),
  76: D([[P, 88, 0x400], [T, 88]], 0x04, 0x00, 2, 3, 1),
  77: D([[P, 83, 0x400], [T, 83]], 0x04, 0x00, 2, 3, 1),
  78: D([[T, 72]], 0x14, 0x00, 4, 6, 1, { slide: 1 }),
  79: D([[T, 70]], 0x14, 0x00, 4, 6, 1, { slide: -1 }),
  80: D([[T, 100]], 0x04, 0x00, 1, 3, 1),
  81: D([[T, 100]], 0x0a, 0x09, 6, 15, 1),
  82: D([[N, 106]], 0x03, 0x00, 1, 2, 1),
};
const PERC = D([[N, 96], [T, 70], [T, 66]], 0x06, 0x00, 3, 4, 1, { slide: -0.4 });


// ---------------------------------------------------------------- conversion to the native format
const reg = (hz) => cutoffReg('6581', hz);                  // presets are voiced for the 6581 (the default model)
const slope = (hz) => Math.max(40, reg(hz * Math.SQRT2) - reg(hz / Math.SQRT2));   // register units per octave there
const gcd = (a, b) => b ? gcd(b, a % b) : a;

function fromOld(o, name, category, extra = {}) {
  const wave = [];
  for (const e of o.at) wave.push(e[2] >= 0 ? [e[0] | 1, e[2], 1] : [e[0] | 1, e[1], 0]);
  const loopAt = wave.length;
  const al = o.arp ? o.arp.length : 1, ch = o.chop || 1, P = al * ch / gcd(al, ch);
  for (let k = 0; k < P; k++) {
    const gate = o.chop && k % o.chop === o.chop - 1 ? 0 : 1;
    if (o.nfix >= 0 && (o.w & N)) wave.push([o.w | gate, o.nfix - 60, 0]);
    else wave.push([o.w | gate, o.arp ? o.arp[k % al] : 0, 0]);
  }
  const f = o.f ? { route: 1, mode: o.f, res: o.res, cut: reg(o.f0), peak: reg(o.f1), atk: o.fa, end: reg(o.f2), rate: o.fk,
    track: Math.round(o.fkt * slope(o.f2)), vel: Math.round(0.5 * slope(o.f2)), lfo: o.fl, lfoDepth: Math.round(o.fld * slope(o.f0)) }
    : { route: 0, mode: LP, res: 0, cut: 1024, peak: 1024, atk: 0, end: 1024, rate: 0.12, track: 0, vel: 0, lfo: 0, lfoDepth: 0 };
  return {
    name, category, kind: 'sid',
    a: o.ad >> 4, d: o.ad & 15, s: o.sr >> 4, r: o.sr & 15, hr: 1, gateOff: o.gate,
    wave, loop: P > 1 ? loopAt : -1,
    pulse: { width: o.pw, speed: o.pwm, lo: o.pwlo, hi: o.pwhi },
    filter: f,
    vib: { depth: Math.round(o.vib * 100), delay: o.vdl, rate: o.vhz },
    slide: { speed: o.slide, limit: o.smax, delay: 0 },
    src: { ratio: o.mod || 1, to: o.modTo || o.mod || 1, frames: o.modFr },
    transpose: o.oct * 12,
    drum: { prio: 1, hold: 12 },
    ...extra,
  };
}
/** Drum sequence → native instrument. relTo: tonal rows become relative to that key (so one preset covers a set of pitches). */
function fromDrum(d, name, relTo = -1) {
  const L = d.seq.length, n = Math.max(L, d.g + 1), wave = [];
  let pw = 0x800;
  for (let t = 0; t < n; t++) {
    const e = d.seq[t < L ? t : L - 1];
    if (e.length > 2 && t < L) pw = e[2];
    const rel = relTo >= 0 && !(e[0] & N);
    wave.push([e[0] | (t < d.g ? 1 : 0), rel ? e[1] - relTo : e[1], rel ? 0 : 1]);
  }
  return {
    name, category: 'Drums', kind: 'sid',
    a: d.ad >> 4, d: d.ad & 15, s: d.sr >> 4, r: d.sr & 15, hr: 1, gateOff: 0,
    wave, loop: -1,
    pulse: { width: pw, speed: 0, lo: 0x100, hi: 0xf00 },
    filter: { route: 0, mode: LP, res: 0, cut: 1024, peak: 1024, atk: 0, end: 1024, rate: 0.12, track: 0, vel: 0, lfo: 0, lfoDepth: 0 },
    vib: { depth: 0, delay: 0, rate: 5.5 },
    slide: { speed: d.slide, limit: 48, delay: L },
    src: { ratio: 1, to: 1, frames: 1 },
    transpose: 0,
    drum: { prio: d.prio, hold: d.len },
  };
}

// [name, category, authoring program, GM programs mapped to it]
const MELODIC = [
  ['Pulse Piano', 'Piano', 0, [0, 1, 3]],
  ['Saw E.Grand LP', 'Piano', 2, [2]],
  ['Tri E.Piano', 'Piano', 4, [4]],
  ['Ring E.Piano', 'Piano', 5, [5]],
  ['Narrow Pulse Harpsichord', 'Piano', 6, [6]],
  ['Pulse Clav Sweep', 'Piano', 7, [7]],
  ['Ring Celesta', 'Chromatic', 8, [8, 112, 114]],
  ['Ring Glockenspiel', 'Chromatic', 9, [9, 10]],
  ['Tri Vibes', 'Chromatic', 11, [11]],
  ['Tri Marimba', 'Chromatic', 12, [12, 31, 108, 113]],
  ['Noise-Tick Xylophone', 'Chromatic', 13, [13]],
  ['Ring Tubular Bell', 'Chromatic', 14, [14]],
  ['Square Organ', 'Organ', 16, [16, 17, 20]],
  ['Leslie Square Organ', 'Organ', 18, [18]],
  ['Pulse+Saw Church Organ', 'Organ', 19, [19]],
  ['PWM Accordion', 'Organ', 21, [21, 23]],
  ['Tri Nylon Pluck', 'Guitar', 24, [24, 26, 46, 107]],
  ['PWM Steel Guitar', 'Guitar', 25, [25, 27]],
  ['Muted Pulse Pluck', 'Guitar', 28, [28, 45]],
  ['Pulse Banjo', 'Guitar', 105, [15, 105, 106]],
  ['Sync Overdrive Guitar', 'Guitar', 29, [29, 30]],
  ['Tri Bass', 'Bass', 32, [32, 35]],
  ['Finger Bass LP', 'Bass', 33, [33]],
  ['Saw Pick Bass', 'Bass', 34, [34, 37]],
  ['Slap Bass Noise Pop', 'Bass', 36, [36]],
  ['Saw Filter-Sweep Bass', 'Bass', 38, [38, 87]],
  ['PWM Filter Bass', 'Bass', 39, [39]],
  ['Saw Violin', 'Strings', 40, [40, 41, 110]],
  ['Saw Cello', 'Strings', 42, [42, 43]],
  ['Gate-Chop Tremolo Strings', 'Strings', 44, [44]],
  ['Noise-Hit Timpani', 'Strings', 47, [47, 116]],
  ['PWM String Pad', 'Ensemble', 48, [48, 49, 51]],
  ['Saw Filter Strings', 'Ensemble', 50, [50, 90, 92]],
  ['Tri&Pulse Choir', 'Ensemble', 52, [52, 53, 91, 94, 99]],
  ['Resonant Synth Voice', 'Ensemble', 54, [54, 85]],
  ['Arp Orchestra Hit', 'Ensemble', 55, [55]],
  ['Saw Trumpet Sweep', 'Brass', 56, [56, 57, 61]],
  ['Saw Tuba', 'Brass', 58, [58, 60]],
  ['BP Muted Trumpet', 'Brass', 59, [59]],
  ['Resonant Synth Brass', 'Brass', 62, [62, 63]],
  ['Pulse Sax', 'Reed', 64, [22, 64, 65, 66, 67, 109]],
  ['Narrow Pulse Oboe', 'Reed', 68, [68, 69, 70, 111]],
  ['Square Clarinet', 'Reed', 71, [71]],
  ['Tri Flute Chiff', 'Pipe', 73, [72, 73, 74, 78, 79, 82]],
  ['Noise-Breath Pan Flute', 'Pipe', 75, [75, 76, 77]],
  ['Square Lead', 'Lead', 80, [80, 83]],
  ['Saw Lead', 'Lead', 81, [81]],
  ['Sync Sweep Lead', 'Lead', 84, [84, 101]],
  ['Fifths Arp Lead', 'Lead', 86, [86]],
  ['Ring Pad', 'Pad', 88, [88, 93, 96, 98]],
  ['Warm PWM Pad', 'Pad', 89, [89, 97]],
  ['Filter-LFO Sweep Pad', 'Pad', 95, [95]],
  ['HP Saw Shimmer', 'FX', 100, [100]],
  ['Gate-Echo Pulse', 'FX', 102, [102, 124]],
  ['Tri Sci-Fi Wobble', 'FX', 103, [103]],
  ['BP Saw Sitar', 'Ethnic', 104, [104]],
  ['Reverse Noise Swell', 'SFX', 119, [119]],
  ['Noise Wind', 'SFX', 121, [121, 122]],
  ['Tri Bird Chirp', 'SFX', 123, [123]],
  ['Noise Chopper', 'SFX', 125, [125, 126]],
  ['Noise Shot', 'SFX', 127, [120, 127]],
];
// [name, drum sequence, relTo, GM drum notes]
const DRUMSET = [
  ['Hubbard Kick', DRUMS[36], 36, [35, 36]],
  ['Hubbard Snare', DRUMS[38], -1, [38]],
  ['Noise E-Snare', DRUMS[40], -1, [40]],
  ['Noise Clap', DRUMS[39], -1, [39]],
  ['Noise Closed Hat', DRUMS[42], -1, [42, 44]],
  ['Noise Open Hat', DRUMS[46], -1, [46]],
  ['Tri Tom', DRUMS[45], 45, [41, 43, 45, 47, 48, 50]],
  ['Noise Crash', DRUMS[49], -1, [49, 52, 55, 57]],
  ['Noise Ride', DRUMS[51], -1, [51, 59]],
  ['Tri Ping', DRUMS[81], -1, [53, 81]],
  ['Noise Shaker', DRUMS[54], -1, [54, 58, 69, 70, 73, 74, 82]],
  ['Pulse Cowbell', DRUMS[56], -1, [56]],
  ['Tri Conga', DRUMS[62], 62 - 6, [60, 61, 62, 63, 64, 65, 66]],
  ['Tri Block', DRUMS[76], 76, [37, 67, 68, 75, 76, 77, 80]],
  ['Tri Whistle', DRUMS[72], -1, [71, 72, 78, 79]],
  ['Noise Perc', PERC, 60, []],
];

const PRESETS = [];
const GM = new Array(128).fill(0), KIT = {};
for (const [name, cat, prog, gm] of MELODIC) { const i = PRESETS.length; PRESETS.push(fromOld(OLD[prog], name, cat)); for (const g of gm) GM[g] = i; }
// showcase sounds (not on the GM map)
PRESETS.push(fromOld(I(P, 0x09, 0xa6, { pw: 0x400, pwm: 24, pwlo: 0x200, pwhi: 0xc00, arp: [0, 4, 7] }), 'Major Chord Arp', 'Lead'));
PRESETS.push(fromOld(I(P, 0x09, 0x86, { pw: 0x300, pwm: 48, pwlo: 0x200, pwhi: 0xd00, at: [[P, 12], [P, 12]], f: LP, f0: 2500, f2: 600, fk: 0.2, res: 9 }), 'Octave-Pop PWM Bass', 'Bass'));
const PERC_IDX = PRESETS.length + DRUMSET.length - 1;
for (const [name, d, rel, notes] of DRUMSET) { const i = PRESETS.length; PRESETS.push(fromDrum(d, name, rel)); for (const n of notes) KIT[n] = i; }
GM[117] = KIT[45]; GM[118] = KIT[45]; GM[115] = KIT[76];

export { PRESETS };
export const gmPreset = (program) => GM[program & 127];
export const gmDrum = (note) => KIT[note] != null ? KIT[note] : note < 35 ? (note % 2 ? KIT[37] : KIT[75]) : PERC_IDX;

const CAT_WEIGHT = { piano: 1.5, chromatic: 1.0, organ: 1.4, guitar: 1.6, bass: -2, strings: 1.1, ensemble: 0.6, brass: 2.0,
  reed: 2.2, pipe: 2.2, lead: 3.0, pad: 0.3, fx: 0.4, ethnic: 1.5, percussive: 0.6, sfx: 0.1, drums: 0.3 };
const num = (v, d, lo = -Infinity, hi = Infinity) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };

/** Instrument (possibly user-edited, possibly incomplete) → the driver's runtime form, with every field valid. */
export function normInst(p) {
  p = p || {};
  const f = p.filter || {}, pu = p.pulse || {}, vb = p.vib || {}, sl = p.slide || {}, sr = p.src || {}, dr = p.drum || {};
  let wave = Array.isArray(p.wave) ? p.wave.filter(Array.isArray).slice(0, 64).map(e => [num(e[0], 0x41, 0, 255) | 0, num(e[1], 0, -96, 127), e[2] ? 1 : 0]) : [];
  if (!wave.length) wave = [[0x41, 0, 0]];
  const cat = String(p.category || '').toLowerCase();
  return {
    name: p.name || '', category: p.category || '',
    a: num(p.a, 0, 0, 15) | 0, d: num(p.d, 9, 0, 15) | 0, s: num(p.s, 0, 0, 15) | 0, r: num(p.r, 0, 0, 15) | 0,
    hr: p.hr == null ? 1 : p.hr ? 1 : 0, gateOff: num(p.gateOff, 0, 0, 999) | 0,
    wave, loop: num(p.loop, -1, -1, wave.length - 1) | 0,
    pw: num(pu.width, 0x800, 0, 4095), pwm: num(pu.speed, 0, -2048, 2048), pwlo: num(pu.lo, 0, 0, 4095), pwhi: num(pu.hi, 4095, 0, 4095),
    fon: f.route && (f.mode & 0x70) ? 1 : 0, fmode: (f.mode | 0) & 0x70, res: num(f.res, 0, 0, 15) | 0,
    fcut: num(f.cut, 1024, 0, 2047), fpeak: num(f.peak, num(f.cut, 1024, 0, 2047), 0, 2047), fatk: num(f.atk, 0, 0, 999) | 0,
    fend: num(f.end, num(f.cut, 1024, 0, 2047), 0, 2047), frate: num(f.rate, 0.12, 0, 1), ftrack: num(f.track, 0, -2047, 2047),
    fvel: num(f.vel, 0, -2047, 2047), flfo: num(f.lfo, 0, 0, 50), flfoD: num(f.lfoDepth, 0, -2047, 2047),
    vib: num(vb.depth, 0, 0, 2400) / 100, vdl: num(vb.delay, 0, 0, 999), vhz: num(vb.rate, 5.5, 0, 50),
    slide: num(sl.speed, 0, -48, 48), smax: num(sl.limit, 24, 0, 96), sdl: num(sl.delay, 0, 0, 999),
    mod: num(sr.ratio, 1, 0.01, 16), modTo: num(sr.to, num(sr.ratio, 1, 0.01, 16), 0.01, 16), modFr: Math.max(1, num(sr.frames, 1, 1, 9999)),
    oct: num(p.transpose, 0, -48, 48),
    prio: num(dr.prio, 1, 0, 9), hold: Math.max(1, num(dr.hold, 12, 1, 999) | 0),
    weight: CAT_WEIGHT[cat] != null ? CAT_WEIGHT[cat] : 1, isBass: cat === 'bass',
  };
}
