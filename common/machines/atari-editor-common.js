// Shared pieces of the Atari 2600 / Atari 800 / TurboGrafx-16 instrument editors (main thread):
// tracker-style macro tabs and the driver settings group. Original code for RetroSynths.

const ROLES = [['lead', 'Lead (melody)'], ['bass', 'Bass'], ['mid', 'Mid (chords/arps)'], ['pad', 'Pad'], ['fx', 'FX']];

/** Ensure inst[key] is a macro object. */
export function ensureMacro(inst, key) {
  if (!inst[key] || !Array.isArray(inst[key].values)) inst[key] = { values: [], loop: -1, release: -1 };
  return inst[key];
}

/**
 * Macro editor with tabs. tabs = [{ key, label, min, max, maxLength, fmt, hint }]
 * Empty macros show an "Enable" button (FamiTracker: unused sequence).
 */
export function macroTabs(parent, kit, inst, onChange, tabs, { title = 'Macros (one step per video frame)', width = 560 } = {}) {
  const g = kit.group(parent, title);
  const body = document.createElement('div');
  let cur = tabs[0].key;
  const show = () => {
    body.innerHTML = '';
    const t = tabs.find((x) => x.key === cur);
    const m = ensureMacro(inst, t.key);
    if (t.hint) kit.note(body, t.hint);
    if (!m.values.length) {
      const r = kit.row(body);
      kit.note(r, 'Not used.');
      kit.button(r, 'Enable', () => { m.values = [t.init != null ? t.init : t.min < 0 ? 0 : t.max]; onChange(inst); show(); });
      return;
    }
    kit.macro(body, { label: t.label, m, min: t.min, max: t.max, maxLength: Math.max(t.maxLength || 64, m.values.length), width, height: 120, fmt: t.fmt, zero: t.zero,
      onChange: () => onChange(inst) });
    const r = kit.row(body);
    kit.button(r, 'Clear macro', () => { m.values = []; m.loop = -1; m.release = -1; onChange(inst); show(); });
  };
  kit.seg(g, { options: tabs.map((t) => [t.key, t.label]), value: cur, onChange: (k) => { cur = k; show(); } });
  g.appendChild(body);
  show();
  return { redraw: show };
}

/** Driver settings: priority role / drum priority, release, vibrato. */
export function driverGroup(parent, kit, inst, onChange, { frameHz = 60 } = {}) {
  const g = kit.group(parent, 'Driver', { cols: 2 });
  const set = (k) => (v) => { inst[k] = v; onChange(inst); };
  if (inst.drum) {
    kit.slider(g, { label: 'Priority', min: 30, max: 70, value: inst.prio ?? 50, onInput: set('prio'), title: 'Voice-stealing priority (lead 60, bass 55, pads 38)' });
    kit.select(g, { label: 'Choke group', options: [['', 'none'], ['hat', 'hi-hat'], ['cym', 'cymbal']], value: inst.choke || '', onChange: set('choke') });
    kit.toggle(g, { label: 'Pitch tracks the key', value: !!inst.track, onChange: set('track'), title: 'Off: fixed-frequency drum. On: the key (or tom/conga pitch) sets the base, the frequency macro offsets it.' });
  } else {
    kit.select(g, { label: 'Role', options: ROLES, value: inst.role || 'mid', onChange: set('role'), title: 'Who wins a voice when there are too few: lead > drums > bass > mid > pad' });
    kit.slider(g, { label: 'Release', min: 0, max: 120, value: inst.rel ?? 6, onInput: set('rel'), fmt: (v) => v ? `${v} fr` : 'cut', title: 'Frames to fade after key-up when the volume macro has no release point' });
    kit.slider(g, { label: 'Vib delay', min: 0, max: 120, value: inst.vibDelay || 0, onInput: set('vibDelay'), fmt: (v) => `${v} fr` });
    kit.slider(g, { label: 'Vib depth', min: 0, max: 100, value: inst.vibDepth || 0, onInput: set('vibDepth'), fmt: (v) => `${v} ¢` });
    kit.slider(g, { label: 'Vib rate', min: 1, max: 12, step: 0.5, value: inst.vibRate || 5.5, onInput: set('vibRate'), fmt: (v) => `${v} Hz` });
  }
  kit.note(g, `Frame rate ${frameHz.toFixed(2)} Hz. MIDI velocity, CC7/CC11 scale the volume; CC1 adds vibrato; pitch bend applies.`);
  return g;
}

/** Note name helper for chart axes. */
export const noteName = (n) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
