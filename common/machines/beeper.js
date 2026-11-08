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

import { midiHz, gmLevel } from './util.js';
import { noteStart, noteTick, noteRelease, noteVol, notePitch, macroVal, normInst } from './ay-driver.js';
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
          if (p.k !== 1) { const P = Math.max(4, Math.min(p.maxP, (p.hi + p.lo) * p.k)), d = p.hi / (p.hi + p.lo); p.hi = Math.max(1, Math.round(P * d)); p.lo = Math.max(1, Math.round(P - p.hi)); }
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

// ---------------------------------------------------------------- drum blips
/** OneBit program + duration (s) for a 'blip' instrument. amp 0..1; pwm: loudness by pulse width. */
export function blipProgram(b, note, amp, clock, pwm) {
  const us = clock * 1e-6, width = pwm ? (6 + 34 * Math.sqrt(amp)) * us : 0;
  const hz = Math.max(20, b.rel ? b.hz * Math.pow(2, (note - 60) / 12) : b.hz);
  const dur = (b.ms / 1000) * (pwm ? 1 : 0.55 + 0.45 * Math.sqrt(amp));
  if (b.mode === 'noise') return [{ mode: NOISE, gmin: b.gapMin * us, gmax: Math.max(b.gapMin, b.gapMax) * us, w: width }, dur];
  const P = clock / hz, hi = pwm ? Math.min(P / 2, width * 1.5) : P / 2;
  return [{ mode: TONE, hi, lo: P - hi, k: b.mode === 'sweep' ? 1 + (b.sweep || 0) / 1000 : 1, maxP: clock / 20 }, dur];
}

// ---------------------------------------------------------------- the music driver
const CLASS = { lead: 3, bass: 2, chord: 1, pad: 1, perc: 1, fx: 1, drum: 1 };
const AY_LEVEL = [0, 0.01, 0.0145, 0.021, 0.0307, 0.0455, 0.0645, 0.107, 0.127, 0.205, 0.292, 0.373, 0.493, 0.635, 0.806, 1];

export class OneBitDriver {
  /**
   * cfg: clock, timer 'pit' | 'cpu', quantum (cycles of the tone loop), gateOff, speaker 'pc' | 'apple', frameHz,
   *      mode 'priority' | 'multiplex', gain, lib { presets, gmPreset, gmDrum }, ayPwm (AY instruments use pulse width)
   */
  constructor(host, cfg) {
    this.h = host; this.sr = host.sampleRate; this.cfg = { ...cfg };
    this.gen = new OneBit(this.sr, cfg.clock, cfg.gateOff);
    this.spk = new SpeakerModel(this.sr, cfg.speaker);
    this.notes = Array.from({ length: 48 }, () => ({ active: false }));
    this.byCh = Array.from({ length: 16 }, () => []);
    this.pend = null; this.blipNow = null;
    this.age = 0; this.frame = 0; this.toTick = 0;
    this.tmp = new Float32Array(2048);
    this.gain = cfg.gain || 0.3;
    this.sounding = 0;
    this.table = cfg.lib ? cfg.lib.presets.map(p => normInst({ ...p })) : [];
    this.arr = Array.from({ length: 16 }, () => ({ inst: -1, voice: 'auto' }));
    this.kit = {}; this.vmute = 0;
    this.vs = new Float32Array(4); this.vstate = [0, -1, -1, -1];
    this.setRate(cfg.frameHz);
  }
  setRate(hz) { this.cfg.frameHz = hz; this.frameHz = hz; this.dt = 1 / hz; }

