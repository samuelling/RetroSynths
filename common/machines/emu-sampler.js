/*
 * AWE32 (E-mu EMU8000) / Sound Blaster Live! (E-mu EMU10K1) machine core — SoundFont wavetable engine with
 * each card's character, ported from Blasta's SamplerCore:
 *   AWE32: 30 voices, linear interpolation, SF2.0 default modulators only, gritty half-rate 12-bit reverb, chorus
 *   Live!: 64 voices, 8-point windowed-sinc interpolation, the bank's own SF2.01 modulators, stereo reverb, chorus
 * The bank (a SoundFont, ROM-budget squeezed per era by <id>.prep.js) arrives through setData(). Instruments are
 * the bank's own presets with generator overrides (emu-presets.js); MIDI channels map to them through the
 * Arranger, or Auto: bank:program with the GM fallback chain (drums: kit by program).
 */
import { resolveMelodic, resolveKit, applyOverrides } from './emu-presets.js';

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

const DEFAULT_MODS = [
  [0x0502, 48, 960, 0, 0], [0x0081, 6, 50, 0, 0], [0x000D, 6, 50, 0, 0], [0x0587, 48, 960, 0, 0],
  [0x058B, 48, 960, 0, 0], [0x028A, 17, 1000, 0, 0], [0x00DB, 16, 200, 0, 0], [0x00DD, 15, 200, 0, 0],
];
const SUB = 32;

