// Shared frame-rate sound driver for the NES and Game Boy machines (original code for RetroSynths).
//
// It plays the machine's NATIVE instruments the way a tracker/game music engine does: once per video
// frame it steps each note's FamiTracker-style macros (volume / arpeggio / pitch / duty / extra, each
// with loop and release points), applies vibrato (instrument + CC1), pitch bend and chord arpeggios,
// and decides which notes the chip's few voices play:
//   · notes are grouped into parts = (MIDI channel × voice kind of its instrument);
//   · parts pinned by the Arranger go to their voice; the others compete per kind by priority
//     (instrument category, loudness, recency, unison penalty, stickiness);
//   · spare voices of a kind spread a part's chord; an optional overflow kind (NES triangle,
//     GB wave) can take an unplaced pulse part or the bass note of a chord;
//   · drum parts are mono: the newest hit wins unless an older one is still much louder.
// Each voice then exposes { note, vol (4-bit), duty, pacc (pitch-macro sum), trig … } and the machine
// module turns it into register writes. Chip-specific envelope behaviour comes from `hooks`.

export const CAT_PRIO = { Lead: 90, Reed: 80, Pipe: 80, Brass: 75, Organ: 60, Guitar: 60, Ethnic: 60, Piano: 55,
  Chromatic: 55, Strings: 50, Bass: 50, Percussive: 50, Ensemble: 45, FX: 40, SFX: 40, Pad: 35, Drums: 70, Showcase: 70 };

/** Loudness 0..1 of a note on a channel (velocity × CC7 × CC11), on a curve that suits 4-bit volume. */
export function chipLevel(ch, vel) {
  const v = (vel / 127) * (ch.vol / 127) * (ch.expr / 127);
  return Math.min(1, Math.pow(v, 1.5) * 1.6);
}

// macro slots in Note.pos
export const M_VOL = 0, M_ARP = 1, M_PIT = 2, M_DUTY = 3, M_X = 4, M_PAN = 5;
export const hasMacro = (m) => !!(m && m.values && m.values.length);
/** does the macro loop while the note is held (so a drum note-off must release it)? */
export const macroLoops = (m) => hasMacro(m) && m.loop >= 0 && (m.release < 0 || m.loop < m.release);

class Note {
  constructor() { this.dead = true; this.pos = new Int16Array(6); }
}

class Part {
  constructor(key) { this.key = key; this.c = key >> 3; this.kind = key & 7; this.notes = []; this.score = 0; this.had = false; this.drum = false; this.pin = -1; this.ok = false; this.low = 0; this.top = 0; this.prio = 50; }
}

export class Voice {
  constructor(i, id, kind) {
    this.idx = i; this.id = id; this.kind = kind; this.part = null; this.prevPart = null;
    this.set = []; this.arpI = 0; this.arpT = 0; this.leadId = -1; this.over = false; this.split = null;
    this.on = false; this.note = 60; this.vol = 0; this.duty = 2; this.trig = false; this.cur = null; this.lead = null;
    this.I = null; this.ii = -1; this.ch = -1; this.pacc = 0; this.amp = 0; this.drum = false;
  }
}

export class Driver {
  /**
   * opt: { fps, voices: [{id, kind}], kinds: ['pulse', …], overflow: [[voiceKind, fromKind]], hooks, table, gmPreset, gmDrum }
   * hooks: { start(n, I), step(n, I) → sets n.vol15 (0..15) and may set n.dead, release(n, I) }
   */
  constructor(host, opt) {
    this.h = host; this.fps = opt.fps; this.hooks = opt.hooks;
    this.kinds = opt.kinds; this.overflow = (opt.overflow || []).map(([a, b]) => [opt.kinds.indexOf(a), opt.kinds.indexOf(b)]);
    this.voices = opt.voices.map((v, i) => new Voice(i, v.id, opt.kinds.indexOf(v.kind)));
    this.table = opt.table; this.gmPreset = opt.gmPreset; this.gmDrum = opt.gmDrum;
    this.arr = Array.from({ length: 16 }, () => ({ inst: -1, voice: 'auto' }));
    this.kit = {};
    this.pool = []; for (let i = 0; i < 64; i++) this.pool.push(new Note());
    this.parts = []; for (let k = 0; k < 128; k++) this.parts.push(new Part(k));
    this.live = []; this.cands = []; this.chosen = []; this.free = [];
    this.id = 0; this.frame = 0; this.arp = true; this.arpSpeed = 1;
  }

