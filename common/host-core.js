// RetroSynths host: MIDI channel state + scheduling + one active machine (with a short crossfade on switch).
// defineHost(machines, name) registers an AudioWorkletProcessor that can play any machine in `machines`.

const SUB = 32;

export class Chan {
  constructor(i) { this.i = i; this.cc = new Uint8Array(128); this.reset(); }
  reset() {
    this.program = 0; this.bank = 0;
    this.cc.fill(0);
    this.cc[7] = 100; this.cc[10] = 64; this.cc[11] = 127; this.cc[91] = 40;
    this.sustain = false; this.bend = 0; this.bendRange = 2; this.pressure = 0;
    this.rpnM = 127; this.rpnL = 127;
    this.drum = this.i === 9;
  }
  get vol() { return this.cc[7]; }
  get expr() { return this.cc[11]; }
  get pan() { return this.cc[10]; }
  get mod() { return this.cc[1]; }
}

export function defineHost(MACHINES, name = 'retrosynths') {
  class HostProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.ch = []; for (let i = 0; i < 16; i++) this.ch.push(new Chan(i));
      this.mute = new Uint8Array(16);
      this.meter = new Float32Array(16);
      this.hostObj = { sampleRate, ch: this.ch, mute: this.mute, meter: this.meter };
      this.inst = {};                       // id → machine instance (lazy)
      this.data = {};                       // id → prep data waiting for instance
      this.cur = null; this.prev = null;    // active and fading-out machine ids
      this.fade = 1; this.fadeStep = 1 / (0.04 * sampleRate);
      this.q = []; this.qi = 0;
      this.master = 0.8;
      this.tL = new Float32Array(SUB); this.tR = new Float32Array(SUB);
      this.pL = new Float32Array(SUB); this.pR = new Float32Array(SUB);
      this.scope = new Float32Array(1024); this.si = 0; this.statN = 0; this.peak = 0;
      this.errors = [];
      this.port.onmessage = (e) => this.onMsg(e.data);
    }
    get(id) {
      if (!id || !MACHINES[id]) return null;
      if (!this.inst[id]) {
        try {
          this.inst[id] = new MACHINES[id](this.hostObj);
          if (this.data[id] !== undefined && this.inst[id].setData) this.inst[id].setData(this.data[id]);
        } catch (err) { this.report(id, err); return null; }
      }
      return this.inst[id];
    }
    report(id, err) {
      const msg = `${id}: ${err && err.message || err}`;
      if (!this.errors.includes(msg)) { this.errors.push(msg); this.port.postMessage({ t: 'error', id, message: msg }); }
    }
    safe(id, fn) { const m = this.get(id); if (!m) return; try { fn(m); } catch (err) { this.report(id, err); } }

    onMsg(m) {
      switch (m.t) {
        case 'ev': {
          let sorted = true;
          const last = this.q.length ? this.q[this.q.length - 1][0] : -Infinity;
          for (const e of m.ev) { if (e[0] < last) sorted = false; this.q.push(e); }
          if (!sorted) { this.q = this.q.slice(this.qi); this.qi = 0; this.q.sort((a, b) => a[0] - b[0]); }
          break;
        }
        case 'now': for (const e of m.ev) this.midi(e[0], e[1], e[2]); break;
        case 'clearq': this.q = []; this.qi = 0; break;
        case 'machine': this.setMachine(m.id); break;
        case 'data': this.data[m.id] = m.data; if (this.inst[m.id] && this.inst[m.id].setData) this.safe(m.id, x => x.setData(m.data)); break;
        case 'option': this.safe(m.id || this.cur, x => x.setOption && x.setOption(m.key, m.value)); break;
        case 'mute': this.mute.set(m.v); for (let c = 0; c < 16; c++) this.safe(this.cur, x => x.ctrl(c)); break;
        case 'master': this.master = m.v; break;
        case 'panic': this.panic(); break;
        case 'reset': this.panic(); for (const c of this.ch) c.reset(); break;
        case 'ping': this.port.postMessage({ t: 'pong', id: m.id }); break;
      }
    }
    setMachine(id) {
      if (id === this.cur || !MACHINES[id]) return;
      if (this.prev) this.safe(this.prev, x => x.reset());
      this.prev = this.cur; this.cur = id; this.fade = this.prev ? 0 : 1;
      this.safe(id, x => x.reset());
    }
    panic() { for (const id of Object.keys(this.inst)) this.safe(id, x => x.reset()); for (const c of this.ch) c.sustain = false; this.q = []; this.qi = 0; }

    midi(st, d1, d2) {
      const type = st & 0xf0, c = st & 15, ch = this.ch[c];
      const id = this.cur;
      switch (type) {
        case 0x90:
          if (d2 > 0) { this.safe(id, x => x.noteOn(c, d1, d2)); break; }
        // falls through: velocity 0 = note off
        case 0x80: this.safe(id, x => x.noteOff(c, d1)); if (this.prev) this.safe(this.prev, x => x.noteOff(c, d1)); break;
        case 0xB0: this.cc(c, d1, d2); break;
        case 0xC0: ch.program = d1; break;
        case 0xD0: ch.pressure = d1 / 127; this.safe(id, x => x.ctrl(c)); break;
        case 0xE0: ch.bend = (((d2 << 7) | d1) - 8192) / 8192; this.safe(id, x => x.pitch(c)); break;
        case 0xF0:
          if (st === 0xFF) { for (const x of this.ch) x.reset(); this.safe(id, x => x.reset()); }
          else if (st === 0xFE) this.ch[d1 & 15].drum = !!d2;
          break;
      }
    }
    cc(c, n, v) {
      const ch = this.ch[c], id = this.cur;
      ch.cc[n] = v;
      switch (n) {
        case 0: ch.bank = v; break;
        case 6: if (ch.rpnM === 0 && ch.rpnL === 0) { ch.bendRange = v; this.safe(id, x => x.pitch(c)); } break;
        case 38: if (ch.rpnM === 0 && ch.rpnL === 0) ch.bendRange = Math.floor(ch.bendRange) + v / 100; break;
        case 101: ch.rpnM = v; break;
        case 100: ch.rpnL = v; break;
        case 98: case 99: ch.rpnM = ch.rpnL = 127; break;
        case 64: { const s = v >= 64; if (ch.sustain && !s) this.safe(id, x => x.sustainOff(c)); ch.sustain = s; break; }
        case 120: this.safe(id, x => x.allOff(c, true)); break;
        case 121: { const b = ch.bank, p = ch.program, d = ch.drum; ch.reset(); ch.bank = b; ch.program = p; ch.drum = d; this.safe(id, x => x.ctrl(c)); break; }
        case 123: case 124: case 125: case 126: case 127: this.safe(id, x => x.allOff(c, false)); break;
        default: this.safe(id, x => x.ctrl(c));
      }
    }

    process(inputs, outputs) {
      const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
      const { tL, tR, pL, pR } = this;
      for (let s0 = 0; s0 < n; s0 += SUB) {
        const fEnd = currentFrame + s0 + SUB, q = this.q;
        while (this.qi < q.length && q[this.qi][0] < fEnd) { const e = q[this.qi++]; this.midi(e[1], e[2], e[3]); }
        if (this.qi > 4096) { this.q = q.slice(this.qi); this.qi = 0; }
        tL.fill(0); tR.fill(0);
        if (this.cur) this.safe(this.cur, x => x.render(tL, tR, SUB));
        if (this.prev && this.fade < 1) {
          pL.fill(0); pR.fill(0);
          this.safe(this.prev, x => x.render(pL, pR, SUB));
          for (let i = 0; i < SUB; i++) {
            this.fade = Math.min(1, this.fade + this.fadeStep);
            tL[i] = tL[i] * this.fade + pL[i] * (1 - this.fade);
            tR[i] = tR[i] * this.fade + pR[i] * (1 - this.fade);
          }
          if (this.fade >= 1) { this.safe(this.prev, x => x.reset()); this.prev = null; }
        }
        const m = this.master;
        for (let i = 0; i < SUB; i++) {
          let l = tL[i] * m, r = tR[i] * m;
          if (l !== l) l = 0; if (r !== r) r = 0;
          l = l > 1 ? 1 : l < -1 ? -1 : l; r = r > 1 ? 1 : r < -1 ? -1 : r;
          L[s0 + i] = l; R[s0 + i] = r;
          const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r); if (a > this.peak) this.peak = a;
          this.scope[this.si] = (l + r) * 0.5; this.si = (this.si + 1) & 1023;
        }
      }
      if (++this.statN >= 12) {
        this.statN = 0;
        const sc = new Float32Array(512);
        for (let i = 0; i < 512; i++) sc[i] = this.scope[(this.si - 512 + i + 1024) & 1023];
        let voices = 0, max = 0;
        if (this.cur) this.safe(this.cur, x => { voices = x.activeCount(); max = x.maxVoices ? x.maxVoices() : 0; });
        this.port.postMessage({ t: 'stat', scope: sc, meter: Array.from(this.meter), peak: this.peak, machine: this.cur, voices, max,
          programs: this.ch.map(c => c.program), banks: this.ch.map(c => c.bank), drums: this.ch.map(c => c.drum) });
        this.meter.fill(0); this.peak = 0;
      }
      return true;
    }
  }
  registerProcessor(name, HostProcessor);
}
