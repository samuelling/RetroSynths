// OPL2 / OPL3 patch editor: connection (2-op FM/AM, dual 2-op, 4-op algorithms) with a routing diagram,
// per-operator waveform picker (drawn waveforms: 4 on OPL2, 8 on OPL3), AR/DR/SL/RR with an envelope graph
// in real OPL timing, KSL, KSR, MULT, TL, AM, VIB, EGT, feedback, tuning — plus .op2 bank import.
import { noteName } from '../gm.js';
import { op as mkOp } from './opl-bank.js';

const FG = '#4cff6a', DIM = '#1b6b2a', GRID = '#0a3a0a';
const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
// YM3812 application manual timings (KSR off, low octave): attack 0→max, decay/release over 96 dB, in ms
const ATT_MS = [Infinity, 2826, 1413, 706, 353, 176, 88, 44, 22, 11, 5.52, 2.76, 1.4, 0.7, 0.38, 0];
const DEC_MS = [Infinity, 39280, 19640, 9820, 4910, 2455, 1227, 614, 307, 153, 76.7, 38.4, 19.2, 9.6, 4.8, 2.4];
const WAVES = ['Sine', 'Half sine', 'Abs sine', 'Pulse sine', 'Alt sine', 'Camel', 'Square', 'Log saw'];
function wave(w, p) {          // p in [0,1)
  const s = Math.sin(2 * Math.PI * p);
  switch (w) {
    case 0: return s;
    case 1: return p < 0.5 ? s : 0;
    case 2: return Math.abs(s);
    case 3: return (p % 0.5) < 0.25 ? Math.abs(s) : 0;
    case 4: return p < 0.5 ? Math.sin(4 * Math.PI * p) : 0;
    case 5: return p < 0.5 ? Math.abs(Math.sin(4 * Math.PI * p)) : 0;
    case 6: return p < 0.5 ? 1 : -1;
    case 7: { const x = p < 0.5 ? p * 2 : (p - 0.5) * 2; const v = Math.pow(2, -x * 8); return p < 0.5 ? v : -v; }
  }
  return 0;
}
const ms = (x) => (!isFinite(x) ? '∞' : x >= 1000 ? (x / 1000).toFixed(x >= 10000 ? 0 : 1) + 's' : x >= 10 ? Math.round(x) + 'ms' : (x ? x.toFixed(1) : '0') + 'ms');
const ALG4 = [['FM-FM', '1→2→3→4'], ['FM-AM', '(1→2)+(3→4)'], ['AM-FM', '1+(2→3→4)'], ['AM-AM', '1+(2→3)+4']];

