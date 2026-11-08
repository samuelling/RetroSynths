// General MIDI → AY-3-8910 / YM2149 music driver (own code), shared by apple2, zx and msx.
//
// Works like an 8-bit game music engine: an interrupt at frame rate (50/60 Hz) runs the driver, which
// steps software envelopes and pitch macros and writes the chip registers. Everything it does is
// expressed in what the chip can do: 12-bit periods, 4-bit volume, one noise period and one hardware
// envelope per chip.
//
// Voice allocation, re-done every frame:
//   · MIDI channels become "parts"; each part is scored by role (lead > bass > perc > chord > fx > pad),
//     current loudness and recency.
//   · Drums claim a chip channel first (noise / tone-sweep macros), like the "channel C steals" trick.
//   · Every part gets one channel in score order; spare channels give multi-note parts real polyphony.
//   · A part with more notes than channels plays them as a per-frame arpeggio (the classic fake chord);
//     chord/pad parts that lost their channel fold into another chord part's arpeggio.
//   · Parts stick to their previous channel; in stereo set-ups they prefer the chip/channel nearest
//     their pan.
//   · Bass patches may take the chip's hardware envelope as a "buzzer" waveform (sawtooth / triangle /
//     tone-gated saw at the note's pitch), one per chip.

import { midiHz, gmLevel, drumKind, TOM_NOTE } from './util.js';
import { patchFor, ROLE_W, MERGEABLE, LogEnv, noiseForNote } from './ay-patches.js';
import { Blep } from './beeper-dsp.js';
import { AYChip } from './ay.js';

const NOTE_POOL = 64;
const MAX_ARP = 4;

class Note {
  constructor() { this.active = false; this.env = new LogEnv(); this.ch = 0; this.note = 0; this.vel = 0; this.on = false; this.sus = false; this.age = 0; this.frames = 0; this.amp = 0; this.patch = null; this.cur = 0; }
}
class Part {
  constructor(c) { this.c = c; this.notes = []; this.score = 0; this.nv = 0; this.merged = []; this.had = false; this.pan = 0.5; this.patch = null; }
}

