/*
 * Blasta — synthesis worklet.
 *
 * Four "sound card" cores share one set of General MIDI channel state:
 *   core 0  OPL2   (AdLib / Sound Blaster 2.0)   9-voice 2-op FM, mono, 4 waveforms
 *   core 1  OPL3   (Sound Blaster 16 / Win 3.1)  18-voice 2-op FM, hard-panned stereo, 8 waveforms
 *   core 2  EMU8000 (AWE32)                      30-voice wavetable, linear interp, gritty reverb
 *   core 3  EMU10K1 (SB Live!)                   64-voice wavetable, 8-point interp, smooth reverb
 *
 * The era slider sets an equal-power crossfade between adjacent cores.
 * The FM cores run a cycle-accurate YMF262 emulation (a JavaScript port of Nuked OPL3, LGPL-2.1,
 * see nuked-opl3.js) at the chip's native 49,716 Hz, through a floating-point DAC model, then a
 * band-limited resampler to the AudioContext rate.
 */

import { OPL3 } from './nuked-opl3.js';

const SR = sampleRate;
const SUB = 32;                 // control-rate sub-block
const DT = SUB / SR;

// ======================================================================
//  MIDI channel state
// ======================================================================
class Chan {
  constructor(i) { this.i = i; this.cc = new Uint8Array(128); this.reset(); }
  reset() {
    this.program = 0; this.bank = 0;
    this.cc.fill(0);
    this.cc[7] = 100; this.cc[10] = 64; this.cc[11] = 127; this.cc[91] = 40; this.cc[93] = 0;
    this.sustain = false; this.bend = 0; this.bendRange = 2; this.pressure = 0;
    this.rpnM = 127; this.rpnL = 127;
    this.drum = this.i === 9;
  }
  get vol() { return this.cc[7]; }
  get expr() { return this.cc[11]; }
  get pan() { return this.cc[10]; }
}

// ======================================================================
//  FM: cycle-accurate YMF262 (Nuked OPL3 port) driven through its registers,
//  the way the DOS/Windows MIDI drivers did it.
// ======================================================================
const OPL_RATE = 49716;                  // 14.31818 MHz / 288 — the chip's native sample rate
const OP_OFF = [0, 1, 2, 8, 9, 10, 16, 17, 18];

function dacFloat(x) {                   // YM3014 / YAC512 floating-point DAC: 10-bit mantissa, 3-bit exponent
  const a = x < 0 ? -x : x;
  if (a < 512) return x;
  let sh = 1;
  while ((a >> sh) >= 512) sh++;
  return ((x >> sh) << sh);
}

// Band-limited polyphase resampler: native chip rate → AudioContext rate.
class Resampler {
  constructor(inRate, outRate, taps = 64, phases = 1024) {
    this.step = inRate / outRate; this.T = taps; this.P = phases;
    const fc = 0.5 * Math.min(1, outRate / inRate) * 0.9;     // cutoff, cycles per input sample
    this.h = new Float32Array(phases * taps);
    for (let p = 0; p < phases; p++) {
      let sum = 0;
      for (let k = 0; k < taps; k++) {
        const x = (k - taps / 2 + 1) - p / phases;
        const s = Math.abs(x) < 1e-9 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
        const n = (x + taps / 2) / taps;                         // 0..1 across the window
        const w = n <= 0 || n >= 1 ? 0 : 0.35875 - 0.48829 * Math.cos(2 * Math.PI * n) + 0.14128 * Math.cos(4 * Math.PI * n) - 0.01168 * Math.cos(6 * Math.PI * n);
        this.h[p * taps + k] = s * w; sum += s * w;
      }
      for (let k = 0; k < taps; k++) this.h[p * taps + k] /= sum;
    }
    this.bL = new Float32Array(taps * 2); this.bR = new Float32Array(taps * 2);
    this.idx = 0; this.frac = 0;
  }
  push(l, r) {
    const T = this.T, i = this.idx;
    this.bL[i] = this.bL[i + T] = l; this.bR[i] = this.bR[i + T] = r;
    this.idx = i + 1 === T ? 0 : i + 1;
  }
  // returns how many new input samples are needed before the next output
  advance() { this.frac += this.step; const n = Math.floor(this.frac); this.frac -= n; return n; }
  out(o) {
    const T = this.T, base = this.idx, h = this.h, hp = ((this.frac * this.P) | 0) * T;
    let l = 0, r = 0;
    for (let k = 0; k < T; k++) { const c = h[hp + k]; l += this.bL[base + k] * c; r += this.bR[base + k] * c; }
    o[0] = l; o[1] = r;
  }
}

class FMVoice {
  constructor(c) {
    this.c = c;                          // chip channel 0..17
    this.hi = c >= 9 ? 0x100 : 0; this.ch = c % 9; this.mop = OP_OFF[this.ch]; this.cop = this.mop + 3;
    this.active = false; this.on = false; this.sus = false;
    this.midi = 0; this.note = 0; this.vel = 0; this.age = 0; this.pv = null;
    this.pitch = 60; this.fixed = false; this.offset = 0; this.detune = 0;
    this.fnum = 0; this.block = 0; this.pan = 0x30; this.offTick = -1;
  }
}

