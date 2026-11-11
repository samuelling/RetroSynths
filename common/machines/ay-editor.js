// AY-3-8910 / YM2149 instrument editor (main thread), laid out like a Vortex Tracker / Arkos Tracker
// instrument: per-frame macros for volume, the T/N mixer bits, arpeggio, tone-period offset and noise
// period, the hardware envelope (R11–R13, the 16 shapes drawn), and the replay routine's vibrato / slide.
// A live preview renders the instrument through the real chip emulation.
import { Chan } from '../host-core.js';
import { ENV_SEGMENTS } from './ay.js';

const BG = '#000', FG = '#4cff6a', DIM = '#1b6b2a', GRID = '#0a3a0a', HI = '#f2c63a';
const ROLES = [['lead', 'Lead'], ['bass', 'Bass'], ['chord', 'Chord'], ['pad', 'Pad'], ['perc', 'Perc'], ['fx', 'FX'], ['drum', 'Drum (one-shot)']];
const RATIOS = [[0.25, '× 1/4'], [0.5, '× 1/2'], [1, '× 1 (unison)'], [2, '× 2'], [4, '× 4']];

/** The envelope generator's 32-step output for shape s over three ramps, stepped exactly like ay.js. */
export function shapeSteps(s, ramps = 3) {
  const segs = ENV_SEGMENTS[s], out = [];
  let seg = 0, act = segs[0], v = (act === 0 || act === 2) ? 31 : 0;
  for (let i = 0; i < 32 * ramps; i++) {
    out.push(v);
    if (act === 0) { if (--v < 0) { seg ^= 1; act = segs[seg]; v = (act === 0 || act === 2) ? 31 : 0; } }
    else if (act === 1) { if (++v > 31) { seg ^= 1; act = segs[seg]; v = (act === 0 || act === 2) ? 31 : 0; } }
  }
  return out;
}
export function drawShape(g, s, x, y, w, h, color = FG) {
  const st = shapeSteps(s);
  g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
  st.forEach((v, i) => { const px = x + i / st.length * w, py = y + h - v / 31 * h; i ? g.lineTo(px, py) : g.moveTo(px, py); });
  g.stroke();
}

/** Per-frame T / N mixer bits editor (click to toggle), length follows the macro. */
function mixerMacro(kit, parent, m, onChange, width = 512) {
  const maxLength = 64;
  const box = document.createElement('div'); box.className = 'ed-macro'; parent.appendChild(box);
  let cur = 0;
  const cv = kit.canvas(box, {
    width, height: 44, label: 'Mixer (frames) — T = tone, N = noise (keys: ↑ toggles tone, ↓ toggles noise)',
    draw: (g, w, h) => {
      g.fillStyle = BG; g.fillRect(0, 0, w, h);
      const bw = w / maxLength;
      g.font = '9px monospace'; g.textBaseline = 'middle';
      for (let i = 0; i < m.values.length; i++) {
        const v = m.values[i];
        for (let r = 0; r < 2; r++) {
          const on = v & (1 << r), y = r * h / 2;
          g.fillStyle = on ? (r ? '#3aa0ff' : FG) : '#122';
          g.fillRect(i * bw + 1, y + 2, bw - 2, h / 2 - 4);
        }
      }
      g.fillStyle = '#333'; g.fillRect(m.values.length * bw, 0, w - m.values.length * bw, h);
      if (m.loop >= 0) { g.fillStyle = HI; g.fillRect(m.loop * bw, 0, 2, h); }
      if (m.release >= 0) { g.fillStyle = '#e2463b'; g.fillRect(m.release * bw, 0, 2, h); }
      g.fillStyle = '#fff'; g.fillText('T', 2, h / 4); g.fillText('N', 2, 3 * h / 4);
      if (document.activeElement === g.canvas && m.values.length) { g.strokeStyle = '#f2c63a'; g.lineWidth = 2; g.strokeRect(Math.min(cur, m.values.length - 1) * bw + 1, 1, bw - 2, h - 2); }
    },
    onPointer: (kind, x, y) => {
      if (kind !== 'down') return;
      const i = Math.floor(x / width * maxLength); if (i >= m.values.length) return;
      m.values[i] ^= (y < 22 ? 1 : 2); cv.redraw(); onChange();
    },
    onKey: (k) => {
      const n = m.values.length; if (!n) return null;
      cur = Math.min(cur, n - 1);
      if (k === 'ArrowLeft') cur = (cur + n - 1) % n;
      else if (k === 'ArrowRight') cur = (cur + 1) % n;
      else if (k === 'ArrowUp') { m.values[cur] ^= 1; onChange(); }
      else if (k === 'ArrowDown') { m.values[cur] ^= 2; onChange(); }
      else return null;
      const v = m.values[cur];
      return `frame ${cur + 1} of ${n}: tone ${v & 1 ? 'on' : 'off'}, noise ${v & 2 ? 'on' : 'off'}`;
    },
  });
  const r = kit.row(box);
  kit.number(r, { label: 'Length', min: 1, max: maxLength, value: m.values.length, onChange: (v) => {
    while (m.values.length < v) m.values.push(m.values[m.values.length - 1] ?? 1); m.values.length = v;
    if (m.loop >= v) m.loop = -1; if (m.release >= v) m.release = -1; cv.redraw(); onChange(); } });
  kit.number(r, { label: 'Loop', min: -1, max: maxLength - 1, value: m.loop, onChange: (v) => { m.loop = v < m.values.length ? v : -1; cv.redraw(); onChange(); } });
  kit.number(r, { label: 'Release', min: -1, max: maxLength - 1, value: m.release, onChange: (v) => { m.release = v < m.values.length ? v : -1; cv.redraw(); onChange(); } });
  kit.button(r, 'All T', () => { m.values.fill(1); cv.redraw(); onChange(); });
  kit.button(r, 'All N', () => { m.values.fill(2); cv.redraw(); onChange(); });
  kit.button(r, 'All off', () => { m.values.fill(0); cv.redraw(); onChange(); }, 'Tone and noise off: the channel outputs its volume / envelope level directly (buzzer)');
  return { redraw: cv.redraw };
}

