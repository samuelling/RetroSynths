// Placeholder machine: a plain 4-voice square synth. Each real machine module replaces its stub.
import { midiHz, bentNote, gmLevel, panGains, allocVoice } from './util.js';

export function makeStub(info) {
  return class Stub {
    static info = { ...info, spec: info.spec || '(placeholder voice — emulation in progress)' };
    constructor(host) {
      this.h = host; this.age = 0;
      this.v = Array.from({ length: 4 }, () => ({ active: false, on: false, age: 0, ch: 0, note: 0, vel: 0, ph: 0, g: 0, tg: 0 }));
    }
    noteOn(c, note, vel) {
      if (this.h.ch[c].drum) return;
      const v = allocVoice(this.v);
      Object.assign(v, { active: true, on: true, sus: false, age: ++this.age, ch: c, note, vel, g: 0 });
      this.ctrlV(v);
    }
    ctrlV(v) { const ch = this.h.ch[v.ch]; v.tg = this.h.mute[v.ch] ? 0 : gmLevel(ch, v.vel) * 0.25; [v.l, v.r] = panGains(ch); v.inc = midiHz(bentNote(ch, v.note)) / this.h.sampleRate; }
    noteOff(c, note) { for (const v of this.v) if (v.active && v.on && v.ch === c && v.note === note) { if (this.h.ch[c].sustain) v.sus = true; else { v.on = false; v.tg = 0; } } }
    sustainOff(c) { for (const v of this.v) if (v.sus && v.ch === c) { v.sus = false; v.on = false; v.tg = 0; } }
    allOff(c, hard) { for (const v of this.v) if (v.active && v.ch === c) { v.on = false; v.tg = 0; if (hard) v.active = false; } }
    pitch(c) { for (const v of this.v) if (v.active && v.ch === c) this.ctrlV(v); }
    ctrl(c) { for (const v of this.v) if (v.active && v.ch === c) { const on = v.on; this.ctrlV(v); if (!on) v.tg = 0; } }
    reset() { for (const v of this.v) v.active = false; }
    activeCount() { return this.v.filter(v => v.active).length; }
    maxVoices() { return 4; }
    render(L, R, n) {
      L.fill(0, 0, n); R.fill(0, 0, n);
      for (const v of this.v) {
        if (!v.active) continue;
        for (let i = 0; i < n; i++) {
          v.g += (v.tg - v.g) * 0.002; v.ph += v.inc; if (v.ph >= 1) v.ph -= 1;
          const s = (v.ph < 0.5 ? 1 : -1) * v.g; L[i] += s * v.l; R[i] += s * v.r;
        }
        if (!v.on && v.g < 1e-4) v.active = false;
        if (v.g > this.h.meter[v.ch]) this.h.meter[v.ch] = v.g * 4;
      }
    }
  };
}
