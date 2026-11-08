// Editor widget kit for machine instrument editors (Windows 3.1 look; styles in common/app.css "editor kit").
// Every widget appends itself to `parent` and returns a handle { el, set(value) } where useful.
// Values are plain numbers / strings / arrays; callbacks fire on every user change.

const h = (tag, cls, parent, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; };

/** A framed group. Returns the body element to put widgets in. */
export function group(parent, title, { cols = 1 } = {}) {
  const fs = h('fieldset', 'ed-group', parent);
  if (title) h('legend', null, fs, title);
  const body = h('div', 'ed-body', fs);
  if (cols > 1) { body.style.display = 'grid'; body.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`; body.style.gap = '4px 14px'; }
  return body;
}
/** A horizontal row (wraps on small screens). */
export function row(parent) { return h('div', 'ed-row', parent); }
/** Columns container: returns an array of n column elements. */
export function columns(parent, n, widths) {
  const g = h('div', 'ed-cols', parent);
  g.style.gridTemplateColumns = widths || `repeat(${n}, minmax(0, 1fr))`;
  return Array.from({ length: n }, () => h('div', 'ed-col', g));
}
/** A short note / hint line. */
export function note(parent, text) { return h('div', 'ed-note', parent, text); }

/** Labelled slider with value readout. fmt(v) formats the readout. */
export function slider(parent, { label, min = 0, max = 15, step = 1, value = 0, onInput, fmt = (v) => String(v), title }) {
  const r = h('label', 'ed-slider', parent);
  if (title) r.title = title;
  h('span', 'ed-lab', r, label);
  const inp = h('input', null, r); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
  const out = h('span', 'ed-val', r, fmt(+value));
  inp.oninput = () => { out.textContent = fmt(+inp.value); onInput && onInput(+inp.value); };
  return { el: r, set(v) { inp.value = v; out.textContent = fmt(+v); } };
}
/** Labelled dropdown. options = [[value, text], …] */
export function select(parent, { label, options, value, onChange, title }) {
  const r = h('label', 'ed-select', parent);
  if (title) r.title = title;
  if (label) h('span', 'ed-lab', r, label);
  const s = h('select', null, r);
  options.forEach(([v, t], i) => { const o = new Option(t, i); s.add(o); if (JSON.stringify(v) === JSON.stringify(value)) s.selectedIndex = i; });
  s.onchange = () => onChange && onChange(options[s.selectedIndex][0]);
  return { el: r, set(v) { const i = options.findIndex(([x]) => JSON.stringify(x) === JSON.stringify(v)); if (i >= 0) s.selectedIndex = i; } };
}
/** Checkbox. */
export function toggle(parent, { label, value, onChange, title }) {
  const r = h('label', 'ed-toggle', parent);
  if (title) r.title = title;
  const c = h('input', null, r); c.type = 'checkbox'; c.checked = !!value;
  h('span', null, r, label);
  c.onchange = () => onChange && onChange(c.checked);
  return { el: r, set(v) { c.checked = !!v; } };
}
/** Segmented push-buttons (pick one). options = [[value, text], …] */
export function seg(parent, { label, options, value, onChange, title }) {
  const r = h('div', 'ed-seg', parent);
  if (title) r.title = title;
  if (label) h('span', 'ed-lab', r, label);
  const box = h('span', 'ed-segbox', r);
  const btns = options.map(([v, t]) => {
    const b = h('button', null, box, t); b.type = 'button';
    b.onclick = () => { btns.forEach(x => x.classList.remove('on')); b.classList.add('on'); onChange && onChange(v); };
    if (JSON.stringify(v) === JSON.stringify(value)) b.classList.add('on');
    return b;
  });
  return { el: r, set(v) { btns.forEach((b, i) => b.classList.toggle('on', JSON.stringify(options[i][0]) === JSON.stringify(v))); } };
}
/** Several independent toggle buttons (e.g. SID waveform bits). items = [{ key, label, value }] → onChange(key, bool) */
export function bits(parent, { label, items, onChange, title }) {
  const r = h('div', 'ed-seg', parent);
  if (title) r.title = title;
  if (label) h('span', 'ed-lab', r, label);
  const box = h('span', 'ed-segbox', r);
  const btns = items.map((it) => {
    const b = h('button', null, box, it.label); b.type = 'button'; b.classList.toggle('on', !!it.value);
    b.onclick = () => { b.classList.toggle('on'); onChange && onChange(it.key, b.classList.contains('on')); };
    return b;
  });
  return { el: r, set(key, v) { const i = items.findIndex(x => x.key === key); if (i >= 0) btns[i].classList.toggle('on', !!v); } };
}
/** Number box. */
export function number(parent, { label, min, max, step = 1, value, onChange, width = 56 }) {
  const r = h('label', 'ed-select', parent);
  if (label) h('span', 'ed-lab', r, label);
  const i = h('input', 'ed-num', r); i.type = 'number'; i.min = min; i.max = max; i.step = step; i.value = value; i.style.width = width + 'px';
  i.onchange = () => { let v = Math.max(min, Math.min(max, +i.value)); i.value = v; onChange && onChange(v); };
  return { el: r, set(v) { i.value = v; } };
}
/** A button. */
export function button(parent, label, onClick, title) { const b = h('button', 'ed-btn', parent, label); b.type = 'button'; if (title) b.title = title; b.onclick = onClick; return b; }

/** A canvas you draw yourself. draw(ctx, w, h) is called on redraw(). Pointer handlers optional. */
export function canvas(parent, { width = 320, height = 120, draw, onPointer, label } = {}) {
  const wrap = h('div', 'ed-canvas', parent);
  if (label) h('div', 'ed-lab', wrap, label);
  const c = h('canvas', null, wrap); c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  const redraw = () => { ctx.clearRect(0, 0, c.width, c.height); draw && draw(ctx, c.width, c.height); };
  if (onPointer) {
    let down = false;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * c.width, (e.clientY - r.top) / r.height * c.height]; };
    c.style.touchAction = 'none'; c.style.cursor = 'crosshair';
    c.addEventListener('pointerdown', (e) => { down = true; c.setPointerCapture(e.pointerId); onPointer('down', ...pos(e), e); });
    c.addEventListener('pointermove', (e) => { if (down) onPointer('move', ...pos(e), e); });
    c.addEventListener('pointerup', (e) => { down = false; onPointer('up', ...pos(e), e); });
  }
  redraw();
  return { el: wrap, canvas: c, ctx, redraw };
}

const GRID = '#0a3a0a', FG = '#4cff6a', DIM = '#1b6b2a', BG = '#000';

/**
 * Wavetable drawer: `length` steps of 0..max (e.g. 32 × 4-bit → max 15). values is mutated in place.
 * Draw with the mouse/finger; shape buttons fill standard waves.
 */
export function wave(parent, { label = 'Waveform', length = 32, max = 15, values, onChange, width = 384, height = 128 }) {
  const box = h('div', 'ed-wave', parent);
  let last = -1;
  const cv = canvas(box, {
    width, height, label,
    draw: (g, w, hh) => {
      g.fillStyle = BG; g.fillRect(0, 0, w, hh);
      g.strokeStyle = GRID; g.lineWidth = 1;
      for (let i = 0; i <= max; i++) { const y = hh - (i + 0.5) * hh / (max + 1); if (i % 4 === 0) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); } }
      const bw = w / length;
      for (let i = 0; i < length; i++) {
        const v = values[i], y = hh - (v + 1) * hh / (max + 1);
        g.fillStyle = DIM; g.fillRect(i * bw + 1, y, bw - 2, hh - y);
        g.fillStyle = FG; g.fillRect(i * bw + 1, y, bw - 2, Math.max(2, hh / (max + 1) * 0.35));
      }
    },
    onPointer: (kind, x, y) => {
      if (kind === 'up') { last = -1; onChange && onChange(values); return; }
      const i = Math.max(0, Math.min(length - 1, Math.floor(x / width * length)));
      const v = Math.max(0, Math.min(max, Math.round((1 - y / height) * (max + 1) - 0.5)));
      if (last >= 0 && last !== i) { const a = Math.min(last, i), b = Math.max(last, i), va = values[last]; for (let k = a; k <= b; k++) values[k] = Math.round(va + (v - va) * (k - last) / (i - last)); }
      values[i] = v; last = i; cv.redraw();
      if (kind === 'move') onChange && onChange(values);
    },
  });
  const r = row(box);
  const fill = (fn) => { for (let i = 0; i < length; i++) values[i] = Math.max(0, Math.min(max, Math.round(fn(i / length) * max))); cv.redraw(); onChange && onChange(values); };
  button(r, 'Sine', () => fill(p => 0.5 + 0.5 * Math.sin(2 * Math.PI * p)));
  button(r, 'Tri', () => fill(p => p < 0.5 ? p * 2 : 2 - p * 2));
  button(r, 'Saw', () => fill(p => p));
  button(r, 'Square', () => fill(p => p < 0.5 ? 1 : 0));
  button(r, 'Pulse', () => fill(p => p < 0.25 ? 1 : 0));
  button(r, 'Noise', () => fill(() => Math.random()));
  button(r, 'Smooth', () => { const c = values.slice(); for (let i = 0; i < length; i++) values[i] = Math.round((c[(i + length - 1) % length] + 2 * c[i] + c[(i + 1) % length]) / 4); cv.redraw(); onChange && onChange(values); });
  button(r, 'Invert', () => { for (let i = 0; i < length; i++) values[i] = max - values[i]; cv.redraw(); onChange && onChange(values); });
  return { el: box, redraw: cv.redraw, set(v) { for (let i = 0; i < length; i++) values[i] = v[i]; cv.redraw(); } };
}

/**
 * FamiTracker-style macro (per-frame sequence) editor.
 * m = { values: number[], loop: -1|index, release: -1|index }  (mutated in place)
 * min/max bound each step; maxLength caps the sequence length. Draw bars; set length/loop/release below.
 */
export function macro(parent, { label, m, min = 0, max = 15, maxLength = 64, onChange, width = 512, height = 110, fmt = (v) => String(v), zero = null }) {
  const box = h('div', 'ed-macro', parent);
  const span = max - min;
  const z = zero == null ? (min < 0 ? 0 : min) : zero;
  const cv = canvas(box, {
    width, height, label: label + ' (frames)',
    draw: (g, w, hh) => {
      g.fillStyle = BG; g.fillRect(0, 0, w, hh);
      const n = maxLength, bw = w / n;
      const yOf = (v) => hh - ((v - min) + 0.5) / (span + 1) * hh;
      g.strokeStyle = GRID; g.beginPath(); g.moveTo(0, yOf(z)); g.lineTo(w, yOf(z)); g.stroke();
      for (let i = 0; i < m.values.length; i++) {
        const v = m.values[i], y = yOf(v), y0 = yOf(z);
        g.fillStyle = i >= m.loop && m.loop >= 0 && (m.release < 0 || i < m.release) ? '#2d8f3f' : DIM;
        g.fillRect(i * bw + 1, Math.min(y, y0), bw - 2, Math.max(2, Math.abs(y0 - y)));
        g.fillStyle = FG; g.fillRect(i * bw + 1, y - 1, bw - 2, 2);
      }
      g.fillStyle = '#333'; g.fillRect(m.values.length * bw, 0, w - m.values.length * bw, hh);
      if (m.loop >= 0) { g.fillStyle = '#f2c63a'; g.fillRect(m.loop * bw, 0, 2, hh); }
      if (m.release >= 0) { g.fillStyle = '#e2463b'; g.fillRect(m.release * bw, 0, 2, hh); }
    },
    onPointer: (kind, x, y) => {
      if (kind === 'up') { onChange && onChange(m); return; }
      const i = Math.floor(x / width * maxLength);
      if (i >= m.values.length) return;
      m.values[i] = Math.max(min, Math.min(max, Math.round(min + (1 - y / height) * (span + 1) - 0.5)));
      cv.redraw(); readout.textContent = `step ${i}: ${fmt(m.values[i])}`;
    },
  });
  const r = row(box);
  number(r, { label: 'Length', min: 1, max: maxLength, value: m.values.length, onChange: (v) => {
    while (m.values.length < v) m.values.push(m.values.length ? m.values[m.values.length - 1] : z);
    m.values.length = v; if (m.loop >= v) m.loop = -1; if (m.release >= v) m.release = -1; cv.redraw(); onChange && onChange(m); } });
  number(r, { label: 'Loop', min: -1, max: maxLength - 1, value: m.loop, onChange: (v) => { m.loop = v < m.values.length ? v : -1; cv.redraw(); onChange && onChange(m); } });
  number(r, { label: 'Release', min: -1, max: maxLength - 1, value: m.release, onChange: (v) => { m.release = v < m.values.length ? v : -1; cv.redraw(); onChange && onChange(m); } });
  const readout = h('span', 'ed-note', r, 'yellow = loop · red = release');
  return { el: box, redraw: cv.redraw };
}

/**
 * Envelope group: sliders for each param + a live graph. params = [{ key, label, min, max, fmt }]
 * env is mutated in place. curve(env) → array of [t 0..1, level 0..1] points to plot.
 */
export function envelope(parent, { label = 'Envelope', params, env, curve, onChange, width = 260, height = 90 }) {
  const g = group(parent, label);
  const cols = columns(g, 2, 'minmax(0, 1fr) auto');
  const cv = canvas(cols[1], {
    width, height,
    draw: (c, w, hh) => {
      c.fillStyle = BG; c.fillRect(0, 0, w, hh);
      const pts = curve ? curve(env) : [];
      c.strokeStyle = FG; c.lineWidth = 2; c.beginPath();
      pts.forEach(([t, l], i) => { const x = 4 + t * (w - 8), y = hh - 4 - l * (hh - 8); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
    },
  });
  for (const p of params) slider(cols[0], { label: p.label, min: p.min, max: p.max, step: p.step || 1, value: env[p.key], fmt: p.fmt, title: p.title,
    onInput: (v) => { env[p.key] = v; cv.redraw(); onChange && onChange(env); } });
  return { el: g, redraw: cv.redraw };
}

export const kit = { group, row, columns, note, slider, select, toggle, seg, bits, number, button, canvas, wave, macro, envelope };
export default kit;
