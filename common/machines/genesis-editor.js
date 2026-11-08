// Genesis instrument editor (DefleMask / Furnace style), main thread.
//   fm:    algorithm picker with a drawn operator-routing diagram (carriers lit), FB / AMS / PMS / LFO rate,
//          four operator columns with every OPN2 operator register and a live envelope graph each
//          (AR → D1R → SL → D2R → key-off → RR, the SSG-EG shape when enabled, scaled by TL).
//   psg:   volume / arpeggio / pitch macros.   noise: volume / noise-mode macros.
//   dac:   sample, playback rate, gain, length, key tracking, with the sample's waveform.
import { CARRIERS } from './genesis-bank.js';
import { SAMPLES, DAC_RATE } from './genesis-drums.js';

const BG = '#000', GRID = '#123d12', FG = '#4cff6a', DIM = '#1b6b2a', CAR = '#f2c63a', TXT = '#c8f5d0';
const LFO_HZ = ['3.98', '5.56', '6.02', '6.37', '6.88', '9.63', '48.1', '72.2'];
const SSG = [[0, 'Off'], [8, '8 \\\\\\\\'], [9, '9 \\___'], [10, '10 \\/\\/'], [11, '11 \\¯¯¯'], [12, '12 ////'], [13, '13 /¯¯¯'], [14, '14 /\\/\\'], [15, '15 /___']];
const NOISE_MODES = ['0 periodic ÷512', '1 periodic ÷1024', '2 periodic ÷2048', '3 periodic ×PSG3', '4 white ÷512', '5 white ÷1024', '6 white ÷2048', '7 white ×PSG3'];

// operator-routing layouts: op positions [col, row] (ops 0..3 = OP1..OP4), modulation edges [from, to]
const ALG = [
  { pos: [[0, 1], [1, 1], [2, 1], [3, 1]], edges: [[0, 1], [1, 2], [2, 3]] },
  { pos: [[0, 0], [0, 2], [1, 1], [2, 1]], edges: [[0, 2], [1, 2], [2, 3]] },
  { pos: [[1, 0], [0, 2], [1, 2], [2, 1]], edges: [[0, 3], [1, 2], [2, 3]] },
  { pos: [[0, 0], [1, 0], [1, 2], [2, 1]], edges: [[0, 1], [1, 3], [2, 3]] },
  { pos: [[0, 0], [1, 0], [0, 2], [1, 2]], edges: [[0, 1], [2, 3]] },
  { pos: [[0, 1], [1, 0], [1, 1], [1, 2]], edges: [[0, 1], [0, 2], [0, 3]] },
  { pos: [[0, 0], [1, 0], [1, 1], [1, 2]], edges: [[0, 1]] },
  { pos: [[0, 0], [1, 0], [2, 0], [3, 0]], edges: [] },
];

