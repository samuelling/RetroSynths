// AY-3-8910 / YM2149 music driver (own code), shared by apple2, zx and msx.
//
// Works like an 8-bit game / tracker replay routine: an interrupt at frame rate (50/60 Hz) steps every
// sounding instrument's macros (volume, arpeggio, pitch, noise, mixer, hardware envelope — see
// ay-instruments.js) and writes the chip registers. Everything is expressed in what the chip can do:
// 12-bit periods, 4-bit volume, one noise period and one hardware envelope per chip.
//
// Voice allocation, re-done every frame:
//   · MIDI channels pinned to a chip channel (Arranger) take it first; drums (one-shot instruments) claim
//     a channel next, like the "channel C steals" trick;
//   · remaining MIDI channels become "parts" scored by role (lead > bass > perc > chord > fx > pad),
//     loudness and recency; each gets one channel in score order, spare channels give polyphony;
//   · a part with more notes than channels plays them as a per-frame arpeggio (the classic fake chord),
//     chord/pad parts that lost their channel fold into another chord part's arpeggio;
//   · parts stick to their channel; in stereo set-ups they prefer the chip/channel nearest their pan;
//   · instruments using the hardware envelope get it one per chip (highest score), others fall back to
//     the plain tone at their macro volume.

import { midiHz, gmLevel } from './util.js';
import { ROLE_W, MERGEABLE, noiseForNote } from './ay-patches.js';
import { Blep } from './beeper-dsp.js';
import { AYChip } from './ay.js';

const NOTE_POOL = 64;
const MAX_ARP = 4;
const CONT_SHAPES = new Set([8, 10, 12, 14]);

const MAC = (v) => ({ values: [v], loop: -1, release: -1 });
const okMacro = (m, def) => (m && Array.isArray(m.values) && m.values.length) ? m : MAC(def);
/** Fill in anything missing from an instrument (older saves, hand-made JSON) so the driver never trips. */
export function normInst(I) {
  if (!I || typeof I !== 'object') return null;
  I.vol = okMacro(I.vol, 15); I.arp = okMacro(I.arp, 0);
  if (I.kind !== 'speaker') { I.pitch = okMacro(I.pitch, 0); I.noise = okMacro(I.noise, 0); I.mixer = okMacro(I.mixer, 1); }
  else I.pitch = okMacro(I.pitch, 0);
  if (!I.env || typeof I.env !== 'object') I.env = { shape: -1, mode: 'note', ratio: 1, period: 1000 };
  if (!I.vib) I.vib = { depth: 0, delay: 0, speed: 8 };
  if (!I.slide) I.slide = { speed: 0, limit: 0 };
  if (I.type === 'blip' && !I.blip) I.blip = { mode: 'tone', hz: 800, ms: 40, sweep: 0, gapMin: 20, gapMax: 200, rel: 0 };
  return I;
}

/** Advance a macro index by one step (FamiTracker loop / release semantics). */
export function stepMacro(m, i, released) {
  const len = m.values.length;
  i++;
  if (!released && m.release >= 0 && i >= m.release) return (m.loop >= 0 && m.loop < m.release) ? m.loop : m.release - 1;
  if (i >= len) return (m.loop >= 0 && (!released || m.release < 0 || m.loop >= m.release)) ? m.loop : len - 1;
  return i;
}
export const macroVal = (m, i) => m.values[Math.min(i, m.values.length - 1)] || 0;
const tri = (ph) => { const x = ph - Math.floor(ph); return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4; };

class Note {
  constructor() { this.active = false; this.ch = 0; this.note = 0; this.vel = 0; this.on = false; this.sus = false; this.age = 0; this.frames = 0; this.amp = 0; this.inst = null; this.idx = -1; this.cur = 0; this.rel = false; this.relCap = 15; this.iv = 0; this.ia = 0; this.ip = 0; this.inz = 0; this.im = 0; this.vsub = 0; this.slide = 0; }
}
class Part {
  constructor(c) { this.c = c; this.notes = []; this.score = 0; this.nv = 0; this.merged = []; this.had = false; this.pan = 0.5; this.inst = null; this.pin = null; }
}

