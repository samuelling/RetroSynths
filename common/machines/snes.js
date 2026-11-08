/*
 * Super Nintendo — Sony S-DSP (see snes-dsp.js) driven by a period-style sound driver.
 *
 * The driver plays the role of a game's music engine running on the SPC700: it owns the 8 hardware
 * voices, writes SRCN/PITCH/VOL/ADSR/GAIN/NON/EON and KON/KOFF, and ticks at 60 Hz for envelope polling
 * (ENVX), vibrato, echo level and voice bookkeeping. Samples, directory and per-instrument sample data
 * come from snes.prep.js (a RAM image squeezed from GeneralUser GS); until setData() arrives it is silent.
 *
 * Instruments (snes-presets.js) carry the real voice parameters, read live from the instrument table:
 *   ADSR (AR/DR/SL/SR) or GAIN, key-off release (KOFF or GAIN exp-decrease), EON, NON + noise clock,
 *   coarse/fine tune, volume, pan. MIDI channels map to instruments via the Arranger (Auto = gmPreset /
 *   kit / gmDrum) and can be pinned to a voice.
 *   - allocation: free → oldest released → oldest among un-pinned voices; a stolen voice that is still
 *     audible is keyed off and re-keyed once the hardware release reaches zero (no clicks)
 *   - pitch = split base × 2^(SF2 cents(note) + tune + bend + vibrato); 14-bit PITCH register
 *   - truncated samples: the natural decay the prep measured is folded into SR when playback reaches
 *     the loop (ADSR2 rewritten by the driver at that frame)
 *   - velocity × CC7 × CC11 × instrument volume → 8-bit VOL, pan → L/R VOL, CC91 → EVOL (global)
 */
import { SDSP, DSP_RATE, R } from './snes-dsp.js';
import { Resampler, FrameClock, gmLevel, panGains, allocVoice, DCBlock } from './util.js';
import { PRESETS, gmPreset, gmDrum, adsrRegs, gainReg, expRate, rateDbps } from './snes-presets.js';

// our own 8-tap echo filters (signed 8-bit FIR registers; 128 = unity DC gain)
function lowpass(fc, sum) {
  const h = [];
  for (let k = 0; k < 8; k++) {
    const x = k - 3.5, s = Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    h.push(s * (0.54 - 0.46 * Math.cos(2 * Math.PI * (k + 0.5) / 8)));
  }
  const t = h.reduce((a, b) => a + b, 0);
  return h.map(c => Math.round(c / t * sum));
}
const FIRS = { lowpass: lowpass(0.13, 113), dark: lowpass(0.07, 110), flat: [112, 0, 0, 0, 0, 0, 0, 0] };
const EFBS = { low: 0x20, mid: 0x37, high: 0x50 };
const EVOL_MAX = 0x4C, MVOL = 0x7F;
const VOL_K = 190;            // driver level scale: sample gain × GM level × instrument volume → 8-bit VOL
const OUT_GAIN = 1.0;         // analog stage after the 16-bit DAC
const VOICE_IDS = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'];

export default class SNES {
  static info = {
    id: 'snes', name: 'Super Nintendo', maker: 'Nintendo', year: 1990, chip: 'Sony SPC700 + S-DSP',
    voices: '8 BRR sample voices · 64KB RAM · echo',
    spec: 'S-DSP at 32 kHz: BRR samples squeezed per song into 64 KB, Gaussian interpolation, ADSR, FIR echo',
  };
  static options = [
    { key: 'echo', label: 'Echo', choices: [[true, 'On'], [false, 'Off']], default: true },
    { key: 'fir', label: 'Echo FIR', choices: [['lowpass', 'Low-pass'], ['dark', 'Dark'], ['flat', 'Flat']], default: 'lowpass' },
    { key: 'efb', label: 'Feedback', choices: [['low', 'Low (EFB $20)'], ['mid', 'Mid (EFB $37)'], ['high', 'High (EFB $50)']], default: 'mid' },
  ];
  static voices = VOICE_IDS.map((id, i) => ({ id, name: `Voice ${i + 1}`, kind: 'sample' }));
  static presets = PRESETS;
  static gmPreset(program) { return gmPreset(program); }
  static gmDrum(note) { return gmDrum(note); }

