// NES instrument editor — FamiTracker-style 2A03 instrument: channel, duty, sequences (macros),
// $4001 sweep, noise mode/period, DPCM sample assignment. Main thread only.

import { synthOneShot, loopBits, decode } from './nes-dpcm.js';

const mac = () => ({ values: [], loop: -1, release: -1 });
// macro editor sized to its content: empty macros stay compact, long volume sequences get 128 steps
function M(kit, parent, W, label, m, min, max, o = {}) {
  const long = m.values.length > 48;
  return kit.macro(parent, { label, m, min, max, maxLength: o.maxLength || (long ? 128 : 64), width: W,
    height: m.values.length ? (o.height || 80) : 40, fmt: o.fmt, onChange: o.onChange });
}
const DUTY = [[0, 1, 0, 0, 0, 0, 0, 0], [0, 1, 1, 0, 0, 0, 0, 0], [0, 1, 1, 1, 1, 0, 0, 0], [1, 0, 0, 1, 1, 1, 1, 1]];
const DUTY_TXT = ['12.5%', '25%', '50%', '75%'];
const DMC_P = [428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54];
const NOISE_P = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const CPU = 39375000 / 22;
const hex = (v, n = 2) => '$' + v.toString(16).toUpperCase().padStart(n, '0');
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n) => NOTE[n % 12] + (Math.floor(n / 12) - 1);

function ensure(inst) {
  for (const k of ['vol', 'arp', 'pitch', 'dutyMac', 'xMac']) if (!inst[k] || !Array.isArray(inst[k].values)) inst[k] = mac();
  if (inst.duty == null) inst.duty = 2;
  if (inst.fade == null) inst.fade = 2;
  if (!inst.vib) inst.vib = { speed: 6, depth: 0, delay: 0 };
  if (!inst.sweep) inst.sweep = { en: 0, period: 0, neg: 1, shift: 0 };
  if (inst.kind === 'dpcm') {
    if (!inst.sample) inst.sample = 'Kick';
    for (const [k, v] of [['rate', 15], ['loop', 0], ['track', 0], ['ref', 60], ['level', -1], ['layer', -1]]) if (inst[k] == null) inst[k] = v;
  }
  if (!inst.vol.values.length && inst.kind !== 'dpcm') inst.vol = { values: [15], loop: 0, release: -1 };
}

