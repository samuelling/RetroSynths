/*
 * Super Nintendo — Sony S-DSP (see snes-dsp.js) driven by a General MIDI sound driver.
 *
 * The driver plays the role of a game's music engine running on the SPC700: it owns the 8 hardware
 * voices, writes SRCN/PITCH/VOL/ADSR/GAIN and KON/KOFF, and ticks at 60 Hz for envelope polling
 * (ENVX), vibrato, echo level and voice bookkeeping. Samples, directory and instrument map come from
 * snes.prep.js (a per-song RAM image squeezed from GeneralUser GS); until setData() arrives it is silent.
 *
 *   - voice allocation: free → oldest released → oldest; a stolen voice that is still audible is
 *     keyed off first and re-keyed once the hardware release has reached zero (no clicks)
 *   - pitch = split base × 2^((note + bend + vibrato − root) / 12), 14-bit PITCH register
 *   - ADSR per instrument from the SF2 envelope; note-off switches the voice to an exponential
 *     GAIN decay matching the SF2 release (or KOFF for short releases), like period drivers did
 *   - velocity × CC7 × CC11 → 8-bit VOL, pan → L/R VOL, CC91 → EON bit + global EVOL
 *   - default echo: EDL from the prep budget (4–5 → 64–80 ms), 8-tap FIR low-pass, EFB ≈ 0.43
 */
import { SDSP, DSP_RATE, R } from './snes-dsp.js';
import { Resampler, FrameClock, gmLevel, panGains, bentNote, allocVoice, DCBlock } from './util.js';

// our own 8-tap echo low-pass (≈4 kHz at 32 kHz, DC gain ≈ 0.88), signed 8-bit like the FIR registers
const FIR = (() => {
  const fc = 0.13, h = [];
  for (let k = 0; k < 8; k++) {
    const x = k - 3.5, s = Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    h.push(s * (0.54 - 0.46 * Math.cos(2 * Math.PI * (k + 0.5) / 8)));
  }
  const sum = h.reduce((a, b) => a + b, 0);
  return h.map(c => Math.round(c / sum * 113));
})();
const EFB = 0x37, EVOL_MAX = 0x4C, MVOL = 0x7F;
const VOL_K = 190;            // driver level scale: instrument gain × GM level → 8-bit VOL
const OUT_GAIN = 1.0;         // analog stage after the 16-bit DAC

export default class SNES {
  static info = {
    id: 'snes', name: 'Super Nintendo', maker: 'Nintendo', year: 1990, chip: 'Sony SPC700 + S-DSP',
    voices: '8 BRR sample voices · 64KB RAM · echo',
    spec: 'S-DSP at 32 kHz: BRR samples squeezed per song into 64 KB, Gaussian interpolation, ADSR, FIR echo',
  };
  static options = [{ key: 'echo', label: 'Echo', choices: [[true, 'On'], [false, 'Off']], default: true }];

  constructor(host) {
    this.h = host;
    this.dsp = new SDSP();
    this.rs = new Resampler(DSP_RATE, host.sampleRate);
    this.clk = new FrameClock(DSP_RATE, 60);
    this.dcL = new DCBlock(host.sampleRate, 8); this.dcR = new DCBlock(host.sampleRate, 8);
    this.v = [];
    for (let i = 0; i < 8; i++) this.v.push({ i, bit: 1 << i, base: i << 4, active: false, on: false, sus: false, age: 0,
      ch: 0, note: 0, vel: 0, sp: null, drum: false, pendAt: -1, late: false, ticks: 0, vibPh: 0, gainRel: false });
    this.data = null; this.echo = true; this.age = 0; this.n = 0; this.pending = 0;
    this.koff = 0; this.eon = 0; this.evol = 0;
  }