  // ---------------------------------------------------------------- instrument resolution
  resolve(c, note) {
    const ch = this.h.ch[c], a = this.arr[c];
    if (a && a.inst >= 0 && this.table[a.inst]) return a.inst;
    if (ch.drum) { const k = this.kit[note]; return k != null && this.table[k] ? k : this.gmDrum(note); }
    return this.gmPreset(ch.program & 127);
  }
  kindOf(I) { const k = this.kinds.indexOf(I.kind); return k < 0 ? 0 : k; }

  // ---------------------------------------------------------------- MIDI side
  noteOn(c, note, vel) {
    const ii = this.resolve(c, note);
    if (ii < 0 || !this.table[ii]) return;
    const drum = this.h.ch[c].drum;
    this.start(c, note, vel, ii, drum);
    const I = this.table[ii];
    if (I.layer != null && I.layer >= 0 && this.table[I.layer] && I.layer !== ii) this.start(c, note, vel, I.layer, drum);
  }
  start(c, note, vel, ii, drum) {
    let n = null;
    for (const x of this.pool) if (!x.dead && x.ch === c && x.key === note && x.ii === ii) { n = x; break; }
    if (!n) for (const x of this.pool) if (x.dead) { n = x; break; }
    if (!n) {
      let best = null;
      for (const x of this.pool) if (!x.on && (!best || x.id < best.id)) best = x;
      if (!best) for (const x of this.pool) if (!best || x.id < best.id) best = x;
      n = best;
    }
    const I = this.table[ii];
    n.ch = c; n.key = note; n.note = note; n.vel = vel; n.ii = ii; n.id = ++this.id; n.drum = drum;
    n.kind = this.kindOf(I);
    n.on = true; n.sus = false; n.released = false; n.dead = false; n.t = -1;
    n.pos.fill(0); n.pacc = 0; n.arpV = 0; n.dutyV = I.duty | 0; n.vol15 = 0; n.amp = 0; n.L = 0; n.x = 0; n.panV = 0;
    this.hooks.start(n, I, this);
  }
  release(n) {
    if (n.released) return;
    n.on = false; n.sus = false; n.released = true;
    const I = this.table[n.ii]; if (!I) { n.dead = true; return; }
    const ms = [I.vol, I.arp, I.pitch, I.dutyMac, I.xMac, I.panMac];
    for (let k = 0; k < 6; k++) { const m = ms[k]; if (hasMacro(m) && m.release >= 0 && m.release < m.values.length) n.pos[k] = m.release; }
    this.hooks.release(n, I, this);
  }
  noteOff(c, note) {
    const sus = this.h.ch[c].sustain;
    for (const x of this.pool) if (!x.dead && x.on && x.ch === c && x.key === note) {
      if (x.drum && !this.hooks.drumHolds(this.table[x.ii])) continue;   // one-shot drum: plays out
      if (sus) x.sus = true; else this.release(x);
    }
  }
  sustainOff(c) { for (const x of this.pool) if (!x.dead && x.sus && x.ch === c) this.release(x); }
  allOff(c, hard) { for (const x of this.pool) if (!x.dead && x.ch === c) { this.release(x); if (hard) x.dead = true; } }
  reset() {
    for (const x of this.pool) x.dead = true;
    for (const p of this.parts) p.had = false;
    for (const v of this.voices) { v.part = v.prevPart = null; v.on = false; v.vol = 0; v.set.length = 0; v.cur = v.lead = null; v.leadId = -1; }
  }
  liveCount() { let k = 0; for (const x of this.pool) if (!x.dead) k++; return k; }

  /** read a macro's current value for a note and advance it (FamiTracker loop / release semantics) */
  mval(m, n, slot) {
    if (!m || !m.values || !m.values.length) return null;
    const vals = m.values, L = vals.length, R = m.release < L ? m.release : -1, Lp = m.loop < L ? m.loop : -1;
    let p = n.pos[slot]; if (p >= L) p = L - 1;
    const v = vals[p];
    let q = p + 1;
    if (!n.released && R >= 0) { if (q >= R) q = Lp >= 0 && Lp < R ? Lp : Math.max(0, R - 1); }
    else if (q >= L) q = Lp >= 0 && (R < 0 || Lp >= R) ? Lp : L - 1;
    n.pos[slot] = q;
    return v;
  }
  /** has a non-looping macro reached (and is holding) its last step? */
  macroDone(m, n, slot) {
    if (!hasMacro(m)) return true;
    const L = m.values.length;
    if (n.pos[slot] < L - 1) return false;
    return !(m.loop >= 0 && (n.released ? (m.release < 0 || m.loop >= m.release) : true));
  }

