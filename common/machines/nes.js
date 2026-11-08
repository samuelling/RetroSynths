// NES — Ricoh 2A03 APU (NTSC) played through native instruments by a frame-rate sound driver.
//
// Chip: nes-apu.js, cycle-exact at 1.789773 MHz with the NESdev nonlinear mixer; its output is
// box-integrated over 8 CPU cycles (223.7 kHz), run through the console's analog chain
// (1st-order HP 90 Hz, HP 440 Hz, LP 14 kHz) and band-limited to the output rate.
// Instruments (nes-presets.js) are FamiTracker-style: volume / arpeggio / pitch / duty / noise-period
// macros, vibrato, the $4001 hardware sweep, and DPCM samples (synthesized + delta-encoded here).
// The driver (nes-gb-driver.js) steps them every NTSC frame (60.0988 Hz) and allocates parts to
// Pulse 1/2, Triangle, Noise and DPCM; this module writes $4000-$4017 from the result.

import { midiHz, Resampler } from './util.js';
import { APU, NES_CPU, NES_FRAME, DMC_P } from './nes-apu.js';
import { Driver, hasMacro, macroLoops, M_VOL, M_X } from './nes-gb-driver.js';
import { PRESETS, GM_MAP, gmDrum as GM_DRUM, SAMPLE_NAMES } from './nes-presets.js';
import { synthOneShot, loopBits } from './nes-dpcm.js';

const D = 8;                                   // CPU cycles per integration step
const IRATE = NES_CPU / D;
const DMC_HZ = DMC_P.map(p => NES_CPU / p);
const clone = (o) => JSON.parse(JSON.stringify(o));

const noiseIndex = (note) => Math.max(0, Math.min(15, Math.round(14 - (note - 24) / 5)));

const VOICES = [
  { id: 'p1', name: 'Pulse 1', kind: 'pulse' },
  { id: 'p2', name: 'Pulse 2', kind: 'pulse' },
  { id: 'tri', name: 'Triangle', kind: 'triangle' },
  { id: 'noise', name: 'Noise', kind: 'noise' },
  { id: 'dpcm', name: 'DPCM', kind: 'dpcm' },
];

export default class NES {
  static info = {
    id: 'nes', name: 'NES', maker: 'Nintendo', year: 1985,
    chip: 'Ricoh 2A03 APU', voices: '2 pulse · triangle · noise · DPCM',
    spec: '2A03 at 1.79 MHz, nonlinear mixer and NES filter chain · 60 Hz macro driver: pulses, triangle, noise, DPCM samples',
  };
  static options = [
    { key: 'arp', label: 'Chord arps', choices: [[true, 'On'], [false, 'Off']], default: true },
    { key: 'filter', label: 'Output', choices: [['nes', 'NES filters'], ['clean', 'Clean']], default: 'nes' },
  ];
  static voices = VOICES;
  static presets = PRESETS;
  static samples = SAMPLE_NAMES;
  static gmPreset(program) { return GM_MAP[program & 127]; }
  static gmDrum(note) { return GM_DRUM(note); }

  constructor(host) {
    this.h = host;
    this.apu = new APU();
    this.table = clone(PRESETS);
    const self = this;
    this.drv = new Driver(host, {
      fps: NES_CPU / NES_FRAME, voices: VOICES, kinds: ['pulse', 'triangle', 'noise', 'dpcm'],
      overflow: [['triangle', 'pulse']], table: this.table,
      gmPreset: NES.gmPreset, gmDrum: NES.gmDrum,
      hooks: {
        start: (n, I) => self.noteStart(n, I),
        step: (n, I, d) => self.noteStep(n, I, d),
        release: (n, I) => self.noteRelease(n, I),
        drumHolds: (I) => !!I && (macroLoops(I.vol) || (I.kind === 'dpcm' && !!I.loop)),
      },
    });
    this.rs = new Resampler(IRATE, host.sampleRate);
    this.filter = 'nes';
    const dt = 1 / IRATE, hp = (f) => { const rc = 1 / (2 * Math.PI * f); return rc / (rc + dt); };
    this.a90 = hp(90); this.a440 = hp(440); this.a37 = hp(37);
    { const rc = 1 / (2 * Math.PI * 14000); this.b14 = dt / (rc + dt); }
    this.f = new Float64Array(6);
    this.gain = 3.1;
    this.buildSamples();
    this.sh = new Int32Array(24).fill(-1); this.pend = new Uint8Array(4);
    this.vmute = 0; this.vs = new Float32Array(VOICES.length * 4);
    this.fpos = 0; this.flush = false; this.dmcNote = null; this.dmcLeft = 0;
    this.reset();
  }

