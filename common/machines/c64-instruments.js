// Commodore 64 driver instruments: 128 GM programs + GM drum kit, designed for RetroSynths in the style of
// mid-80s C64 game music engines (wave tables, PWM, filter sweeps, Hubbard-style drums). Original designs.
//
// Instrument fields (all optional except w/ad/sr):
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

export const PROGRAMS = [
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

export const DRUMS = {
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
export const drumDef = (n) => DRUMS[n] || (n < 35 ? DRUMS[n % 2 ? 37 : 75] || PERC : PERC);

/** Melody weight per GM family when choosing which part gets the lead voice. */
export const FAMILY_WEIGHT = { piano: 1.5, chromatic: 1.0, organ: 1.4, guitar: 1.6, bass: -2, strings: 1.1, ensemble: 0.6,
  brass: 2.0, reed: 2.2, pipe: 2.2, lead: 3.0, pad: 0.3, fx: 0.4, ethnic: 1.5, percussive: 0.6, sfx: 0.1 };