  constructor(host) {
    this.h = host;
    this.dsp = new SDSP();
    this.rs = new Resampler(DSP_RATE, host.sampleRate);
    this.clk = new FrameClock(DSP_RATE, 60);
    this.dcL = new DCBlock(host.sampleRate, 8); this.dcR = new DCBlock(host.sampleRate, 8);
    this.v = [];
    for (let i = 0; i < 8; i++) this.v.push({ i, bit: 1 << i, base: i << 4, active: false, on: false, sus: false, age: 0,
      ch: 0, note: 0, vel: 0, idx: -1, ins: null, sp: null, oneshot: false, pendAt: -1, late: false, ticks: 0, vibPh: 0, gainRel: false });
    this.table = PRESETS.slice();
    this.arr = Array.from({ length: 16 }, () => ({ inst: -1, voice: 'auto' }));
    this.kit = {}; this.vmute = 0;
    this.pool = this.v;                     // voices open to automatic allocation
    this.vs = new Float32Array(32);
    this.data = null; this.echo = true; this.fir = 'lowpass'; this.efb = 'mid';
    this.age = 0; this.n = 0; this.pending = 0;
    this.koff = 0; this.eon = 0; this.non = 0; this.evol = 0; this.nclk = 0;
  }

  // ---------------------------------------------------------------- setup
  setData(data) {
    if (!data || !data.ram) { this.data = null; return; }
    if (this.data && data.key && data.key === this.data.key) { this.data = data; return; }   // same RAM image
    this.data = data;
    this.dsp.ram.set(data.ram);
    this.reset();
  }
  setOption(key, value) {
    if (key === 'echo') { this.echo = value === true || value === 'true'; this.applyEcho(true); }
    else if (key === 'fir' && FIRS[value]) { this.fir = value; this.writeFir(); }
    else if (key === 'efb' && EFBS[value] != null) { this.efb = value; this.w(R.EFB, EFBS[value]); }
  }
  setInstruments(list) { if (Array.isArray(list) && list.length) { this.table = list; this.refreshAll(); } }
  updateInstrument(i, inst) {
    if (!inst) return;
    this.table[i] = inst;
    for (const v of this.v) if (v.active && v.idx === i && v.pendAt < 0) {
      v.ins = inst;
      if (!v.gainRel) { const [a1, a2] = adsrRegs(inst); this.w(v.base + R.ADSR1, a1); this.w(v.base + R.ADSR2, a2); this.w(v.base + R.GAIN, gainReg(inst)); }
      this.setPitch(v); this.setVol(v); this.setEon(v); this.setNoise(v);
    }
  }
  setArrangement(arr) {
    if (!Array.isArray(arr)) return;
    this.arr = Array.from({ length: 16 }, (_, c) => arr[c] ? { inst: arr[c].inst | 0, voice: arr[c].voice || 'auto' } : { inst: -1, voice: 'auto' });
    const pinned = new Set(this.arr.map(a => VOICE_IDS.indexOf(a.voice)).filter(i => i >= 0));
    const free = this.v.filter(v => !pinned.has(v.i));
    this.pool = free.length ? free : this.v;
  }
  setKit(kit) { this.kit = kit && typeof kit === 'object' ? kit : {}; }
  setVoiceMute(mask) { this.vmute = mask | 0; for (const v of this.v) if (v.active && v.pendAt < 0) this.setVol(v); }
  voiceState() {
    const vs = this.vs, d = this.dsp;
    for (const v of this.v) {
      const k = v.i * 4, hv = d.v[v.i];
      if (!v.active) { vs[k] = 0; vs[k + 1] = -1; vs[k + 2] = -1; vs[k + 3] = -1; continue; }
      const vl = Math.abs(d.regs[v.base + R.VOLL] << 24 >> 24) + Math.abs(d.regs[v.base + R.VOLR] << 24 >> 24);
      vs[k] = (hv.env / 0x7FF) * Math.min(1, vl / 90); vs[k + 1] = v.ch; vs[k + 2] = v.note; vs[k + 3] = v.idx;
    }
    return vs;
  }

