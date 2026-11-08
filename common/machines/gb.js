// Game Boy (DMG) — Sharp LR35902 APU played through native instruments by a frame-rate sound driver.
//
// Chip: gb-apu.js, cycle-exact at 4.194304 MHz (pulse ×2 with CH1 sweep, 32×4-bit wave, 15/7-bit
// noise, 512 Hz frame sequencer, DACs with negative slope, NR50/NR51 mixer). Output is integrated
// over 16 T-cycles (262,144 Hz), passed through the DMG output capacitor high-pass
// (charge factor 0.999958 per T-cycle) and band-limited to the output rate.
// Instruments (gb-presets.js) are in register terms: NRx2 hardware envelopes (plus an optional second
// envelope re-triggered mid-note and a release envelope), NR10 sweep, NRx1 duty/length, wave RAM +
// NR32 level, NR43 polynomial-counter macros, NR51 pan, and tracker macros (arp/pitch/duty/pan).
// The driver (nes-gb-driver.js) steps them every LCD frame (59.73 Hz) and allocates parts to
// Pulse 1/2, Wave and Noise; this module writes NR10-NR52 from the result.

import { midiHz, Resampler } from './util.js';
import { GBAPU, GB_CLOCK, GB_FRAME } from './gb-apu.js';
import { Driver, hasMacro, macroLoops, M_VOL, M_X, M_PAN } from './nes-gb-driver.js';
import { PRESETS, GM_MAP, gmDrum as GM_DRUM, POLY, polyNear, WAVES } from './gb-presets.js';

const D = 16;
const IRATE = GB_CLOCK / D;
const FPS = GB_CLOCK / GB_FRAME;
const clone = (o) => JSON.parse(JSON.stringify(o));
const PANB = { L: 0x10, R: 0x01, LR: 0x11 };
const panGM = (pan) => (pan < 43 ? 0x10 : pan > 85 ? 0x01 : 0x11);

const VOICES = [
  { id: 'p1', name: 'Pulse 1', kind: 'pulse' },
  { id: 'p2', name: 'Pulse 2', kind: 'pulse' },
  { id: 'wave', name: 'Wave', kind: 'wave' },
  { id: 'noise', name: 'Noise', kind: 'noise' },
];

export default class GB {
  static info = {
    id: 'gb', name: 'Game Boy', maker: 'Nintendo', year: 1989,
    chip: 'Sharp LR35902 APU (DMG)', voices: '2 pulse · 4-bit wave · noise',
    spec: 'DMG APU at 4.19 MHz, hard-panned stereo, output capacitor · 60 Hz driver with hardware envelopes, wave RAM, noise macros',
  };
  static options = [
    { key: 'arp', label: 'Chord arps', choices: [[true, 'On'], [false, 'Off']], default: true },
    { key: 'pan', label: 'Panning', choices: [['hard', 'Hard L/R'], ['mono', 'Mono']], default: 'hard' },
  ];
  static voices = VOICES;
  static presets = PRESETS;
  static poly = POLY;
  static waves = WAVES;
  static gmPreset(program) { return GM_MAP[program & 127]; }
  static gmDrum(note) { return GM_DRUM(note); }

