// 1-bit speaker engines (own code): Apple II speaker and IBM PC speaker (Intel 8253 PIT channel 2).
//
// OneBit — an edge generator that only ever produces 0/1 levels at integer clock times of the machine's
// timing source (Apple II: CPU cycles at 1.0227 MHz; PC: PIT input clock 1.193182 MHz). Every edge is
// written as a band-limited step (beeper-dsp.js Blep), so 1-bit tones, pulse-width tricks and noise
// bursts come out with their real timing quantisation but without aliasing.
//   · PC: PIT mode 3 square — count N: high for ⌈N/2⌉ clocks, low for ⌊N/2⌋; f = 1193182 / N.
//     Port 61h gates the speaker, so silence is a steady 0.
//   · Apple II: each access to $C030 toggles the speaker; tone loops time the toggles in CPU cycles
//     (5-cycle delay-loop granularity); loudness by pulse width (two toggles close together).
//
// SpeakerModel — the small cone as a band-pass (PC ≈ 300 Hz–8 kHz with mild resonance; Apple II similar
// but a bit lower).
//
// OneBitDriver — a General MIDI driver like a PC / Apple II game's: one note at a time, chosen by
// priority (melody > bass > chords); chords as fast arpeggios at the driver rate (60 or 120 Hz); drums
// as blips (pitch sweeps and noise bursts) that interrupt the tone for a few milliseconds.

import { midiHz, gmLevel, drumKind, TOM_NOTE } from './util.js';
import { patchFor, LogEnv } from './ay-patches.js';
import { Blep, Biquad } from './beeper-dsp.js';

const OFF = 0, TONE = 1, NOISE = 2;
const prog = () => ({ mode: OFF, hi: 0, lo: 0, gmin: 0, gmax: 0, w: 0, k: 1, maxP: 0 });

export class OneBit {
  /**
   * @param sr      output rate
   * @param clock   timing source in Hz (edges fall on integer clocks)
   * @param gateOff true: silence forces the line low (PC port 61h); false: the line keeps its state (Apple II)
   */
  constructor(sr, clock, gateOff) {
    this.sr = sr; this.clock = clock; this.k = sr / clock; this.gateOff = gateOff;
    this.blep = new Blep(sr);
    this.mus = prog(); this.drm = prog(); this.cur = this.mus;
    this.level = 0; this.next = Infinity; this.drumEnd = Infinity;
    this.seed = 0x2545F491;
    this.edges = 0;
  }
  rand() { let s = this.seed; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.seed = s >>> 0; return this.seed / 4294967296; }
  reset() { this.mus.mode = OFF; this.cur = this.mus; this.next = Infinity; this.drumEnd = Infinity; if (this.level) { this.level = 0; this.blep.add(0, -1); } }
  interval(p) {
    switch (p.mode) {
      case TONE:
        if (this.level) {
          if (p.k !== 1) { const P = Math.min(p.maxP, (p.hi + p.lo) * p.k), d = p.hi / (p.hi + p.lo); p.hi = Math.max(1, Math.round(P * d)); p.lo = Math.max(1, Math.round(P - p.hi)); }
          return p.hi;
        }
        return p.lo;
      case NOISE:
        if (p.w > 0 && this.level) return p.w;
        return Math.round(p.gmin + (p.gmax - p.gmin) * this.rand());
      default: return Infinity;
    }
  }
  /** Program change at time 0 of the next render chunk. `p` is this.mus or this.drm. */
  changed(p, wasMode) {
    if (this.cur !== p) return;
    if (p.mode === OFF) { this.next = Infinity; if (this.gateOff && this.level) { this.level = 0; this.blep.add(0, -1); } }
    else if (wasMode === OFF || p === this.drm) this.next = 0;
  }
  setTone(hi, lo) { const m = this.mus, w = m.mode; m.mode = TONE; m.hi = Math.max(1, Math.round(hi)); m.lo = Math.max(1, Math.round(lo)); m.k = 1; this.changed(m, w); }
  setNoise(gmin, gmax, w = 0) { const m = this.mus, o = m.mode; m.mode = NOISE; m.gmin = Math.max(1, gmin); m.gmax = Math.max(m.gmin, gmax); m.w = Math.round(w); this.changed(m, o); }
  off() { const m = this.mus, w = m.mode; m.mode = OFF; this.changed(m, w); }
  /** One-shot drum program for `dur` clocks; afterwards the music program resumes. */
  burst(d, dur) {
    const p = this.drm;
    Object.assign(p, d);
    p.hi = Math.max(1, Math.round(p.hi)); p.lo = Math.max(1, Math.round(p.lo));
    this.cur = p; this.drumEnd = Math.round(dur);
    this.next = 0;
  }
  get busy() { return this.cur === this.drm; }
  render(m) {
    const end = m / this.k, k = this.k, b = this.blep;
    for (;;) {
      if (this.cur === this.drm && this.drumEnd <= this.next && this.drumEnd < end) {
        const t = this.drumEnd;
        this.cur = this.mus; this.drumEnd = Infinity;
        if (this.mus.mode === OFF) { this.next = Infinity; if (this.gateOff && this.level) { this.level = 0; b.add(t * k, -1); } }
        else this.next = t;
        continue;
      }
      const t = this.next;
      if (t >= end) break;
      this.level ^= 1;
      b.add(t * k, this.level ? 1 : -1);
      this.edges++;
      this.next = t + this.interval(this.cur);
    }
    this.next -= end; this.drumEnd -= end;
  }
}

