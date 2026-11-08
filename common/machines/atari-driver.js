// Frame-rate "music engine" core shared by the Atari 2600, Atari 800 and TurboGrafx-16 machines.
//
// Like a period game driver, it keeps a set of *virtual notes* (one per MIDI key) whose software
// envelopes, vibrato and pitch effects run at the console's frame rate, and every frame decides which
// virtual notes own the chip's few hardware voices (melody / bass / drums priority, with stickiness so
// voices don't flap). A note that loses its voice keeps running silently and resumes if it wins one
// back — the classic "SFX interrupts a music channel" behaviour. Each machine subclasses Driver and
// supplies the chip side: program(vi, vn) / update(vi, vn) / silence(vi) write real chip registers.
//
// Original code for RetroSynths.
import { gmLevel } from './util.js';

// ---------------------------------------------------------------------------------------------
// GM program → timbre class. Machines map a class onto the chip's own timbres.
// env = [attack s, decay s (time to ~-40 dB of the way to sustain), sustain 0..1, release s]
// vib = [delay s, depth semitones, rate Hz]; trem = [rate Hz, depth 0..1]; sweep = semitones/s
// ---------------------------------------------------------------------------------------------
export const CLASS = {
  piano:   { role: 'mid',  env: [0.002, 1.8, 0, 0.25] },
  epiano:  { role: 'mid',  env: [0.002, 2.2, 0.12, 0.3] },
  harpsi:  { role: 'mid',  env: [0.001, 1.0, 0, 0.12] },
  clav:    { role: 'mid',  env: [0.001, 0.6, 0, 0.08] },
  bell:    { role: 'mid',  env: [0.001, 2.0, 0, 0.7] },
  vibes:   { role: 'mid',  env: [0.001, 1.8, 0, 0.6], trem: [5.5, 0.3] },
  mallet:  { role: 'mid',  env: [0.001, 0.4, 0, 0.1] },
  organ:   { role: 'pad',  env: [0.008, 0.1, 0.9, 0.06] },
  reed:    { role: 'lead', env: [0.025, 0.3, 0.8, 0.1], vib: [0.35, 0.16, 5.2] },
  pluck:   { role: 'mid',  env: [0.001, 1.1, 0, 0.15] },
  dist:    { role: 'lead', env: [0.003, 1.6, 0.5, 0.12], vib: [0.5, 0.15, 5.5] },
  bass:    { role: 'bass', env: [0.002, 1.4, 0.35, 0.08] },
  synbass: { role: 'bass', env: [0.001, 0.6, 0.55, 0.06] },
  string:  { role: 'pad',  env: [0.12, 0.3, 0.85, 0.3], vib: [0.3, 0.14, 5.5] },
  pad:     { role: 'pad',  env: [0.35, 0.6, 0.8, 0.6] },
  voice:   { role: 'pad',  env: [0.15, 0.4, 0.8, 0.4], vib: [0.3, 0.14, 5] },
  hit:     { role: 'mid',  env: [0.001, 0.45, 0, 0.1] },
  brass:   { role: 'lead', env: [0.04, 0.3, 0.75, 0.12], vib: [0.35, 0.14, 5.5] },
  flute:   { role: 'lead', env: [0.04, 0.2, 0.8, 0.12], vib: [0.3, 0.16, 5] },
  square:  { role: 'lead', env: [0.002, 0.3, 0.8, 0.08], vib: [0.4, 0.12, 5.5] },
  saw:     { role: 'lead', env: [0.002, 0.4, 0.75, 0.1], vib: [0.4, 0.12, 5.5] },
  noise:   { role: 'fx',   env: [0.005, 0.6, 0.6, 0.3] },
  bird:    { role: 'fx',   env: [0.01, 0.3, 0.8, 0.1], bird: true },
  phone:   { role: 'fx',   env: [0.002, 0.1, 0.9, 0.05], trill: 4 },
  timpani: { role: 'bass', env: [0.002, 1.2, 0, 0.4] },
  tomperc: { role: 'mid',  env: [0.001, 0.5, 0, 0.1], sweep: -14 },
  block:   { role: 'mid',  env: [0.001, 0.15, 0, 0.05] },
};