  w(a, x) { this.dsp.write(a, x); }
  writeFir() { const f = FIRS[this.fir]; for (let k = 0; k < 8; k++) this.w(R.FIR + (k << 4), f[k] & 0xFF); }
  reset() {
    const d = this.dsp;
    d.reset();
    for (const v of this.v) { v.active = false; v.on = false; v.sus = false; v.pendAt = -1; v.late = false; }
    this.pending = 0; this.koff = 0; this.eon = 0; this.non = 0; this.evol = 0; this.nclk = 0;
    if (!this.data) return;
    this.w(R.DIR, this.data.dir); this.w(R.ESA, this.data.esa); this.w(R.EDL, this.data.edl);
    this.writeFir();
    this.w(R.EFB, EFBS[this.efb]);
    this.w(R.MVOLL, MVOL); this.w(R.MVOLR, MVOL);
    this.w(R.EVOLL, 0); this.w(R.EVOLR, 0);
    this.w(R.KOFF, 0); this.w(R.NON, 0); this.w(R.PMON, 0); this.w(R.EON, 0);
    d.clearEcho();
    this.applyEcho(false);
  }
  flg() { this.w(R.FLG, (this.echo ? 0x00 : 0x20) | (this.nclk & 31)); }
  applyEcho(clear) {
    if (!this.data) return;
    if (this.echo && clear) this.dsp.clearEcho();
    this.flg();
    if (!this.echo) { this.eon = 0; this.w(R.EON, 0); this.evol = 0; this.w(R.EVOLL, 0); this.w(R.EVOLR, 0); }
    else for (const v of this.v) if (v.active && v.pendAt < 0) this.setEon(v);
  }
  refreshAll() {
    for (const v of this.v) if (v.active && v.pendAt < 0 && this.table[v.idx]) { v.ins = this.table[v.idx]; this.setPitch(v); this.setVol(v); this.setEon(v); }
  }

  // ---------------------------------------------------------------- instrument lookup
  instIndex(c, note) {
    const a = this.arr[c], ch = this.h.ch[c];
    if (a && a.inst >= 0 && a.inst < this.table.length) return a.inst;
    if (ch.drum) { const k = this.kit[note]; return k != null && k >= 0 ? k : gmDrum(note); }
    return gmPreset(ch.program);
  }

  // ---------------------------------------------------------------- per-voice register helpers
  pitchOf(v) {
    const ins = v.ins, sp = v.sp, ch = this.h.ch[v.ch];
    const n = ins.fixed ? ins.src.key : v.note;
    let cents = (n - sp.zroot) * sp.scale + sp.off + (ins.coarse || 0) * 100 + (ins.tune || 0);
    if (!ins.fixed) {
      cents += ch.bend * ch.bendRange * 100;
      if (ch.cc[1] > 0) cents += Math.sin(v.vibPh) * ch.cc[1] / 127 * 50;     // mod wheel: up to ±50 cents
    }
    const p = Math.round(sp.base * Math.pow(2, cents / 1200));
    return p < 0 ? 0 : p > 0x3FFF ? 0x3FFF : p;
  }
  setPitch(v) { const p = this.pitchOf(v); this.w(v.base + R.PL, p & 0xFF); this.w(v.base + R.PH, p >> 8); }
  setVol(v) {
    const c = v.ch, ch = this.h.ch[c], ins = v.ins;
    let l = 0, r = 0;
    if (!this.h.mute[c] && !(this.vmute & v.bit)) {
      const g = VOL_K * v.sp.gain * gmLevel(ch, v.vel) * (ins.vol != null ? ins.vol : 100) / 100;
      const p = Math.max(0, Math.min(1, ((ch.pan - 64) / 63 + (ins.pan || 0) / 64 + 1) / 2));
      const pl = Math.cos(p * Math.PI / 2), pr = Math.sin(p * Math.PI / 2);
      l = Math.min(127, Math.round(g * pl)); r = Math.min(127, Math.round(g * pr));
    }
    this.w(v.base + R.VOLL, l); this.w(v.base + R.VOLR, r);
  }
  setEon(v) {
    const on = this.echo && v.ins.echo && this.h.ch[v.ch].cc[91] >= 8;
    const e = on ? this.eon | v.bit : this.eon & ~v.bit;
    if (e !== this.eon) { this.eon = e; this.w(R.EON, e); }
  }
  setNoise(v) {
    const ins = v.ins, e = ins.noise ? this.non | v.bit : this.non & ~v.bit;
    if (e !== this.non) { this.non = e; this.w(R.NON, e); }
    if (ins.noise) {         // one global noise clock (FLG): the latest noise note sets it
      const nr = (ins.nrate | 0) + (ins.fixed ? 0 : (v.note - 60) >> 2);
      this.nclk = nr < 1 ? 1 : nr > 31 ? 31 : nr; this.flg();
    }
  }
  keyOff(v) { this.koff |= v.bit; this.w(R.KOFF, this.koff); }

