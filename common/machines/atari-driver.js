// Frame-rate "music engine" core shared by the Atari 2600, Atari 800 and TurboGrafx-16 machines.
//
// Instrument-driven, like a period tracker driver: every note plays a native instrument (from the
// machine's preset table, chosen by the Arranger, the drum kit or the GM mapping) whose macros —
// volume, arpeggio, pitch, and per-frame distortion / frequency for drums — step once per video frame.
// The driver keeps one *virtual note* per MIDI key and every frame decides which of them own the
// chip's hardware voices (melody / bass / drums priority, stickiness, voice pinning). A voice "slot"
// may use several chip channels (POKEY's joined 16-bit pairs and high-pass pairings), so allocation
// works on channel bitmasks. A note that loses its voice keeps running silently and resumes if it wins
// one back — the classic "SFX interrupts a music channel" behaviour.
//
// Each machine subclasses Driver and writes the chip registers: program(slot, vn), update(slot, vn),
// silence(slot). Original code for RetroSynths.
import { gmLevel, TOM_NOTE } from './util.js';

// ---------------------------------------------------------------------------------------------
// GM timbre classes (used by the machines to build their native preset libraries)
// env = [attack s, decay s (to ~-40 dB of the way to sustain), sustain 0..1, release s]
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

/** Priority of each drum kind (from util.drumKind): kick/snare beat bass, hats don't. */
export const DRUM_PRIO = { kick: 59, snare: 59, clap: 57, stick: 50, tom: 56, crash: 56, ride: 48, hatClosed: 49, hatPedal: 47, hatOpen: 50,
  bell: 48, shaker: 44, cowbell: 50, conga: 50, block: 48, triangle: 46, perc: 46 };
const ROLE_PRIO = { lead: 60, bass: 55, mid: 44, pad: 38, fx: 36 };

// ---------------------------------------------------------------------------------------------
// Macro helpers. A macro is { values: number[], loop: -1|i, release: -1|i } stepped once per frame:
// while the key is held it loops [loop, release) (or [loop, end) without a release point, or holds
// the last step); at note-off it jumps to the release point and plays on to the end.
// ---------------------------------------------------------------------------------------------
export const mac = (values = [], loop = -1, release = -1) => ({ values, loop, release });

/**
 * Volume macro from a class envelope sampled at the frame rate.
 * q(level 0..1) → chip volume step. Sustained envelopes end on the sustain step (held), optionally
 * looping a tremolo cycle; decays run to 0. Release is left to the instrument's `rel` (frames).
 */
export function envMacro(env, q, { trem = null, fps = 60, maxFrames = 120 } = {}) {
  const [a, d, s] = env, out = [];
  let lv = a > 0.004 ? 0 : 1, stage = a > 0.004 ? 0 : 1;
  const dt = 1 / fps;
  for (let f = 0; f < maxFrames; f++) {
    let l = lv;
    if (trem) l *= 1 - trem[1] * (0.5 + 0.5 * Math.sin(2 * Math.PI * trem[0] * f * dt));
    out.push(q(l));
    if (stage === 0) { lv += dt / a; if (lv >= 1) { lv = 1; stage = 1; } }
    else if (stage === 1) {
      lv = s + (lv - s) * Math.exp(-4.6 * dt / Math.max(0.01, d));
      if (s <= 0.001 ? lv < 0.004 : lv - s < 0.002) { lv = s; stage = 2; }
    } else if (stage === 2) {
      if (s <= 0.001) { out.push(q(0)); break; }
      if (!trem) break;                                         // hold the last (sustain) step
      const per = Math.max(2, Math.min(60, Math.round(fps / trem[0]))), start = out.length;
      for (let k = 0; k < per; k++) out.push(q(s * (1 - trem[1] * (0.5 + 0.5 * Math.sin(2 * Math.PI * k / per)))));
      return mac(out, start, -1);
    }
  }
  if (s <= 0.001 && out[out.length - 1] !== 0) out.push(0);     // a truncated decay ends silent
  while (out.length > 1 && out[out.length - 1] === 0 && out[out.length - 2] === 0) out.pop();
  return mac(out, -1, -1);
}
/** Delayed pitch effects baked into a pitch macro (1/8 semitone units, absolute). */
export function pitchMacro({ sweep = 0, bird = false } = {}, fps = 60) {
  if (bird) {
    const v = []; for (let f = 0; f < 40; f++) { const t = f / fps; v.push(Math.round(8 * (3 * Math.sin(2 * Math.PI * 9 * t) + 4 * Math.min(1, t * 3)))); }
    const per = Math.round(fps / 9); return mac(v, v.length - per, -1);
  }
  if (sweep) { const v = []; for (let f = 0; f < 40; f++) v.push(Math.max(-96, Math.min(96, Math.round(8 * sweep * f / fps)))); return mac(v); }
  return mac();
}
/** Linear 4-bit volume quantiser and HuC6280-style 1.5 dB log quantiser. */
export const qLin = (max) => (l) => Math.max(0, Math.min(max, Math.round(l * max)));
export const qLog = (l) => { if (l <= 1e-4) return 0; const v = 31 + Math.round(20 * Math.log10(l) / 1.5); return v < 0 ? 0 : v > 31 ? 31 : v; };