// ---------------------------------------------------------------- drum macros (per driver frame)
// frame = [volume 0..15, mix (0 tone, 1 tone+noise, 2 noise), noise period, tone Hz]
function decay(v0, frames, f) {
  const out = [];
  for (let i = 0; i < frames; i++) { const v = Math.max(1, Math.round(v0 - (v0 - 1) * i / Math.max(1, frames - 1))); out.push([v, ...f(i)]); }
  return out;
}
const sweep = (h0, h1, n) => (i) => h0 * Math.pow(h1 / h0, Math.min(1, i / Math.max(1, n - 1)));
export function ayDrumMacro(n) {
  const k = drumKind(n);
  switch (k) {
    case 'kick': { const lo = n === 35 ? 0.85 : 1; return decay(15, 8, (i) => [i === 0 ? 1 : 0, 14, sweep(150 * lo, 42 * lo, 6)(i)]); }
    case 'snare': return decay(15, n === 40 ? 8 : 10, (i) => i === 0 ? [1, n === 40 ? 4 : 6, 230] : [2, (n === 40 ? 3 : 5) + (i >> 1), 0]);
    case 'stick': return [[14, 1, 1, 1700], [9, 0, 0, 1250], [4, 0, 0, 1250]];
    case 'clap': return [[13, 2, 3, 0], [3, 2, 3, 0], [13, 2, 3, 0], ...decay(12, 7, (i) => [2, 4 + (i >> 1), 0])];
    case 'hatClosed': return [[12, 2, 0, 0], [8, 2, 0, 0], [3, 2, 0, 0]];
    case 'hatPedal': return [[10, 2, 1, 0], [6, 2, 1, 0], [2, 2, 1, 0]];
    case 'hatOpen': return decay(13, 16, (i) => [2, i & 1, 0]);
    case 'crash': {
      const len = n === 55 ? 20 : 44, np = n === 52 ? 4 : 2;
      return decay(14, len, (i) => [2, np + (i % 3 === 0 ? 1 : 0), 0]);
    }
    case 'ride': return decay(12, 26, (i) => i < 2 ? [1, 0, 3400] : [1, 1, 3100]);
    case 'bell': return decay(13, 24, (i) => [0, 0, i & 1 ? 2150 : 1420]);
    case 'tom': { const t = TOM_NOTE[n] || 50; return decay(15, 9, (i) => [i === 0 ? 1 : 0, 10, sweep(midiHz(t + 7), midiHz(t - 5), 8)(i)]); }
    case 'conga': {
      const t = TOM_NOTE[n] || 64, mute = n === 62;
      return decay(14, mute ? 3 : 6, (i) => [0, 0, sweep(midiHz(t + 3), midiHz(t), 4)(i)]);
    }
    case 'cowbell':
      if (n === 56) return decay(13, 9, (i) => [0, 0, i & 1 ? 545 : 810]);
      return decay(12, 6, (i) => [0, 0, n === 67 ? 1000 : 760]);   // agogo
    case 'shaker':
      if (n === 54) return [[11, 2, 0, 0], [8, 2, 0, 0], [11, 2, 0, 0], [7, 2, 0, 0], [5, 2, 0, 0], [3, 2, 0, 0]];
      return [[9, 2, 0, 0], [6, 2, 0, 0], [3, 2, 0, 0]];
    case 'block': return decay(13, 3, () => [0, 0, n === 75 ? 2500 : n === 76 ? 1250 : 950]);
    case 'triangle': return decay(12, n === 80 ? 4 : 32, (i) => [0, 0, i & 1 ? 4480 : 4420]);
    default:
      switch (n) {
        case 58: return decay(12, 20, (i) => [i & 1 ? 2 : 1, 6, 300]);                            // vibraslap
        case 71: return decay(12, 8, (i) => [0, 0, 2350 + (i & 1) * 40]);                          // short whistle
        case 72: return decay(12, 26, (i) => [0, 0, 2350 + (i & 2) * 20]);                         // long whistle
        case 73: return [[11, 2, 6, 0], [2, 2, 6, 0], [11, 2, 6, 0], [2, 2, 6, 0], [9, 2, 6, 0]];  // short guiro
        case 74: return decay(11, 14, (i) => [2, i & 1 ? 9 : 5, 0]);                               // long guiro
        case 78: return decay(12, 5, (i) => [0, 0, sweep(420, 720, 5)(i)]);                        // mute cuica
        case 79: return decay(12, 10, (i) => [0, 0, sweep(650, 300, 10)(i)]);                     // open cuica
        default: return decay(12, 5, (i) => [1, 3, midiHz(n + 12)]);
      }
  }
}
const DRUM_PRIO = { kick: 9, snare: 8, clap: 7, tom: 7, crash: 6, stick: 5, conga: 5, cowbell: 5, bell: 4, ride: 4, block: 4, triangle: 3, perc: 3, hatOpen: 3, shaker: 2, hatClosed: 2, hatPedal: 1 };
const MACRO_CACHE = [];
const macroFor = (n) => MACRO_CACHE[n] || (MACRO_CACHE[n] = ayDrumMacro(n));