  constructor(host) {
    this.h = host;
    this.apu = new GBAPU();
    this.table = clone(PRESETS);
    const self = this;
    this.drv = new Driver(host, {
      fps: FPS, voices: VOICES, kinds: ['pulse', 'wave', 'noise'], overflow: [['wave', 'pulse']], table: this.table,
      gmPreset: GB.gmPreset, gmDrum: GB.gmDrum,
      hooks: {
        start: (n, I) => self.noteStart(n, I),
        step: (n, I, d) => self.noteStep(n, I, d),
        release: (n, I) => self.noteRelease(n, I),
        only: (I) => (I.kind === 'pulse' && I.sweep && (I.sweep.pace || I.sweep.shift) ? 'p1' : null),   // NR10 exists on CH1 only
        drumHolds: (I) => !!I && (I.kind === 'wave' ? macroLoops(I.lvlMac) : (I.env && I.env.pace === 0 && I.env.vol > 0 && !(I.len > 0))),
      },
    });
    this.rs = new Resampler(IRATE, host.sampleRate);
    this.charge = Math.pow(0.999958, D);
    this.capL = 0; this.capR = 0;
    this.gain = 0.157; this.panMode = 'hard';
    this.sh = new Int32Array(32).fill(-1);
    this.loaded = new Int8Array(32).fill(-1);
    this.pans = new Uint8Array(4).fill(0x11);
    this.vmute = 0; this.vs = new Float32Array(VOICES.length * 4);
    this.fpos = 0; this.flush = false;
    this.reset();
  }
  w(a, v) { this.apu.write(a, v); }
  reset() {
    this.apu.reset(); this.drv.reset();
    this.sh.fill(-1); this.pans.fill(0x11); this.loaded.fill(-1);
    this.w(0xFF26, 0x80); this.w(0xFF24, 0x77); this.w(0xFF25, 0xFF);
    this.w(0xFF10, 0x00); this.w(0xFF11, 0x80); this.w(0xFF12, 0x08); this.w(0xFF16, 0x80); this.w(0xFF17, 0x08);
    this.w(0xFF1A, 0x00); this.w(0xFF1C, 0x00); this.w(0xFF21, 0x08);
    const o = this.apu.sample(D); this.capL = o[0]; this.capR = o[1];   // output capacitor starts settled
  }
  setOption(k, v) {
    if (k === 'arp') this.drv.arp = !!v;
    else if (k === 'pan') this.panMode = v === 'mono' ? 'mono' : 'hard';
  }
  // ---------------------------------------------------------------- v2: native instruments
  setInstruments(list) { this.table = list.map(x => x); this.drv.table = this.table; }
  updateInstrument(i, inst) { if (i >= 0) this.table[i] = inst; }
  setArrangement(arr) { for (let c = 0; c < 16; c++) this.drv.arr[c] = arr && arr[c] ? { inst: arr[c].inst | 0, voice: arr[c].voice || 'auto' } : { inst: -1, voice: 'auto' }; }
  setKit(kit) { this.drv.kit = kit || {}; }
  setVoiceMute(mask) { this.vmute = mask | 0; this.flush = true; }
  voiceState() {
    const vs = this.vs, V = this.drv.voices, A = this.apu, chans = [A.c1, A.c2, A.c3, A.c4];
    for (let i = 0; i < V.length; i++) {
      const v = V[i], c = chans[i];
      const lvl = !c.on ? 0 : i === 2 ? [0, 1, 0.5, 0.25][c.lvl] : c.vol / 15;
      const on = v.on && lvl > 0 && !((this.vmute >> i) & 1);
      vs[i * 4] = on ? lvl : 0; vs[i * 4 + 1] = on ? v.ch : -1; vs[i * 4 + 2] = on ? Math.round(v.note) : -1; vs[i * 4 + 3] = on ? v.ii : -1;
    }
    return vs;
  }

  // ---------------------------------------------------------------- driver hooks: a model of the hardware envelope per note
  noteStart(n, I) {
    n.fading = false; n.fv = 0; n.ft = 0; n.e2 = false; n.e2W = false; n.relP = false; n.relW = false;
    if (I.kind === 'wave') return;
    const e = I.env || { vol: 15, dir: 0, pace: 0 };
    n.hv = e.vol; n.hd = e.dir; n.hp = e.pace; n.hacc = 0;
    n.lenF = I.len > 0 ? Math.max(1, Math.round(I.len * FPS / 256)) : 0;
  }
  noteStep(n, I, d) {
    const pv = d.mval(I.panMac, n, M_PAN); n.panV = pv == null ? 0 : pv;
    if (I.kind === 'wave') {
      const lv = d.mval(I.lvlMac, n, M_VOL);
      let L = lv == null ? (I.level == null ? 3 : I.level) : lv;
      if (n.fading) { if (++n.ft >= Math.max(1, I.fade | 0)) { n.ft = 0; n.fv--; } L = Math.min(L, n.fv); if (n.fv <= 0) n.dead = true; }
      n.vol15 = Math.max(0, L) * 5;
      if (L <= 0 && d.macroDone(I.lvlMac, n, M_VOL)) n.dead = true;
      return;
    }
    if (I.kind === 'noise') { const x = d.mval(I.poly, n, M_X); if (x != null) n.x = x; }
    const e2 = I.env2;
    if (e2 && e2.at > 0 && n.t === e2.at && !n.released) { n.hv = e2.vol; n.hd = e2.dir; n.hp = e2.pace; n.hacc = 0; n.e2 = true; }
    if (n.hp > 0) {                                           // the APU envelope ticks at 64 Hz
      n.hacc += 64 / FPS;
      while (n.hacc >= n.hp) { n.hacc -= n.hp; if (n.hd) { if (n.hv < 15) n.hv++; } else if (n.hv > 0) n.hv--; }
    }
    n.vol15 = n.hv;
    if (n.lenF && n.t >= n.lenF) n.dead = true;
    const pendingE2 = e2 && e2.at > n.t && !n.released;
    if (n.hv === 0 && !(n.hd && n.hp) && !pendingE2 && n.t > 0) n.dead = true;
  }
  noteRelease(n, I) {
    if (I.kind === 'wave') {
      if (hasMacro(I.lvlMac) && I.lvlMac.release >= 0) return;
      if ((I.fade | 0) > 0) { n.fading = true; n.fv = Math.round(n.vol15 / 5); n.ft = 0; } else n.dead = true;
      return;
    }
    const r = I.rel == null ? 0 : I.rel;
    if (r === 0) { n.dead = true; return; }
    if (r < 0) { if (n.hd || !n.hp) n.dead = true; return; }   // "ring": only meaningful while the envelope decays
    n.hd = 0; n.hp = r; n.hacc = 0; n.relP = true;
  }