class SVoice {
  constructor(slot) {
    this.slot = slot; this.active = false; this.dyn = new Float64Array(61); this.z = null; this.idx = -1; this.age = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
}

// ---------------- card effects ----------------
// AWE32 reverb types: half-rate Schroeder network with 12-bit delay memory (lengths/feedback per type);
// 'hall1' is the original Blasta setting.
export const AWE_REVERBS = {
  room1: { len: 0.55, fb: 0.70, wet: 0.50 }, room2: { len: 0.65, fb: 0.75, wet: 0.52 }, room3: { len: 0.78, fb: 0.78, wet: 0.54 },
  hall1: { len: 1.00, fb: 0.83, wet: 0.55 }, hall2: { len: 1.18, fb: 0.86, wet: 0.55 }, plate: { len: 0.85, fb: 0.85, wet: 0.6, bright: 1 },
  delay: { echo: 0.25, fb: 0.45, wet: 0.5 }, pandelay: { echo: 0.3, fb: 0.5, wet: 0.5, pan: 1 },
};
export const AWE_CHORUSES = {
  chorus1: { rate: 0.4, depth: 0.002 }, chorus2: { rate: 0.5, depth: 0.003 }, chorus3: { rate: 0.55, depth: 0.0035 }, chorus4: { rate: 0.8, depth: 0.005 },
  feedback: { rate: 0.3, depth: 0.004, fb: 0.5 }, flanger: { rate: 0.2, depth: 0.0015, base: 0.003, fb: 0.6 },
  short: { rate: 0, depth: 0, base: 0.015 }, shortfb: { rate: 0, depth: 0, base: 0.015, fb: 0.55 },
};
export const LIVE_REVERBS = {
  hall: { fb: 0.84, damp: 0.3, wet: 0.33 }, room: { fb: 0.74, damp: 0.45, wet: 0.3 }, plate: { fb: 0.8, damp: 0.12, wet: 0.36 },
  cathedral: { fb: 0.9, damp: 0.25, wet: 0.34 }, off: { fb: 0, damp: 0, wet: 0 },
};
class AWEReverb {   // metallic Schroeder-style reverb, run at half rate like a budget DSP
  constructor(SR) { this.SR = SR; this.set('hall1'); }
  set(type) {
    const t = AWE_REVERBS[type] || AWE_REVERBS.hall1, k = this.SR / 44100 / 2;
    this.t = t;
    if (t.echo) {
      this.combs = [{ b: new Float32Array(Math.max(1, Math.round(t.echo * this.SR / 2))), i: 0 }];
      if (t.pan) this.combs.push({ b: new Float32Array(Math.max(1, Math.round(t.echo * this.SR / 2))), i: 0 });
      this.aps = [];
    } else {
      this.combs = [1116, 1188, 1277, 1356].map(d => ({ b: new Float32Array(Math.max(1, Math.round(d * k * t.len))), i: 0 }));
      this.aps = [556, 225].map(d => ({ b: new Float32Array(Math.max(1, Math.round(d * k * (t.bright ? 0.6 : 1)))), i: 0 }));
    }
    this.half = 0; this.acc = 0; this.prev = 0; this.cur = 0; this.prevR = 0; this.curR = 0; this.wet = t.wet; this.fb = t.fb;
  }
  clear() { for (const c of this.combs) c.b.fill(0); for (const a of this.aps) a.b.fill(0); this.prev = this.cur = this.prevR = this.curR = 0; }
  process(inp, oL, oR, n) {
    const echo = !!this.t.echo, pan = !!this.t.pan, fb = this.fb;
    for (let i = 0; i < n; i++) {
      this.acc += inp[i];
      if (++this.half === 2) {
        const x = this.acc * 0.5; this.acc = 0; this.half = 0;
        let y = 0, yr = 0;
        if (echo) {
          const c = this.combs[0], o = c.b[c.i];
          if (pan) { const d = this.combs[1], o2 = d.b[d.i]; c.b[c.i] = x + o2 * fb; d.b[d.i] = o * fb; d.i = (d.i + 1) % d.b.length; y = o; yr = o2; }
          else { c.b[c.i] = x + o * fb; y = o; yr = o; }
          c.i = (c.i + 1) % c.b.length;
        } else {
          for (const c of this.combs) { const o = c.b[c.i]; c.b[c.i] = x + o * fb; c.i = (c.i + 1) % c.b.length; y += o; }
          y *= 0.25;
          for (const a of this.aps) { const o = a.b[a.i]; const w = y + o * 0.5; a.b[a.i] = w; a.i = (a.i + 1) % a.b.length; y = o - w * 0.5; }
          yr = -y * 0.9;
        }
        this.prev = this.cur; this.cur = Math.round(y * 4096) / 4096;   // 12-bit delay memory
        this.prevR = this.curR; this.curR = Math.round(yr * 4096) / 4096;
      }
      oL[i] = (this.half ? this.prev : this.cur) * this.wet; oR[i] = (this.half ? this.prevR : this.curR) * this.wet;
    }
  }
}
class LiveReverb {  // Freeverb-style stereo reverb with damping
  constructor(SR) {
    const k = SR / 44100;
    const cd = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], ad = [556, 441, 341, 225];
    this.cl = cd.map(d => ({ b: new Float32Array(Math.round(d * k)), i: 0, f: 0 }));
    this.cr = cd.map(d => ({ b: new Float32Array(Math.round((d + 23) * k)), i: 0, f: 0 }));
    this.al = ad.map(d => ({ b: new Float32Array(Math.round(d * k)), i: 0 }));
    this.ar = ad.map(d => ({ b: new Float32Array(Math.round((d + 23) * k)), i: 0 }));
    this.set('hall');
  }
  set(type) { const t = LIVE_REVERBS[type] || LIVE_REVERBS.hall; this.fb = t.fb; this.damp = t.damp; this.wet = t.wet; }
  clear() { for (const c of [...this.cl, ...this.cr, ...this.al, ...this.ar]) { c.b.fill(0); c.f = 0; } }
  process(inp, oL, oR, n) {
    const fb = this.fb, d1 = this.damp, d2 = 1 - d1;
    if (!this.wet) { oL.fill(0, 0, n); oR.fill(0, 0, n); return; }
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
  constructor(SR, rate, depth) {
    this.SR = SR; this.n = Math.ceil(SR * 0.05); this.b = new Float32Array(this.n); this.i = 0;
    this.rate = rate; this.depth = depth; this.base = 0.012; this.fb = 0; this.ph = 0; this.lastL = 0;
  }
  set(t) { this.rate = t.rate; this.depth = t.depth; this.base = t.base || 0.012; this.fb = t.fb || 0; }
  clear() { this.b.fill(0); this.lastL = 0; }
  process(inp, oL, oR, n) {
    const N = this.n, SR = this.SR;
    for (let i = 0; i < n; i++) {
      this.b[this.i] = inp[i] + this.lastL * this.fb;
      this.ph += this.rate / SR; if (this.ph >= 1) this.ph -= 1;
      const l = Math.sin(2 * Math.PI * this.ph), r = Math.sin(2 * Math.PI * (this.ph + 0.25));
      const dl = (this.base + this.depth * l) * SR, dr = (this.base + this.depth * r) * SR;
      const a = this.tap(dl, N), b = this.tap(dr, N);
      this.lastL = a;
      oL[i] = a * 0.9; oR[i] = b * 0.9;
      if (++this.i >= N) this.i = 0;
    }
  }
  tap(d, N) {
    let p = this.i - d; while (p < 0) p += N;
    const ip = p | 0, fr = p - ip, j = (ip + 1) % N;
    return this.b[ip] + (this.b[j] - this.b[ip]) * fr;
  }
}

export class EmuMachine {
  constructor(host, kind) {
    this.h = host; this.kind = kind;            // 2 = AWE32, 3 = Live!
    this.SR = host.sampleRate; this.DT = SUB / this.SR;
    this.max = kind === 2 ? 30 : 64;
    this.interp = kind === 2 ? 1 : 3;            // 1 linear, 3 sinc8
    this.useZoneMods = kind === 3;               // EMU8000 era: SF2.0, default modulators only
    this.voices = []; for (let i = 0; i < this.max + 8; i++) this.voices.push(new SVoice(i));
    this.bank = null; this.pool = null; this.list = []; this.keyIdx = new Map(); this.age = 0; this.bankKey = null;
    this.rev = kind === 2 ? new AWEReverb(this.SR) : new LiveReverb(this.SR);
    this.cho = new Chorus(this.SR, kind === 2 ? 0.55 : 0.4, kind === 2 ? 0.0035 : 0.0028);
    this.rbuf = new Float32Array(SUB); this.cbuf = new Float32Array(SUB);
    this.revL = new Float32Array(SUB); this.revR = new Float32Array(SUB);
    this.choL = new Float32Array(SUB); this.choR = new Float32Array(SUB);
    this.scale = kind === 2 ? 1.3 : 1.2;
    this.table = []; this.arr = Array.from({ length: 16 }, () => ({ inst: -1, voice: 'auto' }));
    this.kit = {}; this.vmute = new Uint8Array(this.max); this.pinned = new Set(); this.zcache = new Map(); this.byKey = new Map();
    this.vs = new Float32Array(this.max * 4);
  }

