// GM instrument designs for the PSG / 1-bit drivers (AY, YM, beeper, PC speaker). Own designs.
//
// A patch is what a period music engine's instrument table held: a software volume envelope stepped per
// frame, pitch macros (attack arpeggio, looping arpeggio table, vibrato, slide), mixer choice
// (tone / tone+noise / noise) and, on machines that allow it, "buzzer" use of the hardware envelope.
//
//   role   'lead' | 'bass' | 'chord' | 'pad' | 'fx' | 'perc'   — voice-allocation priority class
//   a      attack (s, 0 = instant)
//   d      decay: seconds to fall the full 45 dB range;  s  sustain on that log scale (0..1)
//   r      release: seconds to fall the full range
//   gain   level trim (amplitude)
//   mix    0 tone, 1 tone + noise, 2 noise only;  np noise period (−1 = follow pitch)
//   atkN   frames of tone+noise at the attack (pick / hammer / breath chiff), atkNp its noise period
//   arp0   semitone offsets for the first frames (attack chirp);  loop  repeating per-frame arpeggio table
//   vib    [depth semitones, delay s, rate Hz];  trem [depth (log-level units), rate Hz]
//   sweep  semitones / s pitch slide (sweepMax limits it)
//   oct    octave transpose;  buzz  'saw' | 'tri' | 'sync' hardware-envelope bass

const P = (role, a, d, s, r, x = {}) => ({ role, a, d, s, r, gain: 1, mix: 0, np: 0, atkN: 0, atkNp: 1, arp0: null, loop: null,
  vib: null, trem: null, sweep: 0, sweepMax: 0, oct: 0, buzz: 0, ...x });

