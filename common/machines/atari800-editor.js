// Atari 800 instrument editor: POKEY distortion (AUDC bits 7–5) with its output pattern, clock
// (64 kHz / 15 kHz / 1.79 MHz), 8-bit or joined 16-bit, high-pass pairing, poly9, a tuning chart, and
// AUDC-volume / arpeggio / pitch / distortion / AUDF frame macros. Original code for RetroSynths.
import { DIST_NAMES, CLOCK_NAMES, PAT, toneN } from './atari800.js';
import { POKEY } from './pokey.js';
import { macroTabs, driverGroup, noteName } from './atari-editor-common.js';

export function mountEditor(el, inst, kit, onChange) {
  const top = kit.columns(el, 2, 'minmax(240px, 0.85fr) minmax(0, 1.15fr)');
  const g = kit.group(top[0], 'POKEY channel');
  const ch = () => { pat.redraw(); chart.redraw(); place.textContent = placement(); onChange(inst); };
  kit.select(g, { label: 'Distortion', value: inst.distortion ?? 5, options: DIST_NAMES.map((n, i) => [i, n]), onChange: (v) => { inst.distortion = v; ch(); } });
  kit.seg(g, { label: 'Clock', value: inst.clock ?? 0, options: CLOCK_NAMES.map((n, i) => [i, n]), onChange: (v) => { inst.clock = v; ch(); },
    title: 'AUDCTL: 64 kHz (÷28) or 15 kHz (÷114) base clock — shared by all base-clocked channels — or 1.79 MHz (ch1 / ch3 / pairs)' });
  kit.seg(g, { label: 'Divider', value: inst.bits ?? 8, options: [[8, '8-bit'], [16, '16-bit pair']], onChange: (v) => { inst.bits = v; ch(); },
    title: 'AUDCTL bits 4/3 join ch1+2 or ch3+4 into one 16-bit divider (one voice, fine tuning)' });
  kit.toggle(g, { label: 'High-pass pairing', value: !!inst.hpf, onChange: (v) => { inst.hpf = v; ch(); }, title: 'AUDCTL bits 2/1: ch1 filtered by ch3, ch2 by ch4' });
  kit.slider(g, { label: 'HP detune', min: -50, max: 50, value: inst.hpfDetune || 0, fmt: (v) => `${v} ¢`, onInput: (v) => { inst.hpfDetune = v; onChange(inst); },
    title: 'The filter channel runs at ~2× the tone, offset by this much: the beat sweeps the pulse width' });
  kit.toggle(g, { label: '9-bit poly (AUDCTL bit 7)', value: !!inst.poly9, onChange: (v) => { inst.poly9 = v; onChange(inst); } });
  const place = kit.note(g, '');
  place.textContent = placement();
  const pat = kit.canvas(g, { width: 230, height: 46, label: 'Output pattern', draw: drawPattern });

  const cg = kit.group(top[1], 'Tuning (notes C1–C8)');
  let sum = { textContent: '' };
  const chart = kit.canvas(cg, { width: 420, height: 132, draw: drawChart });
  sum = kit.note(cg, '');
  chart.redraw();

  function placement() {
    if (inst.hpf) return inst.bits === 16 ? 'Plays on ch1+2 (16-bit) filtered by ch4.' : 'Plays on ch1 filtered by ch3 (or ch2 by ch4).';
    if (inst.bits === 16) return 'Plays on a joined pair (ch1+2 or ch3+4); falls back to 8 bits when no pair is free.';
    return inst.clock === 2 ? 'Plays on ch1 or ch3 (only they take 1.79 MHz in 8-bit mode).' : 'Plays on any single channel.';
  }
  function drawPattern(c, w, h) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const p = new POKEY(); p.write(8, 0); p.write(0, 0); p.write(1, ((inst.distortion ?? 5) << 5) | 15);
    const n = Math.max(32, Math.min(230, (PAT[inst.distortion ?? 5] || 60) * 2));
    for (let i = 0; i < 40; i++) p.chunk();
    c.strokeStyle = '#4cff6a'; c.lineWidth = 1.5; c.beginPath();
    let prev = null;
    for (let i = 0; i < n; i++) { const y = p.chunk() * 2 > 15 ? 8 : h - 8; const x0 = i * w / n, x1 = (i + 1) * w / n; if (prev === null) c.moveTo(x0, y); else if (prev !== y) c.lineTo(x0, y); c.lineTo(x1, y); prev = y; }
    c.stroke();
    c.fillStyle = '#9c9'; c.font = '10px monospace';
    c.fillText(PAT[inst.distortion ?? 5] ? `pattern ${PAT[inst.distortion ?? 5]} underflows` : 'noise', 4, h - 1);
  }
  function drawChart(c, w, h) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const lo = 24, hi = 108, nn = hi - lo + 1, bw = w / nn, base = h - 16, sc = (base - 6) / 100;
    c.strokeStyle = '#0a3a0a';
    for (const v of [25, 50, 100]) { const y = base - v * sc; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.fillStyle = '#9c9'; c.font = '10px monospace';
    for (let k = lo; k <= hi; k += 12) c.fillText(noteName(k), (k - lo) * bw, h - 3);
    const d = inst.distortion ?? 5;
    if (!PAT[d]) { c.fillText('noise distortion: AUDF sets the colour', 8, 14); sum.textContent = ''; return; }
    if (inst.drum && !inst.track) { c.fillText('fixed-frequency drum (AUDF macro)', 8, 14); sum.textContent = ''; return; }
    const wide = inst.bits === 16, fast = inst.clock === 2, base_ = inst.clock === 1 ? 114 : 28;
    let tot = 0, cnt = 0, out = 0, sub = 0;
    const tmp = [0, 0];
    for (let k = lo; k <= hi; k++) {
      const hz = 440 * Math.pow(2, (k - 69) / 12);
      let dd = d;
      toneN(dd, hz, wide, fast, base_, tmp);
      if (!wide && tmp[1] > 50 && (dd === 5 || dd === 7)) { dd = 6; toneN(dd, hz, wide, fast, base_, tmp); sub++; }
      const e = tmp[1], x = (k - lo) * bw;
      if (e > 100) { out++; c.fillStyle = '#5a2020'; c.fillRect(x + 0.5, 6, bw - 1, base - 6); continue; }
      tot += e; cnt++;
      c.fillStyle = dd !== d ? '#3a7bd5' : e < 5 ? '#4cff6a' : e < 25 ? '#f2c63a' : '#e2463b';
      c.fillRect(x + 0.5, base - Math.max(1.5, e * sc), bw - 1, Math.max(1.5, e * sc));
    }
    sum.textContent = `bar = tuning error. green < 5¢ · yellow < 25¢ · red worse · blue = driver switched to distortion C (${sub}) · dark red = out of range (${out}). Mean ${cnt ? (tot / cnt).toFixed(1) : '—'}¢.`;
  }

  macroTabs(el, kit, inst, onChange, [
    { key: 'vol', label: 'Volume', min: 0, max: 15, maxLength: 128, hint: 'AUDC volume bits per frame (4-bit). Scaled by velocity / CC7 / CC11.' },
    { key: 'arp', label: 'Arpeggio', min: -24, max: 24, zero: 0, fmt: (v) => (v > 0 ? '+' : '') + v + ' st', hint: 'Semitone offset per frame.' },
    { key: 'pitch', label: 'Pitch', min: -96, max: 96, zero: 0, fmt: (v) => (v / 8).toFixed(2) + ' st', hint: 'Pitch offset per frame in 1/8 semitones.' },
    { key: 'dist', label: 'Distortion', min: 0, max: 7, init: inst.distortion ?? 5, fmt: (v) => DIST_NAMES[v], hint: 'Per-frame distortion override (e.g. noise attack → tone).' },
    { key: 'freq', label: 'AUDF', min: 0, max: 255, init: 0, hint: inst.drum ? (inst.track ? 'AUDF offset from the tracked pitch.' : 'Absolute AUDF per frame at the instrument clock.') : 'Noise distortions: AUDF colour (the key shifts it). Tones: unused.' },
  ]);
  driverGroup(el, kit, inst, (v) => { onChange(v); chart.redraw(); }, { frameHz: 59.92 });
  return { destroy() {} };
}
