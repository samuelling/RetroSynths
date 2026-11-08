// Game Boy (DMG) — Sharp LR35902 APU with a frame-rate General MIDI sound driver.
//
// Chip: gb-apu.js, cycle-exact at 4.194304 MHz (pulse ×2 with CH1 sweep, 32×4-bit wave, 15/7-bit
// noise, 512 Hz frame sequencer, DACs with negative slope, NR50/NR51 mixer). Output is integrated
// over 16 T-cycles (262,144 Hz), passed through the DMG output capacitor high-pass
// (charge factor 0.999958 per T-cycle) and band-limited to the output rate.
// Driver (nes-gb-driver.js + below): every LCD frame (59.73 Hz) it writes NR10-NR52 like a game's
// music engine. Volumes use the hardware envelope: each note is triggered with an initial volume and
// an envelope direction/pace planned from the instrument's software ADSR, and re-triggered only when
// the hardware drifts from the plan. Bass (or the lowest free part) goes to the wave channel with an
// original 4-bit waveform per instrument family; drums are noise-channel macros (NR43 per frame).
// GM pan is hard L / both / R through NR51.

import { midiHz, Resampler, TOM_NOTE } from './util.js';
import { GBAPU, GB_CLOCK, GB_FRAME } from './gb-apu.js';
import { Driver, chipLevel } from './nes-gb-driver.js';

const D = 16;
const IRATE = GB_CLOCK / D;

// ------------------------------------------------------------------------------------------------
//  Wave RAM patterns: original designs from harmonic recipes, quantized to 32 × 4 bits.
// ------------------------------------------------------------------------------------------------
function waveFrom(h, ph = []) {
  const y = new Float64Array(32);
  for (let k = 0; k < 32; k++) for (let n = 0; n < h.length; n++) if (h[n]) y[k] += h[n] * Math.sin(2 * Math.PI * (n + 1) * k / 32 + (ph[n] || 0));
  let lo = Infinity, hi = -Infinity; for (const v of y) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const b = new Uint8Array(16);
  for (let k = 0; k < 32; k++) { const q = Math.round((y[k] - lo) / (hi - lo) * 15); b[k >> 1] |= k & 1 ? q : q << 4; }
  return b;
}
const fromSamples = (s) => { const b = new Uint8Array(16); for (let k = 0; k < 32; k++) b[k >> 1] |= k & 1 ? s[k] : s[k] << 4; return b; };
const WAVES = {
  sine: waveFrom([1]),
  pulse: fromSamples(Array.from({ length: 32 }, (_, k) => (k < 8 ? 15 : 0))),
  square: fromSamples(Array.from({ length: 32 }, (_, k) => (k < 16 ? 15 : 0))),
  saw: fromSamples(Array.from({ length: 32 }, (_, k) => 15 - (k >> 1))),
  piano: waveFrom([1, 0.45, 0.25, 0.12, 0.08, 0.05]),
  bell: waveFrom([1, 0, 0.5, 0, 0.35, 0, 0.2]),
  hollow: waveFrom([1, 0, 0.45, 0, 0, 0, 0.3]),
  organ: waveFrom([1, 0.7, 0.5, 0, 0.3, 0, 0, 0.25]),
  guitar: waveFrom([1, 0.6, 0.35, 0.25, 0.15, 0.1, 0.08], [0, 0.4, 0.9, 1.3, 0.2, 0.7]),
  bass: waveFrom([1, 0.5, 0.15]),
  bassbright: waveFrom([1, 0.7, 0.5, 0.35, 0.25], [0, 0.3, 0.6, 0.9, 1.2]),
  synbass: waveFrom([1, 0.5, 0.33, 0.25, 0.2, 0.16, 0.14, 0.12]),
  cello: waveFrom([1, 0.8, 0.55, 0.4, 0.3, 0.2], [0, 0.5, 1, 1.5, 2, 2.5]),
  brass: waveFrom([1, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2]),
  reed: waveFrom([1, 0.1, 0.6, 0.1, 0.4, 0.1, 0.25]),
  choir: waveFrom([1, 0.35, 0.5, 0.15, 0.2], [0, 1.1, 0.4, 2.0, 0.8]),
  pad: waveFrom([1, 0.3, 0.15, 0.1]),
  fx: waveFrom([1, 0, 0.7, 0, 0, 0, 0.3], [0, 0, 1.0, 0, 0, 0, 2.2]),
};