/** Render the instrument through the real machine emulation (C4 or the drum note), for the preview graph. */
export function renderPreview(Machine, inst, note, secs = 0.9, offAt = 0.6) {
  const sr = 22050;
  const host = { sampleRate: sr, ch: Array.from({ length: 16 }, (_, i) => new Chan(i)), mute: new Uint8Array(16), meter: new Float32Array(16) };
  const m = new Machine(host);
  m.setInstruments([inst]);
  m.setArrangement(Array.from({ length: 16 }, () => ({ inst: 0, voice: 'auto' })));
  const N = Math.round(secs * sr), out = new Float32Array(N), L = new Float32Array(256), R = new Float32Array(256);
  m.noteOn(0, note, 110);
  for (let i = 0; i < N; i += 256) {
    if (i <= offAt * sr && i + 256 > offAt * sr) m.noteOff(0, note);
    m.render(L, R, 256);
    for (let k = 0; k < 256 && i + k < N; k++) out[i + k] = (L[k] + R[k]) * 0.5;
  }
  return { out, sr, offAt };
}

export function mountAYEditor(el, inst, kit, onChange, ctx) {
  const Machine = ctx.Machine, info = Machine.chipInfo || { clock: 1773400, variant: 'AY', fps: 50 };
  const ym = info.variant === 'YM', fps = info.fps;
  const fire = () => { preview.schedule(); onChange(inst); };
  const isDrum = () => inst.role === 'drum';

  // ---- header
  const top = kit.group(el, `${ym ? 'YM2149' : 'AY-3-8910'} instrument · replay at ${fps} Hz · clock ${(info.clock / 1e6).toFixed(4)} MHz`);
  const hr = kit.row(top);
  kit.select(hr, { label: 'Priority', options: ROLES, value: inst.role, onChange: (v) => { inst.role = v; fire(); }, title: 'Who keeps a channel when the 3 channels are scarce; Drum = one-shot that steals a channel' });
  kit.number(hr, { label: 'Transpose', min: -36, max: 36, value: inst.transpose || 0, onChange: (v) => { inst.transpose = v; fire(); } });
  if (isDrum()) kit.number(hr, { label: 'Drum priority', min: 1, max: 9, value: inst.prio || 3, onChange: (v) => { inst.prio = v; fire(); } });

  // ---- live preview
  const preview = (() => {
    let t = 0, data = null;
    const cv = kit.canvas(top, {
      width: 720, height: 96, label: 'Preview — chip output for one note (C2 for buzzer / bass sounds, else C4; note-off at the yellow line)',
      draw: (g, w, h) => {
        g.fillStyle = BG; g.fillRect(0, 0, w, h);
        g.strokeStyle = GRID; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
        if (!data) return;
        const { out, sr, offAt } = data, per = out.length / w;
        let pk = 1e-4; for (const v of out) pk = Math.max(pk, Math.abs(v));
        const sc = (h / 2 - 3) / Math.max(pk, 0.25);
        g.fillStyle = FG;
        for (let x = 0; x < w; x++) {
          let mn = 0, mx = 0; const a = Math.floor(x * per), b = Math.floor((x + 1) * per);
          for (let i = a; i < b; i++) { const v = out[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
          g.fillRect(x, h / 2 - mx * sc, 1, Math.max(1, (mx - mn) * sc));
        }
        g.fillStyle = HI; g.fillRect(offAt * sr / per, 0, 1, h);
        g.fillStyle = DIM; for (let f = 0; f * sr / fps < out.length; f += fps / 10) g.fillRect(f * sr / fps / per, h - 4, 1, 4);
      },
    });
    const run = () => {
      try {
        const note = inst.arpMode === 'fixed' ? 60 : isDrum() ? 45 : inst.role === 'bass' || (inst.env.shape >= 0 && inst.env.mode === 'note' && (inst.transpose || 0) >= 0) ? 36 : 60;
        data = renderPreview(Machine, JSON.parse(JSON.stringify(inst)), note);
      } catch (err) { data = null; }
      cv.redraw();
    };
    run();
    return { schedule() { clearTimeout(t); t = setTimeout(run, 60); } };
  })();

  // ---- macros
  const mac = kit.group(el, 'Sample macros (one step per frame)');
  const vr = kit.row(mac);
  kit.number(vr, { label: 'Volume speed (frames/step)', min: 1, max: 8, value: inst.volSpeed || 1, onChange: (v) => { inst.volSpeed = v; fire(); } });
  kit.note(vr, 'Volume is the 4-bit R8–R10 level; velocity and MIDI volume attenuate it through the DAC curve.');
  kit.macro(mac, { label: 'Volume 0–15', m: inst.vol, min: 0, max: 15, maxLength: 128, width: 720, height: 90, onChange: fire });
  mixerMacro(kit, mac, inst.mixer, fire, 720);
  const ar = kit.row(mac);
  let arpEd = null;
  const arpBox = document.createElement('div');
  const mountArp = () => {
    arpBox.innerHTML = '';
    const fixed = inst.arpMode === 'fixed';
    arpEd = kit.macro(arpBox, { label: fixed ? 'Arpeggio — fixed MIDI notes' : 'Arpeggio — semitones', m: inst.arp, min: fixed ? 0 : -24, max: fixed ? 127 : 24, maxLength: 64, width: 720, height: 70,
      fmt: (v) => fixed ? `note ${v}` : (v > 0 ? '+' : '') + v, onChange: fire });
  };
  kit.seg(ar, { label: 'Arp mode', options: [['rel', 'Relative'], ['fixed', 'Fixed']], value: inst.arpMode || 'rel', onChange: (v) => {
    inst.arpMode = v;
    inst.arp.values = inst.arp.values.map(x => v === 'fixed' ? Math.max(0, Math.min(127, 60 + x)) : Math.max(-24, Math.min(24, x - 60)));
    mountArp(); fire(); } });
  mac.appendChild(arpBox); mountArp();
  kit.macro(mac, { label: 'Pitch — tone-period offset (+ = lower)', m: inst.pitch, min: -64, max: 64, maxLength: 64, width: 720, height: 60, onChange: fire });
  const nr = kit.row(mac);
  kit.toggle(nr, { label: 'Noise follows note (macro = offset)', value: !!inst.noiseRel, onChange: (v) => { inst.noiseRel = v ? 1 : 0; fire(); } });
  kit.note(nr, 'R6: one noise period per chip — drums win, then the highest-priority channel.');
  kit.macro(mac, { label: 'Noise period 0–31 (R6)', m: inst.noise, min: 0, max: 31, maxLength: 64, width: 720, height: 60, onChange: fire });

  // ---- hardware envelope
  const envG = kit.group(el, `Hardware envelope (R11–R13) — ${ym ? 'YM2149: 32 steps per ramp' : 'AY: 16 steps per ramp'}, one per chip`);
  const env = inst.env;
  const shapeRow = kit.row(envG);
  const shapeCvs = [];
  const mkShape = (s) => {
    const c = kit.canvas(shapeRow, {
      width: 32, height: 30,
      draw: (g, w, h) => {
        const on = env.shape === s;
        g.fillStyle = on ? '#103d18' : BG; g.fillRect(0, 0, w, h);
        if (s < 0) { g.fillStyle = on ? FG : DIM; g.font = '10px monospace'; g.fillText('OFF', 6, 19); }
        else { drawShape(g, s, 3, 10, w - 6, h - 13, on ? FG : '#3a8a48'); g.fillStyle = on ? HI : '#777'; g.font = '9px monospace'; g.fillText(String(s), 2, 9); }
        if (on) { g.strokeStyle = HI; g.lineWidth = 2; g.strokeRect(1, 1, w - 2, h - 2); }
      },
      onPointer: (kind) => { if (kind !== 'down') return; env.shape = s; shapeCvs.forEach(x => x.redraw()); envInfo(); fire(); },
      onKey: (k) => { if (k !== 'Enter' && k !== ' ') return null; env.shape = s; shapeCvs.forEach(x => x.redraw()); envInfo(); fire(); return `envelope shape ${s < 0 ? 'off' : s} selected`; },
      ariaLabel: s < 0 ? 'Envelope off' : `Envelope shape ${s}`, keyHint: '', role: 'button',
    });
    c.el.title = s < 0 ? 'Envelope off (fixed volume)' : `R13 = ${s}: ${[s & 8 ? 'CONT' : '', s & 4 ? 'ATT' : '', s & 2 ? 'ALT' : '', s & 1 ? 'HOLD' : ''].filter(Boolean).join(' ') || '—'}`;
    shapeCvs.push(c);
  };
  for (let s = -1; s < 16; s++) mkShape(s);
  const er = kit.row(envG);
  kit.seg(er, { label: 'Period', options: [['note', 'Ratio to note (buzzer)'], ['abs', 'Absolute R11/R12']], value: env.mode || 'note', onChange: (v) => { env.mode = v; envInfo(); fire(); } });
  kit.select(er, { label: 'Ratio', options: RATIOS, value: env.ratio || 1, onChange: (v) => { env.ratio = v; envInfo(); fire(); }, title: 'Envelope cycle = note frequency × ratio' });
  kit.number(er, { label: 'EP', min: 1, max: 65535, value: env.period || 1000, onChange: (v) => { env.period = v; per.set(Math.min(8192, v)); envInfo(); fire(); }, width: 70 });
  const per = kit.slider(envG, { label: 'Abs. period', min: 1, max: 8192, value: Math.min(8192, env.period || 1000), onInput: (v) => { env.period = v; envInfo(); fire(); } });
  const infoEl = kit.note(envG, '');
  const envInfo = () => {
    if (env.shape < 0) { infoEl.textContent = 'Off: the channel uses the volume macro (M bit clear).'; return; }
    const tri = env.shape === 10 || env.shape === 14, ramps = tri ? 2 : 1;
    if (env.mode === 'abs') {
      const hz = info.clock / (256 * (env.period || 1));
      infoEl.textContent = `R13=${env.shape} · EP=${env.period} → one ramp ${(1000 / hz).toFixed(1)} ms, ${(hz / ramps).toFixed(2)} Hz cycle. Volume macro >0 gates it (M bit).`;
    } else infoEl.textContent = `R13=${env.shape} · EP = clock / (${256 * ramps} × f_note × ${env.ratio}) — the envelope becomes the oscillator (buzzer). Mixer T on + shape 12 = sync lead; T/N off = pure envelope wave. Falls back to the tone when another channel owns the envelope.`;
  };
  envInfo();

  // ---- driver effects
  const fx = kit.group(el, 'Replay routine effects', { cols: 2 });
  const vib = inst.vib, sl = inst.slide;
  kit.slider(fx, { label: 'Vibrato (cents)', min: 0, max: 200, value: vib.depth, onInput: (v) => { vib.depth = v; fire(); } });
  kit.slider(fx, { label: 'Slide (ct/frame)', min: -200, max: 200, value: sl.speed, onInput: (v) => { sl.speed = v; fire(); } });
  kit.slider(fx, { label: 'Vib. delay (fr)', min: 0, max: 60, value: vib.delay, onInput: (v) => { vib.delay = v; fire(); } });
  kit.slider(fx, { label: 'Slide limit (ct)', min: 0, max: 4800, step: 50, value: sl.limit, fmt: (v) => v ? String(v) : '∞', onInput: (v) => { sl.limit = v; fire(); } });
  kit.slider(fx, { label: 'Vib. period (fr)', min: 2, max: 64, value: vib.speed, onInput: (v) => { vib.speed = v; fire(); } });
  kit.note(fx, 'CC1 (mod wheel) adds the driver\'s own vibrato; pitch bend is applied every frame.');
  return { destroy() {} };
}

export function mountEditor(el, inst, kit, onChange, ctx) { return mountAYEditor(el, inst, kit, onChange, ctx); }