const T = [];
// ---- 0–7 piano ----
T[0] = P('chord', 0, 3.2, 0, 0.35, { arp0: [12], atkN: 1, atkNp: 2 });          // acoustic grand
T[1] = P('chord', 0, 2.8, 0, 0.3, { arp0: [12], atkN: 1, atkNp: 1 });           // bright
T[2] = P('chord', 0, 3.0, 0, 0.3, { arp0: [12, 0, 12], atkN: 1 });              // electric grand
T[3] = P('chord', 0, 2.2, 0, 0.3, { loop: [0, 0, 0, 1, 0, 0, 0, -1].map(x => x * 0.12), arp0: [12] }); // honky-tonk (detune wobble)
T[4] = P('chord', 0, 4.0, 0.15, 0.4, { trem: [0.05, 4] });                      // rhodes
T[5] = P('chord', 0, 3.0, 0.1, 0.35, { arp0: [12, 12], vib: [0.08, 0.2, 5] });  // chorus EP
T[6] = P('chord', 0, 1.6, 0, 0.25, { arp0: [12, 0], atkN: 1, atkNp: 0 });       // harpsichord
T[7] = P('chord', 0, 1.2, 0.25, 0.15, { loop: [0, 12], atkN: 1 });              // clavinet
// ---- 8–15 chromatic percussion ----
T[8] = P('chord', 0, 1.6, 0, 0.4, { arp0: [24, 12] });                          // celesta
T[9] = P('chord', 0, 1.4, 0, 0.4, { oct: 1, arp0: [12] });                      // glockenspiel
T[10] = P('chord', 0, 1.8, 0, 0.5, { arp0: [12, 24] });                         // music box
T[11] = P('chord', 0, 2.6, 0, 0.6, { trem: [0.12, 5.5] });                      // vibraphone
T[12] = P('chord', 0, 0.7, 0, 0.2, { atkN: 1, atkNp: 4 });                      // marimba
T[13] = P('chord', 0, 0.5, 0, 0.15, { oct: 1, atkN: 1, atkNp: 1 });             // xylophone
T[14] = P('chord', 0, 3.5, 0, 0.8, { arp0: [19, 12, 7], loop: [0, 0, 0, 0.1] }); // tubular bells
T[15] = P('chord', 0, 1.3, 0, 0.3, { atkN: 1, atkNp: 1, loop: [0, 0.1] });       // dulcimer
// ---- 16–23 organ ----
T[16] = P('chord', 0.01, 0, 1, 0.06, { gain: 0.85 });                           // drawbar
T[17] = P('chord', 0, 1.2, 0.6, 0.05, { arp0: [12, 12, 19], gain: 0.85 });      // percussive organ
T[18] = P('chord', 0.01, 0, 1, 0.08, { loop: [0, 12], gain: 0.85 });            // rock organ
T[19] = P('chord', 0.08, 0, 1, 0.4, { loop: [0, 0, 12], gain: 0.85 });          // church organ
T[20] = P('chord', 0.06, 0, 1, 0.2, { vib: [0.1, 0, 4], gain: 0.85 });          // reed organ
T[21] = P('lead', 0.04, 0, 0.95, 0.12, { vib: [0.12, 0, 6] });                  // accordion
T[22] = P('lead', 0.03, 0, 0.9, 0.1, { vib: [0.2, 0.15, 5.5], atkN: 1, atkNp: 3 }); // harmonica
T[23] = P('lead', 0.05, 0, 0.95, 0.12, { vib: [0.1, 0, 6.5] });                 // tango accordion
// ---- 24–31 guitar ----
T[24] = P('chord', 0, 1.4, 0, 0.25, { atkN: 1, atkNp: 2 });                     // nylon
T[25] = P('chord', 0, 1.8, 0, 0.25, { arp0: [12], atkN: 1, atkNp: 1 });         // steel
T[26] = P('chord', 0, 1.8, 0.1, 0.2, {});                                       // jazz
T[27] = P('chord', 0, 2.2, 0.1, 0.2, { arp0: [12] });                           // clean
T[28] = P('chord', 0, 0.3, 0, 0.05, { atkN: 1, atkNp: 4 });                     // muted
T[29] = P('lead', 0, 3, 0.75, 0.12, { loop: [0, 0, 12], vib: [0.15, 0.3, 5] }); // overdrive
T[30] = P('lead', 0, 3, 0.8, 0.12, { loop: [0, 7, 12], vib: [0.2, 0.3, 5] });   // distortion (power-chord arp)
T[31] = P('chord', 0, 1.5, 0, 0.3, { oct: 1, arp0: [12] });                     // harmonics
// ---- 32–39 bass ----
T[32] = P('bass', 0, 1.6, 0.3, 0.12, { atkN: 1, atkNp: 6 });                    // acoustic
T[33] = P('bass', 0, 2.0, 0.45, 0.1, { buzz: 'tri' });                          // finger
T[34] = P('bass', 0, 1.6, 0.35, 0.08, { arp0: [12], buzz: 'saw' });             // pick
T[35] = P('bass', 0.02, 0, 0.9, 0.15, { vib: [0.15, 0.3, 5], buzz: 'tri' });     // fretless
T[36] = P('bass', 0, 0.9, 0.2, 0.08, { arp0: [12, 0, 12], atkN: 1, atkNp: 2 }); // slap 1
T[37] = P('bass', 0, 1.0, 0.25, 0.08, { arp0: [24, 12], atkN: 1, atkNp: 2 });   // slap 2
T[38] = P('bass', 0, 3, 0.8, 0.08, { buzz: 'saw' });                            // synth bass 1
T[39] = P('bass', 0, 2.2, 0.6, 0.08, { arp0: [12, 0], buzz: 'sync' });          // synth bass 2
// ---- 40–47 strings ----
T[40] = P('lead', 0.08, 0, 0.92, 0.25, { vib: [0.3, 0.25, 5.8] });              // violin
T[41] = P('lead', 0.09, 0, 0.92, 0.25, { vib: [0.28, 0.25, 5.5] });             // viola
T[42] = P('lead', 0.1, 0, 0.92, 0.3, { vib: [0.25, 0.3, 5] });                  // cello
T[43] = P('bass', 0.08, 0, 0.9, 0.25, { vib: [0.15, 0.3, 5] });                 // contrabass
T[44] = P('pad', 0.06, 0, 0.9, 0.3, { trem: [0.2, 12] });                       // tremolo strings
T[45] = P('chord', 0, 0.5, 0, 0.1, { atkN: 1, atkNp: 6 });                      // pizzicato
T[46] = P('chord', 0, 1.6, 0, 0.6, { arp0: [12] });                             // harp
T[47] = P('perc', 0, 0.9, 0, 0.3, { oct: -1, atkN: 2, atkNp: 8, sweep: -6, sweepMax: 2 }); // timpani
// ---- 48–55 ensemble ----
T[48] = P('pad', 0.12, 0, 0.88, 0.35, { vib: [0.12, 0.3, 5] });                 // strings
T[49] = P('pad', 0.35, 0, 0.85, 0.6, { vib: [0.1, 0.4, 4.5] });                 // slow strings
T[50] = P('pad', 0.04, 0, 0.9, 0.3, { loop: [0, 0, 0.1, 0.1] });                // synth strings 1
T[51] = P('pad', 0.15, 0, 0.88, 0.5, { vib: [0.15, 0, 3] });                    // synth strings 2
T[52] = P('pad', 0.18, 0, 0.88, 0.45, { vib: [0.2, 0.2, 5] });                  // choir aahs
T[53] = P('pad', 0.12, 0, 0.88, 0.35, { vib: [0.15, 0.2, 5], gain: 0.9 });      // voice oohs
T[54] = P('pad', 0.1, 0, 0.9, 0.4, { vib: [0.1, 0, 4], loop: [0, 0, 12, 12] }); // synth voice
T[55] = P('chord', 0, 1.0, 0, 0.2, { arp0: [12, 7, 0], atkN: 2, atkNp: 3 });    // orchestra hit
// ---- 56–63 brass ----
T[56] = P('lead', 0.03, 0, 0.88, 0.12, { arp0: [-1], vib: [0.22, 0.3, 5.5] });  // trumpet (scoop)
T[57] = P('lead', 0.05, 0, 0.88, 0.15, { arp0: [-2, -1], vib: [0.2, 0.3, 5] }); // trombone
T[58] = P('bass', 0.04, 0, 0.88, 0.12, { vib: [0.12, 0.3, 4.5] });              // tuba
T[59] = P('lead', 0.02, 0.8, 0.6, 0.1, { vib: [0.2, 0.25, 6], gain: 0.8 });     // muted trumpet
T[60] = P('lead', 0.08, 0, 0.88, 0.25, { vib: [0.12, 0.35, 5] });               // french horn
T[61] = P('chord', 0.03, 0, 0.9, 0.15, { arp0: [-1], loop: [0, 0, 0.12, 0.12] }); // brass section
T[62] = P('chord', 0.02, 1.5, 0.75, 0.15, { loop: [0, 12] });                   // synth brass 1
T[63] = P('chord', 0.04, 1.5, 0.75, 0.2, { loop: [0, 0, 12] });                 // synth brass 2
// ---- 64–71 reed ----
T[64] = P('lead', 0.03, 0, 0.9, 0.12, { vib: [0.25, 0.3, 5.5], atkN: 1, atkNp: 4 }); // soprano sax
T[65] = P('lead', 0.03, 0, 0.9, 0.12, { vib: [0.25, 0.3, 5.2], atkN: 1, atkNp: 5 }); // alto sax
T[66] = P('lead', 0.03, 0, 0.9, 0.12, { vib: [0.22, 0.3, 5], atkN: 1, atkNp: 6 });   // tenor sax
T[67] = P('lead', 0.03, 0, 0.9, 0.12, { vib: [0.2, 0.3, 4.8], atkN: 1, atkNp: 8 });  // baritone sax
T[68] = P('lead', 0.03, 0, 0.9, 0.12, { vib: [0.15, 0.3, 5.5] });               // oboe
T[69] = P('lead', 0.04, 0, 0.9, 0.15, { vib: [0.15, 0.3, 5] });                 // english horn
T[70] = P('lead', 0.03, 0, 0.9, 0.12, { vib: [0.12, 0.35, 5] });                // bassoon
T[71] = P('lead', 0.03, 0, 0.92, 0.12, { vib: [0.1, 0.4, 5] });                 // clarinet
// ---- 72–79 pipe ----
T[72] = P('lead', 0.03, 0, 0.92, 0.1, { oct: 1, vib: [0.2, 0.25, 6] });         // piccolo
T[73] = P('lead', 0.05, 0, 0.92, 0.15, { vib: [0.2, 0.3, 5.5], atkN: 2, atkNp: 1 }); // flute
T[74] = P('lead', 0.04, 0, 0.92, 0.12, { vib: [0.1, 0.35, 5], atkN: 1, atkNp: 1 }); // recorder
T[75] = P('lead', 0.05, 0, 0.9, 0.2, { mix: 1, np: 1, vib: [0.12, 0.2, 5], gain: 0.9 }); // pan flute (breathy)
T[76] = P('lead', 0.08, 0, 0.85, 0.2, { mix: 1, np: 2, gain: 0.85 });           // blown bottle
T[77] = P('lead', 0.06, 0, 0.9, 0.2, { arp0: [-1, -1], vib: [0.3, 0.2, 4.5], atkN: 3, atkNp: 1 }); // shakuhachi
T[78] = P('lead', 0.02, 0, 0.92, 0.1, { vib: [0.25, 0.1, 6.5] });               // whistle
T[79] = P('lead', 0.04, 0, 0.92, 0.15, { vib: [0.12, 0.3, 5] });                // ocarina
// ---- 80–87 synth lead ----
T[80] = P('lead', 0, 0, 1, 0.06, { vib: [0.15, 0.3, 6] });                      // square
T[81] = P('lead', 0, 0, 1, 0.08, { vib: [0.18, 0.25, 5.5], loop: [0, 0, 0, 0.08, 0.08, 0.08] }); // saw (chorused)
T[82] = P('lead', 0.03, 0, 0.92, 0.15, { vib: [0.3, 0, 7], mix: 1, np: 1, atkN: 0, gain: 0.95 }); // calliope
T[83] = P('lead', 0, 0, 0.9, 0.1, { atkN: 2, atkNp: 0, arp0: [12] });           // chiff
T[84] = P('lead', 0, 2.5, 0.75, 0.1, { loop: [0, 12, 0, 7] });                  // charang
T[85] = P('lead', 0.08, 0, 0.9, 0.2, { vib: [0.25, 0.15, 5] });                 // voice
T[86] = P('lead', 0, 0, 1, 0.1, { loop: [0, 7] });                              // fifths
T[87] = P('lead', 0, 0, 1, 0.1, { loop: [0, 0, -12], vib: [0.1, 0.3, 5] });     // bass + lead
// ---- 88–95 synth pad ----
T[88] = P('pad', 0.25, 0, 0.88, 0.7, { vib: [0.08, 0, 3] });                    // new age
T[89] = P('pad', 0.35, 0, 0.85, 0.8, { trem: [0.1, 3] });                       // warm
T[90] = P('pad', 0.03, 1.8, 0.7, 0.4, { loop: [0, 0, 0.1, 0.1] });              // polysynth
T[91] = P('pad', 0.3, 0, 0.85, 0.7, { vib: [0.15, 0.1, 4.5] });                 // choir
T[92] = P('pad', 0.3, 0, 0.85, 0.6, { trem: [0.15, 2] });                       // bowed
T[93] = P('pad', 0.1, 0, 0.85, 0.6, { loop: [0, 12, 19] });                     // metallic
T[94] = P('pad', 0.3, 0, 0.85, 0.8, { loop: [0, 0, 0, 12], vib: [0.08, 0, 3] }); // halo
T[95] = P('pad', 0.25, 0, 0.88, 0.6, { trem: [0.14, 1.2], loop: [0, 0, 0, 0.1] });                      // sweep
// ---- 96–103 synth fx ----
T[96] = P('fx', 0, 1.5, 0.3, 0.6, { arp0: [24, 19, 12], loop: [0, 12], mix: 1, np: 1, gain: 0.8 }); // rain
T[97] = P('fx', 0.3, 0, 0.85, 0.7, { vib: [0.2, 0, 2] });                       // soundtrack
T[98] = P('fx', 0, 1.8, 0.2, 0.6, { loop: [24, 12, 19, 0] });                   // crystal
T[99] = P('fx', 0.05, 2.0, 0.5, 0.6, { arp0: [12], loop: [0, 0, 7] });          // atmosphere
T[100] = P('fx', 0.02, 2.0, 0.5, 0.6, { loop: [0, 12, 24, 12] });               // brightness
T[101] = P('fx', 0.3, 0, 0.8, 0.6, { vib: [0.8, 0, 3], loop: [0, 0.3] });       // goblins
T[102] = P('fx', 0.02, 2.0, 0.4, 0.8, { trem: [0.35, 4.5] });                   // echoes
T[103] = P('fx', 0.1, 0, 0.85, 0.5, { vib: [1.2, 0, 1.5] });                    // sci-fi
// ---- 104–111 ethnic ----
T[104] = P('chord', 0, 2.2, 0.1, 0.4, { arp0: [12, 0], vib: [0.15, 0.15, 6], loop: [0, 0, 0.15] }); // sitar
T[105] = P('chord', 0, 0.7, 0, 0.15, { arp0: [12], atkN: 1, atkNp: 1 });        // banjo
T[106] = P('chord', 0, 0.8, 0, 0.15, { atkN: 1, atkNp: 0, arp0: [12, 0] });     // shamisen
T[107] = P('chord', 0, 1.4, 0, 0.3, { arp0: [12], vib: [0.1, 0.3, 5] });        // koto
T[108] = P('chord', 0, 0.8, 0, 0.3, { oct: 1, arp0: [12, 0] });                 // kalimba
T[109] = P('lead', 0.02, 0, 1, 0.1, { loop: [0, 0, 0, -12], vib: [0.1, 0, 6] }); // bagpipe (drone)
T[110] = P('lead', 0.04, 0, 0.9, 0.15, { vib: [0.3, 0.15, 6] });                // fiddle
T[111] = P('lead', 0.03, 0, 0.92, 0.12, { vib: [0.25, 0.1, 6.5], loop: [0, 0.1] }); // shanai
// ---- 112–119 percussive ----
T[112] = P('perc', 0, 0.9, 0, 0.4, { oct: 1, loop: [0, 24] });                  // tinkle bell
T[113] = P('perc', 0, 0.35, 0, 0.1, { arp0: [12], atkN: 1, atkNp: 1 });         // agogo
T[114] = P('perc', 0, 1.0, 0, 0.3, { arp0: [12, 7], loop: [0, 0, 0, 0.15] });   // steel drums
T[115] = P('perc', 0, 0.15, 0, 0.05, { oct: 1, atkN: 1, atkNp: 0 });            // woodblock
T[116] = P('perc', 0, 0.8, 0, 0.2, { oct: -1, mix: 1, np: 12, sweep: -18, sweepMax: 7 }); // taiko
T[117] = P('perc', 0, 0.6, 0, 0.2, { arp0: [5, 3], sweep: -14, sweepMax: 7, atkN: 1, atkNp: 6 }); // melodic tom
T[118] = P('perc', 0, 0.6, 0, 0.2, { sweep: -24, sweepMax: 12 });               // synth drum
T[119] = P('fx', 0.35, 0, 0.9, 0.05, { mix: 2, np: 2 });                        // reverse cymbal
// ---- 120–127 sound effects ----
T[120] = P('fx', 0, 0.25, 0, 0.05, { mix: 1, np: 3, sweep: 24, sweepMax: 5 });  // fret noise
T[121] = P('fx', 0.08, 0, 0.8, 0.15, { mix: 2, np: -1 });                       // breath noise
T[122] = P('fx', 0.12, 0, 0.88, 0.6, { mix: 2, np: -1, trem: [0.18, 0.5] });      // seashore
T[123] = P('fx', 0, 0, 0.9, 0.1, { oct: 1, loop: [0, 2, 5, 9, 12, 9, 5, 2], vib: [0.5, 0, 9] }); // bird
T[124] = P('fx', 0, 0, 1, 0.05, { oct: 1, loop: [0, 0, 4, 4] });                // telephone
T[125] = P('fx', 0, 0, 0.9, 0.2, { mix: 2, np: -1, trem: [0.6, 12] });         // helicopter
T[126] = P('fx', 0.15, 0, 0.8, 0.4, { mix: 2, np: -1, trem: [0.3, 9] });       // applause
T[127] = P('fx', 0, 0.5, 0, 0.1, { mix: 2, np: -1, atkN: 0 });                  // gunshot