function drawAlg(g, w, h, alg, fb) {
  g.fillStyle = BG; g.fillRect(0, 0, w, h);
  const L = ALG[alg], car = CARRIERS[alg];
  const cols = Math.max(...L.pos.map(p => p[0])) + 1, rows = alg === 7 ? 1 : 3;
  const bw = 40, bh = 24, outX = w - 26;
  const gx = (outX - 30) / Math.max(1, cols), x0 = 18, y0 = alg === 7 ? h / 2 - bh / 2 : 10;
  const gy = rows > 1 ? (h - 20 - bh) / (rows - 1) : 0;
  const box = (i) => { const [c, r] = L.pos[i]; return { x: x0 + c * gx + (gx - bw) / 2 * 0.2, y: y0 + r * gy }; };
  g.lineWidth = 2; g.strokeStyle = DIM; g.fillStyle = DIM;
  const arrow = (x1, y1, x2, y2) => {
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    const a = Math.atan2(y2 - y1, x2 - x1);
    g.beginPath(); g.moveTo(x2, y2); g.lineTo(x2 - 7 * Math.cos(a - 0.45), y2 - 7 * Math.sin(a - 0.45)); g.lineTo(x2 - 7 * Math.cos(a + 0.45), y2 - 7 * Math.sin(a + 0.45)); g.fill();
  };
  for (const [a, b] of L.edges) { const A = box(a), B = box(b); arrow(A.x + bw, A.y + bh / 2, B.x - 2, B.y + bh / 2); }
  // output bus
  g.strokeStyle = CAR; g.fillStyle = CAR;
  const ys = car.map(i => box(i).y + bh / 2);
  g.beginPath(); g.moveTo(outX, Math.min(...ys)); g.lineTo(outX, Math.max(...ys)); g.stroke();
  for (const i of car) { const B = box(i); g.beginPath(); g.moveTo(B.x + bw, B.y + bh / 2); g.lineTo(outX, B.y + bh / 2); g.stroke(); }
  arrow(outX, (Math.min(...ys) + Math.max(...ys)) / 2, w - 4, (Math.min(...ys) + Math.max(...ys)) / 2);
  // feedback loop on OP1
  const A = box(0);
  g.strokeStyle = fb ? FG : DIM; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(A.x + bw - 6, A.y); g.lineTo(A.x + bw - 6, A.y - 6); g.lineTo(A.x + 6, A.y - 6); g.lineTo(A.x + 6, A.y); g.stroke();
  // operator boxes
  g.font = 'bold 12px "Lucida Console", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let i = 0; i < 4; i++) {
    const B = box(i), isC = car.includes(i);
    g.fillStyle = isC ? CAR : '#0b2a0f'; g.fillRect(B.x, B.y, bw, bh);
    g.strokeStyle = isC ? '#fff3b0' : FG; g.lineWidth = 1; g.strokeRect(B.x + 0.5, B.y + 0.5, bw - 1, bh - 1);
    g.fillStyle = isC ? '#000' : TXT; g.fillText('OP' + (i + 1), B.x + bw / 2, B.y + bh / 2 + 1);
  }
  g.textAlign = 'right'; g.fillStyle = TXT; g.font = '11px "Lucida Console", monospace';
  g.fillText(`ALG ${alg} · FB ${fb}`, w - 4, 10); g.textAlign = 'left';
}

