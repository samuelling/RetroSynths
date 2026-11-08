// Game Boy instrument editor — DMG register terms: NRx1 duty/length, NRx2 envelope (+ second and release
// envelopes), NR10 sweep (Pulse 1), wave RAM + NR32 level, NR43 noise width/polynomial counter, NR51 pan,
// and tracker macros. Main thread only.

const mac = () => ({ values: [], loop: -1, release: -1 });
// macro editor sized to its content: empty macros stay compact
function M(kit, parent, W, label, m, min, max, o = {}) {
  return kit.macro(parent, { label, m, min, max, maxLength: o.maxLength || (m.values.length > 48 ? 128 : 64), width: W,
    height: m.values.length ? (o.height || 80) : 40, fmt: o.fmt, onChange: o.onChange });
}
const DUTY = [[0, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 1, 1], [0, 1, 1, 1, 1, 1, 1, 0]];
const DUTY_TXT = ['12.5%', '25%', '50%', '75%'];
const FPS = 4194304 / 70224;
const hex = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const LEVEL_TXT = ['Mute', '25%', '50%', '100%'];

function ensure(inst) {
  for (const k of ['arp', 'pitch', 'dutyMac', 'panMac']) if (!inst[k] || !Array.isArray(inst[k].values)) inst[k] = mac();
  if (!inst.vib) inst.vib = { speed: 6, depth: 0, delay: 0 };
  if (!inst.pan) inst.pan = 'auto';
  if (inst.kind === 'wave') {
    if (!Array.isArray(inst.wave) || inst.wave.length !== 32) inst.wave = Array.from({ length: 32 }, (_, k) => Math.round(7.5 + 7.5 * Math.sin(2 * Math.PI * k / 32)));
    if (inst.level == null) inst.level = 3;
    if (!inst.lvlMac || !Array.isArray(inst.lvlMac.values)) inst.lvlMac = mac();
    if (inst.fade == null) inst.fade = 2;
  } else {
    if (inst.duty == null) inst.duty = inst.kind === 'noise' ? 0 : 2;
    if (!inst.env) inst.env = { vol: 15, dir: 0, pace: 3 };
    if (!inst.env2) inst.env2 = { vol: 0, dir: 0, pace: 0, at: 0 };
    if (inst.rel == null) inst.rel = 2;
    if (inst.len == null) inst.len = 0;
    if (inst.kind === 'pulse' && !inst.sweep) inst.sweep = { pace: 0, dir: 0, shift: 0 };
    if (inst.kind === 'noise' && (!inst.poly || !Array.isArray(inst.poly.values))) inst.poly = mac();
  }
}
const nrx2 = (e) => ((e.vol & 15) << 4) | (e.dir ? 8 : 0) | (e.pace & 7);

// the hardware envelope over time (64 Hz steps), note held for `hold` frames, as a 4-bit staircase
function envCurve(inst, frames = 200, hold = 120) {
  const e = inst.env, e2 = inst.env2, out = [];
  let v = e.vol, d = e.dir, p = e.pace, acc = 0, alive = true;
  const lenF = inst.len > 0 ? Math.round(inst.len * FPS / 256) : 0;
  for (let t = 0; t < frames; t++) {
    if (e2 && e2.at > 0 && t === e2.at && t < hold) { v = e2.vol; d = e2.dir; p = e2.pace; acc = 0; }
    if (t === hold) { if (inst.rel === 0) alive = false; else if (inst.rel > 0) { d = 0; p = inst.rel; acc = 0; } else if (d || !p) alive = false; }
    if (lenF && t >= lenF) alive = false;
    out.push(alive ? v : 0);
    if (p > 0) { acc += 64 / FPS; while (acc >= p) { acc -= p; if (d) { if (v < 15) v++; } else if (v > 0) v--; } }
  }
  return out;
}