// NR43 value whose LFSR clock is nearest `clock` Hz (w = 7-bit mode)
function nr43For(clock, w) {
  let best = 0, be = Infinity;
  for (let s = 0; s < 14; s++) for (let r = 0; r < 8; r++) {
    const c = 524288 / (r || 0.5) / (1 << s), e = Math.abs(Math.log(c / clock));
    if (e < be) { be = e; best = (s << 4) | (w << 3) | r; }
  }
  return best;
}
// tonal 7-bit noise: the 127-step sequence repeats at clock/127 Hz
const tone7 = (note) => nr43For(127 * midiHz(note), 1);

// GM drum → { v: initial volume, p: envelope pace (decrease), seq: NR43 per frame, n: frames, prio, re: retrigger frames }
function drumDef(note) {
  const X = (v, p, seq, n, o = {}) => ({ v, p, seq, n, prio: 3, ...o });
  const tom = (nn, v = 13) => X(v, 2, [tone7(nn + 7), tone7(nn + 3), tone7(nn), tone7(nn - 3), tone7(nn - 5)], 14, { prio: 5 });
  switch (note) {
    case 35: return X(15, 1, [tone7(50), tone7(41), tone7(35), tone7(30), tone7(26)], 9, { prio: 4 });
    case 36: return X(15, 1, [0x30, tone7(48), tone7(40), tone7(34), tone7(29)], 9, { prio: 4 });
    case 37: return X(12, 1, [0x10], 3, { prio: 5 });
    case 38: return X(14, 1, [0x21, 0x22, 0x32], 14, { prio: 6 });
    case 40: return X(15, 1, [0x11, 0x21, 0x22], 14, { prio: 6 });
    case 39: return X(13, 1, [0x21, 0x21, 0x31], 12, { prio: 6, re: [2, 4] });
    case 42: return X(9, 1, [0x00], 3, { prio: 2 });
    case 44: return X(7, 1, [0x01], 3, { prio: 2 });
    case 46: return X(10, 3, [0x00], 30);
    case 41: case 43: case 45: case 47: case 48: case 50: return tom(TOM_NOTE[note]);
    case 49: return X(13, 6, [0x10, 0x20], 70, { prio: 5 });
    case 57: return X(13, 6, [0x20, 0x21], 70, { prio: 5 });
    case 52: return X(12, 5, [0x18, 0x20], 60, { prio: 5 });
    case 55: return X(11, 4, [0x10], 40, { prio: 5 });
    case 51: return X(8, 4, [0x09, 0x01], 40);
    case 59: return X(8, 4, [0x0A, 0x02], 40);
    case 53: return X(10, 4, [0x0A], 40);
    case 54: return X(8, 1, [0x00], 5, { re: [2] });
    case 69: return X(7, 1, [0x01], 3);
    case 70: return X(8, 1, [0x00], 3);
    case 56: return X(10, 2, [tone7(79)], 14);
    case 67: return X(10, 2, [tone7(84)], 12);
    case 68: return X(10, 2, [tone7(79)], 12);
    case 58: return X(10, 3, [0x31], 30, { re: [3, 6, 9, 12] });
    case 60: case 61: case 62: case 63: case 64: case 65: case 66: return tom(TOM_NOTE[note], 11);
    case 71: return X(7, 2, [tone7(96)], 12);
    case 72: return X(7, 4, [tone7(96)], 30);
    case 73: return X(9, 1, [0x40], 6, { re: [2, 4] });
    case 74: return X(9, 2, [0x40], 16, { re: [2, 4, 6, 8, 10, 12] });
    case 75: return X(11, 1, [tone7(96)], 3, { prio: 4 });
    case 76: return X(11, 1, [tone7(86)], 3, { prio: 4 });
    case 77: return X(11, 1, [tone7(81)], 3, { prio: 4 });
    case 78: return X(9, 2, [tone7(76), tone7(81)], 8);
    case 79: return X(9, 2, [tone7(81), tone7(74)], 8);
    case 80: return X(7, 1, [0x08], 4);
    case 81: return X(7, 5, [0x08], 40);
    default: return X(10, 1, [0x22], 6);
  }
}
const DRUMS = []; for (let n = 0; n < 128; n++) DRUMS.push(drumDef(n < 35 || n > 81 ? 0 : n));

