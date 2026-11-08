// Commodore 64 — General MIDI through a MOS 6581/8580 SID, driven like a mid-80s C64 game music player.
//
// Signal path: SID emulation (sid.js) clocked at the real PAL 985,248 Hz (or NTSC 1,022,727 Hz), including
// the C64's 16 kHz output RC → second anti-alias pole → 8-cycle box decimation (~123 kHz) → 16 Hz
// coupling-cap high-pass → 128-tap band-limited resampler to the AudioContext rate. Mono.
//
// Driver ("player routine"): runs once per video frame (PAL 19,656 cycles ≈ 50.12 Hz, NTSC 17,095 ≈ 59.83 Hz)
// and only talks to the chip through its registers. Each frame it arranges the MIDI parts onto the three
// voices by priority — melody (lead) > bass > drums > other lines / chords — keeping parts on their voice
// where it can. Classic tricks:
//   - chords on one voice as a 1-frame (50 Hz) arpeggio (option 'arp'); off = chord notes take free voices;
//   - Hubbard-style drums: per-frame wave tables (noise burst → pulse/triangle pitch drop), sharing a voice
//     with the arpeggio and handing it back after a few frames;
//   - pulse-width sweeps, attack wave tables (noise "chiff", pulse click), delayed vibrato, CC1 vibrato,
//     ring-mod bells and hard-sync sweeps when the source voice is free (else a plain waveform);
//   - the one filter goes to the highest-priority voice whose instrument wants it (bass/brass sweeps);
//   - hard restart: with the ADSR bug on (default, as on the real chip) every note first gets two frames
//     of gate-off with ADSR $00/$00, so the 15-bit rate counter has wrapped (≤ 32,768 cycles) and settled
//     before the gate goes on — exactly what real players do two frames ahead of a note. Without pattern
//     look-ahead this shows as a constant ~2-frame latency (40–60 ms) but keeps timing steady; a 1-frame
//     restart would leave the bug's random 0–33 ms delays. With the bug off notes start on the next frame.
// Levels: the SID has no per-voice volume, so velocity × CC7 × CC11 scales the sustain level written to
// the voice (for decaying sounds it shortens the decay); the level is only ever lowered mid-note, since
// raising the sustain nibble during sustain makes the real envelope fall to zero. Master volume stays at 15.

import { SID, PAL_CLOCK, NTSC_CLOCK, MAXN, cutoffReg } from './sid.js';
import { PROGRAMS, drumDef, FAMILY_WEIGHT, SYNC, N as NOISE } from './c64-instruments.js';
import { family, Resampler, DCBlock } from './util.js';

const DECIM = 8;
const SRC = [2, 0, 1];                         // ring/sync source of voice 1, 2, 3
const IDLE = 0, HR = 1, ON = 2, REL = 3;
const K_LEAD = 1, K_BASS = 2, K_DRUM = 3, K_DRUM2 = 4;
const NOTE = 0, ARP = 1, DRUM = 2, HOLD = 3;
const LEAD_HOLD = 8, BASS_HOLD = 6;           // frames a role stays reserved for its part after it stops
const REF_LEVEL = 0.62;                        // vel 100 × CC7 100 × CC11 127: instrument plays as designed
const GAIN = 0.16;

/** util.Resampler, mono: same Blackman-Harris polyphase table, half the work. */
class MonoResampler extends Resampler {
  push(x) { const T = this.T, i = this.idx; this.bL[i] = this.bL[i + T] = x; this.idx = i + 1 === T ? 0 : i + 1; }
  out() {
    const T = this.T, b = this.bL, base = this.idx, h = this.h, hp = ((this.frac * this.P) | 0) * T;
    let y = 0;
    for (let k = 0; k < T; k++) y += b[base + k] * h[hp + k];
    return y;
  }
}

