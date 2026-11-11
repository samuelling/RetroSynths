// AudioWorklet: runs the modem engine at 8 kHz, resamples to the context rate, adds the mechanical sounds
// (hook relay, dial pulses, rotary dial) at full rate, and streams events + the line signal to the UI.
import { ModemEngine } from './session.js';
import { Resampler, Rand } from '../../../common/machines/util.js';

/** relay / handset / rotary-dial clicks, synthesised at the output rate */
class Mech {
  constructor(sr) { this.sr = sr; this.v = []; this.rng = new Rand(5); }
  add(what, relay, vol) {
    if (relay === 'none' && what.startsWith('relay')) return;
    const sr = this.sr, R = (f, d, a, delay = 0) => this.v.push({ w: 2 * Math.PI * f / sr, dec: Math.exp(-1 / (d * sr)), a: a * vol, n: -Math.round(delay * sr), ph: 0, noise: 0 });
    const N = (d, a, delay = 0) => this.v.push({ w: 0, dec: Math.exp(-1 / (d * sr)), a: a * vol, n: -Math.round(delay * sr), noise: 1 });
    const big = relay === 'clunk', hs = relay === 'handset';
    switch (what) {
      case 'relay-on':
        if (hs) { R(180, 0.03, 0.35); R(620, 0.012, 0.2); N(0.004, 0.15); break; }
        R(big ? 1400 : 2600, big ? 0.008 : 0.003, big ? 0.32 : 0.16); R(big ? 3900 : 6100, 0.002, 0.12); N(0.0015, big ? 0.2 : 0.1);
        R(big ? 1700 : 3100, 0.004, big ? 0.14 : 0.07, 0.0045); N(0.001, 0.06, 0.0045); break;
      case 'relay-off':
        if (hs) { R(240, 0.02, 0.25); N(0.003, 0.1); break; }
        R(big ? 1200 : 2300, big ? 0.006 : 0.0025, big ? 0.22 : 0.11); N(0.001, big ? 0.12 : 0.06); break;
      case 'pulse-break': case 'pulse-make':
        if (hs) { R(2900, 0.002, 0.05); break; }
        R(big ? 1500 : 2800, 0.0025, what === 'pulse-break' ? 0.12 : 0.08); N(0.0008, 0.06); break;
      case 'rotary': for (let k = 0; k < 9; k++) { R(3300 + k * 40, 0.0015, 0.05, k * 0.035); N(0.0006, 0.03, k * 0.035); } break;
    }
    if (this.v.length > 64) this.v.splice(0, this.v.length - 64);
  }
  next() {
    let y = 0;
    for (let i = this.v.length - 1; i >= 0; i--) {
      const o = this.v[i];
      if (o.n++ < 0) continue;
      y += o.noise ? (this.rng.next() * 2 - 1) * o.a : Math.sin(o.ph) * o.a;
      o.ph += o.w; o.a *= o.dec;
      if (o.a < 1e-5) this.v.splice(i, 1);
    }
    return y;
  }
}

class ModemProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.eng = new ModemEngine({});
    this.rs = new Resampler(8000, sampleRate, 32, 256);
    this.mech = new Mech(sampleRate);
    this.line = new Float32Array(256); this.spk = new Float32Array(256); this.li = 0; this.lineT0 = 0;
    this.lastPost = 0; this.alive = true;
    this.port.onmessage = (e) => {
      const d = e.data; if (!d) return;
      if (d.type === 'dispose') { this.alive = false; return; }
      if (d.type === 'debug') { const g = this.eng; this.port.postMessage({ type: 'debug', n: g.n, state: { ...g.state }, evq: g.evq.slice(0, 8).map(x => [x.t, x.kind]), role: g.localRole }); return; }
      this.eng.msg(d);
    };
  }
  process(_in, outputs) {
    if (!this.alive) return false;
    try { return this._process(outputs); }
    catch (err) { // never let one bad segment kill the instrument: report, hang up, keep running
      this.port.postMessage({ type: 'error', message: String(err && err.stack || err) });
      try { this.eng.hangup(true); } catch (e) {}
      return true;
    }
  }
  _process(outputs) {
    const out = outputs[0], L = out[0], R = out[1], eng = this.eng;
    for (let i = 0; i < L.length; i++) {
      const n = this.rs.advance();
      for (let k = 0; k < n; k++) {
        if (this.li === 0) this.lineT0 = eng.n;
        const y = eng.tick(); this.rs.push(y, 0);
        this.spk[this.li] = y; this.line[this.li++] = eng.lineOut;
        if (this.li === 256) { this.port.postMessage({ type: 'line', t0: this.lineT0, data: this.line.slice(), spk: eng.tapOn ? this.spk.slice() : null }); this.li = 0; }
      }
      if (eng.mech.length) { const relay = (eng.model.ch && eng.model.ch.relay) || 'tick'; for (const w of eng.mech) this.mech.add(w, relay, Math.min(1.5, eng.cfg.vol)); eng.mech.length = 0; }
      const s = this.rs.out()[0] + this.mech.next();
      L[i] = s; if (R) R[i] = s;
    }
    if (eng.out.length && (currentTime - this.lastPost > 0.02 || eng.out.some(e => e.kind === 'result' || e.kind === 'hook'))) {
      this.port.postMessage({ type: 'events', list: eng.take() }); this.lastPost = currentTime;
    }
    return true;
  }
}
registerProcessor('retrosynths-modem', ModemProcessor);

/** Secret Notes: forwards microphone input to the main thread in 2048-sample chunks (no processing) */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.i = 0; this.alive = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; }; }
  process(inputs) {
    if (!this.alive) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let k = 0; k < ch.length; k++) { this.buf[this.i++] = ch[k]; if (this.i === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(2048); this.i = 0; } }
    return true;
  }
}
registerProcessor('retrosynths-modem-capture', CaptureProcessor);