export function mountEditor(el, inst, kit, onChange, ctx) {
  const changed = () => onChange(inst);
  const W = Math.max(420, Math.min(700, (el.clientWidth || 720) - 24));
  const POLY = (ctx.Machine && ctx.Machine.poly) || [];
  let regs = null, reg = () => {};

  function envGroup(parent) {
    const g = kit.group(parent, 'Envelope (NRx2 hardware envelope, 64 Hz steps)');
    const cols = kit.columns(g, 2, 'minmax(0,1fr) auto');
    let graph;
    const upd = () => { graph.redraw(); reg(); changed(); };
    const e = inst.env, e2 = inst.env2;
    kit.slider(cols[0], { label: 'Initial volume', min: 0, max: 15, value: e.vol, onInput: (v) => { e.vol = v; upd(); } });
    kit.seg(cols[0], { label: 'Direction', value: e.dir, options: [[0, 'Down'], [1, 'Up']], onChange: (v) => { e.dir = v; upd(); } });
    kit.slider(cols[0], { label: 'Pace', min: 0, max: 7, value: e.pace, fmt: (v) => (v ? String(v) : 'hold'), title: 'n/64 s per volume step (0 = hold)', onInput: (v) => { e.pace = v; upd(); } });
    kit.slider(cols[0], { label: '2nd env at', min: 0, max: 120, value: e2.at, fmt: (v) => (v ? `fr ${v}` : 'off'), title: 'Re-trigger with a second NRx2 value mid-note (e.g. swell → sustain)', onInput: (v) => { e2.at = v; upd(); } });
    kit.slider(cols[0], { label: '2nd volume', min: 0, max: 15, value: e2.vol, onInput: (v) => { e2.vol = v; upd(); } });
    kit.seg(cols[0], { label: '2nd dir', value: e2.dir, options: [[0, 'Down'], [1, 'Up']], onChange: (v) => { e2.dir = v; upd(); } });
    kit.slider(cols[0], { label: '2nd pace', min: 0, max: 7, value: e2.pace, fmt: (v) => (v ? String(v) : 'hold'), onInput: (v) => { e2.pace = v; upd(); } });
    kit.slider(cols[0], { label: 'Release', min: -1, max: 7, value: inst.rel, fmt: (v) => (v < 0 ? 'ring' : v === 0 ? 'cut' : String(v)), title: 'On note-off: keep the envelope running, cut, or re-trigger decreasing at this pace', onInput: (v) => { inst.rel = v; upd(); } });
    kit.slider(cols[0], { label: 'Length (NRx1)', min: 0, max: 64, value: inst.len, fmt: (v) => (v ? String(v) : 'off'), title: 'NRx1 sound length in 1/256 s (0 = off)', onInput: (v) => { inst.len = v; upd(); } });
    graph = kit.canvas(cols[1], {
      width: 250, height: 150, label: 'Volume (note-off at the red line)',
      draw: (c, w, h) => {
        c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
        c.strokeStyle = '#0a3a0a'; for (let i = 0; i <= 15; i += 5) { const y = h - 4 - i / 15 * (h - 8); c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
        const pts = envCurve(inst), n = pts.length;
        c.strokeStyle = '#4cff6a'; c.lineWidth = 2; c.beginPath();
        pts.forEach((v, i) => { const x = i / n * w, y = h - 4 - v / 15 * (h - 8); i ? c.lineTo(x, y) : c.moveTo(x, y); c.lineTo((i + 1) / n * w, y); });
        c.stroke();
        c.fillStyle = '#e2463b'; c.fillRect(120 / n * w, 0, 2, h);
        if (e2.at > 0) { c.fillStyle = '#f2c63a'; c.fillRect(e2.at / n * w, 0, 1, h); }
      },
    });
  }
  function panGroup(parent) {
    const g = kit.group(parent, 'Panning (NR51)');
    kit.seg(g, { label: 'Output', value: inst.pan, options: [['auto', 'MIDI pan'], ['L', 'Left'], ['LR', 'Both'], ['R', 'Right']], onChange: (v) => { inst.pan = v; changed(); } });
    M(kit, g, W, 'Pan macro (1 L · 2 R · 3 both; empty = above)', inst.panMac, 0, 3, { height: 50, fmt: (v) => ['—', 'Left', 'Right', 'Both'][v], onChange: changed });
  }
  function pitchGroup(parent) {
    const g = kit.group(parent, 'Pitch');
    M(kit, g, W, 'Arpeggio macro (semitones)', inst.arp, -24, 24, { height: 80, fmt: (v) => (v > 0 ? '+' : '') + v, onChange: changed });
    if (inst.kind !== 'noise') M(kit, g, W, 'Pitch macro (frequency register, added each frame; + = higher)', inst.pitch, -127, 127, { height: 80, fmt: (v) => (v > 0 ? '+' : '') + v, onChange: changed });
    if (inst.kind === 'noise') return;
    const vr = kit.row(g);
    kit.slider(vr, { label: 'Vibrato speed', min: 0, max: 15, value: inst.vib.speed | 0, onInput: (v) => { inst.vib.speed = v; changed(); } });
    kit.slider(vr, { label: 'Depth', min: 0, max: 15, value: inst.vib.depth | 0, title: '×0.05 semitone', onInput: (v) => { inst.vib.depth = v; changed(); } });
    kit.slider(vr, { label: 'Delay', min: 0, max: 63, value: inst.vib.delay | 0, title: 'frames before vibrato starts', onInput: (v) => { inst.vib.delay = v; changed(); } });
  }

  function render() {
    el.innerHTML = '';
    ensure(inst);
    const kind = inst.kind;
    const top = kit.row(el);
    kit.seg(top, { label: 'Channel', value: kind, options: [['pulse', 'Pulse'], ['wave', 'Wave'], ['noise', 'Noise']],
      onChange: (v) => { inst.kind = v; ensure(inst); changed(); render(); } });
    kit.note(top, { pulse: 'CH1/CH2 · f = 131072/(2048−x) · sweep on Pulse 1 only', wave: 'CH3 · 32 × 4-bit wave RAM · f = 65536/(2048−x)', noise: 'CH4 · LFSR clocked by NR43' }[kind]);

    if (kind === 'pulse') {
      const g = kit.group(el, 'Duty (NRx1 bits 7–6)');
      const cols = kit.columns(g, 2, 'minmax(0,1fr) auto');
      let shape;
      kit.seg(cols[0], { label: 'Duty', value: inst.duty & 3, options: DUTY.map((_, i) => [i, DUTY_TXT[i]]), onChange: (v) => { inst.duty = v; shape.redraw(); reg(); changed(); } });
      kit.note(cols[0], 'Duty macro overrides the duty per frame (empty = fixed duty).');
      shape = kit.canvas(cols[1], {
        width: 168, height: 46,
        draw: (c, w, h) => {
          c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
          const d = DUTY[(inst.dutyMac.values.length ? inst.dutyMac.values[0] : inst.duty) & 3], step = w / 16;
          c.strokeStyle = '#4cff6a'; c.lineWidth = 2; c.beginPath();
          for (let i = 0; i < 16; i++) { const y = d[i & 7] ? 8 : h - 8; if (i === 0) c.moveTo(0, y); c.lineTo(i * step, y); c.lineTo((i + 1) * step, y); }
          c.stroke();
        },
      });
      M(kit, g, W, 'Duty macro', inst.dutyMac, 0, 3, { height: 70, fmt: (v) => DUTY_TXT[v], onChange: () => { shape.redraw(); changed(); } });
      envGroup(el);
      const gs = kit.group(el, 'Sweep (NR10 — Pulse 1 only)');
      const s = inst.sweep, r = kit.row(gs);
      kit.slider(r, { label: 'Pace', min: 0, max: 7, value: s.pace, fmt: (v) => (v ? String(v) : 'off'), title: 'n/128 s per sweep step', onInput: (v) => { s.pace = v; reg(); changed(); } });
      kit.seg(r, { label: 'Direction', value: s.dir, options: [[0, 'Up'], [1, 'Down']], onChange: (v) => { s.dir = v; reg(); changed(); } });
      kit.slider(r, { label: 'Shift', min: 0, max: 7, value: s.shift, onInput: (v) => { s.shift = v; reg(); changed(); } });
    }
    if (kind === 'wave') {
      const g = kit.group(el, 'Wave RAM ($FF30–$FF3F, 32 × 4-bit)');
      kit.wave(g, { label: 'Waveform', length: 32, max: 15, values: inst.wave, width: W, height: 128, onChange: () => { reg(); changed(); } });
      const gl = kit.group(el, 'Output level (NR32)');
      kit.seg(gl, { label: 'Level', value: inst.level, options: [[0, 'Mute'], [1, '25%'], [2, '50%'], [3, '100%']], onChange: (v) => { inst.level = v; reg(); changed(); } });
      M(kit, gl, W, 'Level macro (0 mute · 1 25% · 2 50% · 3 100%; empty = fixed)', inst.lvlMac, 0, 3, { height: 60, fmt: (v) => LEVEL_TXT[v], onChange: changed });
      kit.slider(gl, { label: 'Release fade', min: 0, max: 15, value: inst.fade | 0, fmt: (v) => (v ? `${v} fr` : 'cut'), onInput: (v) => { inst.fade = v; changed(); } });
    }
    if (kind === 'noise') {
      const g = kit.group(el, 'Noise (NR43)');
      const r = kit.row(g);
      kit.seg(r, { label: 'Width', value: inst.duty & 1, options: [[0, '15-bit'], [1, '7-bit (tonal)']], onChange: (v) => { inst.duty = v; reg(); changed(); } });
      kit.toggle(r, { label: 'Fixed clock (macro)', value: inst.poly.values.length > 0, onChange: (on) => { inst.poly = on ? { values: [20], loop: 0, release: -1 } : mac(); changed(); render(); } });
      M(kit, g, W, 'Width macro (0 15-bit · 1 7-bit)', inst.dutyMac, 0, 1, { height: 44, onChange: changed });
      if (inst.poly.values.length) kit.macro(g, { label: 'Clock macro (shift/divisor setting, high → low)', m: inst.poly, min: 0, max: Math.max(1, POLY.length - 1), maxLength: 64, width: W, height: 100,
        fmt: (v) => { const p = POLY[v]; return p ? `s=${p.s} r=${p.r} · ${Math.round(p.hz)} Hz` : String(v); }, onChange: changed });
      else kit.note(g, 'Clock follows the key (7-bit mode is tuned: the 127-step sequence plays the note).');
      envGroup(el);
    }
    pitchGroup(el);
    panGroup(el);
    regs = kit.note(el, ''); regs.style.fontFamily = 'monospace';
    reg = () => {
      if (kind === 'pulse') { const s = inst.sweep; regs.textContent = `note-on → NR10=${hex((s.pace << 4) | (s.dir ? 8 : 0) | s.shift)} NRx1=${hex((inst.duty & 3) << 6)} NRx2=${hex(nrx2(inst.env))} NRx4=$80|freq`; }
      else if (kind === 'wave') regs.textContent = `note-on → NR30=$80 NR32=${hex([0, 3, 2, 1][inst.level] << 5)} NR34=$80|freq · RAM ${inst.wave.map(v => v.toString(16).toUpperCase()).join('')}`;
      else { const p = POLY[inst.poly.values[0] | 0] || { s: 0, r: 0 }; regs.textContent = `note-on → NR42=${hex(nrx2(inst.env))} NR43=${hex((p.s << 4) | ((inst.duty & 1) << 3) | p.r)} NR44=$80`; }
    };
    reg();
  }
  render();
  return { destroy() { el.innerHTML = ''; } };
}