// ---------------------------------------------------------------- the driver
export class AYDriver {
  /**
   * cfg:
   *   chips: [{ clock, variant }],  frameHz,
   *   panMode: 'mono' | 'chips' (chip 0 → L, chip 1 → R) | 'ABC' (A left, B centre, C right),
   *   buzz: allow hardware-envelope bass,  drumVoices: max chip channels drums may take,
   *   gain: output scale
   */
  constructor(host, cfg) {
    this.h = host; this.sr = host.sampleRate;
    this.cfg = cfg;
    this.frameHz = cfg.frameHz; this.dt = 1 / cfg.frameHz;
    this.blepL = new Blep(this.sr); this.blepR = new Blep(this.sr);
    this.chips = [];
    this.makeChips();
    // inverse DAC lookup thresholds for fixed volume levels (geometric means between neighbours)
    const amp = (v) => this.chips[0].levelAmp(v);
    this.ampOf = Float64Array.from({ length: 16 }, (_, v) => amp(v));
    this.thr = Float64Array.from({ length: 15 }, (_, v) => v === 0 ? amp(1) * 0.5 : Math.sqrt(amp(v) * amp(v + 1)));
    this.notes = Array.from({ length: NOTE_POOL }, () => new Note());
    this.parts = Array.from({ length: 16 }, (_, c) => new Part(c));
    this.drums = Array.from({ length: 6 }, () => ({ active: false, n: 0, f: 0, macro: null, amp: 0, prio: 0, age: 0, c: 9 }));
    this.age = 0; this.frame = 0; this.toTick = 0;
    this.arpSpeed = 1;
    this.dcL = 0; this.dcR = 0; this.dcxL = 0; this.dcxR = 0; this.dcK = Math.exp(-2 * Math.PI * 18 / this.sr);
    this.gain = cfg.gain || 0.5;
    this.sounding = 0;
    this.reqs = [];
    this.silence();
  }
  makeChips() {
    const cfg = this.cfg;
    this.slots = [];
    this.chips = cfg.chips.map((cc) => new AYChip({ clock: cc.clock, variant: cc.variant, sampleRate: this.sr, outL: this.blepL, outR: this.blepR }));
    for (let ci = 0; ci < this.chips.length; ci++)
      for (let i = 0; i < 3; i++)
        this.slots.push({ chip: this.chips[ci], ci, i, pan: 0.5, lastKey: -1, taken: false, drum: null, req: null, buzzNote: null, idle: 0 });
    const m = cfg.panMode; cfg.panMode = null;
    this.setPanMode(m);
  }
  setPanMode(mode) {
    if (this.cfg.panMode === mode) return;
    this.cfg.panMode = mode;
    const pans = mode === 'chips' ? null : mode === 'ABC' ? [[1, 0.0], [0.5, 0.5], [0.0, 1]] : [[1, 0], [1, 0], [1, 0]];
    this.chips.forEach((c, ci) => c.setPan(pans || (ci === 0 ? [[1, 0], [1, 0], [1, 0]] : [[0, 1], [0, 1], [0, 1]])));
    for (const s of this.slots) s.pan = mode === 'chips' ? s.ci : mode === 'ABC' ? s.i * 0.5 : 0.5;
    this.stereo = mode !== 'mono';
  }
  silence() {
    for (const c of this.chips) {
      c.reset();
      c.write(7, 0xFF);                 // all tone and noise off (I/O ports as inputs... bits 6/7 set: outputs; harmless)
      for (let r = 8; r <= 10; r++) c.write(r, 0);
    }
    for (const s of this.slots) { s.lastKey = -1; s.buzzNote = null; s.vol = 0; }
  }

  // ------------------------------------------------------------ MIDI
  noteAmp(c, vel, patch) {
    if (this.h.mute[c]) return 0;
    return Math.min(1, 1.6 * gmLevel(this.h.ch[c], vel) * patch.gain);
  }
  noteOn(c, note, vel) {
    const ch = this.h.ch[c];
    if (ch.drum) { this.drumOn(c, note, vel); return; }
    let n = null;
    for (const x of this.notes) if (x.active && x.ch === c && x.note === note) { n = x; break; }
    if (!n) n = this.allocNote();
    const patch = patchFor(ch.program);
    n.active = true; n.ch = c; n.note = note; n.vel = vel; n.on = true; n.sus = false; n.age = ++this.age; n.frames = 0;
    n.patch = patch; n.amp = this.noteAmp(c, vel, patch); n.env.start(patch); n.vibPh = 0;
  }
  allocNote() {
    let best = null, ba = Infinity;
    for (const x of this.notes) if (!x.active) return x;
    for (const x of this.notes) if (!x.on && !x.sus && x.age < ba) { best = x; ba = x.age; }
    if (best) return best;
    for (const x of this.notes) if (x.age < ba) { best = x; ba = x.age; }
    return best;
  }
  drumOn(c, note, vel) {
    const amp = this.h.mute[c] ? 0 : Math.min(1, 1.6 * gmLevel(this.h.ch[c], vel));
    if (amp <= 0) return;
    if (this.extDrum && this.extDrum(note, vel, amp, c)) return;   // e.g. Apple II speaker drums
    if (note < 27 || note > 87) return;
    let d = null;
    for (const x of this.drums) if (!x.active) { d = x; break; }
    if (!d) { let ba = Infinity; for (const x of this.drums) if (x.age < ba) { ba = x.age; d = x; } }
    const k = drumKind(note);
    // hi-hats choke each other
    if (k === 'hatClosed' || k === 'hatPedal') for (const x of this.drums) if (x.active && drumKind(x.n) === 'hatOpen') x.active = false;
    Object.assign(d, { active: true, n: note, f: -1, macro: macroFor(note), amp, prio: DRUM_PRIO[k] || 3, age: ++this.age, c });
  }
  noteOff(c, note) {
    for (const n of this.notes) if (n.active && n.on && n.ch === c && n.note === note) {
      n.on = false;
      if (this.h.ch[c].sustain) n.sus = true; else n.env.release();
    }
  }
  sustainOff(c) { for (const n of this.notes) if (n.active && n.sus && n.ch === c) { n.sus = false; n.env.release(); } }
  allOff(c, hard) {
    for (const n of this.notes) if (n.active && n.ch === c) { n.on = false; n.sus = false; n.env.release(); if (hard) n.active = false; }
    if (hard) for (const d of this.drums) if (d.c === c) d.active = false;
  }
  pitch(c) {}                     // periods are recomputed every driver frame
  ctrl(c) { for (const n of this.notes) if (n.active && n.ch === c) n.amp = this.noteAmp(c, n.vel, n.patch); }
  reset() {
    for (const n of this.notes) n.active = false;
    for (const d of this.drums) d.active = false;
    this.silence();
    this.blepL.clear(); this.blepR.clear();
    this.dcL = this.dcR = this.dcxL = this.dcxR = 0;
    this.toTick = 0; this.sounding = 0;
  }
  activeCount() { return this.sounding; }
  maxVoices() { return this.slots.length; }