export function mountEditor(el, inst, kit, onChange, ctx) {
  const opl3 = ctx && ctx.Machine && ctx.Machine.info && ctx.Machine.info.id === 'opl3';
  const nW = opl3 ? 8 : 4;
  const fire = () => onChange(inst);
  let fT = 0; const fireSoon = () => { clearTimeout(fT); fT = setTimeout(fire, 50); };
  const mode = () => (inst.four ? 'four' : inst.dual ? 'dual' : '2op');
  const ensureOps = (n) => { while (inst.ops.length < n) inst.ops.push(mkOp(1, inst.ops.length % 2 ? 0 : 30, 15, 4, 4, 7, 0, 1)); };

  function build() {
    el.innerHTML = '';
    const [c1, c2] = kit.columns(el, 2, 'minmax(0, 1fr) minmax(0, 1fr)');
    // ---------------- connection
    const g = kit.group(c1, 'Connection');
    const r = kit.row(g);
    kit.seg(r, { label: 'Mode', options: [['2op', '2-op'], ['dual', 'Dual 2-op'], ['four', '4-op']], value: mode(),
      title: 'Dual = two independent 2-op voices per note (OP2 "double voice"); 4-op = OPL3 channel pair',
      onChange: (m) => { inst.four = m === 'four'; inst.dual = m === 'dual'; if (m !== '2op') ensureOps(4); fire(); build(); } });
    if (inst.four && !opl3) kit.note(g, 'The OPL2 has no 4-op mode: this patch plays as its two 2-op halves here (it is true 4-op on the Sound Blaster 16).');
    const r2 = kit.row(g);
    if (inst.four) kit.seg(r2, { label: 'Algorithm', options: ALG4.map((a, i) => [i, a[0]]), value: ((inst.cnt & 1) << 1) | (inst.cnt2 & 1),
      onChange: (a) => { inst.cnt = a >> 1; inst.cnt2 = a & 1; diag.redraw(); fire(); levelsNote(); } });
    else kit.seg(r2, { label: 'CNT', options: [[0, 'FM'], [1, 'AM (additive)']], value: inst.cnt & 1, onChange: (v) => { inst.cnt = v; diag.redraw(); fire(); } });
    const diag = kit.canvas(g, { width: 420, height: inst.dual ? 120 : 76, draw: drawDiagram });
    kit.slider(g, { label: 'Feedback', min: 0, max: 7, value: inst.fb & 7, title: 'Operator 1 self-modulation (C0 FB)', onInput: (v) => { inst.fb = v; diag.redraw(); fireSoon(); } });
    if (inst.dual) {
      const r3 = kit.row(g);
      kit.seg(r3, { label: 'Voice 2 CNT', options: [[0, 'FM'], [1, 'AM']], value: inst.cnt2 & 1, onChange: (v) => { inst.cnt2 = v; diag.redraw(); fire(); } });
      kit.slider(g, { label: 'Voice 2 FB', min: 0, max: 7, value: inst.fb2 & 7, onInput: (v) => { inst.fb2 = v; diag.redraw(); fireSoon(); } });
    }
    // ---------------- tuning
    const t = kit.group(c2, 'Pitch');
    const rt = kit.row(t);
    kit.toggle(rt, { label: 'Fixed note', value: inst.fixed, title: 'Always play one note (drums)', onChange: (v) => { inst.fixed = v; fire(); build(); } });
    if (inst.fixed) { const nl = { el: null }; kit.number(rt, { label: 'Note', min: 0, max: 127, value: inst.note | 0, onChange: (v) => { inst.note = v; nl.el.textContent = noteName(v); fire(); } }); nl.el = kit.note(rt, noteName(inst.note | 0)); }
    kit.slider(t, { label: 'Transpose', min: -36, max: 36, value: inst.offset | 0, fmt: (v) => (v > 0 ? '+' : '') + v, onInput: (v) => { inst.offset = v; fireSoon(); } });
    if (inst.dual) {
      kit.slider(t, { label: 'V2 transpose', min: -36, max: 36, value: inst.offset2 | 0, fmt: (v) => (v > 0 ? '+' : '') + v, onInput: (v) => { inst.offset2 = v; fireSoon(); } });
      kit.slider(t, { label: 'V2 detune', min: -100, max: 100, value: Math.round((inst.detune || 0) * 100), fmt: (v) => v + '¢', onInput: (v) => { inst.detune = v / 100; fireSoon(); } });
    }
    // ---------------- bank import
    const b = kit.group(c2, 'Bank');
    const rb = kit.row(b);
    const lab = document.createElement('label'); lab.className = 'ed-btn'; lab.textContent = 'Load .OP2 bank…';
    const fi = document.createElement('input'); fi.type = 'file'; fi.accept = '.op2'; fi.hidden = true; lab.appendChild(fi); rb.appendChild(lab);
    const st = kit.note(rb, inst.op2name ? `from .op2: "${inst.op2name}"` : '');
    fi.onchange = async () => {
      const f = fi.files[0]; fi.value = ''; if (!f) return;
      try {
        if (ctx.loadOP2) await ctx.loadOP2(f);
        else if (ctx.applyTable) { const { parseOP2 } = await import('./opl-bank.js'); const list = parseOP2(await f.arrayBuffer()); ctx.applyTable(Object.fromEntries(list.map((p, i) => [i, p]))); }
        st.textContent = `${f.name}: 128 melodic + 47 drum patches loaded into the GM slots`;
      } catch (err) { st.textContent = 'error: ' + err.message; }
    };
    kit.note(b, 'A DMX .op2 (GENMIDI) bank replaces the 175 GM-slot patches (melodic 0–127, drums 35–81). Reset restores a slot.');

    // ---------------- operators
    const n = inst.four || inst.dual ? 4 : 2;
    const roles = opRoles();
    const oc = kit.columns(el, 2, 'minmax(0, 1fr) minmax(0, 1fr)');
    for (let k = 0; k < n; k++) opPanel(oc[k % 2], k, roles[k]);
    function levelsNote() { /* roles may change with the algorithm */ build(); }
    function drawDiagram(c, w, h) {
      c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
      const box = (x, y, label, car) => { c.fillStyle = car ? '#1b4' : '#124'; c.fillRect(x, y, 34, 22); c.strokeStyle = FG; c.strokeRect(x + 0.5, y + 0.5, 33, 21); c.fillStyle = '#efe'; c.font = 'bold 12px monospace'; c.fillText(label, x + 12, y + 15); };
      const arrow = (x1, y1, x2, y2) => { c.strokeStyle = FG; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - 5, y2 - 3); c.lineTo(x2 - 5, y2 + 3); c.fillStyle = FG; c.fill(); };
      const fb = (x, y, amt) => { if (!amt) return; c.strokeStyle = '#f2c63a'; c.beginPath(); c.moveTo(x + 34, y + 11); c.lineTo(x + 40, y + 11); c.lineTo(x + 40, y - 6); c.lineTo(x - 6, y - 6); c.lineTo(x - 6, y + 11); c.lineTo(x, y + 11); c.stroke(); c.fillStyle = '#f2c63a'; c.font = '10px monospace'; c.fillText('fb' + amt, x + 44, y - 1); };
      const out = (x, y) => arrow(x, y, w - 30, y);
      c.fillStyle = '#7f7'; c.font = '10px monospace'; c.fillText('out', w - 26, 14);
      const row = (y, a, b, cnt, fbAmt, lab) => {
        box(20, y, lab[0], cnt === 1); box(120, y, lab[1], true); fb(20, y, fbAmt);
        if (cnt === 1) { c.strokeStyle = FG; c.beginPath(); c.moveTo(37, y + 22); c.lineTo(37, y + 30); c.lineTo(w - 40, y + 30); c.lineTo(w - 40, y + 11); c.stroke(); }
        else arrow(54, y + 11, 118, y + 11);
        out(154, y + 11);
      };
      if (inst.four) {
        const a = ((inst.cnt & 1) << 1) | (inst.cnt2 & 1), y = 30, xs = [20, 100, 180, 260];
        const car = [[3], [1, 3], [0, 3], [0, 2, 3]][a];
        xs.forEach((x, k) => box(x, y, String(k + 1), car.includes(k)));
        fb(20, y, inst.fb & 7);
        const link = [[1, 1, 1], [1, 0, 1], [0, 1, 1], [0, 1, 0]][a];   // 1→2, 2→3, 3→4
        for (let k = 0; k < 3; k++) if (link[k]) arrow(xs[k] + 34, y + 11, xs[k + 1] - 2, y + 11);
        for (const k of car) { c.strokeStyle = FG; c.beginPath(); c.moveTo(xs[k] + 17, y + 22); c.lineTo(xs[k] + 17, y + 36); c.lineTo(w - 40, y + 36); c.lineTo(w - 40, 18); c.stroke(); }
        c.fillStyle = '#7f7'; c.fillText(ALG4[a][1], 20, h - 6);
      } else {
        row(24, 0, 1, inst.cnt & 1, inst.fb & 7, ['M', 'C']);
        if (inst.dual) row(76, 2, 3, inst.cnt2 & 1, inst.fb2 & 7, ['M', 'C']);
      }
    }
  }
  function opRoles() {
    if (inst.four) { const car = [[3], [1, 3], [0, 3], [0, 2, 3]][((inst.cnt & 1) << 1) | (inst.cnt2 & 1)]; return [0, 1, 2, 3].map(k => `Op ${k + 1} · ${car.includes(k) ? 'carrier' : 'modulator'}`); }
    const r2 = (cnt, v) => [`${v}Op 1 · ${cnt ? 'carrier (AM)' : 'modulator'}`, `${v}Op 2 · carrier`];
    return inst.dual ? [...r2(inst.cnt & 1, 'V1 '), ...r2(inst.cnt2 & 1, 'V2 ')] : r2(inst.cnt & 1, '');
  }
  function opPanel(parent, k, title) {
    const p = inst.ops[k];
    const g = kit.group(parent, title);
    // waveform picker: drawn tiles
    const wr = kit.row(g);
    const tiles = [];
    for (let w = 0; w < nW; w++) {
      const cv = document.createElement('canvas'); cv.width = 30; cv.height = 22; cv.title = `${w}: ${WAVES[w]}`;
      cv.style.cssText = 'cursor:pointer;background:#000;box-shadow:inset 1px 1px #808080';
      const draw = () => {
        const c = cv.getContext('2d'); c.fillStyle = (p.ws & 7) === w ? '#123' : '#000'; c.fillRect(0, 0, 30, 22);
        c.strokeStyle = GRID; c.beginPath(); c.moveTo(0, 11); c.lineTo(30, 11); c.stroke();
        c.strokeStyle = (p.ws & 7) === w ? FG : DIM; c.lineWidth = (p.ws & 7) === w ? 2 : 1; c.beginPath();
        for (let x = 0; x < 30; x++) { const y = 11 - wave(w, x / 30) * 8; x ? c.lineTo(x, y) : c.moveTo(x, y); }
        c.stroke();
        if ((p.ws & 7) === w) { c.strokeStyle = '#f2c63a'; c.lineWidth = 1; c.strokeRect(0.5, 0.5, 29, 21); }
      };
      cv.onclick = () => { p.ws = w; tiles.forEach(t => t()); fire(); };
      tiles.push(draw); draw(); wr.appendChild(cv);
    }
    kit.note(wr, WAVES[p.ws & 7]);
    const env = kit.canvas(g, { width: 340, height: 60, draw: (c, w, h) => drawEnv(c, w, h, p) });
    const upd = () => { env.redraw(); fireSoon(); };
    const s = (key, label, max, fmt, title) => kit.slider(g, { label, min: 0, max, value: p[key] | 0, fmt, title, onInput: (v) => { p[key] = v; upd(); } });
    s('ar', 'AR attack', 15, (v) => ms(ATT_MS[v]), 'Attack rate');
    s('dr', 'DR decay', 15, (v) => ms(DEC_MS[v]), 'Decay rate (time for 96 dB)');
    s('sl', 'SL sustain', 15, (v) => (v === 15 ? '−93' : v ? '−' + v * 3 : '0'), 'Sustain level in dB (3 dB steps)');
    s('rr', 'RR release', 15, (v) => ms(DEC_MS[v]), 'Release rate (time for 96 dB)');
    s('tl', 'TL level', 63, (v) => (v ? '−' + (v * 0.75).toFixed(1) : '0'), 'Total level in dB (0.75 dB steps); on a modulator this is the modulation depth');
    s('mult', 'MULT', 15, (v) => '×' + MULT[v], 'Frequency multiplier');
    const fr = kit.row(g);
    kit.seg(fr, { label: 'KSL', options: [[0, '0'], [1, '1.5'], [2, '3'], [3, '6']], value: p.ksl & 3, title: 'Key-scale level (dB/oct)', onChange: (v) => { p.ksl = v; fire(); } });
    const br = kit.row(g);
    kit.bits(br, { items: [{ key: 'am', label: 'AM', value: p.am }, { key: 'vib', label: 'VIB', value: p.vib }, { key: 'egt', label: 'EGT', value: p.egt }, { key: 'ksr', label: 'KSR', value: p.ksr }],
      title: 'AM = tremolo · VIB = vibrato · EGT = sustain while held (off = percussive) · KSR = key-scale rate',
      onChange: (key, v) => { p[key] = v ? 1 : 0; env.redraw(); fire(); } });
  }
  function drawEnv(c, w, h, p) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const ta = ATT_MS[p.ar & 15], td = DEC_MS[p.dr & 15], tr = DEC_MS[p.rr & 15];
    const sl = (p.sl & 15) === 15 ? 93 : (p.sl & 15) * 3;
    const tDec = isFinite(td) ? td * sl / 96 : Infinity;
    let hold = Math.min(3000, Math.max(250, (isFinite(ta) ? ta : 3000) + (isFinite(tDec) ? tDec : 0) + 300));
    const tRel = isFinite(tr) ? Math.min(tr, 3000) : 3000;
    const total = Math.min(6000, hold + tRel + 50);
    const pts = [];
    for (let i = 0; i <= 240; i++) {
      const t = i / 240 * total;
      let att;
      if (!isFinite(ta)) att = 96;
      else if (t < ta) att = 96 * Math.pow(1 - t / ta, 3);                  // exponential-shaped attack
      else {
        const t1 = t - ta;
        att = isFinite(td) ? Math.min(sl, t1 / td * 96) : 0;
        if (att >= sl && !p.egt) { const tt = t1 - tDec; att = sl + (isFinite(tr) ? tt / tr * 96 : 0); }  // percussive: keeps decaying at RR
      }
      if (t > hold) {
        const atHold = (() => { if (!isFinite(ta)) return 96; if (hold < ta) return 96 * Math.pow(1 - hold / ta, 3); const t1 = hold - ta; let a = isFinite(td) ? Math.min(sl, t1 / td * 96) : 0; if (a >= sl && !p.egt) a = sl + (isFinite(tr) ? (t1 - tDec) / tr * 96 : 0); return a; })();
        att = atHold + (isFinite(tr) ? (t - hold) / tr * 96 : 0);
      }
      pts.push([t / total, 1 - Math.min(96, Math.max(0, att)) / 96]);
    }
    c.strokeStyle = GRID; c.beginPath(); for (let k = 1; k < 4; k++) { const y = 3 + k * (h - 6) / 4; c.moveTo(0, y); c.lineTo(w, y); } c.stroke();
    const kx = 3 + hold / total * (w - 6);
    c.strokeStyle = '#e2463b'; c.beginPath(); c.moveTo(kx, 0); c.lineTo(kx, h); c.stroke();
    c.strokeStyle = FG; c.lineWidth = 2; c.beginPath();
    pts.forEach(([x, y], i) => { const X = 3 + x * (w - 6), Y = h - 3 - y * (h - 6); i ? c.lineTo(X, Y) : c.moveTo(X, Y); });
    c.stroke(); c.lineWidth = 1;
    c.fillStyle = '#7f7'; c.font = '10px monospace'; c.fillText(ms(total), w - 44, h - 5); c.fillText(p.egt ? 'sustain' : 'percussive', 4, 11);
  }
  build();
  return { destroy() { clearTimeout(fT); } };
}