export function mountEditor(el, inst, kit, onChange, ctx) {
  const changed = () => onChange(inst);
  const W = Math.max(420, Math.min(700, (el.clientWidth || 720) - 24));

  function dutyShape(parent, getDuty) {
    return kit.canvas(parent, {
      width: 168, height: 46,
      draw: (g, w, h) => {
        g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
        const d = DUTY[getDuty() & 3], step = w / 16;
        g.strokeStyle = '#4cff6a'; g.lineWidth = 2; g.beginPath();
        for (let i = 0; i < 16; i++) {
          const y = d[i & 7] ? 8 : h - 8, x = i * step;
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
          g.lineTo(x + step, y);
          const ny = d[(i + 1) & 7] ? 8 : h - 8; if (i < 15) g.lineTo(x + step, ny);
        }
        g.stroke();
      },
    });
  }
  function regLine(parent) { const n = kit.note(parent, ''); n.style.fontFamily = 'monospace'; return n; }

  function render() {
    el.innerHTML = '';
    ensure(inst);
    const kind = inst.kind;
    const top = kit.row(el);
    kit.seg(top, { label: 'Channel', value: kind, options: [['pulse', 'Pulse'], ['triangle', 'Triangle'], ['noise', 'Noise'], ['dpcm', 'DPCM']],
      onChange: (v) => { inst.kind = v; if (v === 'noise') inst.duty = 0; ensure(inst); changed(); render(); } });
    kit.note(top, { pulse: '$4000–$4007 · 11-bit timer · 4-bit constant volume', triangle: '$4008–$400B · 32-step triangle · on/off only',
      noise: '$400C–$400F · 15-bit LFSR · 16 periods', dpcm: '$4010–$4013 · 1-bit delta samples' }[kind]);

    if (kind === 'dpcm') return renderDpcm();

    if (kind === 'pulse') {
      const g = kit.group(el, 'Duty cycle ($4000 bits 7–6)');
      const cols = kit.columns(g, 2, 'minmax(0,1fr) auto');
      let shape;
      kit.seg(cols[0], { label: 'Duty', value: inst.duty & 3, options: DUTY.map((_, i) => [i, DUTY_TXT[i]]), onChange: (v) => { inst.duty = v; shape.redraw(); reg(); changed(); } });
      kit.note(cols[0], 'Duty macro overrides the duty per frame (empty = fixed duty).');
      shape = dutyShape(cols[1], () => (inst.dutyMac.values.length ? inst.dutyMac.values[0] : inst.duty));
      M(kit, g, W, 'Duty macro', inst.dutyMac, 0, 3, { height: 64, fmt: (v) => DUTY_TXT[v], onChange: () => { shape.redraw(); changed(); } });
    }
    if (kind === 'noise') {
      const g = kit.group(el, 'Noise ($400E)');
      const r = kit.row(g);
      kit.seg(r, { label: 'Mode', value: inst.duty & 1, options: [[0, 'Long (32767)'], [1, 'Short (93)']], onChange: (v) => { inst.duty = v; reg(); changed(); } });
      kit.toggle(r, { label: 'Fixed period (macro)', value: inst.xMac.values.length > 0, onChange: (on) => {
        inst.xMac = on ? { values: [8], loop: 0, release: -1 } : mac(); changed(); render(); } });
      M(kit, g, W, 'Mode macro (0 long · 1 short)', inst.dutyMac, 0, 1, { height: 44, onChange: changed });
      if (inst.xMac.values.length) M(kit, g, W, 'Period macro (index 0–F; high index = long period = low pitch)', inst.xMac, 0, 15, { height: 90,
        fmt: (v) => `${hex(v, 1)} = ${NOISE_P[v]} cycles (${Math.round(CPU / NOISE_P[v])} Hz)`, onChange: changed });
      else kit.note(g, 'Period follows the key (higher note → shorter period).');
    }

    const gv = kit.group(el, kind === 'triangle' ? 'Gate (triangle has no volume: > 0 = sounding)' : 'Volume ($4000 / $400C, constant-volume mode)');
    M(kit, gv, W, 'Volume macro', inst.vol, 0, 15, { height: kind === 'triangle' ? 60 : 110, onChange: changed });
    const rr = kit.row(gv);
    kit.slider(rr, { label: 'Release fade', min: 0, max: 15, value: inst.fade | 0, fmt: (v) => (v ? `${v} fr` : 'cut'),
      title: 'Used when the volume macro has no release point: on note-off the volume steps down every N frames (0 = cut).', onInput: (v) => { inst.fade = v; changed(); } });

    const gp = kit.group(el, kind === 'noise' ? 'Pitch (moves the period when it follows the key)' : 'Pitch');
    M(kit, gp, W, 'Arpeggio macro (semitones)', inst.arp, -24, 24, { fmt: (v) => (v > 0 ? '+' : '') + v, onChange: changed });
    if (kind !== 'noise') {
      M(kit, gp, W, 'Pitch macro (timer period, added each frame; + = lower)', inst.pitch, -127, 127, { fmt: (v) => (v > 0 ? '+' : '') + v, onChange: changed });
      const vr = kit.row(gp);
      kit.slider(vr, { label: 'Vibrato speed', min: 0, max: 15, value: inst.vib.speed | 0, title: 'LFO steps per frame (64 = one cycle)', onInput: (v) => { inst.vib.speed = v; changed(); } });
      kit.slider(vr, { label: 'Depth', min: 0, max: 15, value: inst.vib.depth | 0, title: '×0.05 semitone', onInput: (v) => { inst.vib.depth = v; changed(); } });
      kit.slider(vr, { label: 'Delay', min: 0, max: 63, value: inst.vib.delay | 0, title: 'frames before vibrato starts', onInput: (v) => { inst.vib.delay = v; changed(); } });
    }

    if (kind === 'pulse') {
      const gs = kit.group(el, 'Hardware sweep ($4001)');
      const s = inst.sweep, r = kit.row(gs);
      kit.toggle(r, { label: 'Enable', value: !!s.en, onChange: (v) => { s.en = v ? 1 : 0; reg(); changed(); } });
      kit.slider(r, { label: 'Period', min: 0, max: 7, value: s.period | 0, title: 'half-frames (120 Hz) per sweep step, minus one', onInput: (v) => { s.period = v; reg(); changed(); } });
      kit.seg(r, { label: 'Direction', value: s.neg ? 1 : 0, options: [[0, 'Down (add)'], [1, 'Up (negate)']], onChange: (v) => { s.neg = v; reg(); changed(); } });
      kit.slider(r, { label: 'Shift', min: 0, max: 7, value: s.shift | 0, onInput: (v) => { s.shift = v; reg(); changed(); } });
    }
    const regs = regLine(el);
    const reg = () => {
      const v0 = inst.vol.values[0] | 0;
      if (kind === 'pulse') {
        const s = inst.sweep, r1 = s.en ? 0x80 | (s.period << 4) | (s.neg ? 8 : 0) | s.shift : 0x08;
        regs.textContent = `note-on → $4000=${hex(((inst.duty & 3) << 6) | 0x30 | v0)}  $4001=${hex(r1)}  $4002/$4003 = timer (11-bit), length halted`;
      } else if (kind === 'triangle') regs.textContent = `note-on → $4008=${hex(v0 ? 0xFF : 0x80)} (linear counter ${v0 ? 'run' : 'halt'})  $400A/$400B = timer`;
      else regs.textContent = `note-on → $400C=${hex(0x30 | v0)}  $400E=${hex(((inst.duty & 1) << 7) | (inst.xMac.values[0] | 0))}  $400F=$08`;
    };
    reg();
  }

  function renderDpcm() {
    const M = ctx.Machine, names = (M && M.samples) || ['Kick', 'Snare', 'Tom', 'Clap', 'Saw Loop', 'Square Loop'];
    const g = kit.group(el, 'DPCM sample ($4010–$4013)');
    const cols = kit.columns(g, 2, 'minmax(0,1fr) minmax(0,1fr)');
    let shape;
    kit.select(cols[0], { label: 'Sample', value: inst.sample, options: names.map(n => [n, n]), onChange: (v) => { inst.sample = v; if (v.endsWith('Loop')) { inst.loop = 1; inst.track = 1; } shape.redraw(); changed(); render(); } });
    kit.select(cols[0], { label: 'Rate', value: inst.rate, options: DMC_P.map((p, i) => [i, `${hex(i, 1)} · ${(CPU / p / 1000).toFixed(2)} kHz`]), onChange: (v) => { inst.rate = v; reg(); shape.redraw(); changed(); } });
    kit.toggle(cols[0], { label: 'Loop ($4010 bit 6)', value: !!inst.loop, onChange: (v) => { inst.loop = v ? 1 : 0; reg(); changed(); } });
    kit.toggle(cols[1], { label: 'Pitch follows key (nearest rate)', value: !!inst.track, onChange: (v) => { inst.track = v ? 1 : 0; changed(); render(); } });
    if (inst.track && !inst.sample.endsWith('Loop')) kit.number(cols[1], { label: 'Plays rate at key', min: 0, max: 127, value: inst.ref, onChange: (v) => { inst.ref = v; changed(); } });
    if (inst.sample.endsWith('Loop')) kit.note(cols[1], 'Single-cycle loop: the driver picks the loop length (17/33/65 bytes) and rate nearest each note — DPCM bass is famously a little out of tune.');
    kit.number(cols[1], { label: '$4011 load (−1 none)', min: -1, max: 127, value: inst.level, onChange: (v) => { inst.level = v; reg(); changed(); } });
    const P = ctx.presets || [];
    kit.select(cols[1], { label: 'Layer', value: inst.layer, options: [[-1, '— none —'], ...P.map((p, i) => [i, p.name]).filter(([i]) => P[i].kind === 'noise' || P[i].kind === 'triangle')],
      onChange: (v) => { inst.layer = v; changed(); } });
    shape = kit.canvas(g, {
      width: W, height: 80,
      draw: (c, w, h) => {
        c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
        const s = inst.sample, loop = s.endsWith('Loop');
        const bytes = loop ? loopBits(s, 136) : synthOneShot(s, 80), nbits = loop ? 136 * 6 : (bytes.length - 1) * 8;
        const lv = decode(loop ? Uint8Array.from({ length: 17 * 6 }, (_, i) => bytes[i % 17]) : bytes, nbits);
        c.strokeStyle = '#0a3a0a'; for (let y = 0; y <= 127; y += 32) { const py = h - 4 - y / 127 * (h - 8); c.beginPath(); c.moveTo(0, py); c.lineTo(w, py); c.stroke(); }
        c.strokeStyle = '#4cff6a'; c.lineWidth = 1; c.beginPath();
        for (let x = 0; x < w; x++) { const i = Math.floor(x / w * nbits); const py = h - 4 - lv[i] / 127 * (h - 8); x ? c.lineTo(x, py) : c.moveTo(0, py); }
        c.stroke();
        const ms = nbits * DMC_P[inst.rate] / CPU * 1000;
        c.fillStyle = '#2d8f3f'; c.font = '10px monospace';
        c.fillText(`${s} · ${loop ? '17-byte cycle ×6' : (bytes.length - 1) + ' bytes'} · ${ms.toFixed(0)} ms at rate ${hex(inst.rate, 1)} · 7-bit delta counter`, 6, 12);
      },
    });
    const regs = regLine(el);
    const reg = () => { regs.textContent = `note-on → $4015=$0F, $4010=${hex((inst.loop ? 0x40 : 0) | inst.rate)}, $4012/$4013 = address/length${inst.level >= 0 ? `, $4011=${hex(inst.level)}` : ''}, $4015=$1F`; };
    reg();
  }

  render();
  return { destroy() { el.innerHTML = ''; } };
}