class OPLCore {
  constructor(synth, kind) {
    this.s = synth; this.kind = kind;
    this.nv = kind ? 18 : 9;
    this.stereo = kind === 1;
    this.chip = new OPL3();
    this.voices = []; for (let i = 0; i < this.nv; i++) this.voices.push(new FMVoice(i));
    this.bank = null; this.age = 0;
    this.deferred = [];                  // key-ons held for one chip sample after a key-off
    this.tick = 0;
    this.rs = new Resampler(OPL_RATE, SR);
    this.cbuf = [0, 0]; this.obuf = [0, 0];
    this.lpA = 1 - Math.exp(-2 * Math.PI * (kind ? 14000 : 8500) / SR);
    this.lp2A = 1 - Math.exp(-2 * Math.PI * (kind ? 18000 : 12000) / SR);
    this.lL = 0; this.lR = 0; this.l2L = 0; this.l2R = 0;
    this.hiss = kind ? 0.00004 : 0.00016;
    this.seed = 12345 + kind;
    this.analog = 1;
    this.scale = 2.6 / 32768;
    this.initChip();
  }
  w(reg, v) { this.chip.writeReg(reg, v & 0xff); }
  initChip() {
    this.chip.reset();
    if (this.kind === 1) this.w(0x105, 0x01);    // OPL3 mode (NEW=1); OPL2 core stays in OPL2-compatible mode
    this.w(0x01, 0x20);                           // waveform select enable
    this.w(0xBD, 0xC0);                           // deep tremolo + deep vibrato, melodic mode
    this.w(0x08, 0x00);
  }
  setBank(b) { this.reset(); this.bank = b; }
  reset() {
    for (const v of this.voices) {
      v.active = false; v.on = false;
      this.w(v.hi + 0xB0 + v.ch, 0);
      this.w(v.hi + 0x80 + v.mop, 0x0f); this.w(v.hi + 0x80 + v.cop, 0x0f);   // fastest release
    }
    this.deferred.length = 0;
  }
  activeCount() { let n = 0; for (const v of this.voices) if (v.active) n++; return n; }

  alloc() {
    let best = null, bestAge = Infinity;
    for (const v of this.voices) if (!v.active) return v;
    for (const v of this.voices) if (!v.on && v.age < bestAge) { best = v; bestAge = v.age; }
    if (best) return best;
    for (const v of this.voices) if (v.age < bestAge) { best = v; bestAge = v.age; }
    return best;
  }

  noteOn(c, note, vel) {
    if (!this.bank) return;
    const ch = this.s.ch[c];
    const patch = ch.drum ? this.bank.drums[note] : this.bank.melodic[ch.program & 127];
    if (!patch) return;
    for (let k = 0; k < patch.voices.length; k++) {
      const pv = patch.voices[k];
      const v = this.alloc();
      // the chip only retriggers if it sees at least one sample with the key released
      const wasKeyed = v.active && (v.on || v.offTick === this.tick);
      this.dropDeferred(v);
      if (v.active) this.w(v.hi + 0xB0 + v.ch, (v.block << 2) | (v.fnum >> 8));      // key off (steal)
      v.active = true; v.on = true; v.sus = false;
      v.midi = c; v.note = note; v.vel = vel; v.age = ++this.age; v.pv = pv;
      v.fixed = !!patch.fixed;
      v.pitch = patch.fixed ? patch.fixedNote : note;
      v.offset = pv.offset || 0;
      v.detune = k === 1 ? (patch.detune || 0) : 0;
      const op20 = (p) => (p.am << 7) | (p.vib << 6) | (p.egt << 5) | (p.ksr << 4) | p.mult;
      for (const [off, p] of [[v.mop, pv.m], [v.cop, pv.c]]) {
        this.w(v.hi + 0x20 + off, op20(p));
        this.w(v.hi + 0x60 + off, (p.ar << 4) | p.dr);
        this.w(v.hi + 0x80 + off, (p.sl << 4) | p.rr);
        this.w(v.hi + 0xE0 + off, p.ws);
      }
      this.panOf(v);
      this.level(v);
      this.freq(v, false);
      const keyOn = [v.hi + 0xB0 + v.ch, 0x20 | (v.block << 2) | (v.fnum >> 8)];
      if (wasKeyed) this.deferred.push([v, keyOn[0], keyOn[1]]); else this.w(keyOn[0], keyOn[1]);
    }
  }
  panOf(v) {
    let pan = 0x30;
    if (this.stereo) { const p = this.s.ch[v.midi].pan; pan = p < 43 ? 0x10 : p > 85 ? 0x20 : 0x30; }
    v.pan = pan;
    this.w(v.hi + 0xC0 + v.ch, pan | (v.pv.fb << 1) | v.pv.cnt);
  }
  freq(v, write = true) {
    const ch = this.s.ch[v.midi];
    let n = v.pitch + v.offset + v.detune;
    if (!v.fixed) n += ch.bend * ch.bendRange;
    let f = 440 * Math.pow(2, (n - 69) / 12);
    if (f < 1) f = 1;
    let block = 0, fnum = 0;
    for (block = 0; block < 8; block++) { fnum = Math.round(f * Math.pow(2, 20 - block) / OPL_RATE); if (fnum < 1024) break; }
    if (block > 7) { block = 7; fnum = 1023; }
    v.fnum = fnum; v.block = block;
    this.w(v.hi + 0xA0 + v.ch, fnum & 0xff);
    if (write) this.w(v.hi + 0xB0 + v.ch, (v.on ? 0x20 : 0) | (block << 2) | (fnum >> 8));
  }
  level(v) {
    const ch = this.s.ch[v.midi];
    const vel = Math.max(1, v.vel) / 127;
    const vol = Math.max(1, ch.vol * ch.expr) / 16129;
    const db = -40 * Math.log10(vel) * 0.55 - 40 * Math.log10(vol) * 0.75;
    let add = Math.min(63, Math.round(db / 0.75));
    if (this.s.mute[v.midi]) add = 63;
    const p = v.pv;
    this.w(v.hi + 0x40 + v.cop, (p.c.ksl << 6) | Math.min(63, p.c.tl + add));
    this.w(v.hi + 0x40 + v.mop, (p.m.ksl << 6) | Math.min(63, p.m.tl + (p.cnt ? add : 0)));
  }
  release(v) { v.on = false; v.sus = false; v.offTick = this.tick; this.dropDeferred(v); this.w(v.hi + 0xB0 + v.ch, (v.block << 2) | (v.fnum >> 8)); }
  dropDeferred(v) { if (this.deferred.length) this.deferred = this.deferred.filter(d => d[0] !== v); }
  noteOff(c, note) {
    const ch = this.s.ch[c];
    for (const v of this.voices) if (v.active && v.on && v.midi === c && v.note === note) {
      if (ch.sustain) v.sus = true; else this.release(v);
    }
  }
  sustainOff(c) { for (const v of this.voices) if (v.active && v.on && v.sus && v.midi === c) this.release(v); }
  allOff(c, hard) {
    for (const v of this.voices) if (v.active && v.midi === c) {
      this.release(v);
      if (hard) { this.w(v.hi + 0x80 + v.mop, 0x0f); this.w(v.hi + 0x80 + v.cop, 0x0f); }
    }
  }
  pitch(c) { for (const v of this.voices) if (v.active && v.midi === c) this.freq(v); }
  ctrl(c) { for (const v of this.voices) if (v.active && v.midi === c) { this.level(v); this.panOf(v); } }

