// 1-bit speaker instrument editor (main thread) for the IBM PC speaker (8253 PIT channel 2) and the Apple II
// speaker (CPU-timed toggles). Shows only what a 1-bit line has: gate / pulse width per tick, the timer
// period (arpeggio, divisor offset, vibrato, slide), the chord-arpeggio speed, and drum blips (pitch sweep or
// noise burst timing). A drawn 1-bit waveform and a preview through the real emulation update live.
import { renderPreview } from './ay-editor.js';

const BG = '#000', FG = '#4cff6a', DIM = '#1b6b2a', GRID = '#0a3a0a', HI = '#f2c63a';
const ROLES = [['lead', 'Melody'], ['bass', 'Bass'], ['chord', 'Chord'], ['pad', 'Pad'], ['fx', 'FX'], ['drum', 'Drum']];

let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

/** 1-bit line for drawing: list of [t µs, level] edges over `span` µs. */
function lineEdges(inst, clock, span) {
  const us = 1e6 / clock, edges = [];
  seed = 7;
  if (inst.type === 'blip') {
    const b = inst.blip, w = inst.pwm ? 40 : 0;
    let t = 0, lv = 0;
    const end = Math.min(span, b.ms * 1000);
    if (b.mode === 'noise') {
      while (t < end) { lv ^= 1; edges.push([t, lv]); t += (lv && w) ? w : b.gapMin + (Math.max(b.gapMin, b.gapMax) - b.gapMin) * rnd(); }
    } else {
      let P = 1e6 / Math.max(20, b.hz);
      const k = b.mode === 'sweep' ? 1 + (b.sweep || 0) / 1000 : 1;
      while (t < end) {
        const hi = inst.pwm ? Math.min(P / 2, w * 1.5) : P / 2;
        edges.push([t, 1]); edges.push([t + hi, 0]); t += P; P = Math.max(4 * us, Math.min(50000, P * k));
      }
    }
    edges.push([end, 0]);
    return edges;
  }
  // tone: the line at C5 for (up to) three volume steps: first audible, middle and last audible
  const P = 1e6 / 523.25, L = [0, 0.01, 0.0145, 0.021, 0.0307, 0.0455, 0.0645, 0.107, 0.127, 0.205, 0.292, 0.373, 0.493, 0.635, 0.806, 1];
  const aud = inst.vol.values.filter(v => v > 0);
  const steps = !inst.pwm || aud.length < 2 ? [aud[0] || 0] : [aud[0], aud[aud.length >> 1], aud[aud.length - 1]];
  const duty = Math.min(0.5, (inst.duty || 50) / 100), seg = span / steps.length;
  steps.forEach((lv, k) => {
    const frac = !lv ? 0 : inst.pwm ? Math.min(duty, Math.asin(Math.min(1, L[lv] * 0.6 * 2.2)) / Math.PI) : duty;
    for (let t = k * seg; t + P <= (k + 1) * seg + 1; t += P) if (frac > 0) { edges.push([t, 1]); edges.push([t + P * frac, 0]); }
    edges.label = (edges.label || []).concat([[k * seg, lv]]);
  });
  return edges;
}