/** Per-note frame state: macros, pitch and level. Shared with the 1-bit driver. */
export function noteStart(n, inst, idx) {
  n.inst = inst; n.idx = idx; n.frames = 0; n.rel = false; n.relCap = 15;
  n.iv = n.ia = n.ip = n.inz = n.im = 0; n.vsub = 0; n.slide = 0;
}
export function noteRelease(n) {
  if (n.rel) return;
  const I = n.inst;
  n.relCap = macroVal(I.vol, n.iv);
  n.rel = true;
  for (const [k, key] of [['vol', 'iv'], ['arp', 'ia'], ['pitch', 'ip'], ['noise', 'inz'], ['mixer', 'im']]) {
    const m = I[k]; if (m && m.release >= 0 && m.release < m.values.length) n[key] = m.release;
  }
  if (I.vol.release < 0 && I.role !== 'drum') n.cut = true;    // no release segment: note-off cuts
}
/** Step a note's macros one frame; returns false when the note has finished. */
export function noteTick(n) {
  const I = n.inst;
  if (n.cut) return false;
  if (n.frames > 0) {
    if (++n.vsub >= (I.volSpeed || 1)) { n.vsub = 0; n.iv = stepMacro(I.vol, n.iv, n.rel); }
    n.ia = stepMacro(I.arp, n.ia, n.rel);
    if (I.pitch) n.ip = stepMacro(I.pitch, n.ip, n.rel);
    if (I.noise) n.inz = stepMacro(I.noise, n.inz, n.rel);
    if (I.mixer) n.im = stepMacro(I.mixer, n.im, n.rel);
    if (I.slide && I.slide.speed) { n.slide += I.slide.speed; if (I.slide.limit > 0) n.slide = Math.max(-I.slide.limit, Math.min(I.slide.limit, n.slide)); }
  }
  n.frames++;
  const v = I.vol, last = v.values.length - 1;
  if (n.frames > 1 && n.iv >= last && !macroVal(v, last)) {
    const loops = v.loop >= 0 && (!n.rel || v.release < 0 || v.loop >= v.release);
    if (!loops) return false;
  }
  return true;
}
/** Current 4-bit macro volume (with the release cap). */
export const noteVol = (n) => Math.min(macroVal(n.inst.vol, n.iv), n.rel ? n.relCap : 15);
/** Pitch of a note this frame in semitones (float), before the period-offset macro. */
export function notePitch(n, ch, fps) {
  const I = n.inst, f = n.frames - 1;
  const a = macroVal(I.arp, n.ia);
  let s = I.arpMode === 'fixed' ? a : n.note + a + ch.bend * ch.bendRange;
  s += I.transpose || 0;
  let cents = n.slide;
  const vb = I.vib;
  if (vb && vb.depth && f >= vb.delay) cents += vb.depth * tri((f - vb.delay) / Math.max(2, vb.speed));
  if (ch.mod) cents += (ch.mod / 127) * 50 * tri(f * 5.5 / fps);
  return s + cents / 100;
}