  // ---------------------------------------------------------------- v2 interface
  setData(d) {
    if (!d) return;
    if (d.same || !d.bank) return;                       // unchanged bank: keep what we have
    if (d.key === this.bankKey && this.bank) return;
    this.reset();
    this.bank = d.bank; this.pool = d.bank.pool; this.bankKey = d.key; this.list = d.list || [];
    this.zcache.clear(); this.indexTable();
  }
  setInstruments(list) { if (Array.isArray(list)) { this.table = list; this.zcache.clear(); this.indexTable(); } }
  updateInstrument(i, inst) {
    if (!inst) return;
    this.table[i] = inst; this.zcache.delete(i); this.indexTable();
    for (const v of this.voices) if (v.active && v.idx === i) this.evalMods(v);   // level/pan/send changes are heard at once
  }
  indexTable() { this.byKey.clear(); this.table.forEach((t, i) => { if (t && !t.user && !this.byKey.has(this.keyOf(t))) this.byKey.set(this.keyOf(t), i); }); }
  keyOf(t) { return (t.bank >= 128 ? 128 : t.bank) * 128 + (t.program & 127); }
  setArrangement(arr) {
    if (!Array.isArray(arr)) return;
    this.arr = Array.from({ length: 16 }, (_, c) => arr[c] ? { inst: arr[c].inst | 0, voice: arr[c].voice || 'auto' } : { inst: -1, voice: 'auto' });
    this.pinned = new Set(this.arr.map(a => this.voiceIndex(a.voice)).filter(i => i >= 0));
  }
  setKit(kit) { this.kit = kit && typeof kit === 'object' ? kit : {}; }
  setVoiceMute(mask) {
    this.vmute.fill(0);
    if (Array.isArray(mask)) { for (const i of mask) if (i >= 0 && i < this.max) this.vmute[i] = 1; }
    else for (let i = 0; i < Math.min(31, this.max); i++) if (mask & (1 << i)) this.vmute[i] = 1;
  }
  isMuted(slot) { return slot < this.max && this.vmute[slot] === 1; }
  voiceIndex(id) { const m = /^v(\d+)$/.exec(id || ''); const i = m ? +m[1] - 1 : -1; return i >= 0 && i < this.max ? i : -1; }
  voiceState() {
    const vs = this.vs;
    for (let i = 0; i < this.max; i++) {
      const v = this.voices[i], k = i * 4;
      if (!v.active || v.dying) { vs[k] = 0; vs[k + 1] = -1; vs[k + 2] = -1; vs[k + 3] = -1; continue; }
      vs[k] = v.envG * Math.pow(10, -Math.max(0, v.dyn[48]) / 200); vs[k + 1] = v.ch; vs[k + 2] = v.note; vs[k + 3] = v.idx;
    }
    return vs;
  }
  setOption(key, value) {
    if (key === 'reverb') { this.rev.set(value); this.rev.clear && this.rev.clear(); }
    else if (key === 'chorus' && AWE_CHORUSES[value]) this.cho.set(AWE_CHORUSES[value]);
  }
  reset() { for (const v of this.voices) v.active = false; this.rev.clear(); this.cho.clear(); }
  activeCount() { let n = 0; for (const v of this.voices) if (v.active && !v.dying) n++; return n; }
  maxVoices() { return this.max; }

