// Atari 400/800 — POKEY driven by a frame-rate music driver.
//
// Voice layout (default "16-bit melody"): channels 1+2 are joined into one 16-bit divider clocked at
// 1.79 MHz for an in-tune melody voice; channel 3 and 4 are two 8-bit 64 kHz voices (bass in the
// classic poly4 "distortion C" buzz, drums from the free-running 17-bit poly). When a song leaves
// channels 3/4 idle of drums and harmony for a while, the driver joins them too for a 16-bit bass and
// splits them again on demand — trading voices for tuning, as POKEY composers did.
// Options: 4 × 8-bit voices (64 kHz, coarse tuning), or a high-pass "filter lead" where channel 4
// clocks the ch2 high-pass flip-flop slightly off the melody pitch for a sweeping pulse timbre.
// Original code for RetroSynths.
import { Resampler, DCBlock, drumKind, TOM_NOTE } from './util.js';
import { POKEY, POKEY_CLOCK, POKEY_CHUNK, POKEY_RATE, POKEY_FRAME_CYCLES } from './pokey.js';
import { Driver, DRUM_PRIO, gcd } from './atari-driver.js';

const CLK = POKEY_CLOCK, BASE64 = 28;
const PURE = 0xA0, BUZZ = 0xC0, NOISE = 0x80, GRIT = 0x20;   // AUDC distortion bits
const DIST = {
  saw: BUZZ, brass: BUZZ, dist: BUZZ, synbass: BUZZ, hit: BUZZ, clav: BUZZ, string: BUZZ, reed: BUZZ,
};
const NOISE_N = { hiss: 2, sea: 6, heli: 60, applause: 1, gun: 12, fret: 0, breath: 3, cymbal: 0 };

/** Nearest integer ≥ lo to x with gcd(p, 15) = 1 (poly4 decimation stays a 15-step m-sequence). */
function coprime15(x, lo, hi) {
  const r = Math.round(x);
  for (let d = 0; d < 8; d++) {
    for (const p of [r - d, r + d]) if (p >= lo && p <= hi && gcd(p, 15) === 1) return p;
  }
  return Math.max(lo, Math.min(hi, r));
}
/** 16-bit 1.79 MHz pair → AUDF value for a tone. */
export function n16(dist, hz) {
  if (dist === BUZZ) return coprime15(CLK / (15 * hz), 7, 65542) - 7;
  return Math.max(0, Math.min(65535, Math.round(CLK / (2 * hz)) - 7));
}
/** 8-bit 64 kHz channel → [dist, AUDF]; pure tones too low for 8 bits fall back to distortion C. */
export function n8(dist, hz) {
  if (dist === PURE || dist === GRIT) {
    const n1 = Math.round(CLK / (BASE64 * 2 * hz));
    if (n1 <= 256) return [dist, Math.max(0, n1 - 1)];
    dist = BUZZ;
  }
  return [dist, coprime15(CLK / (BASE64 * 15 * hz), 1, 256) - 1];
}
export const hz16 = (dist, n) => dist === BUZZ ? CLK / (15 * (n + 7)) : CLK / (2 * (n + 7));
export const hz8 = (dist, n) => dist === BUZZ ? CLK / (BASE64 * 15 * (n + 1)) : CLK / (BASE64 * 2 * (n + 1));