function advance(m, p, rel) {
  const len = m.values.length;
  if (!len) return 0;
  const R = m.release < len ? m.release : -1, L = m.loop < len ? m.loop : -1;
  p++;
  if (!rel && R >= 0) { if (p >= R) p = L >= 0 && L < R ? L : Math.max(0, R - 1); return p; }
  if (p >= len) p = L >= 0 && (R < 0 || L >= R) ? L : len - 1;
  return p;
}
const mval = (m, p, d) => (m && m.values && m.values.length ? m.values[p < m.values.length ? p : m.values.length - 1] : d);
const MACROS = ['vol', 'arp', 'pitch', 'dist', 'freq'];

class VNote {
  constructor(i) { this.i = i; this.active = false; this.voice = -1; this.mp = { vol: 0, arp: 0, pitch: 0, dist: 0, freq: 0 }; }
}

export class Driver {
  /**
   * @param host     RetroSynths host object
   * @param slots    channel bitmask of each voice slot (allocation unit)
   * @param nch      number of chip channels (= static voices)
   * @param frameHz  the console's video frame rate (driver tick)
   */
  constructor(host, slots, nch, frameHz) {
    this.h = host; this.res = slots; this.nv = slots.length; this.nch = nch;
    this.frameHz = frameHz; this.dt = 1 / frameHz;
    this.owner = new Array(this.nv).fill(null);
    this.claim = new Array(this.nv).fill(null);
    this.pool = Array.from({ length: 48 }, (_, i) => new VNote(i));
    this.sorted = []; this.ordBuf = [];
    this.age = 0; this.frameNo = 0;
    this.melOrder = [...Array(this.nv).keys()];
    this.drumOrder = [...Array(this.nv).keys()].reverse();
    const C = this.constructor;
    this.table = C.presets ? C.presets.slice() : [];
    this.arr = Array.from({ length: 16 }, () => ({ inst: -1, voice: 'auto' }));
    this.pinMask = 0; this.kit = {}; this.vmask = 0;
    this.vs = new Float32Array(nch * 4);
    this.volMax = 15;
  }

  // ---- machine hooks ---------------------------------------------------------------------------
  allowed(vi, vn) { return true; }
  prefer(vn) { return vn.isDrum ? this.drumOrder : this.melOrder; }
  strict(vn) { return false; }               // true: take voices strictly in prefer() order
  program(vi, vn) {}                          // voice newly given to vn: write everything
  update(vi, vn) {}                           // per frame / on controller change
  silence(vi) {}                              // voice lost its note
  busy(vn) { return false; }                  // drum still sounding beyond its macros (e.g. DDA sample)
  volNorm(v) { return v / this.volMax; }      // chip volume step → linear 0..1
  applyVoiceMute(mask) {}
  preAssign() {}
  postAssign() {}