const panBits = (pan) => (pan < 43 ? 0x10 : pan > 85 ? 0x01 : 0x11);   // L / R / both (per channel, shifted)

export default class GB {
  static info = {
    id: 'gb', name: 'Game Boy', maker: 'Nintendo', year: 1989,
    chip: 'Sharp LR35902 APU (DMG)', voices: '2 pulse · 4-bit wave · noise',
    spec: 'DMG APU at 4.19 MHz, hard-panned stereo, output capacitor · 60 Hz driver with hardware envelopes, wave-channel bass, noise drums',
  };
  static options = [
    { key: 'arp', label: 'Chord arps', choices: [[true, 'On'], [false, 'Off']], default: true },
    { key: 'pan', label: 'Panning', choices: [['hard', 'Hard L/R'], ['mono', 'Mono']], default: 'hard' },
  ];

  constructor(host) {
    this.h = host;
    this.apu = new GBAPU();
    this.drv = new Driver(host, { fps: GB_CLOCK / GB_FRAME, pulses: 2, bass: true, noise: true });
    this.rs = new Resampler(IRATE, host.sampleRate);
    this.charge = Math.pow(0.999958, D);
    this.capL = 0; this.capR = 0;
    this.gain = 0.157; this.panMode = 'hard';
    this.sh = new Int32Array(32).fill(-1);
    this.mode = new Int8Array(4); this.pend = new Uint8Array(4);
    this.drum = { on: false, def: null, f: 0, lvl: 0, ch: 9 };
    this.hits = []; this.fpos = 0; this.flush = false;
    this.pans = new Uint8Array(4).fill(0x11);
    this.reset();
  }
  w(a, v) { this.apu.write(a, v); }
  reset() {
    this.apu.reset(); this.drv.reset();
    this.sh.fill(-1); this.mode.fill(0); this.pend.fill(0); this.pans.fill(0x11);
    this.drum.on = false; this.hits.length = 0; this.waveId = null;
    this.w(0xFF26, 0x80); this.w(0xFF24, 0x77); this.w(0xFF25, 0xFF);
    this.w(0xFF10, 0x00); this.w(0xFF11, 0x80); this.w(0xFF12, 0x08); this.w(0xFF16, 0x80); this.w(0xFF17, 0x08);
    this.w(0xFF1A, 0x00); this.w(0xFF1C, 0x00); this.w(0xFF21, 0x08);
    // let the output capacitor start settled
    const o = this.apu.sample(D); this.capL = o[0]; this.capR = o[1];
  }
  setOption(k, v) {
    if (k === 'arp') this.drv.arp = !!v;
    else if (k === 'pan') this.panMode = v === 'mono' ? 'mono' : 'hard';
  }

  // ---------------------------------------------------------------- MIDI
  noteOn(c, note, vel) {
    if (this.h.ch[c].drum) { if (!this.h.mute[c]) this.hits.push(c, note, vel); return; }
    this.drv.noteOn(c, note, vel);
  }
  noteOff(c, note) { if (!this.h.ch[c].drum) this.drv.noteOff(c, note); }
  sustainOff(c) { this.drv.sustainOff(c); }
  allOff(c, hard) { this.drv.allOff(c, hard); if (hard) { if (this.drum.ch === c) this.drum.on = false; this.flush = true; } }
  pitch() {}
  ctrl(c) { if (this.h.mute[c]) this.flush = true; }