  chipSample() {
    this.chip.generate(this.cbuf);
    this.tick++;
    if (this.deferred.length) { for (const [, r, d] of this.deferred) this.w(r, d); this.deferred.length = 0; }
    if (this.stereo) this.rs.push(dacFloat(this.cbuf[0]) * this.scale, dacFloat(this.cbuf[1]) * this.scale);
    else { const m = dacFloat(this.cbuf[0]) * this.scale; this.rs.push(m, m); }   // YM3812 → YM3014: one mono DAC
  }

  render(oL, oR, n) {
    const an = this.analog;
    const a = this.lpA * an + (1 - an), a2 = this.lp2A * an + (1 - an);
    const o = this.obuf;
    for (let i = 0; i < n; i++) {
      for (let k = this.rs.advance(); k > 0; k--) this.chipSample();
      this.rs.out(o);
      // analog output stage: two gentle poles + hiss
      this.lL += a * (o[0] - this.lL); this.l2L += a2 * (this.lL - this.l2L);
      this.lR += a * (o[1] - this.lR); this.l2R += a2 * (this.lR - this.l2R);
      this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
      const nz = ((this.seed / 0x7fffffff) - 0.5) * this.hiss * an;
      oL[i] = this.l2L + nz; oR[i] = this.l2R + nz;
    }
    // free finished voices; meters from the carrier's real envelope output
    const met = this.s.meter;
    for (const v of this.voices) {
      if (!v.active) continue;
      const chn = this.chip.channel[v.c], car = chn.slotz[1], mod = chn.slotz[0];
      if (!v.on && (car.eg_rout & 0x1f8) === 0x1f8 && (!v.pv.cnt || (mod.eg_rout & 0x1f8) === 0x1f8)) { v.active = false; continue; }
      const g = Math.pow(10, -Math.min(511, car.eg_out) * 0.1875 / 20);
      if (g > met[v.midi]) met[v.midi] = g;
    }
  }
}

// ======================================================================
//  Wavetable (SoundFont-style) engine
// ======================================================================
const SINC_PH = 256, SINC_N = 8;
const SINC8 = new Float32Array(SINC_PH * SINC_N);
for (let p = 0; p < SINC_PH; p++) {
  const fr = p / SINC_PH; let sum = 0;
  for (let k = 0; k < SINC_N; k++) {
    const x = (k - 3) - fr;                        // taps at ip-3 .. ip+4
    const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.42 + 0.5 * Math.cos(Math.PI * x / 4.5) + 0.08 * Math.cos(2 * Math.PI * x / 4.5);
    SINC8[p * SINC_N + k] = s * w; sum += s * w;
  }
  for (let k = 0; k < SINC_N; k++) SINC8[p * SINC_N + k] /= sum;
}

const tc2s = (tc) => Math.pow(2, tc / 1200);
const cents2hz = (c) => 8.176 * Math.pow(2, c / 1200);
function concave(x) { return x >= 1 ? 1 : x <= 0 ? 0 : Math.min(1, -(40 / 96) * Math.log10(1 - x)); }
function convex(x) { return 1 - concave(1 - x); }

const MOD_DESTS = new Set([5, 6, 8, 9, 10, 13, 15, 16, 17, 48, 51, 52]);