const PROG_CLASS = [
  'piano', 'piano', 'piano', 'piano', 'epiano', 'epiano', 'harpsi', 'clav',            // 0  piano
  'bell', 'bell', 'bell', 'vibes', 'mallet', 'mallet', 'bell', 'pluck',                // 8  chromatic
  'organ', 'organ', 'organ', 'organ', 'organ', 'reed', 'reed', 'reed',                 // 16 organ
  'pluck', 'pluck', 'pluck', 'pluck', 'pluck', 'dist', 'dist', 'bell',                 // 24 guitar
  'bass', 'bass', 'bass', 'bass', 'bass', 'bass', 'synbass', 'synbass',                // 32 bass
  'string', 'string', 'string', 'string', 'string', 'pluck', 'pluck', 'timpani',       // 40 strings
  'string', 'string', 'pad', 'pad', 'voice', 'voice', 'voice', 'hit',                  // 48 ensemble
  'brass', 'brass', 'brass', 'brass', 'brass', 'brass', 'brass', 'brass',              // 56 brass
  'reed', 'reed', 'reed', 'reed', 'reed', 'reed', 'reed', 'reed',                      // 64 reed
  'flute', 'flute', 'flute', 'flute', 'flute', 'flute', 'flute', 'flute',              // 72 pipe
  'square', 'saw', 'flute', 'flute', 'dist', 'voice', 'saw', 'saw',                    // 80 lead
  'pad', 'pad', 'saw', 'voice', 'pad', 'bell', 'voice', 'pad',                         // 88 pad
  'bell', 'pad', 'bell', 'pluck', 'bell', 'pad', 'pad', 'bell',                        // 96 fx
  'pluck', 'pluck', 'pluck', 'pluck', 'bell', 'reed', 'string', 'reed',                // 104 ethnic
  'bell', 'bell', 'mallet', 'block', 'timpani', 'tomperc', 'tomperc', 'noise',         // 112 percussive
  'noise', 'noise', 'noise', 'bird', 'phone', 'noise', 'noise', 'noise',               // 120 sfx
];
// per-program refinements on top of the class
const PROG_MOD = {
  2: { env: [0.002, 1.5, 0, 0.2] }, 3: { env: [0.002, 1.4, 0, 0.2] },
  10: { env: [0.001, 1.2, 0, 0.5] }, 14: { env: [0.002, 3.0, 0, 1.0] },
  19: { env: [0.03, 0.2, 0.9, 0.4] }, 28: { env: [0.001, 0.25, 0, 0.05] },
  31: { env: [0.001, 1.2, 0, 0.3] },
  35: { env: [0.005, 1.0, 0.6, 0.1], vib: [0.3, 0.1, 5] }, 36: { env: [0.001, 0.5, 0.25, 0.06] }, 37: { env: [0.001, 0.5, 0.25, 0.06] },
  40: { role: 'lead' }, 41: { role: 'lead' }, 42: { role: 'mid' }, 43: { role: 'bass' }, 44: { trem: [11, 0.45] },
  45: { env: [0.001, 0.35, 0, 0.08] }, 46: { env: [0.001, 1.4, 0, 0.3] },
  50: { env: [0.2, 0.5, 0.8, 0.5] }, 55: { env: [0.001, 0.5, 0, 0.15] },
  58: { role: 'bass' }, 60: { env: [0.06, 0.4, 0.7, 0.2] }, 61: { role: 'mid' }, 62: { env: [0.01, 0.4, 0.7, 0.12] },
  68: { env: [0.03, 0.2, 0.85, 0.08] }, 70: { role: 'bass' },
  75: { env: [0.06, 0.3, 0.7, 0.15] }, 76: { env: [0.1, 0.3, 0.7, 0.15] },
  82: { vib: [0.2, 0.2, 7] }, 84: { env: [0.002, 1.0, 0.3, 0.1] }, 87: { role: 'bass' },
  88: { env: [0.2, 1.5, 0.6, 0.8] }, 90: { env: [0.02, 0.6, 0.65, 0.3] }, 95: { env: [0.5, 0.5, 0.8, 0.6], vib: [0.0, 0.12, 0.6] },
  96: { env: [0.001, 1.0, 0, 0.6] }, 98: { env: [0.001, 1.6, 0, 0.8] }, 101: { vib: [0.0, 0.3, 3] }, 103: { sweep: 6, env: [0.01, 1.2, 0.3, 0.6] },
  108: { env: [0.001, 0.7, 0, 0.2] }, 109: { role: 'lead' }, 110: { role: 'lead' }, 111: { role: 'lead' },
  113: { env: [0.001, 0.35, 0, 0.1] }, 114: { env: [0.001, 0.8, 0, 0.2] }, 116: { env: [0.002, 0.9, 0, 0.3], sweep: -4 },
  119: { env: [1.2, 0.05, 0, 0.05], noise: 'cymbal' },
  120: { env: [0.001, 0.12, 0, 0.05], noise: 'fret' }, 121: { env: [0.15, 0.3, 0.7, 0.3], noise: 'breath' },
  122: { env: [0.8, 1.0, 0.7, 1.0], trem: [0.25, 0.7], noise: 'sea' },
  125: { env: [0.3, 0.3, 0.9, 0.5], trem: [12, 0.8], noise: 'heli' },
  126: { env: [0.4, 0.5, 0.8, 0.6], trem: [7, 0.35], noise: 'applause' },
  127: { env: [0.001, 0.5, 0, 0.1], noise: 'gun' },
};