export class SpeakerModel {
  constructor(sr, kind) {
    this.f = kind === 'pc'
      ? [new Biquad().highpass(sr, 300, 0.8), new Biquad().lowpass(sr, 8000, 1.1), new Biquad().peak(sr, 2600, 1.4, 2.5)]
      : [new Biquad().highpass(sr, 190, 0.75), new Biquad().lowpass(sr, 7000, 0.95), new Biquad().peak(sr, 1800, 1.2, 3)];
  }
  run(x) { const f = this.f; return f[2].run(f[1].run(f[0].run(x))); }
  clear() { for (const b of this.f) b.clear(); }
}

// ---------------------------------------------------------------- 1-bit drums
/** Drum blip as a OneBit program + duration (seconds). amp 0..1; pwm: loudness by pulse width. */
function drumProgram(n, amp, clock, pwm) {
  const us = clock * 1e-6, k = drumKind(n);
  const width = pwm ? (6 + 34 * Math.sqrt(amp)) * us : 0;
  const tone = (hz, dur, sweepK = 1, minHz = 20) => {
    const P = clock / hz;
    const hi = pwm ? Math.min(P / 2, width * 1.5) : P / 2;
    return [{ mode: TONE, hi, lo: P - hi, k: sweepK, maxP: clock / minHz }, dur];
  };
  const noise = (g0, g1, dur) => [{ mode: NOISE, gmin: g0 * us, gmax: g1 * us, w: width }, dur];
  switch (k) {
    case 'kick': return tone(n === 35 ? 140 : 170, 0.075, 1.075, 38);
    case 'snare': return noise(n === 40 ? 30 : 45, n === 40 ? 260 : 380, 0.085);
    case 'stick': return tone(1650, 0.012);
    case 'clap': return noise(35, 300, 0.055);
    case 'hatClosed': return noise(14, 80, 0.016);
    case 'hatPedal': return noise(14, 70, 0.012);
    case 'hatOpen': return noise(14, 90, 0.09);
    case 'crash': return noise(14, n === 52 ? 220 : 150, n === 55 ? 0.12 : 0.28);
    case 'ride': return noise(12, 50, 0.12);
    case 'bell': return tone(1420, 0.14);
    case 'tom': { const t = TOM_NOTE[n] || 50; return tone(midiHz(t + 12), 0.1, 1.022, 30); }
    case 'conga': { const t = TOM_NOTE[n] || 64; return tone(midiHz(t + 7), n === 62 ? 0.03 : 0.055, 1.008, 60); }
    case 'cowbell': return tone(n === 56 ? 800 : n === 67 ? 1000 : 760, 0.06);
    case 'shaker': return noise(12, 70, n === 54 ? 0.05 : 0.03);
    case 'block': return tone(n === 75 ? 2500 : n === 76 ? 1250 : 950, 0.025);
    case 'triangle': return tone(4450, n === 80 ? 0.03 : 0.25);
    default:
      switch (n) {
        case 58: return noise(60, 900, 0.2);                  // vibraslap
        case 71: return tone(2350, 0.08);
        case 72: return tone(2350, 0.25);
        case 73: return noise(150, 700, 0.05);
        case 74: return noise(150, 700, 0.16);
        case 78: return tone(420, 0.05, 0.996, 300);
        case 79: return tone(650, 0.1, 1.004, 250);
        default: return tone(midiHz(n + 12), 0.04);
      }
  }
}
const DRUM_PRIO = { kick: 9, snare: 8, clap: 7, tom: 7, crash: 6, stick: 5, conga: 5, cowbell: 5, bell: 4, ride: 4, block: 4, triangle: 3, perc: 3, hatOpen: 3, shaker: 2, hatClosed: 2, hatPedal: 1 };