class Voice {
  constructor(i) {
    this.i = i; this.key = -1; this.trig = -1; this.phase = IDLE; this.t = 0; this.hrLeft = 0;
    this.kind = NOTE; this.inst = null; this.drum = null; this.ch = -1; this.note = 60; this.vel = 100;
    this.notes = new Float64Array(16); this.n = 0; this.arpI = 0;
    this.sNib = 0; this.srReg = 0; this.pw = 0x800; this.pwd = 0; this.vibPh = 0; this.slide = 0;
    this.ctrlReg = 0; this.fn = -1; this.pwReg = -1; this.ft = 0; this.flog = 10; this.k = 1;
    this.win = null; this.borrowed = false; this.hrNew = false;
  }
}
class Req {
  constructor() { this.key = 0; this.trig = 0; this.prio = 0; this.ch = 0; this.kind = NOTE; this.note = 60; this.vel = 100; this.notes = new Float64Array(16); this.n = 0; this.drum = null; this.taken = false; }
}

export default class C64 {
  static info = {
    id: 'c64', name: 'Commodore 64', maker: 'Commodore', year: 1982, chip: 'MOS 6581 SID',
    voices: '3 voices · tri/saw/pulse/noise · analog filter',
    spec: 'SID at 985 kHz: 3 voices, ring/sync, ADSR, multimode filter — 50 Hz player with arps, Hubbard drums, PWM and filter sweeps',
  };
  static options = [
    { key: 'model', label: 'SID', choices: [['6581', '6581 (1982)'], ['8580', '8580 (1987)']], default: '6581' },
    { key: 'video', label: 'Clock', choices: [['pal', 'PAL 985 kHz · 50 Hz'], ['ntsc', 'NTSC 1.02 MHz · 60 Hz']], default: 'pal' },
    { key: 'arp', label: 'Chord arps', choices: [[true, 'On'], [false, 'Off']], default: true },
    { key: 'adsrBug', label: 'ADSR bug', choices: [[true, 'On (2-frame hard restart)'], [false, 'Off (tighter live play)']], default: false },
  ];

  constructor(host) {
    this.h = host;
    this.model = '6581'; this.video = 'pal'; this.arp = true; this.hr = 0;
    this.sid = new SID(PAL_CLOCK, '6581'); this.sid.adsrBug = false;
    this.v = [0, 1, 2].map(i => new Voice(i));
    this.req = Array.from({ length: 48 }, () => new Req()); this.nreq = 0; this.order = [];
    this.cs = Array.from({ length: 16 }, () => ({ held: [], gen: 0, lastOn: 0, avg: 60 }));
    this.pend = []; this.prim = null; this.sec = null;
    this.ids = 0; this.onSeq = 0; this.frame = 0; this.leadCh = -1; this.bassCh = -1; this.fOwner = -1; this.leadRest = 99; this.bassRest = 99; this.leadStop = 0; this.leadScore = 0;
    this.fReg = [-1, -1, -1, -1];
    this.cnt = new Int32Array(128); this.frac = new Float64Array(128); this.ibuf = new Float64Array(1024);
    this.setVideo('pal');
    this.reset();
  }

  setVideo(video) {
    this.video = video === 'ntsc' ? 'ntsc' : 'pal';
    const clock = this.video === 'ntsc' ? NTSC_CLOCK : PAL_CLOCK;
    this.clock = clock;
    this.framePeriod = this.video === 'ntsc' ? 263 * 65 : 312 * 63;
    this.frameHz = clock / this.framePeriod;
    this.fnScale = 16777216 / clock;
    this.sid.setClock(clock);
    this.rs = new MonoResampler(clock / DECIM, this.h.sampleRate, 128);
    this.dcb = new DCBlock(clock / DECIM, 16);
    this.cyc = 0;
    this.settle();
    for (const v of this.v) v.fn = -1;
  }
  settle() {      // pre-charge the output stage so the DC level of the current registers doesn't click
    const dc = this.sid.dcLevel;
    this.sid.olp = this.sid.oaa = dc; this.dcb.x1 = dc; this.dcb.y1 = 0;
  }
  setOption(key, value) {
    switch (key) {
      case 'model': this.model = value === '8580' ? '8580' : '6581'; this.sid.setModel(this.model); this.fReg.fill(-1); this.settle(); break;
      case 'video': this.setVideo(value); break;
      case 'arp': this.arp = !!value; break;
      case 'adsrBug': this.sid.adsrBug = !!value; this.hr = value ? 2 : 0; break;
    }
  }

