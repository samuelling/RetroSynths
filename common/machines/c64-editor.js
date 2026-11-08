// Commodore 64 instrument editor (main thread): a GoatTracker-style SID instrument — ADSR in real nibbles with the
// data sheet's timings, a per-frame wave table (waveform / ring / sync / gate bits + note), pulse table, filter table
// with the response of the selected SID model, vibrato / slide, ring-sync source tuning and drum settings.
import { RATE_PERIOD, ATTACK_MS, PAL_CLOCK, cutoff6581, cutoff8580, filterQ } from './sid.js';

const FG = '#4cff6a', DIM = '#1b6b2a', GRID = '#0a3a0a', BG = '#000', AMBER = '#f2c63a', RED = '#e2463b', CYAN = '#5fd3f3';
const NOTE = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
const noteName = (n) => NOTE[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
const hex = (v, d = 2) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(d, '0');
const ms = (t) => t < 1 ? `${Math.round(t * 1000)} ms` : `${(+t.toFixed(2))} s`;
const msOf = (v) => v >= 1000 ? `${v / 1000} s` : `${v} ms`;
const FRAME = 1 / 50.125;

function ensure(inst) {
  const d = (o, k, v) => { if (o[k] == null) o[k] = v; };
  for (const [k, v] of [['a', 0], ['d', 9], ['s', 0], ['r', 0], ['hr', 1], ['gateOff', 0], ['loop', -1], ['transpose', 0]]) d(inst, k, v);
  if (!Array.isArray(inst.wave) || !inst.wave.length) inst.wave = [[0x41, 0, 0]];
  inst.pulse = Object.assign({ width: 0x800, speed: 0, lo: 0x100, hi: 0xf00 }, inst.pulse);
  inst.filter = Object.assign({ route: 0, mode: 0x10, res: 0, cut: 1024, peak: 1024, atk: 0, end: 1024, rate: 0.12, track: 0, vel: 0, lfo: 0, lfoDepth: 0 }, inst.filter);
  inst.vib = Object.assign({ depth: 0, delay: 0, rate: 5.5 }, inst.vib);
  inst.slide = Object.assign({ speed: 0, limit: 24, delay: 0 }, inst.slide);
  inst.src = Object.assign({ ratio: 1, to: 1, frames: 1 }, inst.src);
  inst.drum = Object.assign({ prio: 1, hold: 12 }, inst.drum);
  return inst;
}
function savedModel() {
  try { return JSON.parse(localStorage.getItem('retrosynths.opt.c64.model') || '"6581"') === '8580' ? '8580' : '6581'; } catch { return '6581'; }
}

/** The real envelope, stepped as the chip does it (rate counter × exponential counter), as [seconds, level 0..1] points. */
function envCurve(a, d, s, r, hold) {
  const clk = PAL_CLOCK, pts = [[0, 0]], sus = s * 17;
  const eper = (e) => e > 93 ? 1 : e > 54 ? 2 : e > 26 ? 4 : e > 14 ? 8 : e > 6 ? 16 : 30;
  let t = 0, e = 0;
  const ta = RATE_PERIOD[a] / clk;
  const tAtt = Math.min(hold, 255 * ta);
  e = Math.round(tAtt / ta); t = tAtt; pts.push([t, e / 255]);
  if (e >= 255) {
    const pd = RATE_PERIOD[d] / clk;
    while (e > sus && t < hold) { t += pd * eper(e); e--; if (t <= hold) pts.push([t, e / 255]); }
    if (t > hold) t = hold;
  }
  pts.push([hold, e / 255]); t = hold;
  const pr = RATE_PERIOD[r] / clk;
  while (e > 0) { t += pr * eper(e); e--; pts.push([t, e / 255]); }
  return { pts, end: t, tAtt };
}

/** 12-bit waveform output for an accumulator phase 0..1 (combined waveforms = AND, as emulated). */
function waveAt(bits, ph, pw) {
  const acc = Math.floor(ph * 0x1000000) & 0xffffff;
  let o = 0xfff;
  if (bits & 0x10) o &= ((acc & 0x800000 ? ~acc : acc) >> 11) & 0xfff;
  if (bits & 0x20) o &= acc >> 12;
  if (bits & 0x40) o &= (acc >> 12) >= pw ? 0xfff : 0;
  if (bits & 0x80) o &= ((Math.sin(ph * 9137.3) * 43758.5453) % 1 + 1) % 1 * 0xfff | 0;
  return bits & 0xf0 ? o : 0x800;
}

export function mountEditor(el, inst, kit, onChange, ctx) {
  ensure(inst);
  const ch = () => onChange(inst);
  let model = savedModel();
  const cut = (v) => (model === '8580' ? cutoff8580 : cutoff6581)(v);
  const hz = (v) => { const f = cut(v); return f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`; };

  if (!document.getElementById('c64-ed-style')) {
    const st = document.createElement('style'); st.id = 'c64-ed-style';
    st.textContent = `.c64-wtab .ed-seg{flex-wrap:nowrap;gap:0}.c64-wtab .ed-segbox{flex-wrap:nowrap}
.c64-wtab .ed-segbox button{padding:0 4px;font-size:10px;line-height:16px}.c64-wtab .ed-num{font-size:10px;padding:0 2px}
.c64-wtab .wr{display:flex;align-items:center;gap:5px;padding:1px 3px;cursor:pointer;white-space:nowrap}.c64-wtab .wr.sel{background:#c8d4ff}`;
    document.head.appendChild(st);
  }
  const top = kit.columns(el, 2, 'minmax(0, 1.45fr) minmax(0, 1fr)');

  // ---------------------------------------------------------------- wave table
  const wg = kit.group(top[0], 'Wave table (one row per 50 Hz frame)');
  let selRow = 0;
  const preview = kit.canvas(wg, { width: 460, height: 112, draw: drawWave });
  kit.note(wg, 'Strip = first 32 frames: cyan tri · amber saw · green pulse · grey noise; tall = gate on, white = selected row.');
  const tbl = document.createElement('div'); tbl.className = 'c64-wtab'; wg.appendChild(tbl);
  tbl.style.cssText = 'display:flex;flex-direction:column;gap:1px;max-height:250px;overflow:auto;font-family:"Lucida Console",monospace;font-size:11px;background:#fff;box-shadow:inset 1px 1px #808080;padding:2px';
  const wrow = kit.row(wg);
  kit.button(wrow, '+ Row', () => { inst.wave.push(inst.wave[inst.wave.length - 1].slice()); selRow = inst.wave.length - 1; buildTable(); ch(); });
  kit.button(wrow, 'Insert', () => { inst.wave.splice(selRow, 0, inst.wave[selRow].slice()); if (inst.loop > selRow) inst.loop++; buildTable(); ch(); });
  kit.button(wrow, 'Delete', () => {
    if (inst.wave.length <= 1) return;
    inst.wave.splice(selRow, 1);
    if (inst.loop >= inst.wave.length || inst.loop > selRow) inst.loop = Math.min(inst.loop - (inst.loop > selRow ? 1 : 0), inst.wave.length - 1);
    selRow = Math.min(selRow, inst.wave.length - 1); buildTable(); ch();
  });
  const loopSel = document.createElement('label'); loopSel.className = 'ed-select'; wrow.appendChild(loopSel);
  kit.note(wg, 'After the last row the table jumps to the loop row (or holds the last row). Gate off in a row releases the envelope; gate on again retriggers it.');

  function buildLoop() {
    loopSel.innerHTML = '';
    const sp = document.createElement('span'); sp.className = 'ed-lab'; sp.textContent = 'Loop to'; loopSel.appendChild(sp);
    const s = document.createElement('select'); loopSel.appendChild(s);
    s.add(new Option('— hold last row', -1));
    inst.wave.forEach((_, i) => s.add(new Option(`row ${hex(i)}`, i)));
    s.value = inst.loop;
    s.onchange = () => { inst.loop = +s.value; buildTable(); ch(); };
  }
  function buildTable() {
    tbl.innerHTML = '';
    inst.wave.forEach((e, i) => {
      const r = document.createElement('div'); r.className = 'wr' + (i === selRow ? ' sel' : '');
      r.onclick = (ev) => { if (ev.target.tagName === 'BUTTON' || ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return; selRow = i; buildTable(); };
      const idx = document.createElement('span'); idx.textContent = hex(i).slice(1) + (i === inst.loop ? '↻' : ' '); idx.style.width = '22px'; idx.title = i === inst.loop ? 'loop row' : 'row'; r.appendChild(idx);
      const hx = document.createElement('span'); hx.textContent = hex(e[0]); hx.style.width = '26px'; hx.title = 'control register value ($D404)'; r.appendChild(hx);
      const bits = kit.bits(r, { items: [
        { key: 0x10, label: 'TRI', value: e[0] & 0x10 }, { key: 0x20, label: 'SAW', value: e[0] & 0x20 },
        { key: 0x40, label: 'PUL', value: e[0] & 0x40 }, { key: 0x80, label: 'NOI', value: e[0] & 0x80 },
        { key: 0x04, label: 'RING', value: e[0] & 0x04 }, { key: 0x02, label: 'SYNC', value: e[0] & 0x02 },
        { key: 0x01, label: 'GATE', value: e[0] & 0x01 },
      ], onChange: (k, on) => { e[0] = on ? e[0] | k : e[0] & ~k; hx.textContent = hex(e[0]); selRow = i; preview.redraw(); ch(); } });
      bits.el.title = 'Waveform, ring modulation (tri), hard sync and gate bits for this frame';
      const mode = kit.bits(r, { items: [{ key: 'abs', label: 'ABS', value: !!e[2] }], onChange: (k, v) => {
        e[2] = v ? 1 : 0; e[1] = v ? Math.max(0, Math.min(127, 60 + e[1])) : Math.max(-48, Math.min(48, e[1] - 60)); selRow = i; buildTable(); ch(); } });
      mode.el.title = 'ABS = fixed MIDI note; otherwise semitones relative to the played key';
      kit.number(r, { min: e[2] ? 0 : -48, max: e[2] ? 127 : 48, value: e[1], width: 42, onChange: (v) => { e[1] = v; nl.textContent = lab(); ch(); } });
      const lab = () => e[2] ? noteName(e[1]) : (e[1] >= 0 ? '+' : '') + e[1];
      const nl = document.createElement('span'); nl.textContent = lab(); nl.style.width = '28px'; r.appendChild(nl);
      tbl.appendChild(r);
    });
    buildLoop(); preview.redraw();
  }
  function drawWave(g, w, h) {
    g.fillStyle = BG; g.fillRect(0, 0, w, h);
    const e = inst.wave[Math.min(selRow, inst.wave.length - 1)], bits = e[0];
    const T0 = 16, H = h - 22 - T0;
    g.strokeStyle = GRID; g.beginPath(); g.moveTo(0, T0 + H / 2); g.lineTo(w, T0 + H / 2); g.stroke();
    g.strokeStyle = FG; g.lineWidth = 1.5; g.beginPath();
    for (let x = 0; x <= w; x++) {
      const ph = (x / w * 2) % 1, v = waveAt(bits, ph, inst.pulse.width);
      const y = T0 + 2 + (1 - v / 4095) * (H - 4);
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.fillStyle = FG; g.font = '10px monospace';
    const names = [[0x10, 'TRI'], [0x20, 'SAW'], [0x40, 'PULSE'], [0x80, 'NOISE']].filter(([b]) => bits & b).map(([, n]) => n);
    g.fillText(`row ${hex(selRow)}: ${names.join('&') || 'no waveform (DAC holds)'}${bits & 4 ? ' +RING' : ''}${bits & 2 ? ' +SYNC' : ''}${bits & 1 ? '' : ' · gate off'}`, 4, 11);
    // frame strip: the first 32 frames the table plays
    const n = 32, bw = w / n, L = inst.wave.length;
    for (let t = 0; t < n; t++) {
      const i = t < L ? t : inst.loop >= 0 ? inst.loop + (t - L) % (L - inst.loop) : L - 1, b = inst.wave[i][0];
      g.fillStyle = b & 0x80 ? '#888' : b & 0x40 ? FG : b & 0x20 ? AMBER : b & 0x10 ? CYAN : '#333';
      g.fillRect(t * bw + 1, h - (b & 1 ? 16 : 8), bw - 2, b & 1 ? 12 : 4);
      if (i === selRow) { g.fillStyle = '#fff'; g.fillRect(t * bw + 1, h - 3, bw - 2, 2); }
    }
  }
  buildTable();

  // ---------------------------------------------------------------- ADSR
  const eg = kit.group(top[1], 'Envelope (ADSR, SID nibbles 0–F)');
  const envCv = kit.canvas(eg, { width: 340, height: 120, draw: drawEnv });
  const envP = [
    ['a', 'Attack', (v) => `${hex(v, 1)} ${msOf(ATTACK_MS[v])}`],
    ['d', 'Decay', (v) => `${hex(v, 1)} ${msOf(ATTACK_MS[v] * 3)}`],
    ['s', 'Sustain', (v) => `${hex(v, 1)} ${Math.round(v * 17 / 2.55)}%`],
    ['r', 'Release', (v) => `${hex(v, 1)} ${msOf(ATTACK_MS[v] * 3)}`],
  ];
  for (const [k, label, fmt] of envP) {
    const sl = kit.slider(eg, { label, min: 0, max: 15, value: inst[k], fmt, onInput: (v) => { inst[k] = v; envCv.redraw(); ch(); } });
    sl.el.style.gridTemplateColumns = '64px minmax(60px,1fr) 86px';
  }
  const gr = kit.row(eg);
  kit.toggle(gr, { label: 'Hard restart', value: !!inst.hr, title: 'Gate off + ADSR $00 for two frames before each note (needs the ADSR-bug option on)', onChange: (v) => { inst.hr = v ? 1 : 0; ch(); } });
  kit.number(gr, { label: 'Gate off after', min: 0, max: 500, value: inst.gateOff, width: 50, onChange: (v) => { inst.gateOff = v; envCv.redraw(); ch(); } });
  kit.note(gr, 'frames (0 = key up)');
  function drawEnv(g, w, h) {
    g.fillStyle = BG; g.fillRect(0, 0, w, h);
    const hold = inst.gateOff ? inst.gateOff * FRAME : Math.max(0.25, Math.min(2, (ATTACK_MS[inst.a] + ATTACK_MS[inst.d] * 3) / 1000 * 1.15));
    const { pts, end } = envCurve(inst.a, inst.d, inst.s, inst.r, hold);
    const T = Math.max(end, 0.01) * 1.04, X = (t) => 4 + t / T * (w - 8), Y = (l) => h - 16 - l * (h - 34);
    // time grid
    const step = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10].find(s => T / s <= 6) || 10;
    g.font = '9px monospace'; g.fillStyle = DIM; g.strokeStyle = GRID;
    for (let t = 0; t <= T; t += step) { g.beginPath(); g.moveTo(X(t), 16); g.lineTo(X(t), h - 16); g.stroke(); g.fillText(ms(t), X(t) + 2, h - 5); }
    g.strokeStyle = AMBER; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(hold), 16); g.lineTo(X(hold), h - 16); g.stroke(); g.setLineDash([]);
    g.fillStyle = AMBER; const gx = X(hold); g.textAlign = gx > w - 50 ? 'right' : 'left'; g.fillText('gate off', gx + (gx > w - 50 ? -3 : 3), 26); g.textAlign = 'left';
    g.strokeStyle = FG; g.lineWidth = 2; g.beginPath();
    pts.forEach(([t, l], i) => i ? g.lineTo(X(t), Y(l)) : g.moveTo(X(t), Y(l)));
    g.stroke(); g.lineWidth = 1;
    g.fillStyle = FG; g.fillText(`A ${msOf(ATTACK_MS[inst.a])} · D ${msOf(ATTACK_MS[inst.d] * 3)} · S ${inst.s * 17}/255 · R ${msOf(ATTACK_MS[inst.r] * 3)} (data sheet)`, 4, 10);
  }

  // ---------------------------------------------------------------- pulse
  const pg = kit.group(top[1], 'Pulse table (12-bit width)');
  const pulCv = kit.canvas(pg, { width: 340, height: 56, draw: drawPulse });
  const pct = (v) => `${hex(v, 3)} ${(v / 40.95).toFixed(0)}%`;
  for (const [k, label, min, max, fmt] of [['width', 'Start width', 0, 4095, pct], ['speed', 'PWM speed', -256, 256, (v) => `${v > 0 ? '+' : ''}${v}/fr`],
    ['lo', 'Low limit', 0, 4095, pct], ['hi', 'High limit', 0, 4095, pct]]) {
    const sl = kit.slider(pg, { label, min, max, value: inst.pulse[k], fmt, onInput: (v) => { inst.pulse[k] = v; pulCv.redraw(); preview.redraw(); ch(); } });
    sl.el.style.gridTemplateColumns = '76px minmax(60px,1fr) 74px';
  }
  function drawPulse(g, w, h) {
    g.fillStyle = BG; g.fillRect(0, 0, w, h);
    const p = inst.pulse, cyc = 3, cw = w / cyc;
    if (p.speed) { g.fillStyle = '#103a18'; for (let c = 0; c < cyc; c++) g.fillRect(c * cw + Math.min(p.lo, p.hi) / 4096 * cw, 6, Math.abs(p.hi - p.lo) / 4096 * cw, h - 12); }
    g.strokeStyle = FG; g.lineWidth = 1.5; g.beginPath();
    for (let c = 0; c < cyc; c++) {
      // the comparator: output high while the accumulator's top 12 bits ≥ width
      const x0 = c * cw, xw = x0 + p.width / 4096 * cw;
      g.moveTo(x0, h - 6); g.lineTo(xw, h - 6); g.lineTo(xw, 13); g.lineTo(x0 + cw, 13); g.lineTo(x0 + cw, h - 6);
    }
    g.stroke();
    g.fillStyle = AMBER; g.font = '9px monospace'; g.fillText(p.speed ? 'shaded: PWM sweep range' : 'static width', 4, 8);
  }

  // ---------------------------------------------------------------- filter
  const fgp = kit.group(el, 'Filter table (one filter for the whole chip — goes to the highest-priority voice that wants it)');
  const fc = kit.columns(fgp, 2, 'minmax(0, 1fr) minmax(0, 1fr)');
  const fr = kit.row(fc[0]);
  kit.toggle(fr, { label: 'Route this voice', value: !!inst.filter.route, onChange: (v) => { inst.filter.route = v ? 1 : 0; filCv.redraw(); ch(); } });
  kit.bits(fr, { label: 'Mode', items: [{ key: 0x10, label: 'LP', value: inst.filter.mode & 0x10 }, { key: 0x20, label: 'BP', value: inst.filter.mode & 0x20 }, { key: 0x40, label: 'HP', value: inst.filter.mode & 0x40 }],
    onChange: (k, on) => { inst.filter.mode = on ? inst.filter.mode | k : inst.filter.mode & ~k; filCv.redraw(); ch(); } });
  const cfmt = (v) => `${hex(v, 3)} ${hz(v)}Hz`;
  const fsl = [];
  for (const [k, label, min, max, step, fmt] of [
    ['res', 'Resonance', 0, 15, 1, (v) => `${hex(v, 1)} Q${filterQ(model, v).toFixed(1)}`],
    ['cut', 'Cutoff start', 0, 2047, 1, cfmt], ['peak', 'Sweep to', 0, 2047, 1, cfmt], ['atk', 'in frames', 0, 120, 1, (v) => `${v} fr`],
    ['end', 'Then settle', 0, 2047, 1, cfmt], ['rate', 'Settle rate', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%/fr`],
  ]) {
    const sl = kit.slider(fc[0], { label, min, max, step, value: inst.filter[k], fmt, onInput: (v) => { inst.filter[k] = v; filCv.redraw(); ch(); } });
    sl.el.style.gridTemplateColumns = '80px minmax(60px,1fr) 90px'; fsl.push([sl, k, fmt]);
  }
  const fc2 = fc[1];
  const filCv = kit.canvas(fc2, { width: 360, height: 130, draw: drawFilter });
  const mrow = kit.row(fc2);
  kit.seg(mrow, { label: 'Response for', options: [['6581', '6581'], ['8580', '8580']], value: model, onChange: (v) => { model = v; filCv.redraw(); for (const [sl, k, fmt] of fsl) sl.set(inst.filter[k]); } });
  kit.note(mrow, 'same register value, different chip curve');
  for (const [k, label, min, max, step, fmt] of [
    ['track', 'Key track', -600, 600, 1, (v) => `${v}/oct`], ['vel', 'Velocity', -600, 600, 1, (v) => `${v}`],
    ['lfo', 'LFO rate', 0, 10, 0.05, (v) => `${v} Hz`], ['lfoDepth', 'LFO depth', 0, 1000, 1, (v) => `±${v}`],
  ]) {
    const sl = kit.slider(fc2, { label, min, max, step, value: inst.filter[k], fmt, onInput: (v) => { inst.filter[k] = v; ch(); } });
    sl.el.style.gridTemplateColumns = '80px minmax(60px,1fr) 64px';
  }
  function drawFilter(g, w, h) {
    g.fillStyle = BG; g.fillRect(0, 0, w, h);
    const f = inst.filter, Q = filterQ(model, f.res), fmin = 20, fmax = 20000, dbTop = 18, dbBot = -42;
    const X = (fr) => Math.log(fr / fmin) / Math.log(fmax / fmin) * w, Y = (db) => (dbTop - db) / (dbTop - dbBot) * (h - 12);
    g.font = '9px monospace';
    for (const fr of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.strokeStyle = GRID; g.beginPath(); g.moveTo(X(fr), 0); g.lineTo(X(fr), h - 12); g.stroke(); g.fillStyle = DIM; g.fillText(fr >= 1000 ? fr / 1000 + 'k' : fr, X(fr) + 1, h - 2); }
    for (const db of [12, 0, -12, -24, -36]) { g.strokeStyle = db === 0 ? '#1d5a1d' : GRID; g.beginPath(); g.moveTo(0, Y(db)); g.lineTo(w, Y(db)); g.stroke(); }
    const resp = (fc, col, dash) => {
      g.strokeStyle = col; g.lineWidth = dash ? 1 : 2; g.setLineDash(dash ? [3, 3] : []); g.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const fr = fmin * Math.pow(fmax / fmin, x / w), u = fr / fc;
        // state-variable filter: LP = 1/D, BP = (ju/Q)·Q/D … summed as complex responses, D = 1 − u² + ju/Q
        const dr = 1 - u * u, di = u / Q, dd = dr * dr + di * di;
        let re = 0, im = 0;
        if (f.mode & 0x10) { re += dr / dd; im -= di / dd; }
        if (f.mode & 0x20) { re += u * di / dd; im += u * dr / dd; }       // j·u / D
        if (f.mode & 0x40) { re -= u * u * dr / dd; im += u * u * di / dd; } // −u² / D
        const mag = f.mode & 0x70 ? Math.sqrt(re * re + im * im) : 1;
        const y = Y(Math.max(dbBot, 20 * Math.log10(mag + 1e-9)));
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke(); g.setLineDash([]); g.lineWidth = 1;
    };
    if (f.route && (f.mode & 0x70)) {
      resp(cut(f.cut), DIM, true); if (f.peak !== f.cut && f.atk) resp(cut(f.peak), AMBER, true);
      resp(cut(f.end), FG, false);
    } else { g.strokeStyle = DIM; g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(w, Y(0)); g.stroke(); }
    g.fillStyle = FG; g.fillText(f.route && (f.mode & 0x70) ? `${model}: start ${hz(f.cut)} → ${f.atk ? hz(f.peak) + ' → ' : ''}${hz(f.end)} Hz` : 'not routed through the filter', 4, 10);
  }

  // ---------------------------------------------------------------- pitch / modulation / drum
  const mg = kit.group(el, 'Pitch, vibrato, ring / sync source, drum use', { cols: 3 });
  const S = (o, k, label, min, max, step, fmt) => { const sl = kit.slider(mg, { label, min, max, step, value: o[k], fmt, onInput: (v) => { o[k] = v; ch(); } }); sl.el.style.gridTemplateColumns = '78px minmax(50px,1fr) 60px'; };
  S(inst.vib, 'depth', 'Vibrato', 0, 200, 1, (v) => `${v} ct`);
  S(inst.vib, 'delay', 'Vib delay', 0, 100, 1, (v) => `${v} fr`);
  S(inst.vib, 'rate', 'Vib rate', 0, 20, 0.1, (v) => `${v} Hz`);
  S(inst, 'transpose', 'Transpose', -36, 36, 1, (v) => `${v > 0 ? '+' : ''}${v} st`);
  S(inst.slide, 'speed', 'Slide', -2, 2, 0.01, (v) => `${v > 0 ? '+' : ''}${v}/fr`);
  S(inst.slide, 'limit', 'Slide limit', 0, 48, 1, (v) => `${v} st`);
  S(inst.slide, 'delay', 'Slide delay', 0, 60, 1, (v) => `${v} fr`);
  S(inst.src, 'ratio', 'Src ratio', 0.25, 8, 0.01, (v) => `×${(+v).toFixed(2)}`);
  S(inst.src, 'to', 'Src sweep to', 0.25, 8, 0.01, (v) => `×${(+v).toFixed(2)}`);
  S(inst.src, 'frames', 'Sweep frames', 1, 200, 1, (v) => `${v} fr`);
  S(inst.drum, 'prio', 'Drum prio', 0, 5, 1, (v) => `${v}`);
  S(inst.drum, 'hold', 'Drum hold', 1, 60, 1, (v) => `${v} fr`);
  kit.note(el, 'Ring and sync use the source voice (Voice 3 → 1, 1 → 2, 2 → 3): ring = source at note × ratio, sync = this voice at note × ratio over a source at the note. The player only borrows the source while it is silent; otherwise the RING/SYNC bits are dropped for that frame. Cutoff values are raw 11-bit registers — presets are voiced for the 6581, so they sound brighter on an 8580, as real tunes do.');

  return { destroy() {} };
}