  buildSamples() {
    this.smp = {};
    let addr = 0xC000;
    const put = (key, b, loopBitsN) => {
      this.apu.mem.set(b, addr - 0x8000);
      const L = Math.min(255, Math.ceil((b.length - 1) / 16));
      this.smp[key] = { a: (addr - 0xC000) >> 6, l: L, bytes: L * 16 + 1, bits: loopBitsN || 0 };
      addr += Math.ceil((L * 16 + 1) / 64) * 64;
    };
    for (const k of ['Kick', 'Snare', 'Tom', 'Clap']) { put(k, synthOneShot(k, 80)); put(k + '~', synthOneShot(k, 46)); }
    for (const k of ['Saw Loop', 'Square Loop']) for (const N of [136, 264, 520]) put(k + N, loopBits(k, N), N);
  }

  w(a, v) { this.apu.write(a, v); }
  reset() {
    this.apu.reset();
    this.drv.reset();
    this.sh.fill(-1); this.pend.fill(0); this.dmcNote = null; this.dmcLeft = 0;
    this.w(0x4015, 0x0F); this.w(0x4017, 0x40);
    this.w(0x4000, 0x30); this.w(0x4004, 0x30); this.w(0x4001, 0x08); this.w(0x4005, 0x08);
    this.w(0x4008, 0x80); this.w(0x400C, 0x30); this.w(0x4011, 0x00);
  }
  setOption(k, v) {
    if (k === 'arp') this.drv.arp = !!v;
    else if (k === 'filter') this.filter = v === 'clean' ? 'clean' : 'nes';
  }
  // ---------------------------------------------------------------- v2: native instruments
  setInstruments(list) { this.table = list.map(x => x); this.drv.table = this.table; }
  updateInstrument(i, inst) { if (i >= 0) { this.table[i] = inst; } }
  setArrangement(arr) { for (let c = 0; c < 16; c++) this.drv.arr[c] = arr && arr[c] ? { inst: arr[c].inst | 0, voice: arr[c].voice || 'auto' } : { inst: -1, voice: 'auto' }; }
  setKit(kit) { this.drv.kit = kit || {}; }
  setVoiceMute(mask) { this.vmute = mask | 0; this.flush = true; }
  voiceState() {
    const vs = this.vs, V = this.drv.voices;
    for (let i = 0; i < V.length; i++) {
      const v = V[i], on = v.on && (i === 4 ? this.dmcLeft > 0 : v.vol > 0);
      vs[i * 4] = on ? (i === 2 || i === 4 ? 0.8 : v.vol / 15) : 0;
      vs[i * 4 + 1] = on ? v.ch : -1; vs[i * 4 + 2] = on ? Math.round(v.note) : -1; vs[i * 4 + 3] = on ? v.ii : -1;
    }
    return vs;
  }