// ---- drums: per-frame [dist, value, level]; value = Hz for tones, 64 kHz AUDF for noise ----
const dec = (d, v, l0, n, k = 0.72, dv = 0) => Array.from({ length: n }, (_, i) => [d, v + dv * i, l0 * Math.pow(k, i)]);
function drumMacro(note) {
  const kind = drumKind(note);
  let fr;
  switch (kind) {
    case 'kick': fr = [[NOISE, 40, 1], [BUZZ, 110, 0.95], [BUZZ, 82, 0.85], [BUZZ, 66, 0.72], [BUZZ, 56, 0.58], [BUZZ, 50, 0.44], [BUZZ, 46, 0.3], [BUZZ, 44, 0.18], [BUZZ, 42, 0.09]];
      if (note === 35) fr = fr.map(([d, v, l]) => [d, d === BUZZ ? v * 0.85 : v, l]); break;
    case 'snare': fr = [[PURE, 200, 0.9], ...dec(NOISE, 6, 0.95, 9, 0.72, 1)]; if (note === 40) fr[0] = [NOISE, 2, 1]; break;
    case 'clap': fr = [[NOISE, 4, 0.9], [NOISE, 4, 0.25], [NOISE, 4, 0.85], [NOISE, 4, 0.25], ...dec(NOISE, 5, 0.75, 7, 0.68)]; break;
    case 'stick': fr = [[NOISE, 0, 1], [PURE, 1800, 0.7], [PURE, 1800, 0.35]]; break;
    case 'hatClosed': fr = [[NOISE, 0, 0.85], [NOISE, 0, 0.45], [NOISE, 0, 0.18]]; break;
    case 'hatPedal': fr = [[NOISE, 0, 0.7], [NOISE, 0, 0.35], [NOISE, 0, 0.14]]; break;
    case 'hatOpen': fr = dec(NOISE, 0, 0.55, 18, 0.86); break;
    case 'crash': fr = dec(NOISE, 1, 0.85, 48, 0.94); if (note === 55) fr = dec(NOISE, 0, 0.75, 26, 0.9); break;
    case 'ride': fr = [[PURE, 2600, 0.4], ...dec(NOISE, 0, 0.38, 24, 0.9)]; break;
    case 'bell': fr = dec(PURE, 1750, 0.7, 22, 0.88); break;
    case 'shaker': fr = [[NOISE, 0, 0.28], [NOISE, 0, 0.36], [NOISE, 0, 0.2], [NOISE, 0, 0.08]]; break;
    case 'cowbell': fr = dec(PURE, note === 56 ? 800 : note === 67 ? 1100 : 850, 0.8, 9, 0.75); break;
    case 'triangle': fr = dec(PURE, 3100, 0.55, note === 81 ? 36 : 6, note === 81 ? 0.93 : 0.7); break;
    case 'block': fr = dec(PURE, note === 76 ? 1900 : note === 77 ? 1300 : 1600, 0.75, 3, 0.4); break;
    case 'tom': { const f = 440 * Math.pow(2, ((TOM_NOTE[note] || 48) - 69) / 12); fr = Array.from({ length: 12 }, (_, i) => [PURE, f * Math.pow(0.965, i), Math.pow(0.78, i)]); break; }
    case 'conga': { const f = 440 * Math.pow(2, ((TOM_NOTE[note] || 64) - 69) / 12); fr = dec(PURE, f, 0.85, 6, 0.65); break; }
    default:
      if (note === 58) fr = dec(GRIT, 900, 0.7, 20, 0.88);
      else if (note === 71 || note === 72) fr = Array.from({ length: note === 72 ? 18 : 8 }, () => [PURE, note === 71 ? 2600 : 2300, 0.5]);
      else if (note === 73 || note === 74) fr = Array.from({ length: note === 74 ? 14 : 6 }, (_, i) => [NOISE, 6, i & 1 ? 0.1 : 0.55]);
      else if (note === 78 || note === 79) fr = Array.from({ length: 8 }, (_, i) => [PURE, (note === 78 ? 600 : 900) * Math.pow(1.05, i), 0.7 * Math.pow(0.8, i)]);
      else fr = dec(PURE, 440 * Math.pow(2, (note - 69) / 12), 0.7, 6, 0.7);
  }
  return { kind, prio: DRUM_PRIO[kind] ?? 46, len: fr.length, fr, choke: kind.startsWith('hat') ? 'hat' : null };
}

export default class Atari800 extends Driver {
  static info = {
    id: 'atari800', name: 'Atari 800', maker: 'Atari', year: 1979,
    chip: 'POKEY (C012294)', voices: '4 × 8-bit dividers · joinable 16-bit · 4/5/17-bit polys',
    spec: 'POKEY at 1.79 MHz: 16-bit melody pair + 8-bit bass/drums, distortion C buzz, poly17 noise',
  };
  static options = [
    { key: 'voices', label: 'Voices', choices: [['16', '16-bit melody + 8-bit'], ['8', '4 × 8-bit (64 kHz)']], default: '16' },
    { key: 'hpf', label: 'High-pass lead', choices: [[false, 'Off'], [true, 'On (ch2 by ch4)']], default: false },
  ];

  constructor(host) {
    super(host, 4, POKEY_CLOCK / POKEY_FRAME_CYCLES);
    this.pk = new POKEY();
    this.rs = new Resampler(POKEY_RATE, host.sampleRate);
    this.dc = new DCBlock(host.sampleRate, 12);
    this.fcyc = 0; this.gain = 1.5 / 60;
    this.cfg8 = false; this.hpf = false; this.joinY = false; this.demandF = -1e9;
    this.reg = new Int16Array(10).fill(-1);
    this.drums = {};
    for (let n = 27; n <= 87; n++) this.drums[n] = drumMacro(n);
    this.melOrder = [0, 1, 2, 3]; this.bassOrder = [1, 2, 3, 0]; this.drumOrder = [2, 3, 1, 0]; this.drum8 = [3, 2, 1, 0];
    this.applyConfig();
  }
  setOption(key, value) {
    if (key === 'voices') this.cfg8 = value === '8';
    else if (key === 'hpf') this.hpf = !!value;
    else return;
    this.reset();
  }
  maxVoices() { return this.cfg8 ? 4 : this.hpf ? 2 : 3; }
  reset() { this.resetDriver(); this.pk.reset(); this.reg.fill(-1); this.joinY = false; this.demandF = -1e9; this.applyConfig(); }