// --- envelope model for the graph (approximate OPN2 timing: 96 dB at rate 62 ≈ 7 ms, ×2 per 4 rate steps)
const T96 = (r) => r <= 0 ? Infinity : 0.0072 * Math.pow(2, (62 - Math.min(62, r)) / 4);
function drawEnv(g, w, h, op) {
  g.fillStyle = BG; g.fillRect(0, 0, w, h);
  g.strokeStyle = GRID; g.lineWidth = 1;
  for (let db = 0; db <= 96; db += 24) { const y = 4 + (db / 96) * (h - 14); g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  const tlDb = op.tl * 0.75, slDb = op.sl >= 15 ? 93 : op.sl * 3;
  const ta = op.ar >= 31 ? 0 : op.ar === 0 ? Infinity : T96(op.ar * 2) / 6;
  const td = op.d1r === 0 ? Infinity : T96(op.d1r * 2) * slDb / 96;
  const HOLD = 1.0;
  const d2Drop = op.d2r === 0 ? 0 : Math.min(96 - slDb, 96 * HOLD / T96(op.d2r * 2));
  const ssg = op.ssg >= 8;
  // segment display widths: log-compressed durations
  const wOf = (t) => 0.1 + Math.log2(1 + Math.min(t, 60) / 0.004) / 4;
  const segs = [wOf(ta), wOf(Math.min(td, 30)), 1.4, 0];
  const relDb = ssg ? 0 : Math.min(96, slDb + d2Drop);
  const tr = T96(op.rr * 4 + 2) * (96 - relDb) / 96;
  segs[3] = wOf(tr);
  const tot = segs.reduce((a, b) => a + b, 0), W = w - 8;
  const X = [4]; for (const s of segs) X.push(X[X.length - 1] + s / tot * W);
  const yOf = (db) => 4 + Math.min(1, (db + tlDb) / 96) * (h - 14);
  g.strokeStyle = FG; g.lineWidth = 2; g.beginPath();
  // attack (exponential approach in dB)
  if (ta === Infinity) { g.moveTo(X[0], yOf(96)); g.lineTo(X[4], yOf(96)); g.stroke(); label(); return; }
  g.moveTo(X[0], yOf(96));
  for (let k = 1; k <= 16; k++) { const f = k / 16; g.lineTo(X[0] + (X[1] - X[0]) * f, yOf(96 * Math.pow(1 - f, 3))); }
  if (!ssg) {
    // D1R to SL, then D2R
    const dEnd = td === Infinity ? 0 : slDb;
    g.lineTo(X[2], yOf(dEnd));
    g.lineTo(X[3], yOf(Math.min(96, dEnd + (td === Infinity ? 0 : d2Drop))));
    g.lineTo(X[4], yOf(96));
  } else {
    // SSG-EG: the level runs between 0 dB and the 48 dB point and repeats / holds per mode
    const m = op.ssg & 7, inv = (m & 4) !== 0, cyc = 4, x1 = X[1], span = X[3] - X[1];
    const lo = 48, at = (u) => inv ? lo * (1 - u) : lo * u;   // u: 0..1 position within a sweep
    for (let c = 0; c < cyc; c++) {
      const xa = x1 + span * c / cyc, xb = x1 + span * (c + 1) / cyc;
      const alt = (m & 2) && (c & 1), once = (m & 1) && c > 0;
      if (once) { const hold = (m & 2) ? (inv ? lo : 0) : (inv ? 0 : 96 - tlDb); g.lineTo(xa, yOf(Math.min(96, hold))); g.lineTo(xb, yOf(Math.min(96, hold))); continue; }
      if (!alt) { g.lineTo(xa, yOf(at(0))); g.lineTo(xb, yOf(at(1))); } else { g.lineTo(xb, yOf(at(0))); }
    }
    g.lineTo(X[4], yOf(96));
  }
  g.stroke();
  label();
  function label() {
    g.strokeStyle = '#e2463b'; g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(X[3], 2); g.lineTo(X[3], h - 10); g.stroke(); g.setLineDash([]);
    g.fillStyle = TXT; g.font = '9px "Lucida Console", monospace'; g.textAlign = 'left';
    g.fillText('key off', Math.min(X[3] + 3, w - 44), h - 2);
    g.fillText(fmtT(ta) + ' / ' + fmtT(td), 4, h - 2);
  }
}
const fmtT = (t) => t === Infinity ? '∞' : t < 0.001 ? '0' : t < 1 ? Math.round(t * 1000) + 'ms' : t.toFixed(1) + 's';

function drawDac(g, w, h, inst) {
  g.fillStyle = BG; g.fillRect(0, 0, w, h);
  const s = SAMPLES[inst.sample]; if (!s) return;
  const end = Math.max(2, Math.floor(s.length * (inst.len ?? 1)));
  g.strokeStyle = GRID; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  const ex = (end / s.length) * w;
  g.fillStyle = '#0b1f0b'; g.fillRect(ex, 0, w - ex, h);
  g.strokeStyle = FG; g.lineWidth = 1; g.beginPath();
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x / w * s.length), b = Math.max(a + 1, Math.floor((x + 1) / w * s.length));
    let mn = 255, mx = 0; for (let i = a; i < b; i++) { mn = Math.min(mn, s[i]); mx = Math.max(mx, s[i]); }
    const k = x < ex ? (inst.gain ?? 1) : 0.25;
    const y1 = h / 2 - (mx - 128) / 128 * (h / 2 - 2) * k, y2 = h / 2 - (mn - 128) / 128 * (h / 2 - 2) * k;
    g.moveTo(x + 0.5, y1); g.lineTo(x + 0.5, y2 + 1);
  }
  g.stroke();
  g.fillStyle = TXT; g.font = '10px "Lucida Console", monospace';
  const hz = DAC_RATE * (inst.rate || 1);
  g.fillText(`${inst.sample} · ${end} of ${s.length} bytes · ${Math.round(hz)} Hz (C4) · ${(end / hz * 1000).toFixed(0)} ms`, 4, 12);
}