  // ---------------------------------------------------------------- setup
  setData(data) {
    if (!data || !data.ram) { this.data = null; return; }
    this.data = data;
    this.dsp.ram.set(data.ram);
    this.reset();
  }
  setOption(key, value) {
    if (key === 'echo') { this.echo = value === true || value === 'true'; this.applyEcho(true); }
  }
  w(a, x) { this.dsp.write(a, x); }
  reset() {
    const d = this.dsp;
    d.reset();
    for (const v of this.v) { v.active = false; v.on = false; v.sus = false; v.pendAt = -1; v.late = false; }
    this.pending = 0; this.koff = 0; this.eon = 0; this.evol = 0;
    if (!this.data) return;
    this.w(R.DIR, this.data.dir); this.w(R.ESA, this.data.esa); this.w(R.EDL, this.data.edl);
    for (let k = 0; k < 8; k++) this.w(R.FIR + (k << 4), FIR[k] & 0xFF);
    this.w(R.EFB, EFB);
    this.w(R.MVOLL, MVOL); this.w(R.MVOLR, MVOL);
    this.w(R.EVOLL, 0); this.w(R.EVOLR, 0);
    this.w(R.KOFF, 0); this.w(R.NON, 0); this.w(R.PMON, 0); this.w(R.EON, 0);
    d.clearEcho();
    this.applyEcho(false);
  }
  applyEcho(clear) {
    if (!this.data) return;
    if (this.echo && clear) this.dsp.clearEcho();
    this.w(R.FLG, this.echo ? 0x00 : 0x20);      // echo writes enabled, unmuted, noise rate 0
    if (!this.echo) { this.eon = 0; this.w(R.EON, 0); this.evol = 0; this.w(R.EVOLL, 0); this.w(R.EVOLR, 0); }
  }

  // ---------------------------------------------------------------- per-voice register helpers
  pitchOf(v) {
    if (v.drum) return v.sp.pitch;
    const ch = this.h.ch[v.ch], sp = v.sp;
    let n = bentNote(ch, v.note);
    if (ch.cc[1] > 0) n += Math.sin(v.vibPh) * ch.cc[1] / 127 * 0.5;     // mod wheel: up to ±50 cents
    const p = Math.round(sp.base * Math.pow(2, (n - sp.root) * sp.scale / 12));
    return p < 0 ? 0 : p > 0x3FFF ? 0x3FFF : p;
  }
  setPitch(v) { const p = this.pitchOf(v); this.w(v.base + R.PL, p & 0xFF); this.w(v.base + R.PH, p >> 8); }
  setVol(v) {
    const c = v.ch, ch = this.h.ch[c];
    let l = 0, r = 0;
    if (!this.h.mute[c]) {
      const g = VOL_K * v.sp.gain * gmLevel(ch, v.vel);
      let pl, pr;
      if (v.drum) {
        const p = Math.max(0, Math.min(1, ((ch.pan - 64) / 63 + v.sp.pan + 1) / 2));
        pl = Math.cos(p * Math.PI / 2); pr = Math.sin(p * Math.PI / 2);
      } else [pl, pr] = panGains(ch);
      l = Math.min(127, Math.round(g * pl)); r = Math.min(127, Math.round(g * pr));
    }
    this.w(v.base + R.VOLL, l); this.w(v.base + R.VOLR, r);
  }
  setEon(v, on) {
    const e = on && this.echo ? this.eon | v.bit : this.eon & ~v.bit;
    if (e !== this.eon) { this.eon = e; this.w(R.EON, e); }
  }
  keyOff(v) { this.koff |= v.bit; this.w(R.KOFF, this.koff); }

  start(v) {
    const sp = v.sp, b = v.base;
    v.pendAt = -1; v.ticks = 0; v.vibPh = 0; v.gainRel = false;
    this.w(b + R.SRCN, sp.srcn);
    this.w(b + R.ADSR1, sp.adsr1); this.w(b + R.ADSR2, sp.adsr2); this.w(b + R.GAIN, 0);
    this.setPitch(v); this.setVol(v);
    this.setEon(v, this.h.ch[v.ch].cc[91] >= 8);
    this.koff &= ~v.bit; this.w(R.KOFF, this.koff);
    this.w(R.KON, v.bit);
    if (!v.on && !v.drum) v.late = true;          // released before it could start: release on next tick
  }
  release(v) {
    v.on = false; v.sus = false;
    if (v.drum) return;                           // drums are one-shots: note-off is ignored
    if (v.pendAt >= 0) return;                    // handled when it starts
    if (v.sp.rel) {                               // switch to GAIN mode: exponential decay
      this.w(v.base + R.GAIN, v.sp.rel);
      this.w(v.base + R.ADSR1, v.sp.adsr1 & 0x7F);
      v.gainRel = true;
    } else this.keyOff(v);
  }