  // ------------------------------------------------------------ frame tick
  quant(a) {   // amplitude → 4-bit level through the chip's DAC curve
    if (a <= 0) return 0;
    const t = this.thr; let v = 0;
    while (v < 15 && a > t[v]) v++;
    return v;
  }
  tick() {
    this.frame++;
    const dt = this.dt, H = this.h;
    for (const n of this.notes) {
      if (!n.active) continue;
      if (n.frames > 0) n.env.tick(dt);
      n.frames++;
      if (n.env.done) n.active = false;
    }
    for (const d of this.drums) if (d.active && (++d.f >= d.macro.length || H.mute[d.c])) d.active = false;

    // ---- drums claim channels
    for (const s of this.slots) { s.taken = false; s.drum = null; s.req = null; }
    let dv = 0;
    const maxD = this.cfg.drumVoices || 1;
    const dl = this.drums.filter(d => d.active).sort((a, b) => (b.prio - a.prio) || (b.age - a.age));
    for (const d of dl) {
      if (dv >= maxD) break;
      // preferred drum channel: C of each chip (B in ABC stereo, the centre)
      let best = null, bc = Infinity;
      for (const s of this.slots) {
        if (s.taken) continue;
        let cost = (this.cfg.panMode === 'ABC' ? (s.i === 1 ? 0 : 1) : (s.i === 2 ? 0 : 1)) + s.ci * 0.1 * (dv === 0 ? 1 : -1);
        if (s.lastKey === -2) cost -= 0.5;
        if (cost < bc) { bc = cost; best = s; }
      }
      if (!best) break;
      best.taken = true; best.drum = d; dv++;
    }

    // ---- build parts
    const parts = this.parts, act = [];
    for (const p of parts) { p.notes.length = 0; p.merged.length = 0; p.nv = 0; }
    for (const n of this.notes) if (n.active && n.amp > 0 && !H.mute[n.ch]) parts[n.ch].notes.push(n);
    for (const p of parts) {
      if (!p.notes.length) { p.had = false; continue; }
      let held = 0;
      for (const n of p.notes) if (n.on || n.sus) held++;
      if (held && held < p.notes.length) { let w = 0; for (const n of p.notes) if (n.on || n.sus) p.notes[w++] = n; p.notes.length = w; }
      if (p.notes.length > MAX_ARP) { p.notes.sort((a, b) => b.age - a.age); p.notes.length = MAX_ARP; }
      p.notes.sort((a, b) => b.note - a.note);
      let mx = 0, young = 99;
      for (const n of p.notes) { n.cur = n.amp * n.env.amp; if (n.cur > mx) mx = n.cur; if (n.frames < young) young = n.frames; }
      p.patch = p.notes[0].patch;
      p.score = ROLE_W[p.patch.role] * Math.sqrt(mx) + (young < 6 ? 0.25 : 0) + (p.had ? 0.08 : 0);
      p.pan = Math.max(0, Math.min(1, (H.ch[p.c].pan - 1) / 126));
      act.push(p);
    }
    act.sort((a, b) => b.score - a.score);
    let avail = this.slots.length - dv;
    for (const p of act) if (avail > 0) { p.nv = 1; avail--; }
    for (const p of act) while (avail > 0 && p.nv < p.notes.length) { p.nv++; avail--; }
    for (const p of act) {
      if (p.nv || !MERGEABLE[p.patch.role]) continue;
      let tgt = null;
      for (let i = act.length - 1; i >= 0; i--) {
        const q = act[i];
        if (q.nv && MERGEABLE[q.patch.role] && (q.notes.length - q.nv + 1) + q.merged.length + p.notes.length <= MAX_ARP) { tgt = q; break; }
      }
      if (tgt) for (const n of p.notes) tgt.merged.push(n);
    }

    // ---- requests → chip channels (sticky, pan-aware)
    const reqs = this.reqs; reqs.length = 0;
    for (const p of act) {
      p.had = p.nv > 0;
      for (let k = 0; k < p.nv; k++) reqs.push({ p, k, key: p.c * 8 + k, slot: null });
    }
    // keep a part on its channel while it holds the same notes; re-place it (by pan and chip load) at onsets
    const load = this.load || (this.load = new Float64Array(8));
    load.fill(0);
    for (const r of reqs) {
      let onset = false;
      for (const n of r.p.notes) if (n.frames === 1) onset = true;
      if (onset && this.cfg.panMode === 'chips') continue;
      for (const s of this.slots) if (!s.taken && s.lastKey === r.key) { s.taken = true; s.req = r; r.slot = s; load[s.ci] += r.p.score; break; }
    }
    for (const r of reqs) {
      if (r.slot) continue;
      let best = null, bc = Infinity;
      for (const s of this.slots) {
        if (s.taken) continue;
        let cost = this.stereo ? Math.abs(s.pan - r.p.pan) : 0;
        if (this.cfg.panMode === 'chips') cost += 0.3 * load[s.ci];
        if (s.lastKey === r.key) cost -= 0.05;
        else if (s.idle === 0) cost += 0.02;
        if (cost < bc) { bc = cost; best = s; }
      }
      if (!best) break;
      best.taken = true; best.req = r; r.slot = best; load[best.ci] += r.p.score;
    }

    // ---- hardware envelope ("buzzer") ownership: one bass part per chip
    const envOwner = this.envOwner || (this.envOwner = []);
    for (let ci = 0; ci < this.chips.length; ci++) envOwner[ci] = null;
    if (this.cfg.buzz) {
      for (const r of reqs) {
        if (!r.slot || r.k !== 0) continue;
        const p = r.p, n = p.notes[0];
        if (!p.patch.buzz || p.nv !== p.notes.length || p.notes.length !== 1 || p.merged.length) continue;
        if (!(n.on || n.sus) || n.cur < 0.08) continue;
        const ci = r.slot.ci;
        if (!envOwner[ci] || envOwner[ci].p.score < p.score) envOwner[ci] = r;
      }
    }

    // ---- compute and write registers
    let sounding = 0;
    for (let ci = 0; ci < this.chips.length; ci++) {
      const chip = this.chips[ci];
      let mixer = 0x3F, noiseP = -1, noisePrio = -1;
      for (let i = 0; i < 3; i++) {
        const s = this.slots[ci * 3 + i];
        let vol = 0, tp = -1, tone = false, noise = false;
        if (s.drum) {
          const d = s.drum, fr = d.macro[d.f];
          vol = this.quant(this.ampOf[fr[0]] * d.amp * (this.cfg.drumGain || 1));
          tone = fr[1] !== 2; noise = fr[1] !== 0;
          if (tone) tp = chip.periodFor(fr[3]);
          if (noise && 100 > noisePrio) { noisePrio = 100; noiseP = fr[2]; }
          s.lastKey = -2; s.buzzNote = null;
          if (vol > 0) { sounding++; if (d.amp > H.meter[d.c]) H.meter[d.c] = d.amp; }
        } else if (s.req) {
          const r = s.req, p = r.p;
          s.lastKey = r.key;
          // which note does this channel play this frame?
          let n;
          if ((p.nv >= p.notes.length && !p.merged.length) || r.k < p.nv - 1) n = p.notes[r.k];
          else {
            const start = p.nv - 1, own = p.notes.length - start, cnt = own + p.merged.length;
            const idx = Math.floor(this.frame / this.arpSpeed) % cnt;
            n = idx < own ? p.notes[start + idx] : p.merged[idx - own];
          }
          const pt = n.patch, ch = H.ch[n.ch], f = n.frames - 1;
          let semis = n.note + pt.oct * 12 + ch.bend * ch.bendRange;
          if (pt.arp0 && f < pt.arp0.length) semis += pt.arp0[f];
          if (pt.loop) semis += pt.loop[f % pt.loop.length];
          if (pt.sweep) { const sw = pt.sweep * f * this.dt; semis += Math.max(-pt.sweepMax, Math.min(pt.sweepMax, sw)); }
          const tsec = f * this.dt;
          if (pt.vib && tsec >= pt.vib[1]) semis += pt.vib[0] * tri(tsec * pt.vib[2]);
          if (ch.mod) semis += (ch.mod / 127) * 0.5 * tri(tsec * 5.5);
          const hz = midiHz(semis);
          let e = n.env.e;
          if (pt.trem && e > 0) e = Math.max(0, e - pt.trem[0] * 0.5 * (1 + Math.sin(2 * Math.PI * tsec * pt.trem[1])));
          const a = e <= 0 ? 0 : n.amp * Math.pow(10, (e - 1) * 45 / 20);
          if (a > H.meter[n.ch]) H.meter[n.ch] = a;
          vol = this.quant(a);
          if (pt.mix === 2) { noise = true; tone = false; }
          else { tone = true; noise = pt.mix === 1 || f < pt.atkN; }
          if (noise) {
            const np = pt.mix === 2 || pt.mix === 1 ? (pt.np < 0 ? noiseForNote(semis) : pt.np) : pt.atkNp;
            if (p.score > noisePrio) { noisePrio = p.score; noiseP = np; }
          }
          tp = chip.periodFor(hz);
          const triB = pt.buzz === 'tri', ep = envOwner[ci] === r ? chip.envPeriodFor(hz, triB) : 0;
          // the envelope only tunes well at bass pitches: skip it when its period is > 20 cents off
          if (ep && vol > 0 && Math.abs(1200 * Math.log2(chip.clock / ((triB ? 512 : 256) * ep) / hz)) < 20) {
            // hardware envelope as the oscillator
            const shape = triB ? 10 : pt.buzz === 'sync' ? 12 : 8;
            chip.write(11, ep & 255); chip.write(12, ep >> 8);
            if (s.buzzNote !== n || n.frames === 1) { chip.write(13, shape); s.buzzNote = n; }
            vol = 16;
            if (pt.buzz === 'sync') { tp = Math.min(4095, ep * 16); tone = true; } else tone = false;
            noise = false;
          } else s.buzzNote = null;
          if (vol > 0) sounding++;
        } else {
          s.buzzNote = null;
          if (s.lastKey !== -1) s.idle = 0;
          s.lastKey = -1;
        }
        s.idle = vol > 0 ? 0 : s.idle + 1;
        if (tp >= 0) { chip.write(i * 2, tp & 255); chip.write(i * 2 + 1, tp >> 8); }
        chip.write(8 + i, vol);
        if (tone) mixer &= ~(1 << i);
        if (noise) mixer &= ~(8 << i);
      }
      if (noiseP >= 0) chip.write(6, noiseP);
      chip.write(7, mixer | 0xC0);
    }
    this.sounding = sounding;
  }