const dtToSigned = (r) => r >= 4 ? -(r - 4) : r;
const signedToDt = (v) => v >= 0 ? v : 4 - v;

export function mountEditor(el, inst, kit, onChange, ctx) {
  const ch = () => onChange(inst);
  const head = kit.row(el);
  kit.note(head, ({
    fm: 'YM2612 FM channel (FM 1–6). Values are the real register fields.',
    psg: 'SN76489 square channel (PSG 1–3). Macros run at 60 Hz frames, as a Genesis driver would.',
    noise: 'SN76489 noise channel. Modes 3 / 7 clock the noise from PSG 3\'s period, so it follows the note (PSG 3 is borrowed).',
    dac: 'FM 6 in DAC mode: 8-bit PCM written to register 0x2A at 13.3 kHz × rate.',
  })[inst.kind] || '');
  if (inst.kind === 'fm') return fmEditor(el, inst, kit, ch);
  if (inst.kind === 'psg' || inst.kind === 'noise') return psgEditor(el, inst, kit, ch);
  if (inst.kind === 'dac') return dacEditor(el, inst, kit, ch);
  kit.note(el, 'Unknown instrument kind.');
  return {};
}

function fmEditor(el, inst, kit, ch) {
  const top = kit.columns(el, 2, 'minmax(0, 380px) minmax(0, 1fr)');
  const gA = kit.group(top[0], 'Algorithm');
  const diag = kit.canvas(gA, { width: 360, height: 126, draw: (g, w, h) => drawAlg(g, w, h, inst.alg, inst.fb) });
  kit.seg(gA, { label: 'ALG', options: [0, 1, 2, 3, 4, 5, 6, 7].map(a => [a, String(a)]), value: inst.alg,
    onChange: (v) => { inst.alg = v; diag.redraw(); relabel(); ch(); } });
  const gC = kit.group(top[1], 'Channel');
  kit.slider(gC, { label: 'FB feedback', min: 0, max: 7, value: inst.fb, title: 'OP1 self-feedback (0 = off)', onInput: (v) => { inst.fb = v; diag.redraw(); ch(); } });
  kit.slider(gC, { label: 'AMS tremolo', min: 0, max: 3, value: inst.ams || 0, fmt: (v) => ['0dB', '1.4dB', '5.9dB', '11.8dB'][v], title: 'LFO amplitude sensitivity (operators with AM on)', onInput: (v) => { inst.ams = v; ch(); } });
  kit.slider(gC, { label: 'PMS vibrato', min: 0, max: 7, value: inst.pms || 0, fmt: (v) => ['0', '3.4¢', '6.7¢', '10¢', '14¢', '20¢', '40¢', '80¢'][v], title: 'LFO pitch sensitivity (± cents)', onInput: (v) => { inst.pms = v; ch(); } });
  kit.slider(gC, { label: 'PMS delay', min: 0, max: 60, value: inst.vibDelay || 0, fmt: (v) => v + 'f', title: 'Driver: frames (60 Hz) before PMS is switched on', onInput: (v) => { inst.vibDelay = v; ch(); } });
  kit.slider(gC, { label: 'Transpose', min: -24, max: 24, value: inst.tr || 0, fmt: (v) => (v > 0 ? '+' : '') + v, onInput: (v) => { inst.tr = v; ch(); } });
  kit.select(gC, { label: 'LFO rate (0x22, global)', value: inst.lfo ?? 1, options: [[-1, 'Off'], ...LFO_HZ.map((t, i) => [i, `${i} · ${t} Hz`])], title: 'Global register: the last note started sets it', onChange: (v) => { inst.lfo = v; ch(); } });

  // operator grid: parameter rows × OP1..OP4 columns
  const gO = kit.group(el, 'Operators (yellow = carrier: its TL also takes velocity and volume)');
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:86px repeat(4,minmax(0,1fr));gap:3px 10px;align-items:center';
  gO.appendChild(grid);
  const cell = (node) => { const d = document.createElement('div'); d.style.minWidth = '0'; if (node) d.appendChild(node); grid.appendChild(d); return d; };
  const lab = (t, title) => { const d = cell(); d.textContent = t; d.className = 'ed-lab'; if (title) d.title = title; return d; };
  lab('');
  const heads = inst.op.map(() => { const d = cell(); d.style.fontWeight = 'bold'; d.style.textAlign = 'center'; return d; });
  lab('Envelope', 'AR → D1R → SL → D2R → key off → RR (dB, log-compressed time; TL lowers the curve)');
  const graphs = inst.op.map((op) => { const d = cell(); return kit.canvas(d, { width: 200, height: 74, draw: (c, w, h) => drawEnv(c, w, h, op) }); });
  const rowOf = (label, title, make) => { lab(label, title); inst.op.forEach((op, i) => make(cell(), op, i)); };
  const rng = (parent, { min, max, value, fmt = String, onInput }) => {
    parent.style.cssText += ';display:grid;grid-template-columns:minmax(40px,1fr) 44px;gap:4px;align-items:center';
    const r = document.createElement('input'); r.type = 'range'; r.min = min; r.max = max; r.value = value; r.style.width = '100%'; r.style.accentColor = 'var(--title)';
    const o = document.createElement('span'); o.className = 'ed-val'; o.textContent = fmt(+value);
    r.oninput = () => { o.textContent = fmt(+r.value); onInput(+r.value); };
    parent.append(r, o);
  };
  const P = (label, title, key, max, fmt) => rowOf(label, title, (c, op, i) => rng(c, { min: 0, max, value: op[key], fmt, onInput: (v) => { op[key] = v; graphs[i].redraw(); ch(); } }));
  P('AR attack', 'Attack rate 0-31 (31 = instant)', 'ar', 31);
  P('D1R decay', 'First decay rate 0-31, down to SL', 'd1r', 31);
  P('SL sustain', 'Sustain level 0-15 (3 dB steps)', 'sl', 15, (v) => v >= 15 ? '-93dB' : `-${v * 3}dB`);
  P('D2R sus.rate', 'Second decay rate 0-31 while held (0 = hold)', 'd2r', 31);
  P('RR release', 'Release rate 0-15', 'rr', 15);
  P('TL level', 'Total level 0-127 (0.75 dB steps)', 'tl', 127, (v) => v ? `-${Math.round(v * 0.75)}dB` : '0dB');
  P('MUL ratio', 'Frequency multiple (0 = ×½)', 'mul', 15, (v) => v === 0 ? '×½' : '×' + v);
  rowOf('DT detune', 'Detune -3..+3 (register 0-7)', (c, op) => rng(c, { min: -3, max: 3, value: dtToSigned(op.dt), fmt: (v) => (v > 0 ? '+' : '') + v, onInput: (v) => { op.dt = signedToDt(v); ch(); } }));
  P('KS key scale', 'Rate scaling by key 0-3', 'ks', 3);
  rowOf('AM', 'Follow the LFO tremolo (with channel AMS)', (c, op) => kit.toggle(c, { label: 'LFO', value: !!op.am, onChange: (v) => { op.am = v ? 1 : 0; ch(); } }));
  rowOf('SSG-EG', 'SSG envelope mode (repeating / inverted shapes)', (c, op, i) => kit.select(c, { value: op.ssg >= 8 ? op.ssg : 0, options: SSG, onChange: (v) => { op.ssg = v; graphs[i].redraw(); ch(); } }));
  function relabel() {
    const car = CARRIERS[inst.alg];
    heads.forEach((d, i) => { const c = car.includes(i); d.textContent = `OP${i + 1} · ${c ? 'carrier' : 'mod'}`; d.style.color = c ? '#7a5a00' : ''; d.style.background = c ? '#f2e3a0' : ''; });
  }
  relabel();
  return { destroy() {} };
}