  // ---------------------------------------------------------------- MIDI
  noteOn(c, note, vel) {
    if (!this.data) return;
    const ch = this.h.ch[c];
    let sp;
    if (ch.drum) { sp = this.data.drums[note]; }
    else {
      const pr = this.data.programs[ch.program];
      if (pr) { sp = pr.splits[pr.splits.length - 1]; for (const s of pr.splits) if (note <= s.hi) { sp = s; break; } }
    }
    if (!sp) return;
    for (const o of this.v) {
      if (!o.active || o.ch !== c) continue;
      if (o.note === note && o.on) this.release(o);                         // repeated note: new voice, old one releases
      if (ch.drum && sp.excl && o.drum && o.sp.excl === sp.excl && o.note !== note) this.keyOff(o);   // hi-hat choke
    }
    const v = allocVoice(this.v);
    const env = this.dsp.v[v.i].env, wasPending = v.pendAt >= 0;
    Object.assign(v, { active: true, on: true, sus: false, age: ++this.age, ch: c, note, vel, sp, drum: !!ch.drum, late: false });
    if (env > 0 || this.dsp.v[v.i].konDelay) {
      // still audible: hardware release (−8/sample) to zero, then key on
      this.keyOff(v);
      v.pendAt = this.n + (env >> 3) + 4;
      if (!wasPending) this.pending++;
    } else {
      if (wasPending) { this.pending--; }
      this.start(v);
    }
  }
  noteOff(c, note) {
    const sus = this.h.ch[c].sustain;
    for (const v of this.v) if (v.active && v.on && v.ch === c && v.note === note) {
      if (sus) v.sus = true; else this.release(v);
    }
  }
  sustainOff(c) { for (const v of this.v) if (v.active && v.sus && v.ch === c) this.release(v); }
  allOff(c, hard) {
    for (const v of this.v) if (v.active && v.ch === c) {
      if (hard) {
        v.on = false; v.sus = false;
        if (v.pendAt >= 0) { v.pendAt = -1; this.pending--; v.active = false; }
        this.keyOff(v);
      } else if (v.on) this.release(v);
    }
  }
  pitch(c) { for (const v of this.v) if (v.active && v.ch === c && !v.drum && v.pendAt < 0) this.setPitch(v); }
  ctrl(c) {
    for (const v of this.v) if (v.active && v.ch === c && v.pendAt < 0) { this.setVol(v); this.setEon(v, this.h.ch[c].cc[91] >= 8); }
  }

  // ---------------------------------------------------------------- 60 Hz driver tick
  tick() {
    const dsp = this.dsp, meter = this.h.meter;
    let send = 0;
    for (const v of this.v) {
      if (!v.active || v.pendAt >= 0) continue;
      const hv = dsp.v[v.i], env = hv.env;
      v.ticks++;
      if (v.late) { v.late = false; this.release(v); }
      if (v.gainRel && env === 0 && !hv.konDelay) this.keyOff(v);     // decay finished: hand back to KOFF
      if (env === 0 && !hv.konDelay && hv.mode !== 0 && v.ticks > 2) { v.active = false; v.on = false; continue; }
      const ch = this.h.ch[v.ch];
      if (v.sp.swTicks && v.ticks === v.sp.swTicks && !v.gainRel) this.w(v.base + R.ADSR2, v.sp.adsr2b);   // folded decay
      if (!v.drum && ch.cc[1] > 0) { v.vibPh += 2 * Math.PI * 5.5 / 60; this.setPitch(v); }
      if (this.eon & v.bit) send = Math.max(send, ch.cc[91]);
      const vl = Math.abs(dsp.regs[v.base + R.VOLL] << 24 >> 24) + Math.abs(dsp.regs[v.base + R.VOLR] << 24 >> 24);
      const m = (env / 0x7FF) * Math.min(1, vl / 90);
      if (m > meter[v.ch]) meter[v.ch] = m;
    }
    // global echo level follows the strongest reverb send among echoing voices (slewed)
    if (this.echo) {
      const target = Math.round(EVOL_MAX * send / 127);
      if (target !== this.evol) {
        this.evol += target > this.evol ? 1 : -1;
        this.w(R.EVOLL, this.evol); this.w(R.EVOLR, this.evol);
      }
    }
  }
  runPending() {
    for (const v of this.v) if (v.pendAt >= 0 && this.n >= v.pendAt) { this.pending--; this.start(v); }
  }

  // ---------------------------------------------------------------- audio
  render(L, R_, n) {
    if (!this.data) { L.fill(0, 0, n); R_.fill(0, 0, n); return; }
    const dsp = this.dsp, rs = this.rs, clk = this.clk, S = OUT_GAIN / 32768;
    for (let i = 0; i < n; i++) {
      let k = rs.advance();
      while (k-- > 0) {
        if (clk.next()) this.tick();
        if (this.pending) this.runPending();
        dsp.sample(); this.n++;
        rs.push(dsp.l * S, dsp.r * S);
      }
      const o = rs.out();
      L[i] = this.dcL.run(o[0]); R_[i] = this.dcR.run(o[1]);
    }
  }
  activeCount() { let c = 0; for (const v of this.v) if (v.active) c++; return c; }
  maxVoices() { return 8; }
}