// ---------------------------------------------------------------- the music driver
class Note {
  constructor() { this.active = false; this.env = new LogEnv(); this.ch = 0; this.note = 0; this.vel = 0; this.on = false; this.sus = false; this.age = 0; this.frames = 0; this.amp = 0; this.patch = null; }
}
const CLASS = { lead: 3, bass: 2, chord: 1, pad: 1, perc: 1, fx: 1 };
const tri = (ph) => { const x = ph - Math.floor(ph); return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4; };

export class OneBitDriver {
  /**
   * cfg: clock, timer 'pit' | 'cpu', quantum (cycles of the tone loop), gateOff, speaker 'pc' | 'apple',
   *      frameHz, volume 'square' | 'pwm', mode 'priority' | 'multiplex', gain
   */
  constructor(host, cfg) {
    this.h = host; this.sr = host.sampleRate; this.cfg = { ...cfg };
    this.gen = new OneBit(this.sr, cfg.clock, cfg.gateOff);
    this.spk = new SpeakerModel(this.sr, cfg.speaker);
    this.notes = Array.from({ length: 48 }, () => new Note());
    this.byCh = Array.from({ length: 16 }, () => []);
    this.pend = null;                 // pending drum hit for the next tick
    this.age = 0; this.frame = 0; this.toTick = 0;
    this.tmp = new Float32Array(2048);
    this.gain = cfg.gain || 0.3;
    this.sounding = 0;
    this.setRate(cfg.frameHz);
  }
  setRate(hz) { this.cfg.frameHz = hz; this.frameHz = hz; this.dt = 1 / hz; }