  // ---- instrument table / arrangement (Interface v2) ----------------------------------------------
  setInstruments(list) { this.table = list && list.length ? list.slice() : (this.constructor.presets || []).slice(); }
  updateInstrument(i, inst) {
    this.table[i] = inst;
    for (const vn of this.pool) if (vn.active && vn.idx === i) {
      vn.inst = inst; this.shape(vn);
      if (vn.voice >= 0) { this.program(vn.voice, vn); this.update(vn.voice, vn); }
    }
  }
  setArrangement(arr) {
    const V = this.constructor.voices || [];
    this.arr = Array.from({ length: 16 }, (_, c) => (arr && arr[c]) || { inst: -1, voice: 'auto' });
    this.pinMask = 0;
    this.pinOf = this.arr.map((a) => { const i = a.voice && a.voice !== 'auto' ? V.findIndex((v) => v.id === a.voice) : -1; if (i >= 0) this.pinMask |= 1 << i; return i; });
  }
  setKit(kit) { this.kit = kit || {}; }
  setVoiceMute(mask) { this.vmask = mask | 0; this.applyVoiceMute(this.vmask); }
  voiceState() {
    const s = this.vs; s.fill(0);
    for (let k = 0; k < this.nch; k++) { s[k * 4 + 1] = -1; s[k * 4 + 2] = -1; s[k * 4 + 3] = -1; }
    for (let vi = 0; vi < this.nv; vi++) {
      const vn = this.owner[vi];
      if (!vn) continue;
      for (let k = 0; k < this.nch; k++) if (this.res[vi] & (1 << k)) {
        s[k * 4] = (this.vmask >> k) & 1 ? 0 : vn.amp; s[k * 4 + 1] = vn.ch; s[k * 4 + 2] = vn.note; s[k * 4 + 3] = vn.idx;
      }
    }
    return s;
  }
  /** Instrument table index for a note on MIDI channel c (Arranger → kit → GM mapping). */
  resolve(c, note) {
    const a = this.arr[c], C = this.constructor;
    if (a && a.inst >= 0 && this.table[a.inst]) return a.inst;
    if (this.h.ch[c].drum) { const k = this.kit[note]; return k != null && this.table[k] ? k : C.gmDrum(note); }
    return C.gmPreset(this.h.ch[c].program & 127);
  }