  // ---------------------------------------------------------------- MIDI
  noteOn(c, note, vel) { this.drv.noteOn(c, note, vel); }
  noteOff(c, note) { this.drv.noteOff(c, note); }
  sustainOff(c) { this.drv.sustainOff(c); }
  allOff(c, hard) { this.drv.allOff(c, hard); if (hard) this.flush = true; }
  pitch() {}
  ctrl(c) { if (this.h.mute[c]) this.flush = true; }

  // ---------------------------------------------------------------- driver → registers, once per frame
  frame() {
    const drv = this.drv; drv.tick();
    const V = drv.voices;
    this.pulse(V[0], 0); this.pulse(V[1], 1); this.waveCh(V[2]); this.noise(V[3]);
    let nr51 = 0;
    for (let i = 0; i < 4; i++) {
      const v = V[i];
      if (v.on && v.lead) {
        const I = v.I, pm = v.lead.panV;
        this.pans[i] = pm >= 1 && pm <= 3 ? [0, 0x10, 0x01, 0x11][pm] : I && PANB[I.pan] ? PANB[I.pan] : panGM(this.h.ch[v.ch].pan);
      }
      nr51 |= (this.panMode === 'mono' ? 0x11 : this.pans[i]) << i;
    }
    if (nr51 !== this.sh[31]) { this.w(0xFF25, nr51); this.sh[31] = nr51; }
    const m = this.h.meter;
    for (let i = 0; i < 4; i++) { const v = V[i]; if (v.on && v.ch >= 0 && !((this.vmute >> i) & 1) && v.vol / 15 > m[v.ch]) m[v.ch] = v.vol / 15; }
  }
  nrx2(e, L) { const v = ((this.scaled(e.vol, L) << 4) | (e.dir ? 8 : 0) | (e.pace & 7)) & 0xFF; return (v & 0xF8) ? v : 0x08; }   // keep the DAC on
  scaled(vol, L) { return vol > 0 ? Math.max(1, Math.min(15, Math.round(vol * L))) : 0; }
  // NRx2 / trigger logic shared by the pulses and noise: note-on, second envelope, release envelope
  envWrites(v, nrx2, trigger, chan) {
    const n = v.lead, I = v.I;
    if (v.trig) {
      const e = I.env || { vol: 15, dir: 0, pace: 0 };
      this.w(nrx2, this.nrx2(e, n.L)); trigger(); return;
    }
    if (n.e2 && !n.e2W) {
      n.e2W = true; this.w(nrx2, this.nrx2(I.env2, n.L)); trigger(); return;
    }
    if (n.relP && !n.relW) {
      n.relW = true;
      if (chan.on && chan.vol > 0) { this.w(nrx2, (chan.vol << 4) | ((I.rel | 0) & 7)); trigger(); }
    }
  }
  cut(nrx2, nrx4, chan) { if (chan.on && chan.vol > 0) { this.w(nrx2, 0x08); this.w(nrx4, 0x80); } }
  pulse(v, i) {
    const sh = this.sh, k = i * 6, b = i ? 0xFF16 : 0xFF11, c = i ? this.apu.c2 : this.apu.c1;
    if (!v.on || !v.lead || ((this.vmute >> i) & 1)) { this.cut(b + 1, b + 3, c); return; }
    const I = v.I;
    let f = midiHz(v.note); while (f < 64.1) f *= 2;
    const x = Math.max(0, Math.min(2047, Math.round(2048 - 131072 / f) + Math.round(v.pacc)));
    const lenOn = I.len > 0 ? 0x40 : 0;
    const r1 = ((v.duty & 3) << 6) | (lenOn ? (64 - Math.min(64, I.len)) & 63 : 0);
    if (r1 !== sh[k] || (v.trig && lenOn)) { this.w(b, r1); sh[k] = r1; }
    const lo = x & 0xFF, hi = x >> 8;
    if (lo !== sh[k + 1]) { this.w(b + 2, lo); sh[k + 1] = lo; }
    if (v.trig && i === 0) {
      const s = I.sweep, r10 = s && (s.pace || s.shift) ? ((s.pace & 7) << 4) | (s.dir ? 8 : 0) | (s.shift & 7) : 0;
      if (r10 !== sh[k + 4]) { this.w(0xFF10, r10); sh[k + 4] = r10; }
    }
    let trig = false;
    this.envWrites(v, b + 1, () => { this.w(b + 3, 0x80 | lenOn | hi); sh[k + 2] = hi; trig = true; }, c);
    if (!trig && hi !== sh[k + 2]) { this.w(b + 3, lenOn | hi); sh[k + 2] = hi; }
  }
  waveCh(v) {
    const sh = this.sh, c = this.apu.c3;
    const nat = !v.on || ((this.vmute >> 2) & 1) ? 0 : v.vol >= 11 ? 3 : v.vol >= 6 ? 2 : v.vol >= 2 ? 1 : 0;
    if (!nat) { if (sh[20] !== 0) { this.w(0xFF1C, 0); sh[20] = 0; } return; }
    const I = v.I, data = v.over ? (WAVES[I.wave] || WAVES.pulse) : (I.wave || WAVES.bass);
    let same = true; for (let j = 0; j < 32; j++) if (this.loaded[j] !== (data[j] & 15)) { same = false; break; }
    let trig = v.trig;
    if (!same) {                                               // wave RAM is only written with the DAC off
      this.w(0xFF1A, 0x00);
      for (let j = 0; j < 16; j++) this.w(0xFF30 + j, ((data[2 * j] & 15) << 4) | (data[2 * j + 1] & 15));
      for (let j = 0; j < 32; j++) this.loaded[j] = data[j] & 15;
      this.w(0xFF1A, 0x80); trig = true;
    }
    let f = midiHz(v.note); while (f < 32.05) f *= 2;
    const x = Math.max(0, Math.min(2047, Math.round(2048 - 65536 / f) + Math.round(v.over ? v.pacc / 2 : v.pacc)));
    const lo = x & 0xFF, hi = x >> 8, code = [0, 3, 2, 1][nat] << 5;
    if (lo !== sh[21]) { this.w(0xFF1D, lo); sh[21] = lo; }
    if (code !== sh[20]) { this.w(0xFF1C, code); sh[20] = code; }
    if (trig || !c.on) { this.w(0xFF1E, 0x80 | hi); sh[22] = hi; }
    else if (hi !== sh[22]) { this.w(0xFF1E, hi); sh[22] = hi; }
  }
  noise(v) {
    const sh = this.sh, c = this.apu.c4;
    if (!v.on || !v.lead || ((this.vmute >> 3) & 1)) { this.cut(0xFF21, 0xFF23, c); return; }
    const I = v.I, w = v.duty & 1;
    const pi = hasMacro(I.poly) ? Math.max(0, Math.min(POLY.length - 1, v.cur.x | 0)) : polyNear(midiHz(v.note) * (w ? 127 : 64));
    const P = POLY[pi], n43 = (P.s << 4) | (w << 3) | P.r;
    if (n43 !== sh[25]) { this.w(0xFF22, n43); sh[25] = n43; }
    const lenOn = I.len > 0 ? 0x40 : 0;
    if (v.trig && lenOn) this.w(0xFF20, (64 - Math.min(64, I.len)) & 63);
    this.envWrites(v, 0xFF21, () => this.w(0xFF23, 0x80 | lenOn), c);
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
  activeCount() { let k = 0; const vs = this.voiceState(); for (let i = 0; i < 4; i++) if (vs[i * 4] > 0) k++; return k; }
  maxVoices() { return 4; }
}
