// TurboGrafx-16 / PC Engine — HuC6280 PSG driven by a 6-voice, frame-rate music driver.
//
// Like a Hudson-era sound driver: each GM program picks a 32-step wave from RetroSynths' own wave set
// (uploaded into the channel's wave RAM when the voice changes instrument), software envelopes step
// the 5-bit log volume once per frame, stereo comes from the 4-bit L/R balance. Drums: kick, snare,
// toms, claps and hand percussion are 5-bit DDA samples streamed from a 6.99 kHz timer interrupt;
// hats, cymbals and shakers use the noise generator of channels 5–6.
// Original code for RetroSynths.
import { Resampler, DCBlock, drumKind, panGains } from './util.js';
import { PSG, PSG_CLOCK, PSG_CHUNK, PSG_RATE, PSG_FRAME_CYCLES, PSG_TIMER_CYCLES } from './tg16-psg.js';
import { WAVES, WAVE_LIST, CLASS_WAVE, PROG_WAVE, ddaSample, noiseMacro } from './tg16-data.js';
import { Driver, DRUM_PRIO } from './atari-driver.js';

const NOISE_NF = { hiss: 0, sea: -6, heli: -18, applause: 3, gun: -4, fret: 2, breath: -2, cymbal: 4 };

/** Amplitude 0..1 → 5-bit channel volume (1.5 dB per step). */
export const vol5 = (amp) => { if (amp <= 1e-4) return 0; const v = 31 + Math.round(20 * Math.log10(amp) / 1.5); return v < 0 ? 0 : v > 31 ? 31 : v; };
/** Gain 0..1 → 4-bit balance nibble (3 dB per step). */
const nib = (g) => { if (g <= 0.001) return 0; const v = 15 + Math.round(20 * Math.log10(g) / 3); return v < 0 ? 0 : v > 15 ? 15 : v; };
/** Frequency → 12-bit period. */
export const period = (hz) => { const p = Math.round(PSG_CLOCK / (32 * hz)); return p < 1 ? 1 : p > 4095 ? 4095 : p; };

export default class TG16 extends Driver {
  static info = {
    id: 'tg16', name: 'TurboGrafx-16', maker: 'NEC / Hudson', year: 1987,
    chip: 'Hudson HuC6280 PSG', voices: '6 × 32-step 5-bit wavetable · noise · DDA',
    spec: 'six 5-bit wavetable channels with log volume and stereo balance; DDA drums, noise hats',
  };
  static options = [
    { key: 'rev', label: 'PSG', choices: [['A', 'HuC6280A (Duo)'], ['orig', 'HuC6280 (DC pops)']], default: 'A' },
  ];

  constructor(host) {
    super(host, 6, PSG_CLOCK / PSG_FRAME_CYCLES);
    this.psg = new PSG();
    this.rs = new Resampler(PSG_RATE, host.sampleRate);
    this.dcL = new DCBlock(host.sampleRate, 10); this.dcR = new DCBlock(host.sampleRate, 10);
    this.o = [0, 0]; this.fcyc = 0; this.tcyc = 0;
    this.gain = 0.58;
    this.melOrder = [0, 1, 2, 3, 4, 5]; this.drumOrder = [5, 4, 3, 2, 1, 0];
    this.drums = {};
    for (let n = 27; n <= 87; n++) {
      const nm = noiseMacro(n), kind = drumKind(n);
      const d = { kind, prio: DRUM_PRIO[kind] ?? 46, choke: kind.startsWith('hat') ? 'hat' : null };
      if (nm) Object.assign(d, { noise: true, fr: nm, len: nm.length });
      else { d.smp = ddaSample(n); d.len = Math.ceil(d.smp.length / (PSG_CLOCK / PSG_TIMER_CYCLES) * this.frameHz) + 1; }
      this.drums[n] = d;
    }
    this.vc = Array.from({ length: 6 }, () => ({ wave: null, ctl: -1, per: -1, bal: -1, nz: -1, smp: null, pos: 0 }));
    this.reset();
  }
  setOption(key, value) { if (key === 'rev') this.psg.off = value === 'orig' ? 0 : 16; }
  maxVoices() { return 6; }
  reset() {
    this.resetDriver();
    const off = this.psg.off; this.psg.reset(); this.psg.off = off;
    for (const v of this.vc) Object.assign(v, { wave: null, ctl: -1, per: -1, bal: -1, nz: -1, smp: null, pos: 0 });
    this.psg.w(1, 0xff);
    for (let i = 0; i < 6; i++) { this.psg.w(0, i); this.psg.w(4, 0); this.psg.w(5, 0xff); this.psg.w(7, 0); }
    this.psg.w(9, 0x80);    // LFO off
  }
  drumFor(note) { return this.drums[note] || this.drums[Math.max(27, Math.min(87, note))]; }
  noisy(vn) { return vn.isDrum ? !!vn.dd.noise : !!vn.p.noise; }
  allowed(vi, vn) { return vi >= 4 || !this.noisy(vn); }