  // ---- MIDI interface ----------------------------------------------------------------------------
  noteOn(c, note, vel) {
    if (this.h.mute[c]) return;
    const idx = this.resolve(c, note), inst = this.table[idx];
    if (!inst) return;
    const drum = !!inst.drum;
    for (const o of this.pool) {
      if (!o.active || o.ch !== c) continue;
      if (drum && o.isDrum && (o.note === note || (inst.choke && o.inst.choke === inst.choke))) this.kill(o);
      else if (!drum && !o.isDrum && o.note === note && o.key) this.release(o);
    }
    const vn = this.alloc();
    vn.active = true; vn.ch = c; vn.note = note; vn.vel = vel; vn.key = true; vn.sus = false; vn.rel = false;
    vn.inst = inst; vn.idx = idx; vn.isDrum = drum; vn.pin = this.pinOf ? this.pinOf[c] : -1;
    vn.role = drum ? 'drum' : inst.role || 'mid';
    if ((vn.role === 'mid' || vn.role === 'pad') && note < 47) vn.role = 'low';
    vn.age = ++this.age; vn.frames = 0; vn.t = 0; vn.voice = -1; vn.fade = 1; vn.started = false;
    vn.tnote = drum && this.h.ch[c].drum && TOM_NOTE[note] ? TOM_NOTE[note] : note;
    for (const k of MACROS) vn.mp[k] = 0;
    this.shape(vn);
    this.assign();
    if (vn.voice >= 0) this.update(vn.voice, vn);
  }
  release(vn) {
    if (vn.rel) return;
    vn.key = false; vn.sus = false; vn.rel = true;
    const inst = vn.inst;
    for (const k of MACROS) { const m = inst[k]; if (m && m.release >= 0 && m.release < m.values.length) vn.mp[k] = m.release; }
    vn.fadeOn = !(inst.vol && inst.vol.release >= 0 && inst.vol.release < inst.vol.values.length);
    if (vn.fadeOn && !(inst.rel > 0) && !vn.isDrum) this.kill(vn);
  }
  noteOff(c, note) {
    const sus = this.h.ch[c].sustain;
    for (const vn of this.pool) if (vn.active && vn.key && vn.ch === c && vn.note === note) {
      if (vn.isDrum) { vn.key = false; continue; }      // drums are one-shot
      if (sus) vn.sus = true; else this.release(vn);
    }
  }
  sustainOff(c) { for (const vn of this.pool) if (vn.active && vn.sus && vn.ch === c) this.release(vn); }
  allOff(c, hard) {
    for (const vn of this.pool) if (vn.active && vn.ch === c) { if (hard) this.kill(vn); else if (!vn.isDrum) this.release(vn); }
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
    if (vn.isDrum) p = vn.inst.prio || 50;
    else {
      p = vn.role === 'low' ? 46 : ROLE_PRIO[vn.role] || 44;
      p += vn.role === 'bass' ? (40 - vn.note) * 0.08 : (vn.note - 60) * 0.08;   // top line / bottom line
      if (vn.rel) p -= 22;
    }
    p += 10 * vn.amp;
    p -= Math.min(8, vn.frames * 0.05);
    if (vn.voice >= 0) p += 4;
    if (vn.pin >= 0) p += 12;
    return p;
  }

  /** Current macro values → vn.vol (chip steps incl. release fade), vn.pitch, vn.dist, vn.freq, vn.amp. */
  shape(vn) {
    const ch = this.h.ch[vn.ch], inst = vn.inst, mp = vn.mp;
    let vol = mval(inst.vol, mp.vol, this.volMax);
    if (vn.fade < 1) vol = this.fadeVol(vol, vn.fade);
    vn.vol = vol;
    vn.dist = mval(inst.dist, mp.dist, -1);
    vn.freq = mval(inst.freq, mp.freq, -1);
    let n = (vn.isDrum && !inst.track ? 60 : vn.tnote) + mval(inst.arp, mp.arp, 0) + mval(inst.pitch, mp.pitch, 0) / 8;
    if (!vn.isDrum) {
      n += ch.bend * ch.bendRange;
      const t = vn.t, mod = ch.cc[1] / 127;
      let vd = mod * 0.6, vr = 5.5;
      const dl = (inst.vibDelay || 0) / this.frameHz;
      if (inst.vibDepth > 0 && t >= dl) { const ramp = Math.min(1, (t - dl) / 0.4); vd = Math.max(vd, inst.vibDepth / 100 * ramp); vr = inst.vibRate || 5.5; }
      if (vd > 0) n += vd * Math.sin(2 * Math.PI * vr * t);
    }
    vn.pitch = n;
    vn.gm = gmLevel(ch, vn.vel);
    vn.amp = this.volNorm(vol) * vn.gm;
  }
  fadeVol(v, f) { return Math.round(v * f); }