  /** which preset (bank key) and instrument table entry a note uses */
  lookup(c, note) {
    const a = this.arr[c], ch = this.h.ch[c], P = this.bank.presets;
    let idx = -1, key = -1;
    const fromTable = (i) => { const t = this.table[i]; if (!t) return false; idx = i; key = this.keyOf(t); if (!P[key]) { const r = t.bank >= 128 ? resolveKit(this.list, t.program) : resolveMelodic(this.list, t.bank, t.program); key = r >= 0 ? this.keyOf({ bank: this.list[r][0], program: this.list[r][1] }) : -1; } return true; };
    if (a && a.inst >= 0 && fromTable(a.inst)) return { idx, key };
    if (ch.drum) {
      const k = this.kit[note];
      if (k != null && k >= 0 && fromTable(k)) return { idx, key };
      const r = resolveKit(this.list, ch.program);
      if (r < 0) return { idx: -1, key: -1 };
      key = 128 * 128 + this.list[r][1];
    } else {
      const r = resolveMelodic(this.list, ch.bank, ch.program);
      if (r < 0) return { idx: -1, key: -1 };
      key = this.list[r][0] * 128 + this.list[r][1];
    }
    idx = this.byKey.has(key) ? this.byKey.get(key) : -1;
    return { idx, key };
  }
  zonesOf(idx, key) {
    const base = this.bank.presets[key];
    if (!base) return null;
    const t = idx >= 0 ? this.table[idx] : null;
    const hasOv = t && ((t.ov && Object.keys(t.ov).length) || (t.zov && Object.keys(t.zov).length));
    if (!hasOv) return base;
    const ck = idx + ':' + key;
    let z = this.zcache.get(idx);
    if (z && z.ck === ck) return z.zones;
    const zones = base.map((zz, i) => {
      const g = applyOverrides(zz.g, t.ov, t.zov && t.zov[i]);
      const root = g[58] >= 0 ? g[58] : zz.root;
      return { ...zz, g, root };
    });
    this.zcache.set(idx, { ck, zones });
    return zones;
  }

  alloc(pin) {
    if (pin >= 0) { const v = this.voices[pin]; return v; }
    let n = 0;
    for (const v of this.voices) if (v.active && !v.dying) n++;
    if (n >= this.max) {               // steal: oldest released, else oldest
      let best = null, ba = Infinity;
      for (const v of this.voices) if (v.active && !v.dying && v.vs === 5 && v.age < ba && !this.pinned.has(v.slot)) { best = v; ba = v.age; }
      if (!best) for (const v of this.voices) if (v.active && !v.dying && v.age < ba && !this.pinned.has(v.slot)) { best = v; ba = v.age; }
      if (best) best.dying = true;
    }
    for (const v of this.voices) if (!v.active && !this.pinned.has(v.slot)) return v;
    // all slots busy (dying voices): take the oldest outright
    let best = this.voices[0];
    for (const v of this.voices) if (v.age < best.age && !this.pinned.has(v.slot)) best = v;
    return best;
  }