  reset() {
    const sid = this.sid;
    sid.reset();
    sid.write(24, 0x0f);
    this.settle();
    this.rs.bL.fill(0); this.rs.bR.fill(0);
    for (const v of this.v) { const i = v.i; Object.assign(v, new Voice(i)); }
    for (const c of this.cs) { c.held.length = 0; c.gen = 0; c.avg = 60; c.lastOn = 0; }
    this.pend.length = 0; this.prim = this.sec = null;
    this.leadCh = this.bassCh = this.fOwner = -1; this.fReg.fill(-1); this.leadRest = this.bassRest = 99;
  }

  // ------------------------------------------------------------------ MIDI in
  noteOn(c, note, vel) {
    const ch = this.h.ch[c];
    if (ch.drum) { if (this.pend.length < 16) this.pend.push({ n: note, v: vel, c, id: ++this.ids, t: 0, def: drumDef(note) }); return; }
    const cs = this.cs[c], held = cs.held;
    for (let k = held.length - 1; k >= 0; k--) if (held[k].n === note) held.splice(k, 1);
    if (held.length >= 12) held.shift();
    held.push({ n: note, v: vel, id: ++this.ids, off: false, sus: false, age: 0 });
    cs.gen++; cs.lastOn = ++this.onSeq; cs.avg += (note - cs.avg) * 0.25;
  }
  noteOff(c, note) {
    const sus = this.h.ch[c].sustain;
    for (const e of this.cs[c].held) if (e.n === note && !e.off && !e.sus) { if (sus) e.sus = true; else e.off = true; }
  }
  sustainOff(c) { for (const e of this.cs[c].held) if (e.sus) { e.sus = false; e.off = true; } }
  allOff(c, hard) {
    const held = this.cs[c].held;
    if (hard) held.length = 0; else for (const e of held) { e.sus = false; e.off = true; }
    if (hard) {
      this.pend = this.pend.filter(p => p.c !== c);
      if (this.prim && this.prim.c === c) this.prim = null;
      if (this.sec && this.sec.c === c) this.sec = null;
      this.killCh(c);
    }
  }
  pitch() { /* retuned on the next frame, like a real player */ }
  ctrl(c) { if (this.h.mute[c]) this.killCh(c); }
  killCh(c) {
    for (const v of this.v) if (v.ch === c && v.phase !== IDLE) {
      this.sid.write(v.i * 7 + 6, 0x00); this.sid.write(v.i * 7 + 4, v.ctrlReg & 0xfe); v.ctrlReg &= 0xfe;
      v.phase = REL; v.key = -1; v.trig = -1;
    }
  }

  // ------------------------------------------------------------------ helpers
  level(c, vel) { const ch = this.h.ch[c]; return (vel / 127) * (ch.vol / 127) * (ch.expr / 127); }
  score(c) {
    const ch = this.h.ch[c], held = this.cs[c].held;
    let top = 0; for (const e of held) if (e.n > top) top = e.n;
    return (FAMILY_WEIGHT[family(ch.program)] || 0) + (held.length === 1 ? 0.8 : 0)
      + 2 * (ch.vol * ch.expr) / 16129 + (top - 60) / 24;
  }
  playable(c) { return !this.h.ch[c].drum && !this.h.mute[c] && this.cs[c].held.length > 0 && this.h.ch[c].vol * this.h.ch[c].expr > 0; }
  isBass(c) { return family(this.h.ch[c].program) === 'bass' || this.cs[c].avg < 44; }
  addReq(key, trig, prio, ch, kind) {
    if (this.nreq >= this.req.length) return null;
    const r = this.req[this.nreq++];
    r.key = key; r.trig = trig; r.prio = prio; r.ch = ch; r.kind = kind; r.n = 0; r.drum = null; r.taken = false;
    return r;
  }
  susNib(s, k) { return s ? Math.max(0, Math.min(15, Math.round(s * Math.pow(Math.min(1.2, k), 0.75)))) : 0; }