  // ------------------------------------------------------------ v2 interface
  setInstruments(list) { this.table = list.map(p => normInst({ ...p })); for (const n of this.notes) if (n.active && this.table[n.idx]) n.inst = this.table[n.idx]; }
  updateInstrument(i, inst) { this.table[i] = normInst({ ...inst }); for (const n of this.notes) if (n.active && n.idx === i) n.inst = this.table[i]; }
  setArrangement(arr) { for (let c = 0; c < 16; c++) this.arr[c] = arr && arr[c] ? { inst: arr[c].inst, voice: arr[c].voice || 'auto' } : { inst: -1, voice: 'auto' }; }
  setKit(kit) { this.kit = kit || {}; }
  setVoiceMute(mask) { this.vmute = mask & 1; }
  voiceState() { const v = this.vs, s = this.vstate; v[0] = s[0]; v[1] = s[1]; v[2] = s[2]; v[3] = s[3]; return v; }
  resolve(c, note) {
    const ch = this.h.ch[c], a = this.arr[c];
    if (a.inst >= 0 && this.table[a.inst]) return a.inst;
    if (ch.drum) { const k = this.kit[note]; return k != null && this.table[k] ? k : this.cfg.lib.gmDrum(note); }
    return this.cfg.lib.gmPreset(ch.program);
  }

  // ------------------------------------------------------------ MIDI
  noteAmp(c, vel) { return this.h.mute[c] ? 0 : Math.min(1, 1.6 * gmLevel(this.h.ch[c], vel)); }
  noteOn(c, note, vel) {
    const idx = this.resolve(c, note), inst = this.table[idx];
    if (inst) this.playInst(inst, idx, c, note, vel);
  }
  /** play a given instrument (also used by the Apple II machine for its speaker instruments) */
  playInst(inst, idx, c, note, vel) {
    const amp = this.noteAmp(c, vel);
    if (inst.type === 'blip') {
      if (amp <= 0) return;
      const pr = inst.prio || 3;
      if (!this.pend || pr >= this.pend.pr) this.pend = { inst, idx, note, amp, pr, c };
      return;
    }
    let n = null;
    for (const x of this.notes) if (x.active && x.ch === c && x.note === note) { n = x; break; }
    if (!n) {
      let ba = Infinity;
      for (const x of this.notes) if (!x.active) { n = x; break; }
      if (!n) for (const x of this.notes) if (x.age < ba) { ba = x.age; n = x; }
    }
    Object.assign(n, { active: true, ch: c, note, vel, on: true, sus: false, age: ++this.age, cut: false, amp });
    noteStart(n, inst, idx);
  }
  noteOff(c, note) {
    for (const n of this.notes) if (n.active && n.on && n.ch === c && n.note === note) {
      n.on = false;
      if (this.h.ch[c].sustain) n.sus = true; else noteRelease(n);
    }
  }
  sustainOff(c) { for (const n of this.notes) if (n.active && n.sus && n.ch === c) { n.sus = false; noteRelease(n); } }
  allOff(c, hard) { for (const n of this.notes) if (n.active && n.ch === c) { n.on = false; n.sus = false; noteRelease(n); if (hard) n.active = false; } }
  pitch(c) {}
  ctrl(c) { for (const n of this.notes) if (n.active && n.ch === c) n.amp = this.noteAmp(c, n.vel); }
  reset() {
    for (const n of this.notes) n.active = false;
    this.pend = null; this.blipNow = null; this.gen.reset(); this.gen.blep.clear(); this.spk.clear(); this.toTick = 0; this.sounding = 0;
    this.vstate = [0, -1, -1, -1];
  }
  activeCount() { return this.sounding; }
  maxVoices() { return 1; }