  // ---------------------------------------------------------------- driver hooks (per note, per frame)
  noteStart(n, I) {
    n.fading = false; n.fv = 0; n.ft = 0; n.dmc = null; n.left = 0;
    if (I.kind === 'dpcm') {
      const s = this.dmcPlan(n, I);
      n.dmc = s; n.left = s ? (I.loop ? 1e9 : Math.ceil(s.bytes * 8 * DMC_P[s.rate] / NES_FRAME) + 1) : 0;
    }
  }
  noteStep(n, I, d) {
    if (I.kind === 'dpcm') { n.vol15 = n.left > 0 ? 15 : 0; if (--n.left <= 0) n.dead = true; return; }
    const v = d.mval(I.vol, n, M_VOL);
    const x = d.mval(I.xMac, n, M_X); if (x != null) n.x = x;
    if (n.fading) {
      if (++n.ft >= Math.max(1, I.fade | 0)) { n.ft = 0; n.fv--; }
      n.vol15 = Math.max(0, Math.min(n.fv, v == null ? 15 : v));
      if (n.fv <= 0) n.dead = true;
      return;
    }
    n.vol15 = v == null ? 15 : v;
    if (n.vol15 === 0 && d.macroDone(I.vol, n, M_VOL)) n.dead = true;
  }
  noteRelease(n, I) {
    if (I.kind === 'dpcm') { if (I.loop) n.dead = true; return; }
    if (hasMacro(I.vol) && I.vol.release >= 0) return;          // the macro's release section takes over
    if ((I.fade | 0) > 0) { n.fading = true; n.fv = n.vol15; n.ft = 0; } else n.dead = true;
  }
  dmcPlan(n, I) {
    const name = I.sample || 'Kick';
    if (name.endsWith('Loop')) {
      const f = midiHz(n.note);
      let best = null, be = Infinity;
      for (const N of [136, 264, 520]) for (let r = 0; r < 16; r++) {
        if (!I.track && r !== (I.rate | 0)) continue;
        const e = Math.abs(Math.log(DMC_HZ[r] / N / f));
        if (e < be) { be = e; best = { ...this.smp[name + N], rate: r }; }
      }
      return best;
    }
    const s = this.smp[name + (n.vel >= 80 ? '' : '~')] || this.smp[name];
    if (!s) return null;
    let rate = I.rate | 0;
    if (I.track) {
      const target = DMC_HZ[rate] * Math.pow(2, (n.note - (I.ref == null ? 60 : I.ref)) / 12);
      let be = Infinity; for (let r = 0; r < 16; r++) { const e = Math.abs(Math.log(DMC_HZ[r] / target)); if (e < be) { be = e; rate = r; } }
    }
    return { ...s, rate };
  }

  // ---------------------------------------------------------------- MIDI
  noteOn(c, note, vel) { this.drv.noteOn(c, note, vel); }
  noteOff(c, note) { this.drv.noteOff(c, note); }
  sustainOff(c) { this.drv.sustainOff(c); }
  allOff(c, hard) { this.drv.allOff(c, hard); if (hard) this.flush = true; }
  pitch() {}                                          // the driver re-reads bend every frame
  ctrl(c) { if (this.h.mute[c]) this.flush = true; }