function psgEditor(el, inst, kit, ch) {
  const isNoise = inst.kind === 'noise';
  const fix = (k, d) => { if (!inst[k] || !Array.isArray(inst[k].values) || !inst[k].values.length) inst[k] = { values: [d], loop: -1, release: -1 }; return inst[k]; };
  const g1 = kit.group(el, 'Volume (4-bit attenuator, 15 = loudest)');
  kit.macro(g1, { label: 'Volume', m: fix('vol', 15), min: 0, max: 15, maxLength: Math.max(48, inst.vol ? inst.vol.values.length : 0), width: 760, height: 110, onChange: ch });
  if (isNoise) {
    const g2 = kit.group(el, 'Noise mode (register 0xE0)');
    kit.macro(g2, { label: 'Noise', m: fix('noise', 4), min: 0, max: 7, maxLength: 32, width: 760, height: 90, fmt: (v) => NOISE_MODES[v], onChange: ch });
    kit.note(g2, NOISE_MODES.join(' · '));
  } else {
    const g2 = kit.group(el, 'Arpeggio (semitones)');
    kit.macro(g2, { label: 'Arpeggio', m: fix('arp', 0), min: -12, max: 24, maxLength: 32, width: 760, height: 90, fmt: (v) => (v > 0 ? '+' : '') + v, onChange: ch });
    const g3 = kit.group(el, 'Pitch (cents, quantised to the 10-bit period)');
    kit.macro(g3, { label: 'Pitch', m: fix('pitch', 0), min: -50, max: 50, maxLength: 32, width: 760, height: 80, fmt: (v) => v + '¢', onChange: ch });
  }
  const r = kit.row(el);
  kit.slider(r, { label: 'Transpose', min: -24, max: 24, value: inst.tr || 0, fmt: (v) => (v > 0 ? '+' : '') + v, onInput: (v) => { inst.tr = v; ch(); } });
  kit.note(r, 'Loop: the held part repeats from the yellow mark. Release: note-off jumps to the red mark (no release = cut).');
  return { destroy() {} };
}

