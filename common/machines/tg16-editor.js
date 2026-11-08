// TurboGrafx-16 instrument editor: channel mode (wavetable / noise / DDA), the 32 × 5-bit wave RAM,
// noise frequency, DDA sample, L/R balance, and volume / arpeggio / pitch / noise-frequency frame
// macros. Original code for RetroSynths.
import { WAVES, DDA_BANK, buildDDA } from './tg16-data.js';
import { PSG_CLOCK } from './tg16-psg.js';
import { macroTabs, driverGroup } from './atari-editor-common.js';

let bankCache = null;
const bank = () => bankCache || (bankCache = buildDDA());

export function mountEditor(el, inst, kit, onChange) {
  inst.wave = Array.isArray(inst.wave) && inst.wave.length === 32 ? inst.wave : Array.from(WAVES.SQUARE);
  const top = kit.columns(el, 2, 'minmax(0, 1.25fr) minmax(220px, 0.75fr)');
  const g = kit.group(top[0], 'PSG channel');
  kit.seg(g, { label: 'Mode', value: inst.mode || 'wave', options: [['wave', 'Wavetable'], ['noise', 'Noise (ch 5–6)'], ['dda', 'DDA sample']],
    onChange: (v) => { inst.mode = v; inst.kind = v === 'noise' ? 'noise' : 'any'; if (v === 'dda' && !inst.drum) inst.track = true; onChange(inst); body(); } });
  const box = document.createElement('div'); g.appendChild(box);

  function body() {
    box.innerHTML = '';
    if ((inst.mode || 'wave') === 'wave') {
      const r = kit.row(box);
      kit.select(r, { label: 'Load wave', value: '', options: [['', '—'], ...Object.keys(WAVES).map((k) => [k, k[0] + k.slice(1).toLowerCase()])],
        onChange: (k) => { if (!k) return; inst.wave = Array.from(WAVES[k]); onChange(inst); body(); } });
      kit.wave(box, { label: 'Wave RAM (32 × 5-bit, 0–31)', length: 32, max: 31, values: inst.wave, width: 416, height: 136,
        onChange: () => { inst.wave = inst.wave.slice(); onChange(inst); } });
      kit.note(box, 'Uploaded to the channel\'s wave RAM (R4 = $40, 32 writes to R6) when a voice takes this instrument. f = 3.58 MHz ÷ (32 × period).');
    } else if (inst.mode === 'noise') {
      const rate = (nf) => { const n = (nf & 31) ^ 31; return PSG_CLOCK / (n ? n * 64 : 32); };
      kit.slider(box, { label: 'Noise freq', min: 0, max: 31, value: inst.nf ?? 18, onInput: (v) => { inst.nf = v; onChange(inst); },
        fmt: (v) => `${v} · ${(rate(v) / 1000).toFixed(2)} kHz`, title: 'R7 bits 4–0: LFSR clock = 3.58 MHz ÷ (64 × (31 − n))' });
      kit.toggle(box, { label: 'Frequency follows the key (≈1 step per 3 semitones)', value: !!inst.nfTrack, onChange: (v) => { inst.nfTrack = v; onChange(inst); } });
      kit.note(box, 'Only channels 5 and 6 have the noise generator (R7). The "Noise freq" macro, when used, sets R7 per frame.');
    } else {
      const names = Object.keys(DDA_BANK);
      kit.select(box, { label: 'Sample', value: inst.sample || 'kick', options: names.map((k) => [k, DDA_BANK[k][0]]), onChange: (v) => { inst.sample = v; onChange(inst); cv.redraw(); } });
      const cv = kit.canvas(box, { width: 416, height: 96, label: 'DDA sample (5-bit, 6.99 kHz timer IRQ)', draw: (c, w, h) => {
        c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
        const s = bank()[inst.sample] || bank().kick;
        c.strokeStyle = '#4cff6a'; c.beginPath();
        for (let x = 0; x < w; x++) { const v = s[Math.floor(x / w * s.length)]; const y = h - 4 - v / 31 * (h - 8); x ? c.lineTo(x, y) : c.moveTo(x, y); }
        c.stroke(); c.fillStyle = '#9c9'; c.font = '10px monospace'; c.fillText(`${s.length} samples · ${(s.length / 6991).toFixed(2)} s`, 4, 12);
      } });
      kit.note(box, '"Pitch tracks the key" (Driver) re-pitches by stepping through the sample at a fractional rate per timer IRQ.');
    }
  }
  body();

  // ---- balance
  const bg = kit.group(top[1], 'Balance (R5)');
  const bc = kit.canvas(bg, { width: 210, height: 60, draw: (c, w, h) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    const L = inst.balL ?? 15, R = inst.balR ?? 15;
    const bar = (x, v, lab) => { const hh = v / 15 * (h - 16); c.fillStyle = '#1b6b2a'; c.fillRect(x, h - 4 - hh, 60, hh); c.fillStyle = '#4cff6a'; c.fillRect(x, h - 4 - hh, 60, 2);
      c.fillStyle = '#9c9'; c.font = '10px monospace'; c.fillText(`${lab} ${v ? (v === 15 ? '0 dB' : '−' + (3 * (15 - v)) + ' dB') : 'off'}`, x, 10); };
    bar(20, L, 'L'); bar(130, R, 'R');
  } });
  kit.slider(bg, { label: 'Left', min: 0, max: 15, value: inst.balL ?? 15, onInput: (v) => { inst.balL = v; bc.redraw(); onChange(inst); } });
  kit.slider(bg, { label: 'Right', min: 0, max: 15, value: inst.balR ?? 15, onInput: (v) => { inst.balR = v; bc.redraw(); onChange(inst); } });
  kit.note(bg, '3 dB per step, added to the MIDI pan. Channel volume (R4) is 1.5 dB per step.');

  macroTabs(el, kit, inst, onChange, [
    { key: 'vol', label: 'Volume', min: 0, max: 31, maxLength: 128, hint: 'R4 channel volume per frame (5-bit, 1.5 dB/step). Velocity and CC7/CC11 subtract from it.' },
    { key: 'arp', label: 'Arpeggio', min: -24, max: 24, zero: 0, fmt: (v) => (v > 0 ? '+' : '') + v + ' st', hint: 'Semitone offset per frame.' },
    { key: 'pitch', label: 'Pitch', min: -96, max: 96, zero: 0, fmt: (v) => (v / 8).toFixed(2) + ' st', hint: 'Pitch offset per frame in 1/8 semitones (12-bit period).' },
    { key: 'freq', label: 'Noise freq', min: 0, max: 31, init: inst.nf ?? 31, hint: 'Noise mode: R7 frequency per frame (absolute; "follows the key" adds to it).' },
  ]);
  driverGroup(el, kit, inst, onChange, { frameHz: 59.83 });
  return { destroy() {} };
}