export class AYDriver {
  /**
   * cfg: chips [{ clock, variant }], frameHz, panMode 'mono' | 'chips' | 'ABC', drumVoices, gain, drumGain,
   *      lib { presets, gmPreset, gmDrum }, voiceIds [ids of the chip channels, in slot order]
   */
  constructor(host, cfg) {
    this.h = host; this.sr = host.sampleRate;
    this.cfg = cfg;
    this.frameHz = cfg.frameHz; this.dt = 1 / cfg.frameHz;
    this.blepL = new Blep(this.sr); this.blepR = new Blep(this.sr);
    this.makeChips();
    const amp = (v) => this.chips[0].levelAmp(v);
    this.ampOf = Float64Array.from({ length: 16 }, (_, v) => amp(v));
    this.thr = Float64Array.from({ length: 15 }, (_, v) => v === 0 ? amp(1) * 0.5 : Math.sqrt(amp(v) * amp(v + 1)));
    this.notes = Array.from({ length: NOTE_POOL }, () => new Note());
    this.parts = Array.from({ length: 16 }, (_, c) => new Part(c));
    this.drums = Array.from({ length: 6 }, () => new Note());
    this.table = cfg.lib.presets.map(p => normInst({ ...p }));
    this.gmDrum = cfg.lib.gmDrum;
    this.arr = Array.from({ length: 16 }, () => ({ inst: -1, voice: 'auto' }));
    this.kit = {};
    this.vmute = 0;
    this.age = 0; this.frame = 0; this.toTick = 0;
    this.dcL = 0; this.dcR = 0; this.dcxL = 0; this.dcxR = 0; this.dcK = Math.exp(-2 * Math.PI * 18 / this.sr);
    this.gain = cfg.gain || 0.5;
    this.sounding = 0;
    this.reqs = [];
    this.vs = new Float32Array(this.slots.length * 4);
    this.silence();
  }
  makeChips() {
    const cfg = this.cfg;
    this.slots = [];
    this.chips = cfg.chips.map((cc) => new AYChip({ clock: cc.clock, variant: cc.variant, sampleRate: this.sr, outL: this.blepL, outR: this.blepR }));
    for (let ci = 0; ci < this.chips.length; ci++)
      for (let i = 0; i < 3; i++)
        this.slots.push({ chip: this.chips[ci], ci, i, n: this.slots.length, vid: cfg.voiceIds ? cfg.voiceIds[ci * 3 + i] : 'ABC'[i], pan: 0.5, lastKey: -1, taken: false, drum: null, req: null, buzzNote: null, idle: 0, lvl: 0, ch: -1, note: -1, idx: -1 });
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
      c.write(7, 0xFF);
      for (let r = 8; r <= 10; r++) c.write(r, 0);
    }
    for (const s of this.slots) { s.lastKey = -1; s.buzzNote = null; s.lvl = 0; s.ch = -1; }
  }

  // ------------------------------------------------------------ v2 interface
  setInstruments(list) { this.table = list.map(p => normInst({ ...p })); for (const n of [...this.notes, ...this.drums]) if (n.active && this.table[n.idx]) n.inst = this.table[n.idx]; }
  updateInstrument(i, inst) {
    this.table[i] = normInst({ ...inst });
    for (const n of [...this.notes, ...this.drums]) if (n.active && n.idx === i) n.inst = this.table[i];   // macro indices are clamped on read
  }
  setArrangement(arr) { for (let c = 0; c < 16; c++) this.arr[c] = arr && arr[c] ? { inst: arr[c].inst, voice: arr[c].voice || 'auto' } : { inst: -1, voice: 'auto' }; }
  setKit(kit) { this.kit = kit || {}; }
  setVoiceMute(mask) { this.vmute = mask | 0; }
  voiceState() {
    const v = this.vs;
    this.slots.forEach((s, i) => { v[i * 4] = s.lvl; v[i * 4 + 1] = s.ch; v[i * 4 + 2] = s.note; v[i * 4 + 3] = s.idx; });
    return v;
  }
  /** table index for a note on MIDI channel c */
  resolve(c, note) {
    const ch = this.h.ch[c], a = this.arr[c];
    if (a.inst >= 0 && this.table[a.inst]) return a.inst;
    if (ch.drum) { const k = this.kit[note]; return k != null && this.table[k] ? k : this.gmDrum(note); }
    return this.cfg.lib.gmPreset(ch.program);
  }
  pinSlot(c) {
    const v = this.arr[c].voice;
    if (!v || v === 'auto') return null;
    for (const s of this.slots) if (s.vid === v) return s;
    return null;
  }

  // ------------------------------------------------------------ MIDI
  noteAmp(c, vel) { return this.h.mute[c] ? 0 : Math.min(1, 1.6 * gmLevel(this.h.ch[c], vel)); }
  noteOn(c, note, vel) {
    const idx = this.resolve(c, note), inst = this.table[idx];
    if (!inst) return;
    if (this.route && this.route(inst, idx, c, note, vel)) return;   // e.g. Apple II speaker instruments
    if (inst.kind !== 'ay' && inst.kind !== 'any') return;
    if (inst.role === 'drum') { this.drumOn(c, note, vel, inst, idx); return; }
    let n = null;
    for (const x of this.notes) if (x.active && x.ch === c && x.note === note) { n = x; break; }
    if (!n) n = this.allocNote(this.notes);
    n.active = true; n.ch = c; n.note = note; n.vel = vel; n.on = true; n.sus = false; n.age = ++this.age; n.cut = false;
    n.amp = this.noteAmp(c, vel);
    noteStart(n, inst, idx);
  }
  allocNote(pool) {
    let best = null, ba = Infinity;
    for (const x of pool) if (!x.active) return x;
    for (const x of pool) if (!x.on && !x.sus && x.age < ba) { best = x; ba = x.age; }
    if (best) return best;
    for (const x of pool) if (x.age < ba) { best = x; ba = x.age; }
    return best;
  }
  drumOn(c, note, vel, inst, idx) {
    const amp = this.noteAmp(c, vel);
    if (amp <= 0) return;
    const d = this.allocNote(this.drums);
    // hi-hats choke each other
    if (note === 42 || note === 44) for (const x of this.drums) if (x.active && x.note === 46 && x.ch === c) x.active = false;
    d.active = true; d.ch = c; d.note = note; d.vel = vel; d.on = false; d.sus = false; d.age = ++this.age; d.cut = false; d.amp = amp;
    noteStart(d, inst, idx);
  }
  noteOff(c, note) {
    for (const n of this.notes) if (n.active && n.on && n.ch === c && n.note === note) {
      n.on = false;
      if (this.h.ch[c].sustain) n.sus = true; else noteRelease(n);
    }
  }
  sustainOff(c) { for (const n of this.notes) if (n.active && n.sus && n.ch === c) { n.sus = false; noteRelease(n); } }
  allOff(c, hard) {
    for (const n of this.notes) if (n.active && n.ch === c) { n.on = false; n.sus = false; noteRelease(n); if (hard) n.active = false; }
    if (hard) for (const d of this.drums) if (d.ch === c) d.active = false;
  }
  pitch(c) {}                     // periods are recomputed every driver frame
  ctrl(c) { for (const n of this.notes) if (n.active && n.ch === c) n.amp = this.noteAmp(c, n.vel); }
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
    const H = this.h;
    for (const n of this.notes) if (n.active && !noteTick(n)) n.active = false;
    for (const d of this.drums) if (d.active && (!noteTick(d) || H.mute[d.ch])) d.active = false;
    for (const s of this.slots) { s.taken = false; s.drum = null; s.req = null; }

    // ---- build parts
    const parts = this.parts, act = [];
    for (const p of parts) { p.notes.length = 0; p.merged.length = 0; p.nv = 0; p.pin = null; }
    for (const n of this.notes) if (n.active && n.amp > 0 && !H.mute[n.ch] && (n.frames < 2 || noteVol(n) > 0)) parts[n.ch].notes.push(n);
    for (const p of parts) {
      if (!p.notes.length) { p.had = false; continue; }
      let held = 0;
      for (const n of p.notes) if (n.on || n.sus) held++;
      if (held && held < p.notes.length) { let w = 0; for (const n of p.notes) if (n.on || n.sus) p.notes[w++] = n; p.notes.length = w; }
      if (p.notes.length > MAX_ARP) { p.notes.sort((a, b) => b.age - a.age); p.notes.length = MAX_ARP; }
      p.notes.sort((a, b) => b.note - a.note);
      let mx = 0, young = 99;
      for (const n of p.notes) { n.cur = n.amp * this.ampOf[noteVol(n)]; if (n.cur > mx) mx = n.cur; if (n.frames < young) young = n.frames; }
      p.inst = p.notes[0].inst;
      p.score = (ROLE_W[p.inst.role] || 0.6) * Math.sqrt(mx) + (young < 6 ? 0.25 : 0) + (p.had ? 0.08 : 0);
      p.pan = Math.max(0, Math.min(1, (H.ch[p.c].pan - 1) / 126));
      p.pin = this.pinSlot(p.c);
      act.push(p);
    }
    act.sort((a, b) => b.score - a.score);

    // ---- pinned parts take their channel
    let used = 0;
    const reqs = this.reqs; reqs.length = 0;
    for (const p of act) {
      if (!p.pin) continue;
      p.had = true;
      if (p.pin.taken) continue;
      const r = { p, k: 0, key: p.c * 8, slot: p.pin }; p.nv = 1;
      p.pin.taken = true; p.pin.req = r; reqs.push(r); used++;
    }
    // ---- drums claim channels
    let dv = 0;
    const maxD = this.cfg.drumVoices || 1;
    const dsc = (d) => (d.inst.prio || 3) + (d.frames <= 3 ? 10 : 0) - d.frames * 0.15;   // fresh hits win, tails yield
    const dl = this.drums.filter(d => d.active).sort((a, b) => (dsc(b) - dsc(a)) || (b.age - a.age));
    for (const d of dl) {
      const pin = this.pinSlot(d.ch);
      if (pin) { if (!pin.taken) { pin.taken = true; pin.drum = d; } continue; }
      if (dv >= maxD) continue;
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
    let avail = 0;
    for (const s of this.slots) if (!s.taken) avail++;
    const free = act.filter(p => !p.pin);
    for (const p of free) if (avail > 0) { p.nv = 1; avail--; }
    for (const p of free) while (avail > 0 && p.nv < p.notes.length) { p.nv++; avail--; }
    for (const p of free) {
      if (p.nv || !MERGEABLE[p.inst.role]) continue;
      let tgt = null;
      for (let i = act.length - 1; i >= 0; i--) {
        const q = act[i];
        if (q.nv && MERGEABLE[q.inst.role] && (q.notes.length - q.nv + 1) + q.merged.length + p.notes.length <= MAX_ARP) { tgt = q; break; }
      }
      if (tgt) for (const n of p.notes) tgt.merged.push(n);
    }

    // ---- requests → chip channels (sticky, pan- and load-aware)
    for (const p of free) {
      p.had = p.nv > 0;
      for (let k = 0; k < p.nv; k++) reqs.push({ p, k, key: p.c * 8 + k, slot: null });
    }
    const load = this.load || (this.load = new Float64Array(8));
    load.fill(0);
    for (const r of reqs) if (r.slot) load[r.slot.ci] += r.p.score;
    for (const r of reqs) {
      if (r.slot) continue;
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

    // ---- pick the note each channel plays this frame
    for (const s of this.slots) {
      s.play = null;
      if (s.drum) { s.play = s.drum; continue; }
      const r = s.req; if (!r) continue;
      const p = r.p;
      if ((p.nv >= p.notes.length && !p.merged.length) || r.k < p.nv - 1) s.play = p.notes[r.k];
      else {
        const start = p.nv - 1, own = p.notes.length - start, cnt = own + p.merged.length;
        const idx = this.frame % cnt;
        s.play = idx < own ? p.notes[start + idx] : p.merged[idx - own];
      }
    }
    // ---- hardware envelope ownership: one per chip, highest score
    const owner = this.envOwner || (this.envOwner = []);
    for (let ci = 0; ci < this.chips.length; ci++) owner[ci] = null;
    for (const s of this.slots) {
      const n = s.play; if (!n || n.inst.env.shape < 0 || n.rel || !macroVal(n.inst.vol, n.iv)) continue;
      const sc = s.drum ? 9 : s.req.p.score;
      const o = owner[s.ci];
      if (!o || o.sc < sc) owner[s.ci] = { s, sc };
    }

    // ---- compute and write registers
    let sounding = 0;
    const fps = this.frameHz;
    for (let ci = 0; ci < this.chips.length; ci++) {
      const chip = this.chips[ci];
      let mixer = 0x3F, noiseP = -1, noisePrio = -1;
      for (let i = 0; i < 3; i++) {
        const s = this.slots[ci * 3 + i], n = s.play;
        let vol = 0, tp = -1, tone = false, noise = false;
        s.lvl = 0;
        if (n) {
          const I = n.inst, ch = H.ch[n.ch];
          s.lastKey = s.drum ? -2 : s.req.key;
          s.ch = n.ch; s.note = n.note; s.idx = n.idx;
          const semis = notePitch(n, ch, fps);
          const hz = midiHz(semis);
          const mv = noteVol(n);
          const a = n.amp * this.ampOf[mv] * (s.drum ? (this.cfg.drumGain || 1) : 1);
          vol = this.quant(a);
          const mx = macroVal(I.mixer, n.im);
          tone = !!(mx & 1); noise = !!(mx & 2);
          tp = chip.periodFor(hz) + macroVal(I.pitch, n.ip);
          tp = tp < 1 ? 1 : tp > 4095 ? 4095 : tp;
          if (noise) {
            let np = macroVal(I.noise, n.inz) + (I.noiseRel ? noiseForNote(semis) : 0);
            np = np < 0 ? 0 : np > 31 ? 31 : np;
            const pr = s.drum ? 100 : s.req.p.score;
            if (pr > noisePrio) { noisePrio = pr; noiseP = np; }
          }
          const env = I.env;
          if (env.shape >= 0 && mv > 0 && !n.rel) {
            const o = owner[ci];
            let ep = 0;
            if (o && o.s === s) {
              const triS = env.shape === 10 || env.shape === 14;
              if (env.mode === 'abs') ep = Math.max(1, Math.min(65535, env.period | 0));
              else {
                ep = chip.envPeriodFor(hz * (env.ratio || 1), triS);
                const err = 1200 * Math.log2(chip.clock / ((triS ? 512 : 256) * ep) / (hz * (env.ratio || 1)));
                if (CONT_SHAPES.has(env.shape) && Math.abs(err) > 25 && !(mx & 1)) ep = 0;   // too far off: plain tone
              }
            }
            if (ep) {
              chip.write(11, ep & 255); chip.write(12, ep >> 8);
              if (s.buzzNote !== n) { chip.write(13, env.shape); s.buzzNote = n; }
              vol = vol > 0 ? 16 : 0;
              if (env.mode === 'note' && env.shape === 12 && (mx & 1) && env.ratio === 1) tp = Math.min(4095, ep * 16);   // phase-locked sync
            } else { s.buzzNote = null; if (!tone && !noise) tone = true; }
          } else s.buzzNote = null;
          if (vol > 0) { sounding++; s.lvl = vol === 16 ? 1 : this.ampOf[vol]; if (n.cur > H.meter[n.ch]) H.meter[n.ch] = n.amp * this.ampOf[mv]; }
          if (this.vmute & (1 << s.n)) { vol = 0; s.lvl = 0; }
        } else {
          s.buzzNote = null; s.lastKey = -1; s.ch = -1; s.note = -1; s.idx = -1;
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