function dacEditor(el, inst, kit, ch) {
  const g = kit.group(el, 'DAC sample (FM 6, register 0x2A)', { cols: 2 });
  const names = Object.keys(SAMPLES);
  let wave = null;
  kit.select(g, { label: 'Sample', value: inst.sample, options: names.map(n => [n, n]), onChange: (v) => { inst.sample = v; wave.redraw(); ch(); } });
  kit.slider(g, { label: 'Rate / pitch', min: 0.25, max: 2.5, step: 0.01, value: inst.rate || 1, fmt: (v) => `×${v.toFixed(2)}`, onInput: (v) => { inst.rate = v; wave.redraw(); ch(); } });
  kit.slider(g, { label: 'Gain', min: 0, max: 1, step: 0.01, value: inst.gain ?? 1, fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { inst.gain = v; wave.redraw(); ch(); } });
  kit.slider(g, { label: 'Length', min: 0.05, max: 1, step: 0.01, value: inst.len ?? 1, fmt: (v) => `${Math.round(v * 100)}%`, onInput: (v) => { inst.len = v; wave.redraw(); ch(); } });
  kit.toggle(g, { label: 'Key track (melodic channels: C4 = rate)', value: inst.keyTrack !== false, onChange: (v) => { inst.keyTrack = v; ch(); } });
  kit.note(g, 'One DAC voice: a new hit replaces the one playing. Samples are synthesised 8-bit originals.');
  const gw = kit.group(el, 'Waveform');
  wave = kit.canvas(gw, { width: 720, height: 150, draw: (c, w, h) => drawDac(c, w, h, inst) });
  return { destroy() {} };
}