export function mountSpeakerEditor(el, inst, kit, onChange, ctx) {
  const Machine = ctx.Machine, info = Machine.chipInfo || { clock: 1193182, timer: 'pit' };
  const pit = info.timer === 'pit';
  const fire = () => { draw.redraw(); preview.schedule(); onChange(inst); };
  if (!inst.blip) inst.blip = { mode: 'sweep', hz: 170, sweep: 75, ms: 75, gapMin: 20, gapMax: 200, rel: 0 };

  const top = kit.group(el, pit ? '8253 PIT channel 2 → speaker · 1.193182 MHz ÷ N · mode 3 square' : 'Apple II speaker · $C030 toggles timed in 1.0227 MHz CPU cycles (5-cycle loops)');
  const hr = kit.row(top);
  kit.seg(hr, { label: 'Type', options: [['tone', 'Tone'], ['blip', 'Drum blip']], value: inst.type, onChange: (v) => {
    inst.type = v; if (v === 'blip') inst.role = 'drum'; else if (inst.role === 'drum') inst.role = 'lead';
    el.innerHTML = ''; mountSpeakerEditor(el, inst, kit, onChange, ctx); onChange(inst); } });
  kit.toggle(hr, { label: pit ? 'PWM volume trick (narrow pulses)' : 'Pulse-width loudness', value: !!inst.pwm, onChange: (v) => { inst.pwm = v ? 1 : 0; fire(); },
    title: pit ? 'Off = authentic PIT mode-3 square, no volume. On = the driver re-triggers short pulses so lower levels are quieter.' : 'Narrow pulses (two toggles close together) are quieter' });
  if (inst.type !== 'blip') kit.select(hr, { label: 'Priority', options: ROLES.slice(0, 5), value: inst.role, onChange: (v) => { inst.role = v; fire(); }, title: 'One voice: melody beats bass beats chords' });
  else kit.number(hr, { label: 'Drum priority', min: 1, max: 9, value: inst.prio || 3, onChange: (v) => { inst.prio = v; fire(); } });

  // drawn 1-bit waveform
  const draw = kit.canvas(top, {
    width: 720, height: 64, label: inst.type === 'blip' ? 'Speaker line during the blip' : (inst.pwm ? 'Speaker line at C5 for early, middle and late volume steps' : 'Speaker line at C5 (high = speaker pushed out)'),
    draw: (g, w, h) => {
      g.fillStyle = BG; g.fillRect(0, 0, w, h);
      const span = inst.type === 'blip' ? Math.min(inst.blip.ms * 1000, 120000) : (inst.pwm ? 12000 : 6000);
      const e = lineEdges(inst, info.clock, span);
      g.strokeStyle = GRID; g.beginPath(); g.moveTo(0, h - 8); g.lineTo(w, h - 8); g.stroke();
      g.strokeStyle = FG; g.lineWidth = 1; g.beginPath();
      let y = h - 8; g.moveTo(0, y);
      for (const [t, lv] of e) { const x = t / span * w; g.lineTo(x, y); y = lv ? 8 : h - 8; g.lineTo(x, y); }
      g.lineTo(w, y); g.stroke();
      g.fillStyle = HI; g.font = '10px monospace';
      if (e.label && e.label.length > 1) for (const [t, lv] of e.label) g.fillText('level ' + lv, t / span * w + 4, h - 12);
      g.fillText(span >= 10000 ? (span / 1000).toFixed(0) + ' ms' : (span / 1000).toFixed(1) + ' ms', w - 48, 12);
    },
  });
  const preview = (() => {
    let t = 0, data = null;
    const cv = kit.canvas(top, {
      width: 720, height: 72, label: 'Preview through the speaker model (note-off at the yellow line)',
      draw: (g, w, h) => {
        g.fillStyle = BG; g.fillRect(0, 0, w, h);
        if (!data) return;
        const { out, sr, offAt } = data, per = out.length / w;
        let pk = 1e-4; for (const v of out) pk = Math.max(pk, Math.abs(v));
        const sc = (h / 2 - 3) / Math.max(pk, 0.1);
        g.fillStyle = FG;
        for (let x = 0; x < w; x++) {
          let mn = 0, mx = 0; const a = Math.floor(x * per), b = Math.floor((x + 1) * per);
          for (let i = a; i < b; i++) { const v = out[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
          g.fillRect(x, h / 2 - mx * sc, 1, Math.max(1, (mx - mn) * sc));
        }
        g.fillStyle = HI; g.fillRect(offAt * sr / per, 0, 1, h);
      },
    });
    const run = () => { try { data = renderPreview(Machine, JSON.parse(JSON.stringify(inst)), inst.blip && inst.blip.rel ? 48 : 60); } catch { data = null; } cv.redraw(); };
    run();
    return { schedule() { clearTimeout(t); t = setTimeout(run, 60); } };
  })();

  if (inst.type === 'blip') {
    const b = inst.blip;
    const g = kit.group(el, 'Drum blip (interrupts the tone, like a game\'s sound-effect routine)', { cols: 2 });
    kit.seg(g, { label: 'Mode', options: [['sweep', 'Pitch sweep'], ['noise', 'Noise burst'], ['tone', 'Tone']], value: b.mode, onChange: (v) => { b.mode = v; fire(); } });
    kit.toggle(g, { label: 'Pitch follows the key (Hz is for C4)', value: !!b.rel, onChange: (v) => { b.rel = v ? 1 : 0; fire(); } });
    kit.slider(g, { label: 'Start pitch (Hz)', min: 30, max: 6000, value: b.hz, onInput: (v) => { b.hz = v; fire(); },
      title: pit ? 'PIT divisor = 1193182 / Hz' : 'half-period in CPU cycles = 511364 / Hz' });
    kit.slider(g, { label: 'Sweep (‰/cycle)', min: -60, max: 200, value: b.sweep || 0, onInput: (v) => { b.sweep = v; fire(); }, title: 'period growth per cycle (+ = falls in pitch)' });
    kit.slider(g, { label: 'Length (ms)', min: 2, max: 500, value: b.ms, onInput: (v) => { b.ms = v; fire(); } });
    kit.slider(g, { label: 'Gap min (µs)', min: 4, max: 2000, value: b.gapMin, onInput: (v) => { b.gapMin = v; fire(); } });
    kit.slider(g, { label: 'Gap max (µs)', min: 4, max: 4000, value: b.gapMax, onInput: (v) => { b.gapMax = v; fire(); } });
    kit.note(g, pit ? 'Velocity shortens the blip (the PIT square has no volume) unless PWM is on.' : 'Velocity sets the pulse width.');
    return { destroy() {} };
  }

  const mac = kit.group(el, `Tick macros (driver interrupt rate — ${pit ? '60 or 120 Hz option' : '60 Hz'})`);
  const vr = kit.row(mac);
  kit.number(vr, { label: 'Volume speed (ticks/step)', min: 1, max: 8, value: inst.volSpeed || 1, onChange: (v) => { inst.volSpeed = v; fire(); } });
  kit.slider(vr, { label: 'Duty at full (%)', min: 5, max: 50, value: inst.duty || 50, onInput: (v) => { inst.duty = v; fire(); }, title: pit ? 'PIT mode 3 is 50 %; shorter = one-shot pulses' : 'high time of each cycle' });
  kit.macro(mac, { label: inst.pwm ? 'Level 0–15 (0 = gated off, else pulse width)' : 'Gate 0–15 (0 = speaker off, anything else = on)', m: inst.vol, min: 0, max: 15, maxLength: 64, width: 720, height: 80, onChange: fire });
  const ar = kit.row(mac);
  const arpBox = document.createElement('div');
  const mountArp = () => {
    arpBox.innerHTML = '';
    const fixed = inst.arpMode === 'fixed';
    kit.macro(arpBox, { label: fixed ? 'Arpeggio — fixed notes' : 'Arpeggio — semitones', m: inst.arp, min: fixed ? 0 : -24, max: fixed ? 127 : 24, maxLength: 64, width: 720, height: 70, onChange: fire });
  };
  kit.seg(ar, { label: 'Arp mode', options: [['rel', 'Relative'], ['fixed', 'Fixed']], value: inst.arpMode || 'rel', onChange: (v) => {
    inst.arpMode = v; inst.arp.values = inst.arp.values.map(x => v === 'fixed' ? Math.max(0, Math.min(127, 60 + x)) : Math.max(-24, Math.min(24, x - 60))); mountArp(); fire(); } });
  kit.number(ar, { label: 'Chord arp speed (ticks/note)', min: 1, max: 8, value: inst.arpSpeed || 1, onChange: (v) => { inst.arpSpeed = v; fire(); }, title: 'When several held notes share the one voice' });
  kit.toggle(ar, { label: 'Noise (random edge timing)', value: !!inst.noisy, onChange: (v) => { inst.noisy = v ? 1 : 0; fire(); } });
  mac.appendChild(arpBox); mountArp();
  kit.macro(mac, { label: pit ? 'Pitch — PIT divisor offset (+ = lower)' : 'Pitch — CPU-cycle offset (+ = lower)', m: inst.pitch, min: -64, max: 64, maxLength: 64, width: 720, height: 60, onChange: fire });
  const fx = kit.group(el, 'Driver effects', { cols: 2 });
  const vib = inst.vib, sl = inst.slide;
  kit.slider(fx, { label: 'Vibrato (cents)', min: 0, max: 600, value: vib.depth, onInput: (v) => { vib.depth = v; fire(); } });
  kit.slider(fx, { label: 'Slide (ct/tick)', min: -200, max: 200, value: sl.speed, onInput: (v) => { sl.speed = v; fire(); } });
  kit.slider(fx, { label: 'Vib. delay (t)', min: 0, max: 60, value: vib.delay, onInput: (v) => { vib.delay = v; fire(); } });
  kit.slider(fx, { label: 'Slide limit (ct)', min: 0, max: 4800, step: 50, value: sl.limit, fmt: (v) => v ? String(v) : '∞', onInput: (v) => { sl.limit = v; fire(); } });
  kit.slider(fx, { label: 'Vib. period (t)', min: 2, max: 64, value: vib.speed, onInput: (v) => { vib.speed = v; fire(); } });
  kit.number(fx, { label: 'Transpose', min: -36, max: 36, value: inst.transpose || 0, onChange: (v) => { inst.transpose = v; fire(); } });
  return { destroy() {} };
}

export function mountEditor(el, inst, kit, onChange, ctx) { return mountSpeakerEditor(el, inst, kit, onChange, ctx); }