  sel(vi) { this.psg.w(0, vi); }
  setCtl(vi, v) { const c = this.vc[vi]; if (c.ctl !== v) { c.ctl = v; this.sel(vi); this.psg.w(4, v); } }

  program(vi, vn) {
    const c = this.vc[vi], psg = this.psg;
    this.sel(vi);
    c.smp = null;
    if (vn.isDrum && !vn.dd.noise) {                       // DDA sample
      if (vi >= 4 && c.nz !== 0) { psg.w(7, 0); c.nz = 0; }
      c.smp = vn.dd.smp; c.pos = 0;
      psg.w(4, 0xc0); c.ctl = 0xc0; psg.w(6, c.smp[0]);
      return;
    }
    if (this.noisy(vn)) return;                             // noise: set up in update
    if (vi >= 4 && c.nz !== 0) { psg.w(7, 0); c.nz = 0; }
    const w = WAVES[PROG_WAVE[vn.p.prog] || CLASS_WAVE[vn.p.cls]] || WAVES.SQUARE;
    if (c.wave !== w) {                                     // upload the instrument's wave
      psg.w(4, 0x40); psg.w(4, 0x00);
      for (let i = 0; i < 32; i++) psg.w(6, w[i]);
      c.wave = w; c.ctl = 0;
    }
  }
  update(vi, vn) {
    const c = this.vc[vi], psg = this.psg, ch = this.h.ch[vn.ch];
    const [gl, gr] = panGains(ch);
    const bal = (nib(gl * 1.414) << 4) | nib(gr * 1.414);
    if (c.bal !== bal) { c.bal = bal; this.sel(vi); psg.w(5, bal); }
    let amp = vn.amp, nz = 0;
    if (vn.isDrum) {
      if (vn.dd.noise) { const f = vn.dd.fr[Math.min(vn.frames, vn.len - 1)]; nz = 0x80 | f[0]; amp *= f[1] * 1.6; }
      else { this.setCtl(vi, 0xc0 | vol5(amp * 1.7)); return; }
    } else if (vn.p.noise) {
      const nf = Math.round(18 + (vn.pitch - 60) / 3 + (NOISE_NF[vn.p.noise] || 0));
      nz = 0x80 | (nf < 0 ? 0 : nf > 31 ? 31 : nf);
      amp *= 0.8;
    } else {
      const p = period(440 * Math.pow(2, (vn.pitch - 69) / 12));
      if (c.per !== p) { c.per = p; this.sel(vi); psg.w(2, p & 255); psg.w(3, p >> 8); }
    }
    if (nz && c.nz !== nz) { c.nz = nz; this.sel(vi); psg.w(7, nz); }
    this.setCtl(vi, 0x80 | vol5(amp));
  }
  silence(vi) {
    const c = this.vc[vi];
    c.smp = null;
    this.setCtl(vi, 0);
    if (vi >= 4 && c.nz !== 0) { this.sel(vi); this.psg.w(7, 0); c.nz = 0; }
  }
  /** Timer IRQ: stream the next 5-bit DDA sample to every channel playing one. */
  timerIrq() {
    for (let vi = 0; vi < 6; vi++) {
      const c = this.vc[vi];
      if (!c.smp) continue;
      if (++c.pos >= c.smp.length) { this.sel(vi); this.psg.w(6, 16); c.smp = null; continue; }
      this.sel(vi); this.psg.w(6, c.smp[c.pos]);
    }
  }

  render(L, R, n) {
    const rs = this.rs, psg = this.psg, o = this.o, g = this.gain;
    for (let i = 0; i < n; i++) {
      for (let k = rs.advance(); k > 0; k--) {
        psg.chunk(o);
        rs.push(o[0], o[1]);
        this.tcyc += PSG_CHUNK;
        if (this.tcyc >= PSG_TIMER_CYCLES) { this.tcyc -= PSG_TIMER_CYCLES; this.timerIrq(); }
        this.fcyc += PSG_CHUNK;
        if (this.fcyc >= PSG_FRAME_CYCLES) { this.fcyc -= PSG_FRAME_CYCLES; this.frame(); }
      }
      const y = rs.out();
      L[i] = this.dcL.run(y[0]) * g; R[i] = this.dcR.run(y[1]) * g;
    }
  }
}