  // ------------------------------------------------------------------ the player routine (once per frame)
  tick() {
    this.frame++;
    const hr = this.hr, h = this.h;
    // note bookkeeping: released notes are kept until they have sounded for at least one frame
    for (let c = 0; c < 16; c++) {
      const held = this.cs[c].held;
      for (let k = held.length - 1; k >= 0; k--) { const e = held[k]; e.age++; if (e.off && e.age > hr + 1) held.splice(k, 1); }
    }
    // drums: advance, then take this frame's new hits
    if (this.prim && ++this.prim.t >= this.prim.def.len + hr) this.prim = null;
    if (this.sec && ++this.sec.t >= this.sec.def.len + hr) this.sec = null;
    if (this.pend.length) {
      this.pend.sort((a, b) => a.def.prio - b.def.prio);
      for (const p of this.pend) {
        if (h.mute[p.c]) continue;
        const pr = this.prim;
        if (!pr || p.def.prio >= pr.def.prio || pr.t >= 2) { if (pr && (!this.sec || pr.def.prio >= this.sec.def.prio)) this.sec = pr; this.prim = p; }
        else if (!this.sec || p.def.prio >= this.sec.def.prio) this.sec = p;
      }
      this.pend.length = 0;
    }
    if (this.prim && h.mute[this.prim.c]) this.prim = null;
    if (this.sec && h.mute[this.sec.c]) this.sec = null;

    // ---- requests
    this.nreq = 0;
    let lead = -1, ls = -1e9;
    for (let c = 0; c < 16; c++) if (this.playable(c) && !this.isBass(c)) { const s = this.score(c); if (s > ls) { ls = s; lead = c; } }
    const cur = this.leadCh;
    let leadHold = false, bassHold = false;
    if (cur >= 0 && cur !== lead) {
      if (this.playable(cur) && !this.isBass(cur)) {
        if (!(ls > this.score(cur) + 1.5 && this.cs[lead].lastOn > this.cs[cur].lastOn)) lead = cur;
      } else if (this.leadRest < LEAD_HOLD && !h.mute[cur] && !(lead >= 0 && this.cs[lead].lastOn > this.leadStop && ls > this.leadScore - 0.5)) { lead = cur; leadHold = true; }
    }
    if (lead >= 0 && !leadHold) { this.leadRest = 0; this.leadStop = this.onSeq; this.leadScore = this.score(lead); } else this.leadRest++;
    this.leadCh = lead;
    let bass = -1;
    const cb = this.bassCh;
    if (cb >= 0 && cb !== lead && this.playable(cb) && this.isBass(cb)) bass = cb;
    else for (let c = 0; c < 16; c++) if (c !== lead && this.playable(c) && this.isBass(c) && (bass < 0 || this.cs[c].lastOn > this.cs[bass].lastOn)) bass = c;
    if (bass < 0 && cb >= 0 && cb !== lead && this.bassRest < BASS_HOLD && !h.mute[cb]) { bass = cb; bassHold = true; }
    if (bass < 0 && lead < 0) {   // only bass-class parts playing: the most recent one leads
      for (let c = 0; c < 16; c++) if (this.playable(c) && (lead < 0 || this.cs[c].lastOn > this.cs[lead].lastOn)) lead = c;
      this.leadCh = lead; if (lead >= 0) this.leadRest = 0;
    }
    if (bass >= 0 && !bassHold) this.bassRest = 0; else this.bassRest++;
    this.bassCh = bass;
    let leadNote = null, bassNote = null;
    if (leadHold) this.addReq(K_LEAD, -2, 100, lead, HOLD);
    else if (lead >= 0) {
      for (const e of this.cs[lead].held) if (!leadNote || e.n > leadNote.n) leadNote = e;
      if (this.level(lead, leadNote.v) > 0.004) { const r = this.addReq(K_LEAD, leadNote.id, 100, lead, NOTE); r.note = leadNote.n; r.vel = leadNote.v; }
    }
    if (bassHold) this.addReq(K_BASS, -2, 90, bass, HOLD);
    else if (bass >= 0) {
      for (const e of this.cs[bass].held) if (!bassNote || e.n < bassNote.n) bassNote = e;
      if (this.level(bass, bassNote.v) > 0.004) { const r = this.addReq(K_BASS, bassNote.id, 90, bass, NOTE); r.note = bassNote.n; r.vel = bassNote.v; }
    }
    if (this.prim) { const r = this.addReq(K_DRUM, this.prim.id, 80, this.prim.c, DRUM); r.drum = this.prim; r.vel = this.prim.v; r.note = this.prim.n; }
    if (this.sec) { const r = this.addReq(K_DRUM2, this.sec.id, 40, this.sec.c, DRUM); r.drum = this.sec; r.vel = this.sec.v; r.note = this.sec.n; }
    for (let c = 0; c < 16; c++) {
      if (!this.playable(c)) continue;
      const held = this.cs[c].held;
      let m = 0, vmax = 0, newest = 0;
      for (const e of held) if (e !== leadNote && e !== bassNote) { m++; if (e.v > vmax) vmax = e.v; if (e.id > newest) newest = e.id; }
      if (!m || this.level(c, vmax) <= 0.004) continue;
      const s = 50 + this.score(c);
      if (this.arp && m >= 2) {
        const r = this.addReq(100 + c, this.cs[c].gen, s, c, ARP); if (!r) continue;
        for (const e of held) if (e !== leadNote && e !== bassNote && r.n < 16) r.notes[r.n++] = e.n;
        r.notes.subarray(0, r.n).sort(); r.vel = vmax; r.note = r.notes[0];
      } else {
        let k = 0;
        for (let j = held.length - 1; j >= 0; j--) {
          const e = held[j]; if (e === leadNote || e === bassNote) continue;
          const r = this.addReq(1000 + e.id, e.id, s - 0.3 * k++ + (e.n - 60) / 200, c, NOTE); if (!r) break;
          r.note = e.n; r.vel = e.v;
        }
      }
    }

    // ---- winners → voices (keep parts on their voice)
    const ord = this.order; ord.length = 0;
    for (let k = 0; k < this.nreq; k++) ord.push(this.req[k]);
    for (let k = 0; k < this.nreq; k++) { const r = this.req[k]; if (r.key >= 100) for (const v of this.v) if (v.key === r.key && v.phase === ON) r.prio += 1; }
    ord.sort((a, b) => b.prio - a.prio);
    if (ord.length > 3) ord.length = 3;
    for (const v of this.v) v.win = null;
    for (const r of ord) for (const v of this.v) if (!v.win && v.key === r.key && (r.kind === HOLD || (v.phase !== IDLE && v.phase !== REL))) { v.win = r; r.taken = true; break; }
    for (const r of ord) {
      if (r.taken || r.kind === HOLD) continue;
      let best = null, bs = -1e9;
      for (const v of this.v) {
        if (v.win) continue;
        let s = 0;
        if (v.key === r.key) s += 4;
        if (v.phase === IDLE) s += 3; else if (v.phase === REL) s += 2 - this.sid.env[v.i] / 255;
        if (r.key === K_DRUM && v.i === 2) s += 0.5;        // drums like voice 3, as in most players
        if (s > bs) { bs = s; best = v; }
      }
      best.win = r; r.taken = true;
    }
    for (const v of this.v) v.borrowed = false;

    // ---- per voice: start, follow or release
    for (const v of this.v) {
      const r = v.win;
      if (r && r.kind === HOLD) { if (v.phase === ON || v.phase === HR) this.release(v); }
      else if (r) {
        if (v.key !== r.key || v.trig !== r.trig || v.phase === REL || v.phase === IDLE) this.start(v, r);
        else if (r.kind === ARP) { v.n = r.n; v.notes.set(r.notes.subarray(0, r.n)); }
        if (r.kind !== DRUM && v.phase === ON) {         // CC7/CC11/velocity: only ever lower the sustain level
          const k = this.level(v.ch, r.vel) / REF_LEVEL, s = this.susNib(v.inst.sr >> 4, k);
          if (s < v.sNib) { v.sNib = s; v.srReg = (s << 4) | (v.inst.sr & 15); this.sid.write(v.i * 7 + 6, v.srReg); }
        }
      } else if (v.phase === ON || v.phase === HR) this.release(v);
    }
    for (const v of this.v) if (v.phase === HR) { if (v.hrNew) v.hrNew = false; else if (--v.hrLeft <= 0) this.trigger(v); }

    // ---- filter owner: highest-priority sounding voice whose instrument wants the filter
    // (kept while its voice still sounds — even in release — unless a higher-priority part wants it)
    let owner = -1, cp = -1;
    for (const r of ord) for (const v of this.v) if (v.win === r && r.kind !== HOLD && v.phase === ON && v.inst && v.inst.f && owner < 0) { owner = v.i; cp = r.prio; }
    const fo = this.fOwner >= 0 ? this.v[this.fOwner] : null;
    if (fo && fo.phase !== IDLE && fo.inst && fo.inst.f && owner !== fo.i) {
      const op = fo.win && fo.win.kind !== HOLD && fo.phase === ON ? fo.win.prio : fo.phase === HR ? 1e9 : 0;
      if (owner < 0 || cp <= op || fo.phase === HR) owner = fo.i;
    }
    if (owner !== this.fOwner && owner >= 0) { const v = this.v[owner]; if (v.t > 0) { v.ft = 0; v.flog = Math.log2(v.inst.f0); } }
    this.fOwner = owner;

    for (const v of this.v) if (v.phase === ON || v.phase === REL) this.update(v);
    this.updFilter();
  }

