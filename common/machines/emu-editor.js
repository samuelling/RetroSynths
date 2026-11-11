// AWE32 / Live! instrument editor: the loaded SoundFont's preset → zones browser, with generator overrides
// layered on top (Global = offset applied to every zone; Zone = absolute value for one zone): volume envelope
// (DAHDSR), modulation envelope → filter/pitch, initial filter cutoff/Q, both LFOs, tuning, attenuation, pan,
// reverb/chorus send. Drawn envelope and filter response. The SoundFont itself is never rewritten.
import { noteName } from '../gm.js';
import { getMeta, emuEvents } from './emu-prep.js';
import { GEN_RANGE, presetName } from './emu-presets.js';

const FG = '#4cff6a', GRID = '#0a3a0a', DIM = '#1b6b2a';
const tc2s = (tc) => (tc <= -12000 ? 0 : Math.pow(2, tc / 1200));
const sec = (tc) => { const s = tc2s(tc); return s === 0 ? '0' : s >= 1 ? s.toFixed(2) + 's' : Math.round(s * 1000) + 'ms'; };
const hz = (c) => { const f = 8.176 * Math.pow(2, c / 1200); return f >= 1000 ? (f / 1000).toFixed(1) + 'k' : f.toFixed(f < 10 ? 2 : 0); };
const cb = (v) => (v / 10).toFixed(1) + 'dB';
const pct = (v) => (v / 10).toFixed(0) + '%';
const signed = (u) => (v) => (v > 0 ? '+' : '') + v + u;
const GROUPS = [
  ['Volume envelope', [[33, 'Delay', sec], [34, 'Attack', sec], [35, 'Hold', sec], [36, 'Decay', sec], [37, 'Sustain −', cb], [38, 'Release', sec]]],
  ['Filter', [[8, 'Cutoff', hz], [9, 'Resonance', cb]]],
  ['Mod envelope', [[25, 'Delay', sec], [26, 'Attack', sec], [27, 'Hold', sec], [28, 'Decay', sec], [29, 'Sustain −', pct], [30, 'Release', sec], [11, '→ Filter', signed('¢')], [7, '→ Pitch', signed('¢')]]],
  ['Mod LFO', [[21, 'Delay', sec], [22, 'Rate', hz], [5, '→ Pitch', signed('¢')], [10, '→ Filter', signed('¢')], [13, '→ Volume', signed('cB')]]],
  ['Vibrato LFO', [[23, 'Delay', sec], [24, 'Rate', hz], [6, '→ Pitch', signed('¢')]]],
  ['Tuning & mix', [[51, 'Coarse', signed(' st')], [52, 'Fine', signed('¢')], [56, 'Scale tune', (v) => v + '¢/key'], [48, 'Attenuation', cb], [17, 'Pan', (v) => (v === 0 ? 'C' : v < 0 ? 'L' + (-v / 5).toFixed(0) : 'R' + (v / 5).toFixed(0))], [16, 'Reverb', pct], [15, 'Chorus', pct]]],
];
const STEP = { 8: 50, 9: 10, 22: 100, 24: 100, 17: 10, 48: 10, 37: 10, 29: 10, 15: 10, 16: 10, 56: 10 };