/** Static per-program patch: { prog, cls, role, env, vib, trem, sweep, trill, bird, noise }. */
export const GM_PATCH = PROG_CLASS.map((cls, prog) => {
  const c = CLASS[cls], m = PROG_MOD[prog] || {};
  return { prog, cls, role: c.role, env: c.env, vib: c.vib, trem: c.trem, sweep: c.sweep, trill: c.trill, bird: c.bird, noise: cls === 'noise' ? 'hiss' : undefined, ...m };
});

const ROLE_PRIO = { lead: 60, bass: 55, mid: 44, pad: 38, fx: 36 };
/** Priority of each drum kind (from util.drumKind): kick/snare beat bass, hats don't. */
export const DRUM_PRIO = { kick: 59, snare: 59, clap: 57, stick: 50, tom: 56, crash: 56, ride: 48, hatClosed: 49, hatPedal: 47, hatOpen: 50,
  bell: 48, shaker: 44, cowbell: 50, conga: 50, block: 48, triangle: 46, perc: 46 };

// ---------------------------------------------------------------------------------------------
// Software envelope, stepped once per frame. Decay/release are exponential (straight lines in dB,
// the way drivers counted volume down), so they quantise evenly on log-volume chips.
// ---------------------------------------------------------------------------------------------
class Env {
  constructor() { this.level = 0; this.stage = 4; }
  start(e) { this.a = e[0]; this.d = e[1]; this.s = e[2]; this.r = e[3]; this.stage = this.a > 0.004 ? 0 : 1; this.level = this.stage ? 1 : 0; }
  release() { if (this.stage < 3) this.stage = 3; }
  get done() { return this.stage === 4; }
  tick(dt) {
    switch (this.stage) {
      case 0: this.level += dt / this.a; if (this.level >= 1) { this.level = 1; this.stage = 1; } break;
      case 1: {
        const k = Math.exp(-4.6 * dt / Math.max(0.01, this.d));
        this.level = this.s + (this.level - this.s) * k;
        if (this.s <= 0.001) { if (this.level < 0.004) { this.level = 0; this.stage = 4; } }
        else if (this.level - this.s < 0.002) { this.level = this.s; this.stage = 2; }
        break;
      }
      case 3: this.level *= Math.exp(-4.6 * dt / Math.max(0.01, this.r)); if (this.level < 0.004) { this.level = 0; this.stage = 4; } break;
    }
    return this.level;
  }
}

class VNote {
  constructor(i) { this.i = i; this.active = false; this.env = new Env(); this.voice = -1; }
}

export class Driver {
  /**
   * @param host     RetroSynths host object
   * @param nVoices  hardware voice slots
   * @param frameHz  the console's video frame rate (driver tick)
   */
  constructor(host, nVoices, frameHz) {
    this.h = host; this.nv = nVoices; this.frameHz = frameHz; this.dt = 1 / frameHz;
    this.owner = new Array(nVoices).fill(null);
    this.claim = new Array(nVoices).fill(null);
    this.pool = Array.from({ length: 48 }, (_, i) => new VNote(i));
    this.sorted = [];
    this.age = 0; this.frameNo = 0;
    this.melOrder = [...Array(nVoices).keys()];
    this.drumOrder = [...Array(nVoices).keys()].reverse();
  }