  start(v, r) {
    v.key = r.key; v.trig = r.trig; v.ch = r.ch; v.kind = r.kind; v.note = r.note; v.vel = r.vel;
    v.n = r.n; if (r.n) v.notes.set(r.notes.subarray(0, r.n));
    v.drum = r.kind === DRUM ? r.drum.def : null;
    v.inst = r.kind === DRUM ? null : PROGRAMS[this.h.ch[r.ch].program & 127];
    if (this.hr) {
      const b = v.i * 7;
      this.sid.write(b + 5, 0x00); this.sid.write(b + 6, 0x00);
      v.ctrlReg &= 0xfe; this.sid.write(b + 4, v.ctrlReg);
      v.phase = HR; v.hrLeft = this.hr; v.hrNew = true;
    } else this.trigger(v);
  }
  trigger(v) {
    const b = v.i * 7, sid = this.sid;
    const k = this.level(v.ch, v.vel) / REF_LEVEL; v.k = k;
    let ad, sr;
    if (v.drum) {
      const d = v.drum;
      const dn = Math.max(0, (d.ad & 15) - (k < 0.6 ? 1 : 0) - (k < 0.3 ? 1 : 0));
      ad = (d.ad & 0xf0) | dn; sr = d.sr;
      v.pw = 0x800; v.pwd = 0;
    } else {
      const ins = v.inst;
      const s = this.susNib(ins.sr >> 4, k);
      v.sNib = s; sr = (s << 4) | (ins.sr & 15);
      ad = ins.ad;
      if (!s) ad = (ad & 0xf0) | Math.max(0, (ad & 15) - (k < 0.6 ? 1 : 0) - (k < 0.3 ? 1 : 0));
      v.pw = ins.pw; v.pwd = ins.pwm;
      v.ft = 0; v.flog = Math.log2(ins.f0);
    }
    v.srReg = sr;
    sid.write(b + 5, ad); sid.write(b + 6, sr);
    if (v.ctrlReg & 1) { v.ctrlReg &= 0xfe; sid.write(b + 4, v.ctrlReg); }
    v.phase = ON; v.t = 0; v.arpI = 0; v.vibPh = 0; v.slide = 0;
  }
  release(v) {
    v.phase = REL;
    if (v.ctrlReg & 1) { v.ctrlReg &= 0xfe; this.sid.write(v.i * 7 + 4, v.ctrlReg); }
  }