  /** Give hardware voices to the highest-priority virtual notes (sticky; channel-mask aware). */
  assign() {
    this.preAssign();
    const s = this.sorted; s.length = 0;
    let busy = 0;
    for (let vi = 0; vi < this.nv; vi++) if (this.owner[vi] && this.owner[vi].active) busy |= this.res[vi];
    for (const vn of this.pool) if (vn.active && (vn.amp > 0.0005 || vn.isDrum)) { vn.pr = this.prio(vn); s.push(vn); }
    s.sort((a, b) => b.pr - a.pr);
    const claim = this.claim, res = this.res; claim.fill(null);
    let used = 0;
    for (const vn of s) {
      const cur = vn.voice;
      if (cur >= 0 && !(used & res[cur]) && this.allowed(cur, vn) && this.pinOk(cur, vn)) { claim[cur] = vn; used |= res[cur]; continue; }
      const ord = this.order(vn);
      let pick = -1;
      if (!this.strict(vn)) for (const vi of ord) if (!(used & res[vi]) && !(busy & res[vi]) && this.allowed(vi, vn) && this.pinOk(vi, vn)) { pick = vi; break; }
      if (pick < 0) for (const vi of ord) if (!(used & res[vi]) && this.allowed(vi, vn) && this.pinOk(vi, vn)) { pick = vi; break; }
      if (pick >= 0) { claim[pick] = vn; used |= res[pick]; }
    }
    for (let vi = 0; vi < this.nv; vi++) {                     // release voices whose owner changed …
      const old = this.owner[vi];
      if (old && claim[vi] !== old) { this.owner[vi] = null; if (old.voice === vi) old.voice = -1; this.silence(vi); }
    }
    for (let vi = 0; vi < this.nv; vi++) {                     // … then program the new owners
      const nw = claim[vi];
      if (nw && this.owner[vi] !== nw) {
        if (nw.voice >= 0 && nw.voice !== vi && this.owner[nw.voice] === nw) { this.owner[nw.voice] = null; this.silence(nw.voice); }
        this.owner[vi] = nw; nw.voice = vi; this.program(vi, nw); this.update(vi, nw);
      }
    }
    for (const vn of this.pool) if (vn.active && vn.voice >= 0 && this.owner[vn.voice] !== vn) vn.voice = -1;
    this.postAssign();
  }
  pinOk(vi, vn) { return vn.pin < 0 || !!(this.res[vi] & (1 << vn.pin)); }
  /** prefer() order, with voices pinned by other MIDI channels moved to the back. */
  order(vn) {
    const base = this.prefer(vn);
    if (!this.pinMask || vn.pin >= 0) return base;
    const o = this.ordBuf; o.length = 0;
    for (const vi of base) if (!(this.res[vi] & this.pinMask)) o.push(vi);
    for (const vi of base) if (this.res[vi] & this.pinMask) o.push(vi);
    return o;
  }

  /** One driver tick (call at frameHz from the chip clock domain). */
  frame() {
    this.frameNo++;
    for (const vn of this.pool) {
      if (!vn.active) continue;
      vn.frames++; vn.t += this.dt;
      const inst = vn.inst, mp = vn.mp;
      for (const k of MACROS) { const m = inst[k]; if (m && m.values && m.values.length) mp[k] = advance(m, mp[k], vn.rel); }
      if (vn.rel && vn.fadeOn && !vn.isDrum) { vn.fade *= Math.exp(-4.6 / Math.max(1, inst.rel || 1)); if (vn.fade < 0.012) { this.kill(vn); continue; } }
      const vm = inst.vol;
      const parked = !vm || !vm.values.length || advance(vm, mp.vol, vn.rel) === mp.vol;
      if (parked) {
        const v = mval(vm, mp.vol, this.volMax);
        if (vn.isDrum ? !this.busy(vn) : (v === 0 || (vn.rel && !vn.fadeOn))) { this.kill(vn); continue; }
      }
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

/** Build a GM program → preset-index table from [presetName, [programs…]] pairs. */
export function gmTable(presets, pairs, fallback = 0) {
  const t = new Int16Array(128).fill(-1);
  for (const [name, progs] of pairs) {
    const i = presets.findIndex((p) => p.name === name);
    if (i < 0) throw new Error('gm map: no preset ' + name);
    for (const p of progs) t[p] = i;
  }
  for (let p = 0; p < 128; p++) if (t[p] < 0) t[p] = fallback;
  return t;
}