  start(v) {
    const ins = v.ins, sp = v.sp, b = v.base;
    v.pendAt = -1; v.ticks = 0; v.vibPh = 0; v.gainRel = false;
    this.w(b + R.SRCN, sp.srcn);
    const [a1, a2] = adsrRegs(ins);
    this.w(b + R.ADSR1, a1); this.w(b + R.ADSR2, a2); this.w(b + R.GAIN, gainReg(ins));
    this.setPitch(v); this.setVol(v); this.setEon(v); this.setNoise(v);
    this.koff &= ~v.bit; this.w(R.KOFF, this.koff);
    this.w(R.KON, v.bit);
    // natural decay of a truncated sample → faster SR from the loop point on
    v.swTick = 0;
    if (ins.env !== 'gain' && sp.natural > 0.2 && sp.loopT > 0) {
      v.sr2 = expRate(rateDbps(ins.sr) + sp.natural);
      if (v.sr2 !== (ins.sr & 31)) v.swTick = Math.max(1, Math.round(sp.loopT * 60));
    }
    if (!v.on && !v.oneshot) v.late = true;       // released before it could start: release on next tick
  }
  release(v) {
    v.on = false; v.sus = false;
    if (v.oneshot) return;                        // drums are one-shots: note-off is ignored
    if (v.pendAt >= 0) return;                    // handled when it starts
    if (v.ins.rel) {                              // switch to GAIN mode: exponential decay
      this.w(v.base + R.GAIN, 0xA0 | (v.ins.rel & 31));
      this.w(v.base + R.ADSR1, adsrRegs(v.ins)[0] & 0x7F);
      v.gainRel = true;
    } else this.keyOff(v);
  }

  // ---------------------------------------------------------------- MIDI
  noteOn(c, note, vel) {
    if (!this.data) return;
    const idx = this.instIndex(c, note), ins = this.table[idx], pd = this.data.insts && this.data.insts[idx];
    if (!ins || !pd || !pd.splits.length) return;
    let sp = pd.splits[pd.splits.length - 1];
    const key = ins.fixed ? ins.src.key : note;
    for (const s of pd.splits) if (key <= s.hi) { sp = s; break; }
    const ch = this.h.ch[c];
    const oneshot = ins.category === 'Drums';
    for (const o of this.v) {
      if (!o.active || o.ch !== c) continue;
      if (o.note === note && o.on) this.release(o);                                  // repeated note: new voice
      if (ch.drum && o.oneshot && o.idx === idx && o.note !== note && ins.fixed) this.keyOff(o);   // same drum: choke
    }
    if (ch.drum && (note === 42 || note === 44)) for (const o of this.v) if (o.active && o.ch === c && o.note === 46) this.keyOff(o);   // hi-hat choke
    const pin = VOICE_IDS.indexOf(this.arr[c] ? this.arr[c].voice : 'auto');
    const v = pin >= 0 ? this.v[pin] : allocVoice(this.pool);
    const env = this.dsp.v[v.i].env, wasPending = v.pendAt >= 0;
    Object.assign(v, { active: true, on: true, sus: false, age: ++this.age, ch: c, note, vel, idx, ins, sp, oneshot, late: false });
    if (env > 0 || this.dsp.v[v.i].konDelay) {
      // still audible: hardware release (−8/sample) to zero, then key on
      this.keyOff(v);
      v.pendAt = this.n + (env >> 3) + 4;
      if (!wasPending) this.pending++;
    } else {
      if (wasPending) this.pending--;
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
  pitch(c) { for (const v of this.v) if (v.active && v.ch === c && v.pendAt < 0) this.setPitch(v); }
  ctrl(c) { for (const v of this.v) if (v.active && v.ch === c && v.pendAt < 0) { this.setVol(v); this.setEon(v); } }

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
      if (v.swTick && v.ticks === v.swTick && !v.gainRel) this.w(v.base + R.ADSR2, ((v.ins.sl & 7) << 5) | v.sr2);   // folded decay
      const ch = this.h.ch[v.ch];
      if (!v.ins.fixed && ch.cc[1] > 0) { v.vibPh += 2 * Math.PI * 5.5 / 60; this.setPitch(v); }
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