  /** one frame of wave table / pitch / pulse-width work for a voice, written to its registers */
  update(v) {
    const sid = this.sid, b = v.i * 7, t = v.t, ch = this.h.ch[v.ch];
    let wave, n, gate = v.phase === ON;
    if (v.drum) {
      const d = v.drum, L = d.seq.length, e = d.seq[t < L ? t : L - 1];
      wave = e[0]; n = e[1] + (t >= L - 1 ? (t - L + 1) * d.slide : 0);
      if (e.length > 2) v.pw = e[2];
      if (t >= d.g) gate = false;
    } else {
      const ins = v.inst;
      let base = v.note, fix = -1;
      wave = ins.w;
      if (v.kind === ARP && v.n) { base = v.notes[v.arpI % v.n]; v.arpI++; }
      if (ins.arp) base += ins.arp[t % ins.arp.length];
      if (t < ins.at.length) { const e = ins.at[t]; wave = e[0]; if (e[2] >= 0) fix = e[2]; else base += e[1]; }
      else if (ins.nfix >= 0 && (wave & NOISE)) fix = ins.nfix + (v.note - 60) * 0.25;
      v.slide += ins.slide; if (v.slide > ins.smax) v.slide = ins.smax; else if (v.slide < -ins.smax) v.slide = -ins.smax;
      let vib = 0;
      const depth = (t >= ins.vdl ? ins.vib : 0) + ch.mod / 127 * 0.6;
      if (depth > 0) {
        v.vibPh += ins.vhz / this.frameHz; if (v.vibPh >= 1) v.vibPh -= 1;
        vib = depth * (v.vibPh < 0.5 ? 4 * v.vibPh - 1 : 3 - 4 * v.vibPh);
      }
      n = fix >= 0 ? fix : base + ins.oct * 12 + ch.bend * ch.bendRange + v.slide + vib;
      if (ins.gate && t >= ins.gate) gate = false;
      if (ins.chop && t % ins.chop === ins.chop - 1) gate = false;
      // ring / sync need the source voice's oscillator: only borrow it if that voice is silent
      if (ins.mod && wave === ins.w) {
        const sv = this.v[SRC[v.i]];
        if (!sv.win && sv.phase === IDLE) {
          const ratio = ins.mod + (ins.modTo - ins.mod) * Math.min(1, t / ins.modFr);
          const off = 12 * Math.log2(ratio);
          let sn = n;
          if (wave & SYNC) n += off; else sn += off;
          this.setFreq(sv, sn); sv.borrowed = true;
        } else wave = ins.fw;
      }
      v.pw += v.pwd;
      if (v.pw > ins.pwhi) { v.pw = ins.pwhi; v.pwd = -v.pwd; } else if (v.pw < ins.pwlo) { v.pw = ins.pwlo; v.pwd = -v.pwd; }
    }
    this.setFreq(v, n);
    const pw = v.pw & 0xfff;
    if (pw !== v.pwReg) { v.pwReg = pw; sid.write(b + 2, pw & 255); sid.write(b + 3, pw >> 8); }
    const cr = wave | (gate ? 1 : 0);
    if (cr !== v.ctrlReg) { v.ctrlReg = cr; sid.write(b + 4, cr); }
    v.t++;
    if (v.phase === REL && sid.env[v.i] === 0 && !(v.ctrlReg & 1)) { v.phase = IDLE; }
  }
  setFreq(v, n) {
    let fn = Math.round(440 * Math.pow(2, (n - 69) / 12) * this.fnScale);
    fn = fn < 1 ? 1 : fn > 65535 ? 65535 : fn;
    if (fn !== v.fn) { v.fn = fn; this.sid.write(v.i * 7, fn & 255); this.sid.write(v.i * 7 + 1, fn >> 8); }
  }
  updFilter() {
    const sid = this.sid, f = this.fReg;
    let fc = f[0], rf = 0, mv = 0x0f;
    if (this.fOwner >= 0) {
      const v = this.v[this.fOwner], ins = v.inst;
      let lh;
      if (v.ft < ins.fa) { const a = Math.log2(ins.f0), z = Math.log2(ins.f1); lh = a + (z - a) * v.ft / ins.fa; v.flog = lh; }
      else { v.flog += (Math.log2(ins.f2) - v.flog) * ins.fk; lh = v.flog; }
      lh += ins.fkt * (v.note - 60) / 12 + 0.5 * (Math.min(1.3, v.k) - 1);
      if (ins.fld) lh += ins.fld * Math.sin(2 * Math.PI * ins.fl * v.ft / this.frameHz);
      v.ft++;
      fc = cutoffReg(this.model, Math.pow(2, lh));
      rf = (ins.res << 4) | (1 << v.i); mv = ins.f | 0x0f;
    }
    if (fc !== f[0]) { f[0] = fc; sid.write(21, fc & 7); sid.write(22, fc >> 3); }
    if (rf !== f[1]) { f[1] = rf; sid.write(23, rf); }
    if (mv !== f[2]) { f[2] = mv; sid.write(24, mv); }
  }