  // ---------------------------------------------------------------- driver → registers, once per frame
  frame() {
    const drv = this.drv; drv.tick();
    const V = drv.voices;
    this.pulse(V[0], 0); this.pulse(V[1], 1);
    this.tri(V[2]); this.noise(V[3]); this.dpcm(V[4]);
    const m = this.h.meter;
    for (let i = 0; i < V.length; i++) {
      const v = V[i]; if (!v.on || v.ch < 0 || (this.vmute >> i) & 1) continue;
      const g = i === 4 ? (this.dmcLeft > 0 ? 0.9 : 0) : i === 2 ? (v.vol > 0 ? 0.8 : 0) : v.vol / 15;
      if (g > m[v.ch]) m[v.ch] = g;
    }
  }
  pulse(v, i) {
    const sh = this.sh, b = 0x4000 + 4 * i, k = i * 4;
    const vol = v.on && !((this.vmute >> i) & 1) ? v.vol : 0;
    let t = -1;
    if (vol > 0) {
      t = Math.round(NES_CPU / (16 * midiHz(v.note))) - 1 + Math.round(v.pacc);
      while (t > 2047) t = ((t + 1) >> 1) - 1;
    }
    const r0 = ((v.duty & 3) << 6) | 0x30 | (t >= 8 ? vol : 0);
    if (r0 !== sh[k]) { this.w(b, r0); sh[k] = r0; }
    if (v.trig) this.pend[i] = 1;
    if (t < 8) return;
    const lo = t & 0xFF, hi = t >> 8;
    if (this.pend[i]) {                                          // new note: sweep unit, then period with phase reset
      const s = v.I && v.I.sweep, r1 = s && s.en ? 0x80 | ((s.period & 7) << 4) | (s.neg ? 8 : 0) | (s.shift & 7) : 0x08;
      this.w(b + 1, r1); sh[k + 3] = r1;
    }
    if (lo !== sh[k + 1]) { this.w(b + 2, lo); sh[k + 1] = lo; }
    if (this.pend[i] || hi !== sh[k + 2]) { this.w(b + 3, 0x08 | hi); sh[k + 2] = hi; this.pend[i] = 0; }
  }
  tri(v) {
    const sh = this.sh;
    let t = -1;
    if (v.on && v.vol > 0 && !((this.vmute >> 2) & 1)) {
      t = Math.round(NES_CPU / (32 * midiHz(v.note))) - 1 + Math.round(v.over ? v.pacc / 2 : v.pacc);
      while (t > 2047) t = ((t + 1) >> 1) - 1;
    }
    if (t < 2) { if (sh[8] !== 0x80) { this.w(0x4008, 0x80); sh[8] = 0x80; } return; }   // linear counter → 0: halts at current step
    const lo = t & 0xFF, hi = t >> 8;
    if (lo !== sh[9]) { this.w(0x400A, lo); sh[9] = lo; }
    if (v.trig || hi !== sh[10]) { this.w(0x400B, 0x08 | hi); sh[10] = hi; }
    if (sh[8] !== 0xFF) { this.w(0x4008, 0xFF); sh[8] = 0xFF; }
  }
  noise(v) {
    const sh = this.sh;
    const vol = v.on && !((this.vmute >> 3) & 1) ? v.vol : 0;
    let re = -1;
    if (vol > 0) {
      const per = v.cur && hasMacro(v.I.xMac) ? v.cur.x : noiseIndex(v.note);
      re = ((v.duty & 1) << 7) | (Math.max(0, Math.min(15, per | 0)));
    }
    const r0 = 0x30 | vol;
    if (v.trig) this.pend[3] = 1;
    if (r0 !== sh[12]) { this.w(0x400C, r0); sh[12] = r0; }
    if (re >= 0 && re !== sh[14]) { this.w(0x400E, re); sh[14] = re; }
    if (this.pend[3] && vol > 0) { this.w(0x400F, 0x08); this.pend[3] = 0; }      // length load + envelope restart
  }
  dpcm(v) {
    const n = v.on ? v.lead : null, muted = (this.vmute >> 4) & 1;
    if (n && n.dmc && v.trig && !muted) {
      const s = n.dmc, I = v.I;
      this.w(0x4015, 0x0F);                                       // stop, then restart the DMC
      this.w(0x4010, (I.loop ? 0x40 : 0) | (s.rate & 15)); this.w(0x4012, s.a); this.w(0x4013, s.l);
      if (I.level >= 0) this.w(0x4011, I.level & 0x7F);
      this.w(0x4015, 0x1F);
      this.dmcNote = n;
    } else if (this.dmcNote && (muted || this.dmcNote.dead)) {
      if (muted || this.apu.dm.loop) this.w(0x4015, 0x0F);       // one-shots play out; loops stop with their note
      this.dmcNote = null;
    }
    this.dmcLeft = this.dmcNote ? 1 : 0;
  }

  // ---------------------------------------------------------------- audio
  render(L, R, n) {
    const apu = this.apu, rs = this.rs, f = this.f, g = this.gain;
    const a90 = this.a90, a440 = this.a440, b14 = this.b14, a37 = this.a37, nes = this.filter === 'nes';
    for (let i = 0; i < n; i++) {
      for (let k = rs.advance(); k > 0; k--) {
        if (this.flush) { this.flush = false; this.frame(); }
        this.fpos += D;
        if (this.fpos >= NES_FRAME) { this.fpos -= NES_FRAME; this.frame(); }
        const x = apu.sample(D);
        let y;
        if (nes) {
          f[1] = a90 * (f[1] + x - f[0]); f[0] = x;               // HP 90 Hz
          f[3] = a440 * (f[3] + f[1] - f[2]); f[2] = f[1];        // HP 440 Hz
          f[4] += b14 * (f[3] - f[4]);                            // LP 14 kHz
          y = f[4];
        } else { f[5] = a37 * (f[5] + x - f[0]); f[0] = x; y = f[5]; f[1] = f[2] = f[3] = f[4] = 0; }
        rs.push(y, y);
      }
      const o = rs.out();
      L[i] = o[0] * g; R[i] = o[0] * g;
    }
  }
  activeCount() {
    let k = 0; const V = this.drv.voices;
    for (let i = 0; i < 4; i++) if (V[i].on && V[i].vol > 0) k++;
    if (this.dmcLeft > 0) k++;
    return k;
  }
  maxVoices() { return 5; }
}