  // ---- machine hooks ---------------------------------------------------------------------------
  patchFor(prog) { return GM_PATCH[prog & 127]; }
  drumFor(note) { return null; }              // → { kind, prio, len (frames), ... } or null
  allowed(vi, vn) { return true; }
  prefer(vn) { return vn.isDrum ? this.drumOrder : this.melOrder; }
  strict(vn) { return false; }                // true: take voices strictly in prefer() order
  program(vi, vn) {}                          // voice newly given to vn: write everything
  update(vi, vn) {}                           // per frame / on controller change
  silence(vi) {}                              // voice lost its note
  preAssign() {}
  postAssign() {}

  // ---- MIDI interface ----------------------------------------------------------------------------
  noteOn(c, note, vel) {
    const ch = this.h.ch[c];
    if (this.h.mute[c]) return;
    let vn;
    if (ch.drum) {
      const d = this.drumFor(note);
      if (!d) return;
      for (const o of this.pool) if (o.active && o.ch === c && (o.note === note || (d.choke && o.dd && o.dd.choke === d.choke))) this.kill(o);
      vn = this.alloc();
      vn.isDrum = true; vn.dd = d; vn.p = null; vn.role = 'drum'; vn.len = d.len;
    } else {
      const p = this.patchFor(ch.program, note);
      for (const o of this.pool) if (o.active && o.ch === c && o.note === note && !o.isDrum) { o.key = false; o.sus = false; o.env.release(); }
      vn = this.alloc();
      vn.isDrum = false; vn.dd = null; vn.p = p; vn.role = p.role;
      if ((p.role === 'mid' || p.role === 'pad') && note < 47) vn.role = 'low';
      vn.env.start(p.env);
    }
    vn.active = true; vn.ch = c; vn.note = note; vn.vel = vel; vn.key = true; vn.sus = false;
    vn.age = ++this.age; vn.frames = 0; vn.t = 0; vn.voice = -1;
    this.shape(vn);
    this.assign();
    if (vn.voice >= 0) this.update(vn.voice, vn);
  }
  noteOff(c, note) {
    const sus = this.h.ch[c].sustain;
    for (const vn of this.pool) if (vn.active && vn.key && vn.ch === c && vn.note === note) {
      if (vn.isDrum) { vn.key = false; continue; }      // drums are one-shot
      if (sus) vn.sus = true; else { vn.key = false; vn.env.release(); }
    }
  }
  sustainOff(c) {
    for (const vn of this.pool) if (vn.active && vn.sus && vn.ch === c) { vn.sus = false; vn.key = false; vn.env.release(); }
  }
  allOff(c, hard) {
    for (const vn of this.pool) if (vn.active && vn.ch === c) {
      if (hard) this.kill(vn); else { vn.key = false; vn.sus = false; if (!vn.isDrum) vn.env.release(); }
    }
  }
  pitch(c) { for (let vi = 0; vi < this.nv; vi++) { const vn = this.owner[vi]; if (vn && vn.ch === c) { this.shape(vn); this.update(vi, vn); } } }
  ctrl(c) {
    if (this.h.mute[c]) { for (const vn of this.pool) if (vn.active && vn.ch === c) this.kill(vn); return; }
    this.pitch(c);
  }
  resetDriver() { for (const vn of this.pool) { vn.active = false; vn.voice = -1; } this.owner.fill(null); }
  activeCount() { let n = 0; for (const o of this.owner) if (o) n++; return n; }

  // ---- internals --------------------------------------------------------------------------------
  alloc() {
    for (const vn of this.pool) if (!vn.active) return vn;
    let best = null, bp = Infinity;
    for (const vn of this.pool) { const p = this.prio(vn); if (p < bp) { bp = p; best = vn; } }
    this.kill(best);
    return best;
  }
  kill(vn) {
    if (vn.voice >= 0) { const vi = vn.voice; this.owner[vi] = null; vn.voice = -1; this.silence(vi); }
    vn.active = false;
  }
  prio(vn) {
    let p;
    if (vn.isDrum) p = vn.dd.prio;
    else {
      p = vn.role === 'low' ? 46 : ROLE_PRIO[vn.role];
      p += vn.role === 'bass' ? (40 - vn.note) * 0.08 : (vn.note - 60) * 0.08;   // top line / bottom line
      if (!vn.key && !vn.sus) p -= 22;
    }
    p += 10 * vn.amp;
    p -= Math.min(8, vn.frames * 0.05);
    if (vn.voice >= 0) p += 4;
    return p;
  }