  noteOn(c, note, vel) {
    if (!this.bank) return;
    const { idx, key } = this.lookup(c, note);
    if (key < 0) return;
    const list = this.zonesOf(idx, key);
    if (!list) return;
    const pinId = this.voiceIndex(this.arr[c] && this.arr[c].voice);
    let first = true;
    for (const z of list) {
      if (!(note >= z.kl && note <= z.kh && vel >= z.vl && vel <= z.vh)) continue;
      const g = z.g;
      if (g[57]) for (const o of this.voices)   // exclusive class (e.g. hi-hats)
        if (o.active && o.ch === c && o.z.g[57] === g[57] && o.note !== note) o.dying = true;
      const v = this.alloc(first ? pinId : -1); first = false;
      v.active = true; v.dying = false; v.z = z; v.ch = c; v.note = note; v.age = ++this.age; v.idx = idx;
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

  release(v) { v.on = false; v.sus = false; v.offTick = this.tick; this.dropDeferred(v); this.w(v.hi + 0xB0 + v.ch, (v.block << 2) | (v.fnum >> 8)); }
  dropDeferred(v) { if (this.deferred.length) this.deferred = this.deferred.filter(d => d[0] !== v); }
  evalMods(v) {
    const z = v.z, g = z.g, d = v.dyn, ch = this.h.ch[v.ch];
    for (let i = 0; i < 61; i++) d[i] = g[i];
    d[48] = g[48] * 0.4;                        // EMU hardware attenuation scaling
    const mods = this.useZoneMods ? z.mods : DEFAULT_MODS;
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
    const ch = this.h.ch[c];
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
      case 0: v.vt += this.DT; v.envG = 0; if (v.vt >= v.vDelay) { v.vs = 1; v.vt = 0; } break;
      case 1: v.vt += this.DT; v.envG = v.vAttack > 0.0011 ? Math.min(1, v.vt / v.vAttack) : 1;
        if (v.envG >= 1) { v.vs = 2; v.vt = 0; v.vAtt = 0; } break;
      case 2: v.vt += this.DT; v.envG = 1; if (v.vt >= v.vHold) { v.vs = 3; v.vt = 0; } break;
      case 3: v.vAtt += 100 * this.DT / Math.max(0.001, v.vDecay);
        if (v.vAtt >= v.vSus) { v.vAtt = v.vSus; v.vs = 4; }
        v.envG = Math.pow(10, -v.vAtt / 20); break;
      case 4: v.envG = Math.pow(10, -v.vSus / 20); if (v.vSus >= 99) v.active = false; break;
      case 5: v.vAtt += 100 * this.DT / v.vRel; v.envG = Math.pow(10, -v.vAtt / 20);
        if (v.vAtt >= 96) v.active = false; break;
    }
    switch (v.ms) {
      case 0: v.mt += this.DT; v.mVal = 0; if (v.mt >= v.mDelay) { v.ms = 1; v.mt = 0; } break;
      case 1: v.mt += this.DT; v.mVal = v.mAttack > 0.0011 ? Math.min(1, v.mt / v.mAttack) : 1; if (v.mVal >= 1) { v.ms = 2; v.mt = 0; } break;
      case 2: v.mt += this.DT; v.mVal = 1; if (v.mt >= v.mHold) { v.ms = 3; v.mt = 0; } break;
      case 3: v.mVal -= this.DT / Math.max(0.001, v.mDecay); if (v.mVal <= v.mSus) { v.mVal = v.mSus; v.ms = 4; } break;
      case 4: break;
      case 5: v.mVal -= this.DT / Math.max(0.001, v.mRel); if (v.mVal < 0) v.mVal = 0; break;
    }
  }

  render(oL, oR, n) {
    oL.fill(0); oR.fill(0);
    this.DT = n / this.SR;
    const rb = this.rbuf, cb = this.cbuf; rb.fill(0); cb.fill(0);
    if (!this.pool) return;
    const pool = this.pool, mute = this.h.mute, met = this.h.meter;
    const interp = this.interp;
    for (const v of this.voices) {
      if (!v.active) continue;
      const z = v.z, d = v.dyn, g = z.g, ch = this.h.ch[v.ch];
      this.stepEnv(v);
      v.t += this.DT;
      // LFOs (triangle)
      let vib = 0, mod = 0;
      if (v.t > v.vibD) { v.vibPh += v.vibF * this.DT; vib = 1 - 4 * Math.abs((v.vibPh % 1) - 0.5); }
      if (v.t > v.modD) { v.modPh += v.modF * this.DT; mod = 1 - 4 * Math.abs((v.modPh % 1) - 0.5); }
      // pitch
      const cents = (v.key - z.root) * d[56] + d[51] * 100 + d[52] - z.corr
        + ch.bend * ch.bendRange * 100 + vib * d[6] + mod * d[5] + v.mVal * g[7];
      const inc = Math.pow(2, cents / 1200) * z.sr / this.SR;
      // gain
      let att = d[48] + mod * d[13];
      if (att < 0) att = 0;
      let gain = v.envG * Math.pow(10, -att / 200) * this.scale;
      if (v.dying) gain = 0;
      if (mute[v.ch] || this.isMuted(v.slot)) gain = 0;
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
        let hz = cents2hz(fc); if (hz > this.SR * 0.45) hz = this.SR * 0.45; if (hz < 20) hz = 20;
        const qdb = Math.max(0, d[9] / 10);
        const Q = Math.max(0.5, Math.pow(10, qdb / 20) * 0.7071);
        const w = 2 * Math.PI * hz / this.SR, cw = Math.cos(w), al = Math.sin(w) / (2 * Q);
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
