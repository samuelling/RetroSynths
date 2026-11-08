// Atari 2600 instrument editor: AUDC distortion mode with a pitch-reach chart (which notes the mode can
// play and how far out of tune), fallback modes, octave substitution, and AUDV / arpeggio / pitch /
// AUDC / AUDF frame macros. Original code for RetroSynths.
import { AUDC_NAMES, pickTone, NOISE_MODE } from './atari2600.js';
import { TIA, MODE_PERIOD } from './tia.js';
import { macroTabs, driverGroup, noteName } from './atari-editor-common.js';

const PITCHED = [1, 2, 3, 4, 6, 7, 9, 10, 12, 14, 15];

export function mountEditor(el, inst, kit, onChange) {
  inst.alt = inst.alt || [];
  const top = kit.columns(el, 2, 'minmax(230px, 0.8fr) minmax(0, 1.2fr)');

  // ---- left: the TIA channel registers
  const g = kit.group(top[0], 'TIA channel');
  kit.select(g, { label: 'AUDC', options: AUDC_NAMES.map((n, i) => [i, n]), value: inst.audc, onChange: (v) => { inst.audc = v; inst.alt = inst.alt.filter((m) => m !== v); fb.set(); changed(); } });
  const fbBox = document.createElement('div'); g.appendChild(fbBox);
  const fb = { set() {
    fbBox.innerHTML = '';
    if (inst.drum) return;
    kit.bits(fbBox, { label: 'Fallbacks', title: 'Other AUDC modes the driver may use when they are closer in pitch (in this order of preference)',
      items: PITCHED.filter((m) => m !== inst.audc).map((m) => ({ key: m, label: String(m), value: inst.alt.includes(m) })),
      onChange: (k, on) => { inst.alt = on ? [...inst.alt.filter((m) => m !== k), k] : inst.alt.filter((m) => m !== k); changed(); } });
  } };
  fb.set();
  if (!inst.drum) kit.toggle(g, { label: 'Octave substitution', value: inst.octSub !== false, onChange: (v) => { inst.octSub = v; changed(); }, title: 'Allow playing a note an octave (or more) away when that is much closer in tune' });
  kit.note(g, 'AUDF (5 bit) divides the 31,399.5 Hz audio clock; pitch = clock ÷ (pattern × (AUDF+1)).');
  const pat = kit.canvas(g, { width: 220, height: 46, label: 'Output pattern (AUDF 0)', draw: drawPattern });

  // ---- right: pitch reach chart
  const cg = kit.group(top[1], 'Pitch reach (notes C1–C8)');
  const sumHolder = { textContent: '' };
  let sum = sumHolder;
  const chart = kit.canvas(cg, { width: 430, height: 132, draw: drawChart });
  sum = kit.note(cg, sumHolder.textContent);

  function drawPattern(c, w, h) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const t = new TIA(); t.write(0x15, inst.audc & 15); t.write(0x17, 0); t.write(0x19, 15);
    const P = Math.min(220, Math.max(16, MODE_PERIOD[inst.audc & 15] || 32));
    for (let i = 0; i < 600; i++) t.clock();
    c.strokeStyle = '#4cff6a'; c.lineWidth = 1.5; c.beginPath();
    let prev = null;
    for (let i = 0; i < P; i++) {
      const y = t.clock() > 0 ? 8 : h - 8, x0 = i * w / P, x1 = (i + 1) * w / P;
      if (prev === null) c.moveTo(x0, y); else if (prev !== y) c.lineTo(x0, y);
      c.lineTo(x1, y); prev = y;
    }
    c.stroke();
    c.fillStyle = '#9c9'; c.font = '10px monospace'; c.fillText(MODE_PERIOD[inst.audc & 15] ? `period ${MODE_PERIOD[inst.audc & 15]} × (AUDF+1)` : 'constant (volume only)', 4, h - 1);
  }
  function drawChart(c, w, h) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const lo = 24, hi = 108, n = hi - lo + 1, bw = w / n, base = h - 16, scale = (base - 6) / 100;
    c.strokeStyle = '#0a3a0a';
    for (const cents of [25, 50, 100]) { const y = base - cents * scale; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.fillStyle = '#9c9'; c.font = '10px monospace';
    for (let k = lo; k <= hi; k += 12) c.fillText(noteName(k), (k - lo) * bw, h - 3);
    c.fillText('100¢', w - 30, base - 100 * scale + 10); c.fillText('25¢', w - 24, base - 25 * scale - 2);
    if (inst.drum && !inst.track) { c.fillText('fixed-frequency drum (AUDF macro)', 8, 14); sum.textContent = ''; return; }
    if (NOISE_MODE(inst.audc)) { c.fillText('noise / constant mode: AUDF sets colour, not pitch', 8, 14); sum.textContent = ''; return; }
    let tot = 0, cnt = 0, oct = 0, far = 0;
    const modes = inst.drum ? [inst.audc] : [inst.audc, ...inst.alt];
    for (let k = lo; k <= hi; k++) {
      const t = pickTone(modes, k, !inst.drum && inst.octSub !== false);
      const e = Math.min(100, t.cents), x = (k - lo) * bw;
      if (t.cents > 100) { far++; c.fillStyle = '#5a2020'; c.fillRect(x + 0.5, 6, bw - 1, base - 6); continue; }
      tot += t.cents; cnt++; if (t.oct) oct++;
      c.fillStyle = t.oct ? '#3a7bd5' : e < 15 ? '#4cff6a' : e < 40 ? '#f2c63a' : '#e2463b';
      c.fillRect(x + 0.5, base - Math.max(1.5, e * scale), bw - 1, Math.max(1.5, e * scale));
      if (t.audc !== inst.audc) { c.fillStyle = '#fff'; c.fillRect(x + bw / 2 - 1, base + 2, 2, 2); }
    }
    sum.textContent = `bar = tuning error. green < 15¢ · yellow < 40¢ · red worse · blue = octave substituted (${oct}) · dark red = unreachable (${far}) · dot = fallback mode. Mean error ${cnt ? (tot / cnt).toFixed(1) : '—'}¢.`;
  }
  function changed() { pat.redraw(); chart.redraw(); onChange(inst); }

  // ---- macros
  macroTabs(el, kit, inst, onChange, [
    { key: 'vol', label: 'AUDV', min: 0, max: 15, maxLength: 128, hint: 'AUDV per frame (4-bit). Scaled by velocity / CC7 / CC11.' },
    { key: 'arp', label: 'Arpeggio', min: -24, max: 24, zero: 0, fmt: (v) => (v > 0 ? '+' : '') + v + ' st', hint: 'Semitone offset per frame (chords, trills).' },
    { key: 'pitch', label: 'Pitch', min: -96, max: 96, zero: 0, fmt: (v) => (v / 8).toFixed(2) + ' st', hint: 'Pitch offset per frame in 1/8 semitones — on the TIA this jumps between AUDF steps.' },
    { key: 'dist', label: 'AUDC', min: 0, max: 15, init: inst.audc, hint: 'Per-frame distortion override (drums: tone attack → noise body).' },
    { key: 'freq', label: 'AUDF', min: 0, max: 31, init: 0, hint: inst.drum ? (inst.track ? 'AUDF offset from the tracked pitch.' : 'Absolute AUDF per frame.') : 'Used by drum instruments only.' },
  ]);
  driverGroup(el, kit, inst, (v) => { onChange(v); chart.redraw(); fb.set(); }, { frameHz: 59.92 });
  return { destroy() {} };
}