  noteAmp(c, vel, patch) { return this.h.mute[c] ? 0 : Math.min(1, 1.6 * gmLevel(this.h.ch[c], vel) * patch.gain); }
  noteOn(c, note, vel) {
    const ch = this.h.ch[c];
    if (ch.drum) { this.drumOn(c, note, vel); return; }
    let n = null;
    for (const x of this.notes) if (x.active && x.ch === c && x.note === note) { n = x; break; }
    if (!n) {
      let ba = Infinity;
      for (const x of this.notes) if (!x.active) { n = x; break; }
      if (!n) for (const x of this.notes) if (x.age < ba) { ba = x.age; n = x; }
    }
    const patch = patchFor(ch.program);
    n.active = true; n.ch = c; n.note = note; n.vel = vel; n.on = true; n.sus = false; n.age = ++this.age; n.frames = 0;
    n.patch = patch; n.amp = this.noteAmp(c, vel, patch); n.env.start(patch);
  }
  drumOn(c, note, vel) {
    const amp = this.h.mute[c] ? 0 : Math.min(1, 1.6 * gmLevel(this.h.ch[c], vel));
    this.drumHit(note, amp, c);
  }
  /** queue a drum blip (also used by the Apple II Mockingboard machine for speaker drums) */
  drumHit(note, amp, c = 9) {
    if (amp <= 0 || note < 27 || note > 87) return;
    const pr = DRUM_PRIO[drumKind(note)] || 3;
    if (!this.pend || pr >= this.pend.pr) this.pend = { note, amp, pr, c };
  }
  noteOff(c, note) {
    for (const n of this.notes) if (n.active && n.on && n.ch === c && n.note === note) {
      n.on = false;
      if (this.h.ch[c].sustain) n.sus = true; else n.env.release();
    }
  }
  sustainOff(c) { for (const n of this.notes) if (n.active && n.sus && n.ch === c) { n.sus = false; n.env.release(); } }
  allOff(c, hard) { for (const n of this.notes) if (n.active && n.ch === c) { n.on = false; n.sus = false; n.env.release(); if (hard) n.active = false; } }
  pitch(c) {}
  ctrl(c) { for (const n of this.notes) if (n.active && n.ch === c) n.amp = this.noteAmp(c, n.vel, n.patch); }
  reset() {
    for (const n of this.notes) n.active = false;
    this.pend = null; this.gen.reset(); this.gen.blep.clear(); this.spk.clear(); this.toTick = 0; this.sounding = 0;
  }
  activeCount() { return this.sounding; }
  maxVoices() { return 1; }