  // ---------------------------------------------------------------- frame tick
  stepNote(n) {
    const I = this.table[n.ii];
    if (!I) { n.dead = true; return; }
    n.t++;
    const a = this.mval(I.arp, n, M_ARP); n.arpV = a == null ? 0 : a;
    const p = this.mval(I.pitch, n, M_PIT); if (p != null) n.pacc += p;
    const d = this.mval(I.dutyMac, n, M_DUTY); n.dutyV = d == null ? (I.duty | 0) : d;
    this.hooks.step(n, I, this);
    n.L = chipLevel(this.h.ch[n.ch], n.vel);
    n.amp = this.h.mute[n.ch] ? 0 : n.vol15 / 15 * n.L;
  }

  tick() {
    this.frame++;
    const h = this.h, pool = this.pool, live = this.live, kinds = this.kinds;
    for (const n of pool) if (!n.dead) this.stepNote(n);

    // ---- parts
    for (const p of live) { p.notes.length = 0; p.ok = false; }
    live.length = 0;
    for (const n of pool) {
      if (n.dead || h.mute[n.ch]) continue;
      if (n.amp < 0.02 && !((n.on || n.sus) && n.L > 0 && n.t < 90)) continue;
      const p = this.parts[n.ch * 8 + n.kind];
      if (!p.notes.length) live.push(p);
      p.notes.push(n);
    }
    for (const p of live) {
      const L = p.notes;
      p.drum = L[0].drum;
      if (!p.drum) {      // like a channel in a game driver: a held note cuts the release tails of earlier ones
        let held = 0; for (const n of L) if (n.on || n.sus) held++;
        if (held && held < L.length) { let j = 0; for (const n of L) if (n.on || n.sus) L[j++] = n; L.length = j; }
      }
      L.sort((a, b) => b.note - a.note || b.id - a.id);
      let amp = 0, newest = 1e9, cat = null, nid = -1;
      for (const n of L) { if (n.amp > amp) amp = n.amp; if (n.t < newest) newest = n.t; if (n.id > nid) { nid = n.id; cat = this.table[n.ii] && this.table[n.ii].category; } }
      p.prio = CAT_PRIO[cat] != null ? CAT_PRIO[cat] : 50;
      p.score = p.prio + 40 * amp + (L.length === 1 ? 12 : L.length >= 3 ? -8 : 0) + 30 * Math.max(0, 1 - newest / 30) + (p.had ? 20 : 0) + (p.drum ? 60 : 0);
      p.top = L[0].note; p.low = L[L.length - 1].note;
      p.pin = -1;
      const a = this.arr[p.c];
      if (a && a.voice && a.voice !== 'auto') {
        const vi = this.voices.findIndex(v => v.id === a.voice);
        if (vi >= 0 && this.voices[vi].kind === p.kind) p.pin = vi;
      }
      p.had = false;
    }
    live.sort((a, b) => b.score - a.score);

    // ---- voices
    const V = this.voices;
    for (const v of V) { v.prevPart = v.part; v.part = null; v.set.length = 0; v.over = false; v.split = null; }
    for (const p of live) if (p.pin >= 0 && !V[p.pin].part) { V[p.pin].part = p; p.ok = true; }
    for (let k = 0; k < kinds.length; k++) {
      const free = this.free; free.length = 0;
      for (const v of V) if (v.kind === k && !v.part) free.push(v);
      if (!free.length) continue;
      const chosen = this.chosen; chosen.length = 0;
      for (const v of V) if (v.kind === k && v.part) chosen.push(v.part);
      const base = chosen.length;
      while (chosen.length - base < free.length) {
        let best = null, bs = -1e9;
        for (const p of live) {
          if (p.ok || p.kind !== k || p.pin >= 0) continue;
          let s = p.score;
          if (!p.drum) for (const x of chosen) { const d = Math.abs(p.top - x.top); if (!x.drum && d % 12 === 0 && d <= 24) s -= 45; }
          if (s > bs) { bs = s; best = p; }
        }
        if (!best) break;
        chosen.push(best); best.ok = true;
      }
      // map onto free voices, sticky to last frame's owner
      for (let i = base; i < chosen.length; i++) { const p = chosen[i]; const v = free.find(v => !v.part && v.prevPart === p); if (v) v.part = p; }
      for (let i = base; i < chosen.length; i++) {
        const p = chosen[i]; if (free.some(v => v.part === p)) continue;
        const v = free.find(v => !v.part && !chosen.includes(v.prevPart)) || free.find(v => !v.part);
        if (v) v.part = p;
      }
      // spare voices of this kind spread chords
      for (const v of free) {
        if (v.part) continue;
        let best = null, need = 0;
        for (const p of chosen) {
          if (p.drum || (p.pin >= 0)) continue;
          let k2 = 0; for (const w of V) if (w.part === p) k2++;
          if (p.notes.length - k2 > need) { need = p.notes.length - k2; best = p; }
        }
        if (best) v.part = best;
      }
    }
    // overflow: e.g. an unplaced pulse part (or a chord's bass note) on a free triangle / wave voice
    for (const [vk, fk] of this.overflow) {
      for (const v of V) {
        if (v.kind !== vk || v.part) continue;
        let low = null;
        for (const p of live) if (!p.ok && p.kind === fk && !p.drum && p.pin < 0 && (!low || p.low < low.low)) low = p;
        if (low && low.low <= 67) { v.part = low; v.over = true; low.ok = true; v.set.push(low.notes[low.notes.length - 1]); continue; }
        let sp = null;
        for (const p of live) if (p.ok && p.kind === fk && !p.drum && p.notes.length >= 2 && p.low < 55 && (!sp || p.low < sp.low)) sp = p;
        if (sp) { v.part = sp; v.over = true; v.split = sp.notes[sp.notes.length - 1]; v.set.push(v.split); }
      }
    }

    // ---- distribute notes of each part over its voices
    for (const p of live) {
      if (!p.ok && p.pin < 0) continue;
      p.had = true;
      const vs = []; for (const v of V) if (v.part === p && !v.over) vs.push(v);
      if (!vs.length) continue;
      if (p.drum) {
        let n = null;
        for (const x of p.notes) if (!n || x.id > n.id) n = x;
        for (const x of p.notes) if (x !== n && x.amp > 1.6 * n.amp) n = x;
        vs[0].set.push(n);
        for (let j = 1; j < vs.length; j++) vs[j].part = null;
        continue;
      }
      let notes = p.notes;
      for (const v of V) if (v.split && v.part === p) notes = notes.filter(n => n !== v.split);
      if (!notes.length) { for (const v of vs) v.part = null; continue; }
      const k = vs.length;
      for (let j = 0; j < k; j++) {
        const v = vs[j];
        if (j < k - 1) { if (j < notes.length) v.set.push(notes[j]); continue; }
        const rest = notes.slice(Math.min(j, notes.length - 1));
        if (rest.length > 1 && this.arp) { for (let q = rest.length - 1; q >= 0; q--) v.set.push(rest[q]); }
        else { let nw = rest[0]; if (!this.arp) for (const x of rest) if (x.id > nw.id) nw = x; v.set.push(nw); }
      }
    }
    for (const v of V) this.voiceOut(v);
  }