  // ------------------------------------------------------------ audio
  /** Optional per-block extra source (e.g. Apple II speaker), adds into L/R at off. */
  extra(L, R, off, m) {}
  render(L, R, n) {
    L.fill(0, 0, n); R.fill(0, 0, n);
    const spt = this.sr / this.frameHz;
    let off = 0;
    while (off < n) {
      if (this.toTick <= 0) { this.tick(); this.toTick += spt; }
      const m = Math.min(n - off, Math.ceil(this.toTick), 2048);
      for (const c of this.chips) c.render(m);
      this.blepL.read(L, m, 1, off);
      this.blepR.read(R, m, 1, off);
      this.post(L, R, off, m);
      this.extra(L, R, off, m);
      off += m; this.toTick -= m;
    }
  }
  /** DC removal (the AY output is unipolar) and output gain. */
  post(L, R, off, m) {
    const k = this.dcK, g = this.gain;
    let xl = this.dcxL, yl = this.dcL, xr = this.dcxR, yr = this.dcR;
    if (this.stereo) {
      for (let i = off; i < off + m; i++) {
        const l = L[i], r = R[i];
        yl = l - xl + k * yl; xl = l; yr = r - xr + k * yr; xr = r;
        L[i] = yl * g; R[i] = yr * g;
      }
    } else {
      for (let i = off; i < off + m; i++) { const l = L[i]; yl = l - xl + k * yl; xl = l; L[i] = R[i] = yl * g; }
    }
    this.dcxL = xl; this.dcL = yl; this.dcxR = xr; this.dcR = yr;
  }
}

const tri = (ph) => { const x = ph - Math.floor(ph); return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4; };