  /** Pitch (semitones, incl. bend/vibrato/effects) and amplitude 0..1 for this frame. */
  shape(vn) {
    const ch = this.h.ch[vn.ch];
    let amp = gmLevel(ch, vn.vel);
    if (vn.isDrum) { vn.pitch = vn.note; vn.amp = amp; return; }
    const p = vn.p, t = vn.t;
    let n = vn.note + ch.bend * ch.bendRange;
    const mod = ch.cc[1] / 127;
    let vd = mod * 0.6, vr = 5.5;
    if (p.vib && t >= p.vib[0]) { const ramp = Math.min(1, (t - p.vib[0]) / 0.4); vd = Math.max(vd, p.vib[1] * ramp); vr = p.vib[2]; }
    if (vd > 0) n += vd * Math.sin(2 * Math.PI * vr * t);
    if (p.sweep) n += p.sweep * t;
    if (p.trill && ((vn.frames >> 1) & 1)) n += p.trill;
    if (p.bird) n += 3 * Math.sin(2 * Math.PI * 9 * t) + 4 * Math.min(1, t * 3);
    vn.pitch = n;
    amp *= vn.env.level;
    if (p.trem) amp *= 1 - p.trem[1] * (0.5 + 0.5 * Math.sin(2 * Math.PI * p.trem[0] * t));
    vn.amp = amp;
  }

  /** Give hardware voices to the highest-priority virtual notes (sticky; constrained by allowed()). */
  assign() {
    this.preAssign();
    const s = this.sorted; s.length = 0;
    for (const vn of this.pool) if (vn.active && (vn.amp > 0.0005 || vn.isDrum)) { vn.pr = this.prio(vn); s.push(vn); }
    s.sort((a, b) => b.pr - a.pr);
    const claim = this.claim; claim.fill(null);
    for (const vn of s) vn.nvi = -1;
    for (const vn of s) {
      if (vn.voice >= 0 && !claim[vn.voice] && this.allowed(vn.voice, vn)) { claim[vn.voice] = vn; vn.nvi = vn.voice; continue; }
      let pick = -1;
      const ord = this.prefer(vn);
      if (!this.strict(vn)) for (let k = 0; k < ord.length; k++) {           // a truly idle voice first …
        const vi = ord[k];
        if (!claim[vi] && this.allowed(vi, vn) && (!this.owner[vi] || !this.owner[vi].active)) { pick = vi; break; }
      }
      if (pick < 0) for (let k = 0; k < ord.length; k++) {   // … else one whose owner ranks lower
        const vi = ord[k];
        if (!claim[vi] && this.allowed(vi, vn)) { pick = vi; break; }
      }
      if (pick >= 0) { claim[pick] = vn; vn.nvi = pick; }
    }
    for (let vi = 0; vi < this.nv; vi++) {
      const old = this.owner[vi], nw = claim[vi];
      if (old === nw) continue;
      if (old && old.voice === vi) old.voice = -1;
      this.owner[vi] = nw;
      if (nw) { nw.voice = vi; this.program(vi, nw); this.update(vi, nw); } else this.silence(vi);
    }
    for (const vn of this.pool) if (vn.active && vn.voice >= 0 && this.owner[vn.voice] !== vn) vn.voice = -1;
    this.postAssign();
  }

  /** One driver tick (call at frameHz from the chip clock domain). */
  frame() {
    this.frameNo++;
    const dt = this.dt;
    for (const vn of this.pool) {
      if (!vn.active) continue;
      vn.frames++; vn.t += dt;
      if (vn.isDrum) { if (vn.frames >= vn.len) { this.kill(vn); continue; } this.shape(vn); continue; }
      vn.env.tick(dt);
      if (vn.env.done) { this.kill(vn); continue; }
      this.shape(vn);
    }
    this.assign();
    const met = this.h.meter;
    for (let vi = 0; vi < this.nv; vi++) {
      const vn = this.owner[vi];
      if (!vn) continue;
      this.update(vi, vn);
      const m = Math.min(1, vn.amp * 2.5);
      if (m > met[vn.ch]) met[vn.ch] = m;
    }
  }
}

/** Greatest common divisor (for poly-counter coprimality checks). */
export const gcd = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a; };