export function mountEditor(el, inst, kit, onChange, ctx) {
  const id = ctx && ctx.Machine && ctx.Machine.info.id;
  inst.ov = inst.ov || {}; inst.zov = inst.zov || {};
  let scope = -1, alive = true, fT = 0;
  const fire = () => { clearTimeout(fT); fT = setTimeout(() => onChange(inst), 80); };

  function build() {
    el.innerHTML = '';
    const meta = getMeta(id);
    if (!meta) { kit.note(el, 'The SoundFont is still being burned into this card\'s ROM — the editor appears when it is ready.'); return; }
    const key = (inst.bank >= 128 ? 128 : inst.bank) * 128 + (inst.program & 127);
    const zones = meta.presets[key] || [];
    const [c1, c2] = kit.columns(el, 2, 'minmax(0, 1fr) minmax(0, 1fr)');
    // ---------------- source
    const g = kit.group(c1, `SoundFont preset — ${meta.name || meta.sfName}${meta.budget === 'raw' ? '' : meta.budget === 'awe' ? ' (AWE-style ROM)' : ' (Live!-style bank)'}`);
    if (inst.user) {
      kit.select(g, { label: 'Preset', options: meta.list.map(([b, p, n]) => [[b, p], presetName(b, p, n)]), value: [inst.bank, inst.program],
        onChange: ([b, p]) => { inst.bank = b; inst.program = p; inst.zov = {}; scope = -1; onChange(inst); build(); } });
    } else kit.note(g, `${String(inst.bank).padStart(3, '0')}:${String(inst.program).padStart(3, '0')} · ${zones.length} zone${zones.length === 1 ? '' : 's'} · Copy it to point a new instrument at another preset.`);
    // zones browser
    const box = document.createElement('div'); box.className = 'emu-zones';
    box.setAttribute('role', 'listbox'); box.setAttribute('aria-label', 'Zones: pick Global or one zone to edit'); box.tabIndex = 0;
    box.style.cssText = 'max-height:170px;overflow:auto;background:#fff;box-shadow:inset 1px 1px #808080;font:11px "Lucida Console",monospace';
    g.appendChild(box);
    const rowOf = (label, zi) => {
      const r = document.createElement('div'); r.textContent = label; r.style.cssText = 'padding:1px 5px;cursor:pointer;white-space:nowrap';
      r.setAttribute('role', 'option'); r.setAttribute('aria-selected', String(scope === zi)); r.id = 'emuz' + (zi + 1);
      if (scope === zi) { r.style.background = '#000080'; r.style.color = '#fff'; box.setAttribute('aria-activedescendant', r.id); }
      r.onclick = () => { scope = zi; build(); setTimeout(() => { const b = document.querySelector('.emu-zones'); if (b) b.focus(); }); };
      box.appendChild(r);
    };
    rowOf(`★ Global — offsets on all ${zones.length} zones${Object.keys(inst.ov).length ? ' (edited)' : ''}`, -1);
    zones.forEach((z, zi) => {
      const len = z.end - z.start, loop = (z.g[54] & 1) && z.le > z.ls ? `loop ${z.le - z.ls}` : 'one-shot';
      const nm = meta.instNames[z.inst] || 'inst ' + z.inst;
      rowOf(`${String(zi + 1).padStart(2)} ${noteName(z.kl).padEnd(4)}–${noteName(z.kh).padEnd(4)} v${z.vl}-${z.vh} ${nm.slice(0, 16).padEnd(16)} root ${noteName(z.root)} ${Math.round(z.sr)}Hz ${len} ${loop}${inst.zov[zi] ? ' *' : ''}`, zi);
    });
    box.onkeydown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault(); e.stopPropagation();
      scope = Math.max(-1, Math.min(zones.length - 1, scope + (e.key === 'ArrowDown' ? 1 : -1))); build();
      setTimeout(() => { const b = document.querySelector('.emu-zones'); if (b) { b.focus(); const a = b.querySelector('[aria-selected=true]'); if (a) a.scrollIntoView({ block: 'nearest' }); } });
    };
    const rr = kit.row(g);
    kit.button(rr, 'Reset overrides', () => { if (scope < 0) inst.ov = {}; else delete inst.zov[scope]; onChange(inst); build(); });
    kit.note(rr, scope < 0 ? 'Global: moves every zone by the same amount' : `Zone ${scope + 1}: absolute values for this zone`);
    // graphs
    const ref = scope >= 0 ? zones[scope] : (zones.find(z => z.kl <= 60 && z.kh >= 60) || zones[0]);
    const val = (k) => {
      if (!ref) return 0;
      if (scope >= 0 && inst.zov[scope] && inst.zov[scope][k] != null) return inst.zov[scope][k];
      return ref.g[k] + (inst.ov[k] || 0);
    };
    const envCv = kit.canvas(c1, { label: 'Volume envelope (key held 1 s)', width: 420, height: 90, draw: (c, w, h) => drawEnv(c, w, h, val) });
    const filCv = kit.canvas(c1, { label: 'Filter response', width: 420, height: 80, draw: (c, w, h) => drawFilter(c, w, h, val) });
    // ---------------- generator controls
    for (const [title, gens] of GROUPS) {
      const gg = kit.group(title === 'Volume envelope' || title === 'Filter' ? c2 : c2, title);
      for (const [k, label, fmt] of gens) {
        const r = GEN_RANGE[k] || [-12000, 12000];
        kit.slider(gg, { label, min: r[0], max: r[1], step: STEP[k] || (r[1] - r[0] > 2000 ? 50 : 1), value: Math.max(r[0], Math.min(r[1], val(k))), fmt,
          onInput: (v) => {
            if (!ref) return;
            if (scope >= 0) { (inst.zov[scope] = inst.zov[scope] || {})[k] = v; }
            else { const d = v - ref.g[k]; if (d) inst.ov[k] = d; else delete inst.ov[k]; }
            envCv.redraw(); filCv.redraw(); fire();
          } });
      }
    }
  }
  function drawEnv(c, w, h, val) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const D = tc2s(val(33)), At = tc2s(val(34)), H = tc2s(val(35)), Dc = Math.max(0.001, tc2s(val(36))), S = Math.min(144, Math.max(0, val(37) / 10)), Rl = Math.max(0.006, tc2s(val(38)));
    const hold = 1, total = Math.min(8, Math.max(1.5, hold + Math.min(Rl, 6) + 0.1));
    const lvl = (t) => {
      let att;
      const tk = Math.min(t, hold);
      if (tk < D) return 0;
      if (tk < D + At) { att = null; const a = (tk - D) / Math.max(1e-6, At); if (t <= hold) return a; att = -20 * Math.log10(Math.max(1e-5, a)); return Math.pow(10, -(att + (t - hold) / Rl * 100) / 20); }
      const t2 = tk - D - At;
      if (t2 < H) att = 0; else att = Math.min(S, (t2 - H) / Dc * 100);
      if (t > hold) att += (t - hold) / Rl * 100;
      return Math.pow(10, -att / 20);
    };
    c.strokeStyle = GRID; c.beginPath(); for (let k = 1; k < 4; k++) { const y = 3 + k * (h - 6) / 4; c.moveTo(0, y); c.lineTo(w, y); } c.stroke();
    const kx = 3 + hold / total * (w - 6);
    c.strokeStyle = '#e2463b'; c.beginPath(); c.moveTo(kx, 0); c.lineTo(kx, h); c.stroke();
    c.strokeStyle = FG; c.lineWidth = 2; c.beginPath();
    for (let x = 0; x <= w - 6; x++) { const t = x / (w - 6) * total, y = h - 3 - lvl(t) * (h - 6); x ? c.lineTo(x + 3, y) : c.moveTo(3, y); }
    c.stroke(); c.lineWidth = 1;
    c.fillStyle = '#7f7'; c.font = '10px monospace'; c.fillText(total.toFixed(1) + ' s', w - 40, h - 5); c.fillText('key-off', kx + 3, 11);
  }
  function drawFilter(c, w, h, val) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const fc = 8.176 * Math.pow(2, val(8) / 1200), qdb = Math.max(0, val(9) / 10), Q = Math.max(0.5, Math.pow(10, qdb / 20) * 0.7071), SR = 44100;
    const off = val(8) >= 13490 && !val(11) && !val(10);
    const w0 = 2 * Math.PI * Math.min(fc, SR * 0.45) / SR, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Q), a0 = 1 + al;
    const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - al) / a0, comp = 1 / Math.sqrt(Math.max(1, Q / 0.7071));
    c.strokeStyle = GRID; c.beginPath();
    for (const f of [100, 1000, 10000]) { const x = Math.log10(f / 20) / Math.log10(20000 / 20) * w; c.moveTo(x, 0); c.lineTo(x, h); }
    c.stroke();
    c.fillStyle = DIM; c.font = '10px monospace'; c.fillText('100', Math.log10(5) / 3 * w + 2, h - 3); c.fillText('1k', Math.log10(50) / 3 * w + 2, h - 3); c.fillText('10k', Math.log10(500) / 3 * w + 2, h - 3);
    c.strokeStyle = FG; c.lineWidth = 2; c.beginPath();
    for (let x = 0; x <= w; x++) {
      const f = 20 * Math.pow(1000, x / w), om = 2 * Math.PI * f / SR;
      let mag = 1;
      if (!off) {
        const re = (k) => Math.cos(k * om), im = (k) => -Math.sin(k * om);
        const nr = b0 + b1 * re(1) + b2 * re(2), ni = b1 * im(1) + b2 * im(2), dr = 1 + a1 * re(1) + a2 * re(2), di = a1 * im(1) + a2 * im(2);
        mag = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di)) * comp;
      }
      const db = 20 * Math.log10(Math.max(1e-6, mag)), y = h / 3 - db / 48 * h;
      x ? c.lineTo(x, Math.max(1, Math.min(h - 1, y))) : c.moveTo(x, y);
    }
    c.stroke(); c.lineWidth = 1;
    c.fillStyle = '#7f7'; c.fillText(off ? 'filter off' : `fc ${hz(val(8))}Hz · Q ${(val(9) / 10).toFixed(1)}dB`, 4, 11);
  }
  const onP = (e) => { if (alive && e.detail && e.detail.id === id && e.detail.stage === 'done') build(); };
  if (emuEvents) emuEvents.addEventListener('progress', onP);
  build();
  return { destroy() { alive = false; clearTimeout(fT); if (emuEvents) emuEvents.removeEventListener('progress', onP); } };
}