class SVoice {
  constructor() {
    this.active = false; this.dyn = new Float64Array(61); this.z = null;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
}

class SamplerCore {
  constructor(synth, kind) {
    this.s = synth; this.kind = kind;            // 2 = AWE32, 3 = Live!
    this.max = kind === 2 ? 30 : 64;
    this.interp = kind === 2 ? 1 : 3;            // 1 linear, 3 sinc8
    this.useZoneMods = kind === 3;               // EMU8000 era: SF2.0, default modulators only
    this.voices = []; for (let i = 0; i < this.max + 8; i++) this.voices.push(new SVoice());
    this.bank = null; this.pool = null; this.age = 0;
    this.rev = kind === 2 ? new AWEReverb() : new LiveReverb();
    this.cho = new Chorus(kind === 2 ? 0.55 : 0.4, kind === 2 ? 0.0035 : 0.0028);
    this.rbuf = new Float32Array(SUB); this.cbuf = new Float32Array(SUB);
    this.revL = new Float32Array(SUB); this.revR = new Float32Array(SUB);
    this.choL = new Float32Array(SUB); this.choR = new Float32Array(SUB);
    this.scale = kind === 2 ? 1.3 : 1.2;
  }
  setBank(b) {
    this.reset();
    this.bank = b; this.pool = b ? b.pool : null;
  }
  reset() { for (const v of this.voices) v.active = false; this.rev.clear(); this.cho.clear(); }
  activeCount() { let n = 0; for (const v of this.voices) if (v.active && !v.dying) n++; return n; }

  findZones(ch, note, vel) {
    const P = this.bank.presets;
    let list;
    if (ch.drum) list = P[128 * 128 + ch.program] || P[128 * 128];
    else list = P[ch.bank * 128 + ch.program] || P[ch.program];
    if (!list) return [];
    const out = [];
    for (const z of list) if (note >= z.kl && note <= z.kh && vel >= z.vl && vel <= z.vh) out.push(z);
    return out;
  }

  alloc() {
    let n = 0;
    for (const v of this.voices) if (v.active && !v.dying) n++;
    if (n >= this.max) {               // steal: oldest released, else oldest
      let best = null, ba = Infinity;
      for (const v of this.voices) if (v.active && !v.dying && v.vs === 5 && v.age < ba) { best = v; ba = v.age; }
      if (!best) for (const v of this.voices) if (v.active && !v.dying && v.age < ba) { best = v; ba = v.age; }
      if (best) best.dying = true;
    }
    for (const v of this.voices) if (!v.active) return v;
    // all slots busy (dying voices): take the oldest outright
    let best = this.voices[0];
    for (const v of this.voices) if (v.age < best.age) best = v;
    return best;
  }

  noteOn(c, note, vel) {
    if (!this.bank) return;
    const ch = this.s.ch[c];
    const zones = this.findZones(ch, note, vel);
    for (const z of zones) {
      const g = z.g;
      if (g[57]) for (const o of this.voices)   // exclusive class (e.g. hi-hats)
        if (o.active && o.ch === c && o.z.g[57] === g[57] && o.note !== note) o.dying = true;
      const v = this.alloc();
      v.active = true; v.dying = false; v.z = z; v.ch = c; v.note = note; v.age = ++this.age;
      v.key = g[46] >= 0 ? g[46] : note;
      v.vel = g[47] >= 0 ? g[47] : vel;
      v.on = true; v.sus = false;
      v.pos = z.start; v.loop = (g[54] & 1) === 1 && z.le > z.ls + 2;
      v.t = 0; v.x1 = v.x2 = v.y1 = v.y2 = 0; v.gPrev = 0;
      // volume envelope
      const keyAdj = 60 - v.key;
      v.vDelay = tc2s(g[33]); v.vAttack = tc2s(g[34]); v.vHold = tc2s(g[35] + keyAdj * g[39]);
      v.vDecay = tc2s(g[36] + keyAdj * g[40]); v.vSus = Math.min(100, Math.max(0, g[37] / 10)); v.vRel = tc2s(g[38]);
      if (v.vRel < 0.006) v.vRel = 0.006;
      v.vs = 0; v.vt = 0; v.vAtt = 0; v.envG = 0;
      // modulation envelope
      v.mDelay = tc2s(g[25]); v.mAttack = tc2s(g[26]); v.mHold = tc2s(g[27] + keyAdj * g[31]);
      v.mDecay = tc2s(g[28] + keyAdj * g[32]); v.mSus = 1 - Math.min(1000, Math.max(0, g[29])) / 1000; v.mRel = tc2s(g[30]);
      v.ms = 0; v.mt = 0; v.mVal = 0;
      // LFOs
      v.vibF = cents2hz(g[24]); v.vibD = tc2s(g[23]); v.vibPh = 0;
      v.modF = cents2hz(g[22]); v.modD = tc2s(g[21]); v.modPh = 0;
      this.evalMods(v);
      v.filt = g[8] < 13490 || g[11] !== 0 || g[10] !== 0 || v.dyn[8] < 13490;
    }
  }

