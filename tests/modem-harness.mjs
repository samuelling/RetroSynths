// Offline harness: the AT interpreter + the modem engine wired together synchronously in Node, rendering 8 kHz.
import fs from 'node:fs';
import { ModemEngine } from '../apps/oldschool/modem/session.js';
import { ATModem } from '../apps/oldschool/modem/at.js';

export function makeRig({ model = 'r336', q = 0.85, region = 'na', M = 2, L = 2 } = {}) {
  const eng = new ModemEngine({});
  const term = [];
  const rig = { eng, term, segs: [], events: [], line: [], spk: [], t: 0 };
  const at = new ATModem({
    send: (m) => eng.msg(m), print: (t) => term.push({ t: eng.n / 8000, text: t }), state: () => {},
    connect: () => {}, data: () => {}, quality: () => q,
  }, model, region);
  eng.msg({ type: 'config', model, region, q, M, L, vol: 1 });
  rig.at = at;
  rig.cmd = (s) => { at.input(s); };
  rig.run = (secs, { until } = {}) => {
    const N = Math.round(secs * 8000);
    for (let i = 0; i < N; i++) {
      rig.spk.push(eng.tick()); rig.line.push(eng.lineOut);
      if ((i & 63) === 63) for (const e of eng.take()) { rig.events.push(e); if (e.kind === 'seg') rig.segs.push(e); at.onEngine(e); }
      if (until && (i & 255) === 0 && until(rig)) break;
    }
    for (const e of eng.take()) { rig.events.push(e); if (e.kind === 'seg') rig.segs.push(e); at.onEngine(e); }
    // M is set by AT on dial via config; keep requested speaker mode for capture
  };
  return rig;
}

export function goertzel(x, f, fs = 8000) {
  const w = 2 * Math.PI * f / fs, c = 2 * Math.cos(w); let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / (x.length / 2);
}
export const rms = (x) => { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); };
export function slice(arr, t0, t1, fs = 8000) { return arr.slice(Math.max(0, Math.round(t0 * fs)), Math.round(t1 * fs)); }

export function writeWav(path, samples, rate = 8000) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  fs_mkdir(path); fs.writeFileSync(path, buf);
}
function fs_mkdir(p) { fs.mkdirSync(p.replace(/\/[^/]*$/, ''), { recursive: true }); }
