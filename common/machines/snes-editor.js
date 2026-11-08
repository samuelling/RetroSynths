// SNES instrument editor: sample source (GeneralUser GS → BRR budget hints), the squeezed sample as it sits in
// audio RAM (rate, length, BRR bytes, loop, decoded waveform), S-DSP ADSR / GAIN with an exact envelope graph
// (real rate table), release, EON / NON, tuning and volume.
import { GM_NAMES, GM_DRUMS, noteName } from '../gm.js';
import { RATE_PERIOD } from './snes-dsp.js';
import { simulateEnv, attackTime, rateDbps, GAIN_MODES } from './snes-presets.js';
import { prepView, prepEvents } from './snes.prep.js';

const FG = '#4cff6a', DIM = '#1b6b2a', GRID = '#0a3a0a', LOOP = '#f2c63a';
const ms = (s) => (!isFinite(s) ? '∞' : s >= 1 ? s.toFixed(1) + ' s' : Math.round(s * 1000) + ' ms');
const db = (d) => (d <= 0 ? 'hold' : `−${d < 10 ? d.toFixed(1) : Math.round(d)} dB/s`);
const hex = (v, n = 2) => '$' + v.toString(16).toUpperCase().padStart(n, '0');

export function mountEditor(el, inst, kit, onChange, ctx) {
  let alive = true, split = 0;
  inst.src = inst.src || { bank: 0, prog: 0, key: 60, vel: 100 };
  const fire = () => onChange(inst);
  let sampleBox = null, wave = null, envCv = null, envInfo = null, ramInfo = null, echoNote = null;

  function build() {
    el.innerHTML = '';
    const [left, right] = kit.columns(el, 2, 'minmax(0, 1fr) minmax(0, 1fr)');
    const isKit = inst.src.bank >= 128;

    // ---------------- sample source
    const g1 = kit.group(left, 'Sample source — GeneralUser GS → BRR');
    const r1 = kit.row(g1);
    kit.seg(r1, { label: 'Bank', options: [[0, 'Melodic'], [128, 'Drum kit']], value: isKit ? 128 : 0, onChange: (b) => {
      inst.src.bank = b;
      if (b >= 128) { inst.src.prog = 0; inst.src.key = 38; inst.fixed = true; inst.splits = 1; }
      else { inst.src.key = 60; inst.fixed = false; }
      fire(); build();
    } });
    kit.toggle(r1, { label: 'Fixed pitch', value: inst.fixed, title: 'Always play the source key (drums) instead of following the note',
      onChange: (v) => { inst.fixed = v; fire(); } });
    if (!isKit) {
      kit.select(g1, { label: 'Program', options: GM_NAMES.map((n, i) => [i, `${String(i + 1).padStart(3, '0')} ${n}`]), value: inst.src.prog,
        onChange: (v) => { inst.src.prog = v; fire(); } });
    } else {
      const notes = Object.keys(GM_DRUMS).map(Number).sort((a, b) => a - b);
      kit.select(g1, { label: 'Drum', options: notes.map(n => [n, `${n} ${GM_DRUMS[n]}`]), value: inst.src.key,
        onChange: (v) => { inst.src.key = v; fire(); build(); } });
    }
    const r2 = kit.row(g1);
    if (!isKit) {
      const keyLab = { el: null };
      kit.number(r2, { label: 'Split centre', min: 12, max: 115, value: inst.src.key, onChange: (v) => { inst.src.key = v; keyLab.el.textContent = noteName(v); fire(); } });
      keyLab.el = kit.note(r2, noteName(inst.src.key));
      kit.seg(r2, { label: 'Splits', options: [[1, '1'], [2, '2'], [3, '3']], value: inst.splits || 1, title: 'Multisamples (key splits) at most; the squeeze may use fewer',
        onChange: (v) => { inst.splits = v; fire(); } });
    }
    kit.number(r2, { label: 'Velocity layer', min: 1, max: 127, value: inst.src.vel || 100, onChange: (v) => { inst.src.vel = v; fire(); } });

    const g2 = kit.group(left, 'Budget hints (the per-song squeeze may go further)');
    kit.select(g2, { label: 'Max rate', options: [32000, 24000, 16000, 12000, 10000, 8000, 6000, 4000].map(r => [r, `${(r / 1000).toFixed(0)} kHz`]), value: inst.rate || 32000,
      onChange: (v) => { inst.rate = v; fire(); } });
    kit.slider(g2, { label: 'Max loop ms', min: 1, max: 100, value: inst.loop || 50, title: 'Longest loop kept; long loops become a few pitch periods',
      onInput: debounce((v) => { inst.loop = v; fire(); }) });
    kit.slider(g2, { label: 'One-shot ms', min: 40, max: 2000, step: 10, value: inst.len || 800, title: 'Unlooped samples are cut (or tail-looped) beyond this',
      onInput: debounce((v) => { inst.len = v; fire(); }) });

    // ---------------- the squeezed sample in RAM
    const g3 = kit.group(left, 'In audio RAM (this song)');
    sampleBox = kit.row(g3);
    wave = kit.canvas(g3, { width: 520, height: 110, draw: drawWave });
    ramInfo = kit.note(g3, '');
    showSample();

    // ---------------- envelope
    const g4 = kit.group(right, 'Envelope (S-DSP ADSR / GAIN, 32 kHz rate table)');
    const r4 = kit.row(g4);
    kit.seg(r4, { label: 'Mode', options: [['adsr', 'ADSR'], ['gain', 'GAIN']], value: inst.env || 'adsr', onChange: (v) => { inst.env = v; fire(); build(); } });
    const regs = kit.note(r4, '');
    const ec1 = g4, ec2 = g4;
    const upd = () => { regs.textContent = regText(); envCv.redraw(); envInfo.textContent = envText(); };
    const num = (key, label, min, max, title) => kit.slider(ec1, { label, min, max, value: inst[key] | 0, title, onInput: (v) => { inst[key] = v; upd(); fireSoon(); } });
    if ((inst.env || 'adsr') === 'adsr') {
      num('ar', 'AR attack', 0, 15, 'Attack rate: linear +32/tick (AR 15 = +1024, instant)');
      num('dr', 'DR decay', 0, 7, 'Decay rate (exponential) toward the sustain level');
      num('sl', 'SL sustain', 0, 7, 'Sustain level (SL+1)/8 — where decay hands over to SR');
      num('sr', 'SR release', 0, 31, 'Sustain rate: exponential decay while the key is held (0 = hold)');
    } else {
      kit.select(ec1, { label: 'GAIN', options: GAIN_MODES, value: inst.gmode || 'direct', onChange: (v) => { inst.gmode = v; if (v !== 'direct' && inst.gval > 31) inst.gval = 12; fire(); build(); } });
      if ((inst.gmode || 'direct') === 'direct') num('gval', 'Level', 0, 127, 'Direct GAIN: envelope = value × 16');
      else num('gval', 'Rate', 0, 31, 'GAIN slope rate (rate table index)');
    }
    num('rel', 'Key-off', 0, 31, '0 = hardware KOFF (−8/sample, 8 ms); 1–31 = driver switches to GAIN exp-decrease at this rate');
    envCv = kit.canvas(ec2, { width: 460, height: 110, draw: drawEnv });
    envInfo = kit.note(g4, '');
    upd();

    // ---------------- voice
    const g5 = kit.group(right, 'Voice');
    const r5 = kit.row(g5);
    kit.toggle(r5, { label: 'Echo (EON)', value: inst.echo, title: 'Send this voice into the echo buffer (level follows the channel CC91)', onChange: (v) => { inst.echo = v; fire(); } });
    kit.toggle(r5, { label: 'Noise (NON)', value: inst.noise, title: 'Voice plays the noise generator instead of its sample', onChange: (v) => { inst.noise = v; fire(); build(); } });
    if (inst.noise) kit.slider(g5, { label: 'Noise clock', min: 0, max: 31, value: inst.nrate | 0, fmt: (v) => v + '',
      title: 'FLG noise rate (one global clock: the latest noise note sets it). Follows the note unless Fixed pitch.',
      onInput: (v) => { inst.nrate = v; nInfo.textContent = noiseText(); fireSoon(); } });
    const nInfo = inst.noise ? kit.note(g5, noiseText()) : null;
    kit.slider(g5, { label: 'Coarse', min: -24, max: 24, value: inst.coarse | 0, fmt: (v) => (v > 0 ? '+' : '') + v, onInput: (v) => { inst.coarse = v; fireSoon(); } });
    kit.slider(g5, { label: 'Fine', min: -100, max: 100, value: inst.tune | 0, fmt: (v) => (v > 0 ? '+' : '') + v + '¢', onInput: (v) => { inst.tune = v; fireSoon(); } });
    kit.slider(g5, { label: 'Volume', min: 0, max: 127, value: inst.vol != null ? inst.vol : 100, onInput: (v) => { inst.vol = v; fireSoon(); } });
    kit.slider(g5, { label: 'Pan', min: -64, max: 63, value: inst.pan | 0, fmt: (v) => (v === 0 ? 'C' : v < 0 ? 'L' + -v : 'R' + v), onInput: (v) => { inst.pan = v; fireSoon(); } });
    echoNote = kit.note(g5, '');
    showSample();
  }

  // ---------------- helpers
  let fT = 0;
  function fireSoon() { clearTimeout(fT); fT = setTimeout(fire, 60); }
  function debounce(fn) { let t = 0; return (v) => { clearTimeout(t); t = setTimeout(() => fn(v), 250); }; }
  function regText() {
    const a1 = ((inst.env === 'gain') ? 0 : 0x80) | ((inst.dr & 7) << 4) | (inst.ar & 15), a2 = ((inst.sl & 7) << 5) | (inst.sr & 31);
    let g = inst.gval & 0x7F;
    if (inst.env === 'gain' && inst.gmode !== 'direct') g = ({ linDec: 4, expDec: 5, linInc: 6, bentInc: 7 }[inst.gmode] << 5) | (inst.gval & 31);
    return `ADSR1 ${hex(a1)}  ADSR2 ${hex(a2)}  GAIN ${hex(inst.env === 'gain' ? g : 0)}`;
  }
  function envText() {
    const rel = inst.rel ? `key-off GAIN ${hex(0xA0 | inst.rel)} ${db(rateDbps(inst.rel))}` : 'key-off KOFF 8 ms';
    if (inst.env === 'gain') return `GAIN ${GAIN_MODES.find(m => m[0] === inst.gmode)?.[1] || 'Direct'} · ${inst.gmode === 'direct' ? 'level ' + inst.gval : 'tick every ' + ms(RATE_PERIOD[inst.gval & 31] / 32000)} · ${rel}`;
    const dec = (inst.sl & 7) === 7 ? 'no decay stage (SL 7)' : `decay ${db(rateDbps(16 + 2 * (inst.dr & 7)))} to ${(inst.sl & 7) + 1}/8`;
    return `attack ${ms(attackTime(inst.ar & 15))} · ${dec} · sustain ${db(rateDbps(inst.sr & 31))} · ${rel}`;
  }
  function noiseText() { const r = inst.nrate | 0; return `noise clock ${r ? Math.round(32000 / RATE_PERIOD[r]) + ' Hz' : 'stopped'} (15-bit LFSR)`; }
  function drawEnv(c, w, h) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const attack = inst.env === 'gain' ? 0.5 : attackTime(inst.ar & 15);
    const hold = Math.min(2.5, Math.max(0.35, attack + 0.8));
    const relS = inst.rel ? Math.min(2, 800 * RATE_PERIOD[inst.rel] / 32000) : 0.05;
    const sim = simulateEnv(inst, hold, hold + Math.max(0.15, relS), 260);
    const kx = 4 + hold / sim.total * (w - 8);
    c.strokeStyle = GRID; c.beginPath();
    for (let i = 1; i < 4; i++) { const y = 4 + i * (h - 8) / 4; c.moveTo(0, y); c.lineTo(w, y); }
    c.stroke();
    c.strokeStyle = '#e2463b'; c.beginPath(); c.moveTo(kx, 0); c.lineTo(kx, h); c.stroke();
    if (inst.env !== 'gain') { const y = h - 4 - ((inst.sl & 7) + 1) / 8 * (h - 8); c.strokeStyle = DIM; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); c.setLineDash([]); }
    c.strokeStyle = FG; c.lineWidth = 2; c.beginPath();
    sim.pts.forEach(([t, l], i) => { const x = 4 + t * (w - 8), y = h - 4 - l * (h - 8); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.stroke(); c.lineWidth = 1;
    c.fillStyle = '#7f7'; c.font = '10px monospace';
    c.fillText(ms(sim.total), w - 40, h - 6); c.fillText('key-off', Math.min(w - 44, kx + 3), 11);
  }
  function current() { const v = prepView.byName[inst.name]; return v || null; }
  function showSample() {
    if (!sampleBox) return;
    sampleBox.innerHTML = '';
    const v = current();
    const info = prepView.info;
    if (echoNote) echoNote.textContent = info ? `Echo is global on the S-DSP: EDL ${info.edl} = ${info.edl * 16} ms, ${info.echoBytes / 1024} KB of RAM (chosen by the squeeze); FIR and feedback are machine options. An instrument only sets its voice's EON bit.` : '';
    if (ramInfo) ramInfo.textContent = info ? `RAM: ${info.bytes.toLocaleString()} of ${info.budget.toLocaleString()} sample bytes · ${info.samples} BRR samples for ${info.instruments} instruments · mean ${(info.meanRate / 1000).toFixed(1)} kHz · echo ${info.echoBytes / 1024} KB · driver/dir 8 KB` : '';
    if (!v) { kit.note(sampleBox, 'Not in RAM yet — the squeeze runs when an instrument is used (selected, arranged or mapped).'); wave.redraw(); return; }
    if (v.noise) { kit.note(sampleBox, 'Noise instrument: no sample (the voice runs a silent looping block; NON replaces its output).'); wave.redraw(); return; }
    if (split >= v.splits.length) split = 0;
    if (v.splits.length > 1) kit.seg(sampleBox, { label: 'Split', options: v.splits.map((s, i) => [i, `${i ? noteName(v.splits[i - 1].hi + 1) : 'C-1'}–${noteName(Math.min(127, s.hi))}`]), value: split, onChange: (i) => { split = i; showSample(); } });
    const s = v.splits[split];
    if (s && s.pcm) {
      const loop = s.loopStart >= 0 ? `loop ${s.loopStart}+${s.loopLen} (${s.mode})` : 'one-shot';
      kit.note(sampleBox, `${(s.rate / 1000).toFixed(2)} kHz · ${s.samples} samples (${ms(s.samples / s.rate)}) · ${s.bytes} BRR bytes @ ${hex(s.addr, 4)} · ${loop} · squeeze ${s.level}/${s.levels}${s.shared > 1 ? ` · shared by ${s.shared}` : ''}`);
    }
    wave.redraw();
  }
  function drawWave(c, w, h) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const v = current(), s = v && v.splits && v.splits[split];
    c.strokeStyle = GRID; c.beginPath(); c.moveTo(0, h / 2); c.lineTo(w, h / 2); c.stroke();
    if (!s || !s.pcm) return;
    const pcm = s.pcm, n = pcm.length;
    if (s.loopStart >= 0) { const x0 = s.loopStart / n * w; c.fillStyle = 'rgba(242,198,58,0.18)'; c.fillRect(x0, 0, w - x0, h); c.fillStyle = LOOP; c.fillRect(x0, 0, 1, h); }
    c.strokeStyle = FG; c.beginPath();
    for (let x = 0; x < w; x++) {
      const a = Math.floor(x / w * n), b = Math.max(a + 1, Math.floor((x + 1) / w * n));
      let lo = 32767, hi = -32768;
      for (let i = a; i < b && i < n; i++) { const p = pcm[i]; if (p < lo) lo = p; if (p > hi) hi = p; }
      c.moveTo(x + 0.5, h / 2 - hi / 32768 * (h / 2 - 2)); c.lineTo(x + 0.5, h / 2 - lo / 32768 * (h / 2 - 2) + 1);
    }
    c.stroke();
    // block grid: 16-sample BRR blocks when zoomed far enough
    if (n / 16 < w / 4) { c.fillStyle = '#163'; for (let b = 0; b < n; b += 16) c.fillRect(b / n * w, h - 3, 1, 3); }
  }

  const onPrep = () => { if (alive) showSample(); };
  if (prepEvents) prepEvents.addEventListener('prep', onPrep);
  build();
  return { destroy() { alive = false; if (prepEvents) prepEvents.removeEventListener('prep', onPrep); clearTimeout(fT); } };
}