  // ---------------------------------------------------------------- driver → registers, once per frame
  frame() {
    const drv = this.drv; drv.tick();
    const [p1, p2] = drv.pulses;
    this.pulse(p1, 0); this.pulse(p2, 1);
    this.waveCh(drv.bassV);
    this.noise(drv.noiseV);
    // NR51: hard pan per chip channel from the MIDI part it is playing
    let nr51 = 0;
    const vs = [p1, p2, drv.bassV];
    for (let i = 0; i < 3; i++) if (vs[i].on && vs[i].part >= 0) this.pans[i] = panBits(this.h.ch[vs[i].part].pan);
    if (this.drum.on) this.pans[3] = panBits(this.h.ch[this.drum.ch].pan);
    else if (drv.noiseV.on && drv.noiseV.part >= 0) this.pans[3] = panBits(this.h.ch[drv.noiseV.part].pan);
    for (let i = 0; i < 4; i++) nr51 |= (this.panMode === 'mono' ? 0x11 : this.pans[i]) << i;
    if (nr51 !== this.sh[31]) { this.w(0xFF25, nr51); this.sh[31] = nr51; }
    const m = this.h.meter;
    for (const v of drv.voices) if (v.on && v.vol > 0) { const g = v.vol / 15; if (g > m[v.ch]) m[v.ch] = g; }
  }
  // hardware envelope plan from the software envelope slope (4-bit units per second)
  envBits(dvdt) {
    if (Math.abs(dvdt) < 4.5) return 0;
    const pace = Math.max(1, Math.min(7, Math.round(64 / Math.abs(dvdt))));
    return dvdt > 0 ? 0x08 | pace : pace;
  }
  // re-plan only when the envelope reverses, or a held level starts moving fast; slow drifts are
  // corrected by the |target − hardware| ≥ 2 rule
  flip(dir, cur, dvdt) { return dir !== 0 && dir !== cur && (cur !== 0 || Math.abs(dvdt) >= 9); }
  pulse(v, i) {
    const sh = this.sh, k = i * 6, b = i ? 0xFF16 : 0xFF11, c = i ? this.apu.c2 : this.apu.c1;
    const target = v.on ? v.vol : 0;
    if (v.trig) this.pend[i] = 1;
    if (target > 0) {
      let f = midiHz(v.note); while (f < 64.1) f *= 2;
      const x = Math.max(0, Math.min(2047, Math.round(2048 - 131072 / f)));
      const d = v.duty << 6;
      if (d !== sh[k]) { this.w(b, d); sh[k] = d; }
      const lo = x & 0xFF, hi = x >> 8;
      if (lo !== sh[k + 1]) { this.w(b + 2, lo); sh[k + 1] = lo; }
      const eb = this.envBits(v.dvdt), dir = eb ? (eb & 8 ? 1 : -1) : 0;
      const cur = c.on ? c.vol : 0;
      if (this.pend[i] || !c.on || Math.abs(target - cur) >= 2 || this.flip(dir, this.mode[i], v.dvdt)) {
        this.w(b + 1, (target << 4) | eb); this.w(b + 3, 0x80 | hi);
        this.mode[i] = dir; sh[k + 2] = hi; this.pend[i] = 0;
      } else if (hi !== sh[k + 2]) { this.w(b + 3, hi); sh[k + 2] = hi; }
    } else if (c.on && c.vol > 0) {
      this.w(b + 1, 0x08); this.w(b + 3, 0x80 | Math.max(0, sh[k + 2])); this.mode[i] = 0;   // cut: volume 0, DAC stays on
    }
  }
  waveCh(v) {
    const sh = this.sh, c = this.apu.c3;
    const t = v.on ? v.vol : 0;
    const code = t >= 10 ? 1 : t >= 5 ? 2 : t >= 2 ? 3 : 0;
    if (v.trig) this.pend[2] = 1;
    if (code === 0) { if (sh[20] !== 0) { this.w(0xFF1C, 0); sh[20] = 0; } return; }
    const id = WAVES[v.inst.wave] ? v.inst.wave : 'bass';
    if (id !== this.waveId) {                                   // wave RAM is only written with the DAC off
      this.w(0xFF1A, 0x00);
      const wb = WAVES[id]; for (let j = 0; j < 16; j++) this.w(0xFF30 + j, wb[j]);
      this.w(0xFF1A, 0x80); this.waveId = id; this.pend[2] = 1;
    }
    let f = midiHz(v.note); while (f < 32.05) f *= 2;
    const x = Math.max(0, Math.min(2047, Math.round(2048 - 65536 / f)));
    const lo = x & 0xFF, hi = x >> 8;
    if (lo !== sh[21]) { this.w(0xFF1D, lo); sh[21] = lo; }
    if (code << 5 !== sh[20]) { this.w(0xFF1C, code << 5); sh[20] = code << 5; }
    if (this.pend[2] || !c.on) { this.w(0xFF1E, 0x80 | hi); sh[22] = hi; this.pend[2] = 0; }
    else if (hi !== sh[22]) { this.w(0xFF1E, hi); sh[22] = hi; }
  }
  noise(nv) {
    const h = this.h, d = this.drum, sh = this.sh, c = this.apu.c4;
    for (let i = 0; i < this.hits.length; i += 3) {
      const ch = this.hits[i], note = this.hits[i + 1], vel = this.hits[i + 2];
      const def = DRUMS[note];
      const rem = d.on ? d.def.prio * (1 - d.f / d.def.n) : 0;
      if (!d.on || def.prio >= rem) { d.on = true; d.def = def; d.f = 0; d.lvl = chipLevel(h.ch[ch], vel); d.ch = ch; }
    }
    this.hits.length = 0;
    if (d.on && h.mute[d.ch]) { d.on = false; this.w(0xFF21, 0x08); this.w(0xFF23, 0x80); }
    if (d.on) {
      const df = d.def, f = d.f;
      const n43 = df.seq[Math.min(f, df.seq.length - 1)];
      if (n43 !== sh[25]) { this.w(0xFF22, n43); sh[25] = n43; }
      if (f === 0 || (df.re && df.re.includes(f))) {
        const v0 = Math.max(1, Math.round(df.v * d.lvl * (f ? 0.8 : 1)));
        this.w(0xFF21, (v0 << 4) | df.p); this.w(0xFF23, 0x80);
        if (v0 / 15 > h.meter[d.ch]) h.meter[d.ch] = v0 / 15;
      }
      if (++d.f >= df.n) { d.on = false; this.w(0xFF21, 0x08); this.w(0xFF23, 0x80); }
      this.pend[3] = 1; this.mode[3] = 0;
      return;
    }
    const target = nv && nv.on ? nv.vol : 0;
    if (nv && nv.trig) this.pend[3] = 1;
    if (target > 0) {
      const n43 = nr43For(440 * Math.pow(2, (nv.note - 69) / 12) * 64, 0);
      if (n43 !== sh[25]) { this.w(0xFF22, n43); sh[25] = n43; }
      const eb = this.envBits(nv.dvdt), dir = eb ? (eb & 8 ? 1 : -1) : 0, cur = c.on ? c.vol : 0;
      if (this.pend[3] || !c.on || Math.abs(target - cur) >= 2 || this.flip(dir, this.mode[3], nv.dvdt)) {
        this.w(0xFF21, (target << 4) | eb); this.w(0xFF23, 0x80); this.mode[3] = dir; this.pend[3] = 0;
      }
    } else if (c.on && c.vol > 0) { this.w(0xFF21, 0x08); this.w(0xFF23, 0x80); this.mode[3] = 0; }
  }

  // ---------------------------------------------------------------- audio
  render(L, R, n) {
    const apu = this.apu, rs = this.rs, g = this.gain, ch = this.charge;
    for (let i = 0; i < n; i++) {
      for (let k = rs.advance(); k > 0; k--) {
        if (this.flush) { this.flush = false; this.frame(); }
        this.fpos += D;
        if (this.fpos >= GB_FRAME) { this.fpos -= GB_FRAME; this.frame(); }
        const o = apu.sample(D);
        let l = 0, r = 0;
        if (apu.dacs) {                                         // DMG output capacitor (high-pass)
          l = o[0] - this.capL; this.capL = o[0] - l * ch;
          r = o[1] - this.capR; this.capR = o[1] - r * ch;
        }
        rs.push(l, r);
      }
      const o = rs.out();
      L[i] = o[0] * g; R[i] = o[1] * g;
    }
  }
  activeCount() {
    let k = 0;
    for (const v of this.drv.voices) if (v.on && v.vol > 0) k++;
    if (this.drum.on && !(this.drv.noiseV.on && this.drv.noiseV.vol > 0)) k++;
    return Math.min(4, k);
  }
  maxVoices() { return 4; }
}