  w(r, v) { if (this.reg[r] !== v) { this.reg[r] = v; this.pk.write(r, v); } }
  applyConfig() {
    this.w(8, this.cfg8 ? 0x00 : 0x50 | (this.joinY ? 0x28 : 0) | (this.hpf ? 0x02 : 0));
    for (let i = 0; i < 4; i++) this.w(i * 2 + 1, 0);        // all quiet; owners get rewritten
  }
  drumFor(note) { return this.drums[note] || this.drums[Math.max(27, Math.min(87, note))]; }
  allowed(vi) {
    if (this.cfg8) return true;
    if (this.hpf) return vi <= 1;
    return vi <= 1 || (vi === 2 && !this.joinY);
  }
  prefer(vn) {
    if (vn.isDrum) return this.cfg8 ? this.drum8 : this.drumOrder;
    return vn.role === 'bass' || vn.role === 'low' ? this.bassOrder : this.melOrder;
  }
  strict(vn) { return vn.role === 'lead'; }

  // demand for the 3rd voice (drums or harmony) → keep channels 3/4 split
  preAssign() {
    if (this.cfg8 || this.hpf) return;
    let wanted = 0, drum = false;
    for (const vn of this.pool) if (vn.active && vn.amp > 0.003) { wanted++; if (vn.isDrum) drum = true; }
    if (drum || wanted >= 3) this.demandF = this.frameNo;
    if (this.joinY && this.demandF === this.frameNo) { this.joinY = false; this.reconfig(); }
  }
  postAssign() {
    if (this.cfg8 || this.hpf || this.joinY) return;
    if (!this.owner[2] && this.frameNo - this.demandF > 2 * this.frameHz) { this.joinY = true; this.reconfig(); }
  }
  reconfig() {
    this.applyConfig();
    for (let vi = 0; vi < 3; vi++) { const vn = this.owner[vi]; if (vn) this.update(vi, vn); }
  }

  /** Output channel of a voice slot, and whether it is a 16-bit pair. */
  slot(vi) {
    if (this.cfg8) return [vi, false];
    if (vi === 0) return [1, true];
    if (vi === 1) return this.joinY ? [3, true] : [2, false];
    return [3, false];
  }
  vol(amp) { const v = Math.round(15 * Math.min(1, 1.4 * amp)); return v < 0 ? 0 : v; }

  program() {}
  update(vi, vn) {
    const [oc, wide] = this.slot(vi);
    let dist, val, lv;
    if (vn.isDrum) {
      const f = vn.dd.fr[Math.min(vn.frames, vn.len - 1)];
      dist = f[0]; val = f[1]; lv = vn.amp * f[2] * 2.2;
    } else {
      const p = vn.p;
      lv = vn.amp;
      if (p.noise) { dist = NOISE; val = NOISE_N[p.noise] ?? 2; val = Math.max(0, Math.min(255, Math.round(val + (60 - vn.pitch) * 0.4))); }
      else { dist = DIST[p.cls] || PURE; val = 440 * Math.pow(2, (vn.pitch - 69) / 12); }
    }
    let n;
    if (dist === NOISE) n = wide ? (val + 1) * BASE64 - 7 : val;
    else if (wide) n = n16(dist, val);
    else { const r = n8(dist, val); dist = r[0]; n = r[1]; }
    const v = this.vol(lv);
    if (wide) {
      this.w((oc - 1) * 2, n & 255); this.w(oc * 2, n >> 8);
      this.w((oc - 1) * 2 + 1, 0);
      if (this.hpf && vi === 0) {          // ch4 clocks the high-pass flip-flop ~0.6 % off twice the tone rate
        const tone = dist === BUZZ ? CLK / (15 * (n + 7)) : CLK / (2 * (n + 7));
        this.w(6, Math.max(0, Math.min(255, Math.round(CLK / (BASE64 * 2 * tone * 1.006)) - 1))); this.w(7, 0);
      }
    } else this.w(oc * 2, n);
    this.w(oc * 2 + 1, dist | v);
  }
  silence(vi) {
    if (!this.allowed(vi)) return;
    const [oc, wide] = this.slot(vi);
    this.w(oc * 2 + 1, 0);
    if (wide) this.w((oc - 1) * 2 + 1, 0);
  }

  render(L, R, n) {
    const rs = this.rs, pk = this.pk, g = this.gain;
    for (let i = 0; i < n; i++) {
      for (let k = rs.advance(); k > 0; k--) {
        const y = pk.chunk();
        rs.push(y, y);
        this.fcyc += POKEY_CHUNK;
        if (this.fcyc >= POKEY_FRAME_CYCLES) { this.fcyc -= POKEY_FRAME_CYCLES; this.frame(); }
      }
      const v = this.dc.run(rs.out()[0]) * g;
      L[i] = v; R[i] = v;
    }
  }
}