  evalMods(v) {
    const z = v.z, g = z.g, d = v.dyn, ch = this.s.ch[v.ch];
    for (let i = 0; i < 61; i++) d[i] = g[i];
    d[48] = g[48] * 0.4;                        // EMU hardware attenuation scaling
    const mods = this.useZoneMods ? z.mods : this.s.defaultMods;
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i];
      const dest = m[1];
      if (!MOD_DESTS.has(dest)) continue;
      let val = m[2] * this.srcVal(m[0], ch, v);
      if (m[3]) val *= this.srcVal(m[3], ch, v);
      if (m[4] === 2) val = Math.abs(val);
      d[dest] += val;
    }
  }
  srcVal(src, ch, v) {
    const idx = src & 127, typ = src >> 10;
    let x;
    if (src & 128) x = ch.cc[idx] / 127;
    else switch (idx) {
      case 0: return 1;
      case 2: x = v.vel / 127; break;
      case 3: x = v.key / 127; break;
      case 13: x = ch.pressure; break;
      case 14: x = (ch.bend + 1) / 2; break;
      case 16: x = ch.bendRange / 127; break;
      default: x = 0;
    }
    if (src & 256) x = 1 - x;
    if (typ === 1) x = concave(x); else if (typ === 2) x = convex(x); else if (typ === 3) x = x >= 0.5 ? 1 : 0;
    if (src & 512) x = 2 * x - 1;
    return x;
  }

  release(v) {
    if (v.vs === 1) v.vAtt = v.envG > 1e-5 ? -20 * Math.log10(v.envG) : 100;
    else if (v.vs < 1) v.vAtt = 100;
    v.vs = 5; v.on = false; v.sus = false;
    v.ms = 5;
    if ((v.z.g[54] & 3) === 3) v.loop = false;   // loop-until-release: play the tail
  }
  noteOff(c, note) {
    const ch = this.s.ch[c];
    for (const v of this.voices) if (v.active && v.on && v.ch === c && v.note === note) {
      if (ch.sustain) v.sus = true; else this.release(v);
    }
  }
  sustainOff(c) { for (const v of this.voices) if (v.active && v.on && v.sus && v.ch === c) this.release(v); }
  allOff(c, hard) { for (const v of this.voices) if (v.active && v.ch === c) { if (hard) v.dying = true; else if (v.on) this.release(v); } }
  pitch(c) { /* pitch recomputed every sub-block */ }
  ctrl(c) { for (const v of this.voices) if (v.active && v.ch === c) this.evalMods(v); }

  stepEnv(v) {
    switch (v.vs) {
      case 0: v.vt += DT; v.envG = 0; if (v.vt >= v.vDelay) { v.vs = 1; v.vt = 0; } break;
      case 1: v.vt += DT; v.envG = v.vAttack > 0.0011 ? Math.min(1, v.vt / v.vAttack) : 1;
        if (v.envG >= 1) { v.vs = 2; v.vt = 0; v.vAtt = 0; } break;
      case 2: v.vt += DT; v.envG = 1; if (v.vt >= v.vHold) { v.vs = 3; v.vt = 0; } break;
      case 3: v.vAtt += 100 * DT / Math.max(0.001, v.vDecay);
        if (v.vAtt >= v.vSus) { v.vAtt = v.vSus; v.vs = 4; }
        v.envG = Math.pow(10, -v.vAtt / 20); break;
      case 4: v.envG = Math.pow(10, -v.vSus / 20); if (v.vSus >= 99) v.active = false; break;
      case 5: v.vAtt += 100 * DT / v.vRel; v.envG = Math.pow(10, -v.vAtt / 20);
        if (v.vAtt >= 96) v.active = false; break;
    }
    switch (v.ms) {
      case 0: v.mt += DT; v.mVal = 0; if (v.mt >= v.mDelay) { v.ms = 1; v.mt = 0; } break;
      case 1: v.mt += DT; v.mVal = v.mAttack > 0.0011 ? Math.min(1, v.mt / v.mAttack) : 1; if (v.mVal >= 1) { v.ms = 2; v.mt = 0; } break;
      case 2: v.mt += DT; v.mVal = 1; if (v.mt >= v.mHold) { v.ms = 3; v.mt = 0; } break;
      case 3: v.mVal -= DT / Math.max(0.001, v.mDecay); if (v.mVal <= v.mSus) { v.mVal = v.mSus; v.ms = 4; } break;
      case 4: break;
      case 5: v.mVal -= DT / Math.max(0.001, v.mRel); if (v.mVal < 0) v.mVal = 0; break;
    }
  }

  render(oL, oR, n) {
    oL.fill(0); oR.fill(0);
    const rb = this.rbuf, cb = this.cbuf; rb.fill(0); cb.fill(0);
    if (!this.pool) return;
    const pool = this.pool, mute = this.s.mute, met = this.s.meter;
    const interp = this.interp;
    for (const v of this.voices) {
      if (!v.active) continue;
      const z = v.z, d = v.dyn, g = z.g, ch = this.s.ch[v.ch];
      this.stepEnv(v);
      v.t += DT;
      // LFOs (triangle)
      let vib = 0, mod = 0;
      if (v.t > v.vibD) { v.vibPh += v.vibF * DT; vib = 1 - 4 * Math.abs((v.vibPh % 1) - 0.5); }
      if (v.t > v.modD) { v.modPh += v.modF * DT; mod = 1 - 4 * Math.abs((v.modPh % 1) - 0.5); }
      // pitch
      const cents = (v.key - z.root) * d[56] + d[51] * 100 + d[52] - z.corr
        + ch.bend * ch.bendRange * 100 + vib * d[6] + mod * d[5] + v.mVal * g[7];
      const inc = Math.pow(2, cents / 1200) * z.sr / SR;
      // gain
      let att = d[48] + mod * d[13];
      if (att < 0) att = 0;
      let gain = v.envG * Math.pow(10, -att / 200) * this.scale;
      if (v.dying) gain = 0;
      if (mute[v.ch]) gain = 0;
      let pan = d[17]; if (pan < -500) pan = -500; else if (pan > 500) pan = 500;
      const ang = (pan + 500) / 1000 * Math.PI / 2;
      const pl = Math.cos(ang), pr = Math.sin(ang);
      let rs = d[16] / 1000, cs = d[15] / 1000;
      rs = rs < 0 ? 0 : rs > 1 ? 1 : rs; cs = cs < 0 ? 0 : cs > 1 ? 1 : cs;
      // filter
      let b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
      const filt = v.filt;
      if (filt) {
        let fc = d[8] + v.mVal * g[11] + mod * d[10];
        let hz = cents2hz(fc); if (hz > SR * 0.45) hz = SR * 0.45; if (hz < 20) hz = 20;
        const qdb = Math.max(0, d[9] / 10);
        const Q = Math.max(0.5, Math.pow(10, qdb / 20) * 0.7071);
        const w = 2 * Math.PI * hz / SR, cw = Math.cos(w), al = Math.sin(w) / (2 * Q);
        const a0 = 1 + al, comp = 1 / Math.sqrt(Math.max(1, Q / 0.7071));
        b0 = (1 - cw) / 2 / a0 * comp; b1 = (1 - cw) / a0 * comp; b2 = b0;
        a1 = -2 * cw / a0; a2 = (1 - al) / a0;
      }
      // render
      const start = z.start, end = z.end, ls = z.ls, le = z.le, L = le - ls;
      let p = v.pos, loop = v.loop;
      let g0 = v.gPrev; const gStep = (gain - g0) / n;
      let x1 = v.x1, x2 = v.x2, y1 = v.y1, y2 = v.y2;
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const ip = p | 0, fr = p - ip;
        let s;
        const limit = loop ? le : end;
        if (interp === 1) {
          if (ip + 1 < limit) s = pool[ip] + (pool[ip + 1] - pool[ip]) * fr;
          else { const a = this.fetch(ip, loop, z), b = this.fetch(ip + 1, loop, z); s = a + (b - a) * fr; }
        } else {
          const o = ((fr * SINC_PH) | 0) * SINC_N;
          if (ip - 3 >= start && ip + 4 < limit) {
            s = pool[ip - 3] * SINC8[o] + pool[ip - 2] * SINC8[o + 1] + pool[ip - 1] * SINC8[o + 2] + pool[ip] * SINC8[o + 3]
              + pool[ip + 1] * SINC8[o + 4] + pool[ip + 2] * SINC8[o + 5] + pool[ip + 3] * SINC8[o + 6] + pool[ip + 4] * SINC8[o + 7];
          } else {
            s = 0; for (let k = 0; k < 8; k++) s += this.fetch(ip - 3 + k, loop, z) * SINC8[o + k];
          }
        }
        s *= 1 / 32768;
        if (filt) { const y = b0 * s + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = s; y2 = y1; y1 = y; s = y; }
        g0 += gStep;
        s *= g0;
        oL[i] += s * pl; oR[i] += s * pr; rb[i] += s * rs; cb[i] += s * cs;
        const as = s < 0 ? -s : s; if (as > peak) peak = as;
        p += inc;
        if (loop) { if (p >= le) p -= L * Math.floor((p - ls) / L); }
        else if (p >= end) { v.active = false; break; }
      }
      v.pos = p; v.gPrev = gain; v.x1 = x1; v.x2 = x2; v.y1 = y1; v.y2 = y2;
      if (v.dying && g0 <= 1e-6) v.active = false;
      if (y1 !== y1) { v.active = false; v.x1 = v.x2 = v.y1 = v.y2 = 0; } // NaN guard
      const mv = v.envG * Math.pow(10, -att / 200);
      if (!v.dying && mv > met[v.ch]) met[v.ch] = mv;
    }
    // effects
    this.rev.process(rb, this.revL, this.revR, n);
    this.cho.process(cb, this.choL, this.choR, n);
    for (let i = 0; i < n; i++) { oL[i] += this.revL[i] + this.choL[i]; oR[i] += this.revR[i] + this.choR[i]; }
  }
  fetch(i, loop, z) {
    if (loop && i >= z.le) i = z.ls + ((i - z.ls) % (z.le - z.ls));
    if (i < z.start || i >= z.end) return 0;
    return this.pool[i];
  }
}