  /** current amplitude of a note including tremolo */
  noteLevel(n) {
    let e = n.env.e;
    const pt = n.patch;
    if (pt.trem && e > 0) e = Math.max(0, e - pt.trem[0] * 0.5 * (1 + Math.sin(2 * Math.PI * n.frames * this.dt * pt.trem[1])));
    return e <= 0 ? 0 : n.amp * Math.pow(10, (e - 1) * 45 / 20);
  }
  semis(n) {
    const pt = n.patch, ch = this.h.ch[n.ch], f = Math.round((n.frames - 1) * this.dt * 60);   // macros are in 60 Hz frames
    let s = n.note + pt.oct * 12 + ch.bend * ch.bendRange;
    if (pt.arp0 && f < pt.arp0.length) s += pt.arp0[f];
    if (pt.loop) s += pt.loop[f % pt.loop.length];
    const t = (n.frames - 1) * this.dt;
    if (pt.sweep) s += Math.max(-pt.sweepMax, Math.min(pt.sweepMax, pt.sweep * t));
    if (pt.vib && t >= pt.vib[1]) s += pt.vib[0] * tri(t * pt.vib[2]);
    if (ch.mod) s += (ch.mod / 127) * 0.5 * tri(t * 5.5);
    return s;
  }
  tick() {
    this.frame++;
    const H = this.h, g = this.gen, clock = this.cfg.clock, pwm = this.cfg.volume === 'pwm';
    for (const n of this.notes) {
      if (!n.active) continue;
      if (n.frames > 0) n.env.tick(this.dt);
      n.frames++;
      if (n.env.done) n.active = false;
    }
    // drums: one blip per tick, highest priority wins
    if (this.pend) {
      const [p, dur] = drumProgram(this.pend.note, this.pend.amp, clock, pwm);
      const len = pwm ? dur : dur * (0.55 + 0.45 * Math.sqrt(this.pend.amp));
      g.burst(p, len * clock);
      if (this.pend.amp > H.meter[this.pend.c]) H.meter[this.pend.c] = this.pend.amp;
      this.pend = null;
    }
    // gather sounding notes per MIDI channel (held notes hide releasing ones)
    let best = null, bestKey = -1;
    const lists = this.byCh;
    for (let c = 0; c < 16; c++) lists[c].length = 0;
    for (const n of this.notes) if (n.active && n.amp > 0 && !H.mute[n.ch]) lists[n.ch].push(n);
    const cand = [];
    for (let c = 0; c < 16; c++) {
      const l = lists[c];
      if (!l.length) continue;
      let held = 0, mx = 0, young = 99;
      for (const n of l) { if (n.on || n.sus) held++; }
      if (held && held < l.length) { let w = 0; for (const n of l) if (n.on || n.sus) l[w++] = n; l.length = w; }
      if (l.length > 4) { l.sort((a, b) => b.age - a.age); l.length = 4; }
      l.sort((a, b) => b.note - a.note);
      for (const n of l) { n.cur = this.noteLevel(n); if (n.cur > mx) mx = n.cur; if (n.frames < young) young = n.frames; }
      if (mx < 0.004) continue;
      const cls = CLASS[l[0].patch.role] || 1;
      const key = (held ? 8 : 0) + cls * 2 + Math.min(1.99, Math.sqrt(mx) + (young < 4 ? 0.3 : 0));
      cand.push({ c, l, key, cls, held });
      if (key > bestKey) { bestKey = key; best = cand[cand.length - 1]; }
    }
    let n = null;
    if (best) {
      if (this.cfg.mode === 'multiplex' && cand.length > 1) {
        // time-slice: melody, bass, then the chord notes, one per tick
        cand.sort((a, b) => b.key - a.key);
        const seq = this.seq || (this.seq = []);
        seq.length = 0;
        for (const x of cand) { if (x.cls >= 2) seq.push(x.cls === 3 ? x.l[0] : x.l[x.l.length - 1]); else for (const y of x.l) if (seq.length < 6) seq.push(y); }
        n = seq[this.frame % seq.length];
      } else n = best.l.length > 1 ? best.l[this.frame % best.l.length] : best.l[0];
    }
    this.sounding = 0;
    if (!n) { g.off(); return; }
    const a = n.cur, pt = n.patch;
    if (a < 0.004) { g.off(); return; }
    if (a > H.meter[n.ch]) H.meter[n.ch] = a;
    this.sounding = 1;
    const s = this.semis(n);
    if (pt.mix === 2) {                     // noise patches: random edge gaps scaled by pitch
      const us = clock * 1e-6, base = Math.max(8, 0.25e6 / midiHz(s));
      g.setNoise(base * 0.3 * us, base * 1.7 * us, pwm ? (6 + 34 * Math.sqrt(Math.min(1, a * 1.5))) * us : 0);
      return;
    }
    const hz = midiHz(s);
    if (this.cfg.timer === 'pit') {
      const N = Math.max(2, Math.min(65535, Math.round(clock / hz)));   // 8253 divisor
      let hi = Math.ceil(N / 2);
      if (pwm) hi = Math.max(2, Math.round(N * Math.asin(Math.min(1, a * 2.2)) / Math.PI));
      g.setTone(hi, N - hi);
    } else {
      const q = this.cfg.quantum || 5;                                     // delay-loop granularity
      const P = Math.max(4 * q, Math.round(clock / hz / q) * q);
      let hi = Math.round(P / 2 / q) * q;
      if (pwm) hi = Math.max(q, Math.round(P * Math.asin(Math.min(1, a * 2.2)) / Math.PI / q) * q);
      g.setTone(hi, P - hi);
    }
  }
  /** Render n samples, adding (centre) into L and R. */
  renderAdd(L, R, n, gain = this.gain) {
    const spt = this.sr / this.frameHz, tmp = this.tmp, g = this.gen, spk = this.spk;
    let off = 0;
    while (off < n) {
      if (this.toTick <= 0) { this.tick(); this.toTick += spt; }
      const m = Math.min(n - off, Math.ceil(this.toTick), 2048);
      g.render(m);
      g.blep.readTo(tmp, m);
      for (let i = 0; i < m; i++) { const y = spk.run(tmp[i]) * gain; L[off + i] += y; R[off + i] += y; }
      off += m; this.toTick -= m;
    }
  }
  render(L, R, n) { L.fill(0, 0, n); R.fill(0, 0, n); this.renderAdd(L, R, n); }
}