  voiceOut(v) {
    v.trig = false;
    if (!v.part || !v.set.length) { v.on = false; v.vol = 0; v.cur = v.lead = null; v.amp = 0; v.ch = -1; v.ii = -1; return; }
    const ch = this.h.ch[v.part.c];
    let n, lead = v.set[0];
    for (const x of v.set) if (x.id > lead.id) lead = x;
    if (v.set.length > 1) {
      if (v.part !== v.prevPart) { v.arpI = 0; v.arpT = 0; }
      if (++v.arpT >= this.arpSpeed) { v.arpT = 0; v.arpI++; }
      v.arpI %= v.set.length; n = v.set[v.arpI];
    } else n = lead;
    if (lead.id !== v.leadId || lead.t === 0 || v.part !== v.prevPart) v.trig = true;
    v.leadId = lead.id; v.cur = n; v.lead = lead;
    const I = this.table[n.ii] || this.table[lead.ii];
    let pitch = n.note + ch.bend * ch.bendRange + n.arpV;
    // vibrato: instrument (speed/depth/delay, FamiTracker-like 4xy) + mod wheel
    const vb = I.vib;
    let depth = ch.mod / 127 * 0.6, speed = 6, ph = n.t;
    if (vb && vb.depth > 0 && n.t >= (vb.delay | 0)) { depth += vb.depth * 0.05 * Math.min(1, (n.t - (vb.delay | 0)) / 12); speed = vb.speed || 6; ph = n.t - (vb.delay | 0); }
    if (depth > 0) pitch += depth * Math.sin(2 * Math.PI * ph * speed / 64);
    v.note = pitch; v.I = I; v.ii = n.ii; v.ch = v.part.c; v.drum = v.part.drum;
    v.duty = n.dutyV; v.pacc = n.pacc;
    // an arpeggiating voice is one driver channel with one envelope: follow the loudest note of its set
    let e = n; if (v.set.length > 1) for (const x of v.set) if (x.amp > e.amp) e = x;
    v.amp = e.amp; v.vol = Math.min(15, Math.round(e.vol15 * e.L)); if (this.h.mute[v.ch]) v.vol = 0;
    v.on = true;
  }
}