// ---------------- effects ----------------
class Comb {
  constructor(n) { this.b = new Float32Array(n); this.i = 0; this.f = 0; }
}
class AWEReverb {   // metallic Schroeder-style reverb, run at half rate like a budget DSP
  constructor() {
    const k = SR / 44100 / 2;
    this.combs = [1116, 1188, 1277, 1356].map(d => ({ b: new Float32Array(Math.round(d * k)), i: 0 }));
    this.aps = [556, 225].map(d => ({ b: new Float32Array(Math.round(d * k)), i: 0 }));
    this.half = 0; this.acc = 0; this.hold = 0; this.prev = 0; this.cur = 0; this.wet = 0.55;
  }
  clear() { for (const c of this.combs) c.b.fill(0); for (const a of this.aps) a.b.fill(0); this.prev = this.cur = 0; }
  process(inp, oL, oR, n) {
    for (let i = 0; i < n; i++) {
      this.acc += inp[i];
      if (++this.half === 2) {
        const x = this.acc * 0.5; this.acc = 0; this.half = 0;
        let y = 0;
        for (const c of this.combs) { const o = c.b[c.i]; c.b[c.i] = x + o * 0.83; c.i = (c.i + 1) % c.b.length; y += o; }
        y *= 0.25;
        for (const a of this.aps) { const o = a.b[a.i]; const w = y + o * 0.5; a.b[a.i] = w; a.i = (a.i + 1) % a.b.length; y = o - w * 0.5; }
        this.prev = this.cur; this.cur = Math.round(y * 4096) / 4096;   // 12-bit delay memory
      }
      const s = (this.half ? this.prev : this.cur) * this.wet;
      oL[i] = s; oR[i] = -s * 0.9;
    }
  }
}
class LiveReverb {  // Freeverb-style stereo reverb with damping
  constructor() {
    const k = SR / 44100;
    const cd = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], ad = [556, 441, 341, 225];
    this.cl = cd.map(d => ({ b: new Float32Array(Math.round(d * k)), i: 0, f: 0 }));
    this.cr = cd.map(d => ({ b: new Float32Array(Math.round((d + 23) * k)), i: 0, f: 0 }));
    this.al = ad.map(d => ({ b: new Float32Array(Math.round(d * k)), i: 0 }));
    this.ar = ad.map(d => ({ b: new Float32Array(Math.round((d + 23) * k)), i: 0 }));
    this.fb = 0.84; this.damp = 0.3; this.wet = 0.33;
  }
  clear() { for (const c of [...this.cl, ...this.cr, ...this.al, ...this.ar]) { c.b.fill(0); c.f = 0; } }
  process(inp, oL, oR, n) {
    const fb = this.fb, d1 = this.damp, d2 = 1 - d1;
    for (let i = 0; i < n; i++) {
      const x = inp[i] * 0.03;
      let l = 0, r = 0;
      for (const c of this.cl) { const o = c.b[c.i]; c.f = o * d2 + c.f * d1; c.b[c.i] = x + c.f * fb; if (++c.i >= c.b.length) c.i = 0; l += o; }
      for (const c of this.cr) { const o = c.b[c.i]; c.f = o * d2 + c.f * d1; c.b[c.i] = x + c.f * fb; if (++c.i >= c.b.length) c.i = 0; r += o; }
      for (const a of this.al) { const o = a.b[a.i]; a.b[a.i] = l + o * 0.5; if (++a.i >= a.b.length) a.i = 0; l = o - l; }
      for (const a of this.ar) { const o = a.b[a.i]; a.b[a.i] = r + o * 0.5; if (++a.i >= a.b.length) a.i = 0; r = o - r; }
      oL[i] = l * this.wet * 8; oR[i] = r * this.wet * 8;
    }
  }
}
class Chorus {
  constructor(rate, depth) {
    this.n = Math.ceil(SR * 0.05); this.b = new Float32Array(this.n); this.i = 0;
    this.rate = rate; this.depth = depth; this.ph = 0;
  }
  clear() { this.b.fill(0); }
  process(inp, oL, oR, n) {
    const N = this.n;
    for (let i = 0; i < n; i++) {
      this.b[this.i] = inp[i];
      this.ph += this.rate / SR; if (this.ph >= 1) this.ph -= 1;
      const l = Math.sin(2 * Math.PI * this.ph), r = Math.sin(2 * Math.PI * (this.ph + 0.25));
      const dl = (0.012 + this.depth * l) * SR, dr = (0.012 + this.depth * r) * SR;
      oL[i] = this.tap(dl, N) * 0.9; oR[i] = this.tap(dr, N) * 0.9;
      if (++this.i >= N) this.i = 0;
    }
  }
  tap(d, N) {
    let p = this.i - d; while (p < 0) p += N;
    const ip = p | 0, fr = p - ip, j = (ip + 1) % N;
    return this.b[ip] + (this.b[j] - this.b[ip]) * fr;
  }
}