  // ------------------------------------------------------------------ audio
  render(L, R, n) {
    const rs = this.rs, sid = this.sid, dcb = this.dcb, fp = this.framePeriod;
    if (this.cnt.length < n) { this.cnt = new Int32Array(n); this.frac = new Float64Array(n); this.ibuf = new Float64Array(n * 4 + 16); }
    // the resampler's input schedule for this block (same arithmetic as Resampler.advance)
    const cnt = this.cnt, fr = this.frac;
    let f = rs.frac, need = 0;
    for (let i = 0; i < n; i++) { f += rs.step; const k = Math.floor(f); f -= k; cnt[i] = k; fr[i] = f; need += k; }
    if (this.ibuf.length < need) this.ibuf = new Float64Array(need * 2);
    // run the chip in chunks, ticking the player exactly at frame boundaries
    const ib = this.ibuf, ob = sid.obuf, maxM = (MAXN / DECIM) | 0;
    for (let p = 0; p < need;) {
      const toTick = Math.ceil((fp - this.cyc) / DECIM);
      const m = Math.min(need - p, maxM, toTick);
      sid.run(m * DECIM);
      for (let j = 0; j < m; j++) ib[p + j] = dcb.run(ob[j]) * GAIN;
      p += m; this.cyc += m * DECIM;
      if (this.cyc >= fp) { this.cyc -= fp; this.tick(); }
    }
    for (let i = 0, q = 0; i < n; i++) {
      for (let k = cnt[i]; k > 0; k--, q++) rs.push(ib[q]);
      rs.frac = fr[i];
      L[i] = R[i] = rs.out();
    }
    const met = this.h.meter;
    for (const v of this.v) if (v.phase !== IDLE && v.ch >= 0) { const g = sid.env[v.i] / 255; if (g > met[v.ch]) met[v.ch] = g; }
  }
  activeCount() { let n = 0; for (const v of this.v) if (v.phase !== IDLE) n++; return n; }
  maxVoices() { return 3; }
}