  isPwm(inst) { return inst.kind === 'speaker' ? !!inst.pwm : !!this.cfg.ayPwm; }
  level(n) {          // amplitude 0..1 of a note this tick
    const v = noteVol(n);
    return v <= 0 ? 0 : n.amp * AY_LEVEL[v];
  }
  tick() {
    this.frame++;
    const H = this.h, g = this.gen, clock = this.cfg.clock;
    for (const n of this.notes) if (n.active && !noteTick(n)) n.active = false;
    // drum blips: one per tick, highest priority wins; they interrupt the tone
    if (this.pend) {
      const p = this.pend, pwm = this.isPwm(p.inst);
      const [prog, dur] = blipProgram(p.inst.blip, p.note, p.amp, clock, pwm);
      if (!(this.vmute & 1)) g.burst(prog, dur * clock);
      if (p.amp > H.meter[p.c]) H.meter[p.c] = p.amp;
      this.blipNow = { p, until: this.frame + Math.max(1, Math.round(dur * this.frameHz)) };
      this.pend = null;
    }
    // gather sounding notes per MIDI channel (held notes hide releasing ones)
    let best = null, bestKey = -1;
    const lists = this.byCh, cand = this.cand || (this.cand = []);
    cand.length = 0;
    for (let c = 0; c < 16; c++) lists[c].length = 0;
    for (const n of this.notes) if (n.active && n.amp > 0 && !H.mute[n.ch]) lists[n.ch].push(n);
    for (let c = 0; c < 16; c++) {
      const l = lists[c];
      if (!l.length) continue;
      let held = 0, mx = 0, young = 99;
      for (const n of l) if (n.on || n.sus) held++;
      if (held && held < l.length) { let w = 0; for (const n of l) if (n.on || n.sus) l[w++] = n; l.length = w; }
      if (l.length > 4) { l.sort((a, b) => b.age - a.age); l.length = 4; }
      l.sort((a, b) => b.note - a.note);
      for (const n of l) { n.cur = this.level(n); if (n.cur > mx) mx = n.cur; if (n.frames < young) young = n.frames; }
      if (mx <= 0) continue;
      const cls = CLASS[l[0].inst.role] || 1;
      const key = (held ? 8 : 0) + cls * 2 + Math.min(1.99, Math.sqrt(mx) + (young < 4 ? 0.3 : 0));
      const x = { c, l, key, cls }; cand.push(x);
      if (key > bestKey) { bestKey = key; best = x; }
    }
    let n = null;
    if (best) {
      if (this.cfg.mode === 'multiplex' && cand.length > 1) {
        cand.sort((a, b) => b.key - a.key);
        const seq = this.seq || (this.seq = []);
        seq.length = 0;
        for (const x of cand) { if (x.cls >= 2) seq.push(x.cls === 3 ? x.l[0] : x.l[x.l.length - 1]); else for (const y of x.l) if (seq.length < 6) seq.push(y); }
        n = seq[this.frame % seq.length];
      } else {
        const sp = Math.max(1, best.l[0].inst.arpSpeed || 1);
        n = best.l.length > 1 ? best.l[Math.floor(this.frame / sp) % best.l.length] : best.l[0];
      }
    }
    this.sounding = 0;
    const bl = this.blipNow && this.frame < this.blipNow.until ? this.blipNow.p : null;
    if (bl) this.vstate = [this.vmute ? 0 : bl.amp, bl.c, bl.note, bl.idx];
    if (!n || this.vmute & 1) { g.off(); if (!bl) this.vstate = [0, -1, -1, -1]; return; }
    const a = n.cur, I = n.inst;
    if (a > H.meter[n.ch]) H.meter[n.ch] = a;
    this.sounding = 1;
    if (!bl) this.vstate = [a, n.ch, n.note, n.idx];
    const semis = notePitch(n, H.ch[n.ch], this.frameHz);
    const hz = midiHz(semis), pwm = this.isPwm(I);
    const noisy = I.kind === 'speaker' ? !!I.noisy : (I.mixer && macroVal(I.mixer, n.im) === 2);
    const us = clock * 1e-6;
    if (noisy) {
      const base = Math.max(8, 0.25e6 / hz);
      g.setNoise(base * 0.3 * us, base * 1.7 * us, pwm ? (6 + 34 * Math.sqrt(Math.min(1, a * 1.5))) * us : 0);
      return;
    }
    const duty = Math.max(0.01, Math.min(0.5, (I.duty || 50) / 100));
    const frac = pwm ? Math.min(duty, Math.asin(Math.min(1, a * 2.2)) / Math.PI) : duty;
    const off = I.kind === 'speaker' && I.pitch ? macroVal(I.pitch, n.ip) : 0;
    if (this.cfg.timer === 'pit') {
      const N = Math.max(2, Math.min(65535, Math.round(clock / hz) + off));    // 8253 divisor
      const hi = frac >= 0.5 ? Math.ceil(N / 2) : Math.max(1, Math.round(N * frac));
      g.setTone(hi, N - hi);
    } else {
      const q = this.cfg.quantum || 5;                                       // delay-loop granularity
      const P = Math.max(4 * q, Math.round((clock / hz + off) / q) * q);
      const hi = Math.max(q, Math.round(P * frac / q) * q);
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