// ======================================================================
//  Synth / processor
// ======================================================================
const DEFAULT_MODS = [
  [0x0502, 48, 960, 0, 0],
  [0x0081, 6, 50, 0, 0],
  [0x000D, 6, 50, 0, 0],
  [0x0587, 48, 960, 0, 0],
  [0x058B, 48, 960, 0, 0],
  [0x028A, 17, 1000, 0, 0],
  [0x00DB, 16, 200, 0, 0],
  [0x00DD, 15, 200, 0, 0],
];

class BlastaProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = []; for (let i = 0; i < 16; i++) this.ch.push(new Chan(i));
    this.mute = new Uint8Array(16);
    this.meter = new Float32Array(16);
    this.defaultMods = DEFAULT_MODS;
    this.cores = [new OPLCore(this, 0), new OPLCore(this, 1), new SamplerCore(this, 2), new SamplerCore(this, 3)];
    this.target = [0, 1, 0, 0]; this.gain = [0, 1, 0, 0];
    this.awake = [false, true, false, false];
    this.q = []; this.qi = 0;
    this.master = 0.8;
    this.tL = new Float32Array(SUB); this.tR = new Float32Array(SUB);
    this.scope = new Float32Array(1024); this.si = 0; this.statN = 0;
    this.peak = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    switch (m.t) {
      case 'ev': {
        const ev = m.ev;
        // events: [frame, status, d1, d2]; keep queue sorted
        let sorted = true;
        const last = this.q.length ? this.q[this.q.length - 1][0] : -Infinity;
        for (const e of ev) { if (e[0] < last) sorted = false; this.q.push(e); }
        if (!sorted) { this.q = this.q.slice(this.qi); this.qi = 0; this.q.sort((a, b) => a[0] - b[0]); }
        break;
      }
      case 'now': for (const e of m.ev) this.midi(e[0], e[1], e[2]); break;
      case 'clearq': this.q = []; this.qi = 0; break;
      case 'era': this.setEra(m.v); break;
      case 'fmbank': this.cores[0].setBank(m.bank); this.cores[1].setBank(m.bank); break;
      case 'sfbank': this.cores[m.core].setBank(m.bank); break;
      case 'mute': this.mute.set(m.v); for (let c = 0; c < 16; c++) { this.cores[0].ctrl(c); this.cores[1].ctrl(c); } break;
      case 'master': this.master = m.v; break;
      case 'analog': this.cores[0].analog = this.cores[1].analog = m.v; break;
      case 'panic': this.panic(); break;
      case 'reset': this.panic(); for (const c of this.ch) c.reset(); break;
      case 'ping': this.port.postMessage({ t: 'pong', id: m.id }); break;
    }
  }

  setEra(e) {
    for (let i = 0; i < 4; i++) {
      const d = Math.abs(e - i);
      this.target[i] = d >= 1 ? 0 : Math.pow(Math.cos(d * Math.PI / 2), 1.5);  // between equal-power and linear
    }
  }

  panic() {
    for (const k of this.cores) k.reset();
    for (const c of this.ch) { c.sustain = false; }
    this.q = []; this.qi = 0;
  }

  midi(st, d1, d2) {
    const type = st & 0xf0, c = st & 15, ch = this.ch[c];
    const cores = this.cores;
    switch (type) {
      case 0x90:
        if (d2 > 0) { for (let i = 0; i < 4; i++) if (this.target[i] > 0 || this.gain[i] > 0.001) cores[i].noteOn(c, d1, d2); break; }
      // fallthrough: velocity 0 = note off
      case 0x80: for (const k of cores) k.noteOff(c, d1); break;
      case 0xB0: this.cc(c, d1, d2); break;
      case 0xC0: ch.program = d1; break;
      case 0xD0: ch.pressure = d1 / 127; for (const k of cores) k.ctrl(c); break;
      case 0xE0: ch.bend = (((d2 << 7) | d1) - 8192) / 8192; for (const k of cores) k.pitch(c); break;
      case 0xF0: // private tokens: 0xFF = GM/GS reset, 0xFE = set drum part
        if (st === 0xFF) { for (const x of this.ch) x.reset(); for (const k of cores) k.reset(); }
        else if (st === 0xFE) { this.ch[d1 & 15].drum = !!d2; }
        break;
    }
  }

  cc(c, n, v) {
    const ch = this.ch[c];
    ch.cc[n] = v;
    switch (n) {
      case 0: ch.bank = v; if (c === 9) ch.drum = true; break;
      case 6: if (ch.rpnM === 0 && ch.rpnL === 0) { ch.bendRange = v; for (const k of this.cores) k.pitch(c); } break;
      case 38: if (ch.rpnM === 0 && ch.rpnL === 0) { ch.bendRange = Math.floor(ch.bendRange) + v / 100; } break;
      case 101: ch.rpnM = v; break;
      case 100: ch.rpnL = v; break;
      case 98: case 99: ch.rpnM = ch.rpnL = 127; break;
      case 64: {
        const s = v >= 64;
        if (ch.sustain && !s) for (const k of this.cores) k.sustainOff(c);
        ch.sustain = s; break;
      }
      case 120: for (const k of this.cores) k.allOff(c, true); break;
      case 121: { const b = ch.bank, p = ch.program, d = ch.drum; ch.reset(); ch.bank = b; ch.program = p; ch.drum = d; for (const k of this.cores) k.ctrl(c); break; }
      case 123: case 124: case 125: case 126: case 127: for (const k of this.cores) k.allOff(c, false); break;
      default: for (const k of this.cores) k.ctrl(c);
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    const tL = this.tL, tR = this.tR;
    for (let s0 = 0; s0 < n; s0 += SUB) {
      const fEnd = currentFrame + s0 + SUB;
      const q = this.q;
      while (this.qi < q.length && q[this.qi][0] < fEnd) { const e = q[this.qi++]; this.midi(e[1], e[2], e[3]); }
      if (this.qi > 4096) { this.q = q.slice(this.qi); this.qi = 0; }
      for (let i = 0; i < SUB; i++) { L[s0 + i] = 0; R[s0 + i] = 0; }
      for (let k = 0; k < 4; k++) {
        const g0 = this.gain[k], g1 = this.target[k];
        const gNew = g0 + (g1 - g0) * 0.08;
        const gEnd = Math.abs(gNew - g1) < 0.0005 ? g1 : gNew;
        if (g0 <= 0 && gEnd <= 0) {
          if (this.awake[k]) { this.cores[k].reset(); this.awake[k] = false; }
          this.gain[k] = 0; continue;
        }
        this.awake[k] = true;
        this.cores[k].render(tL, tR, SUB);
        const gs = (gEnd - g0) / SUB;
        let g = g0;
        for (let i = 0; i < SUB; i++) { g += gs; L[s0 + i] += tL[i] * g; R[s0 + i] += tR[i] * g; }
        this.gain[k] = gEnd;
      }
      const m = this.master;
      for (let i = s0; i < s0 + SUB; i++) {
        let l = L[i] * m, r = R[i] * m;
        l = l > 1 ? 1 : l < -1 ? -1 : l; r = r > 1 ? 1 : r < -1 ? -1 : r;
        L[i] = l; R[i] = r;
        const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r); if (a > this.peak) this.peak = a;
        this.scope[this.si] = (l + r) * 0.5; this.si = (this.si + 1) & 1023;
      }
    }
    if (++this.statN >= 12) {
      this.statN = 0;
      const sc = new Float32Array(512);
      for (let i = 0; i < 512; i++) sc[i] = this.scope[(this.si - 512 + i + 1024) & 1023];
      this.port.postMessage({
        t: 'stat', scope: sc, meter: Array.from(this.meter), peak: this.peak,
        voices: this.cores.map((k, i) => this.awake[i] ? k.activeCount() : -1),
        programs: this.ch.map(c => c.program), banks: this.ch.map(c => c.bank),
      });
      this.meter.fill(0); this.peak = 0;
    } else {
      for (let i = 0; i < 16; i++) this.meter[i] *= 0.999;
    }
    return true;
  }
}

registerProcessor('blasta', BlastaProcessor);