export const PATCHES = T;
export const patchFor = (prog) => T[prog & 127];

/** Priority weight of each role when voices are scarce. */
export const ROLE_W = { lead: 1.0, bass: 0.92, perc: 0.75, chord: 0.66, fx: 0.6, pad: 0.52 };
/** Roles whose notes may be folded into another part's arpeggio when they lose their own voice. */
export const MERGEABLE = { chord: 1, pad: 1, perc: 0, fx: 0, lead: 0, bass: 0 };

/** Noise period that follows pitch, for noise-only sound effects (5-bit). */
export const noiseForNote = (note) => Math.max(0, Math.min(31, Math.round(31 - (note - 30) * 0.5)));

/**
 * Frame-stepped envelope on a 45 dB log scale, like a driver decrementing a volume register.
 * e = 1 → full level, e = 0 → silent.
 */
export const ENV_RANGE_DB = 45;
export class LogEnv {
  constructor() { this.e = 0; this.stage = 4; }
  start(p) { this.p = p; this.stage = p.a > 0 ? 0 : 1; this.e = p.a > 0 ? 0 : 1; }
  release() { if (this.stage < 3) this.stage = 3; }
  get done() { return this.stage === 4; }
  tick(dt) {
    const p = this.p;
    switch (this.stage) {
      case 0: this.e += dt / p.a; if (this.e >= 1) { this.e = 1; this.stage = 1; } break;
      case 1: if (p.d <= 0) this.e = p.s;
        else if (this.e > p.s) { this.e -= dt / p.d; if (this.e <= p.s) this.e = p.s; }
        if (this.e <= 0.001) { this.e = 0; this.stage = 4; } break;
      case 3: this.e -= p.r > 0 ? dt / p.r : 1; if (this.e <= 0) { this.e = 0; this.stage = 4; } break;
    }
    return this.e;
  }
  /** amplitude multiplier 0..1 */
  get amp() { return this.e <= 0 ? 0 : Math.pow(10, (this.e - 1) * ENV_RANGE_DB / 20); }
}
