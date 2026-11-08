// AWE32 / Live! instruments = the loaded SoundFont's own presets (bank:program + real names), with
// generator overrides layered on top (ov: per-generator offsets for all zones; zov: absolute per-zone values).
// Also the General MIDI fallback chain used by both the app (Arranger labels) and the worklet.

export const FAMILY = ['Piano', 'Chromatic Perc.', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass',
  'Reed', 'Pipe', 'Synth Lead', 'Synth Pad', 'Synth FX', 'Ethnic', 'Percussive', 'Sound FX'];
const pad = (n) => String(n).padStart(3, '0');
export const presetName = (bank, program, name) => `${pad(bank)}:${pad(program)} ${name}`;
export function categoryOf(bank, program) {
  if (bank >= 128) return 'Drum kits';
  if (bank === 0) return `Bank 0 · ${FAMILY[program >> 3]}`;
  return `Bank ${bank} variations`;
}
/** list = [[bank, program, name], …] (sorted) → instrument table entries */
export function presetsFromList(list) {
  return list.map(([bank, program, name]) => ({ name: presetName(bank, program, name), category: categoryOf(bank, program), kind: 'sample', bank, program, ov: {}, zov: {} }));
}
export const bankKey = (sfName, n, budget) => `${sfName}|${n}|${budget}`;

/**
 * GM program → index into list: exact bank:program → bank 0 same program → nearest preset of the same GM
 * family (program >> 3) → the bank's first melodic preset. −1 if the bank has no melodic presets.
 */
export function resolveMelodic(list, bank, program) {
  let first = -1, fam = -1, famD = Infinity, b0 = -1;
  for (let i = 0; i < list.length; i++) {
    const [b, p] = list[i];
    if (b >= 128) continue;
    if (first < 0) first = i;
    if (b === bank && p === program) return i;
    if (b === 0 && p === program) b0 = i;
    if ((p >> 3) === (program >> 3)) { const d = Math.abs(p - program) * 2 + (b === 0 ? 0 : 1); if (d < famD) { famD = d; fam = i; } }
  }
  return b0 >= 0 ? b0 : fam >= 0 ? fam : first;
}
/** drum kit: requested kit (128:program) → kit 0 → any bank-128 preset → −1 (silent) */
export function resolveKit(list, program) {
  let k0 = -1, any = -1;
  for (let i = 0; i < list.length; i++) {
    const [b, p] = list[i];
    if (b < 128) continue;
    if (p === program) return i;
    if (p === 0) k0 = i;
    if (any < 0) any = i;
  }
  return k0 >= 0 ? k0 : any;
}

// generator ranges (SF2 units) for overrides
export const GEN_RANGE = {
  5: [-12000, 12000], 6: [-12000, 12000], 7: [-12000, 12000], 8: [1500, 13500], 9: [0, 960], 10: [-12000, 12000], 11: [-12000, 12000],
  13: [-960, 960], 15: [0, 1000], 16: [0, 1000], 17: [-500, 500], 21: [-12000, 5000], 22: [-16000, 4500], 23: [-12000, 5000], 24: [-16000, 4500],
  25: [-12000, 5000], 26: [-12000, 8000], 27: [-12000, 5000], 28: [-12000, 8000], 29: [0, 1000], 30: [-12000, 8000],
  33: [-12000, 5000], 34: [-12000, 8000], 35: [-12000, 5000], 36: [-12000, 8000], 37: [0, 1440], 38: [-12000, 8000],
  48: [0, 1440], 51: [-120, 120], 52: [-99, 99], 56: [0, 1200],
};
/** zone generators with an instrument's overrides applied */
export function applyOverrides(g, ov, zv) {
  const out = new Int32Array(g);
  if (ov) for (const k in ov) { const r = GEN_RANGE[k]; let v = out[k] + (ov[k] | 0); if (r) v = Math.max(r[0], Math.min(r[1], v)); out[k] = v; }
  if (zv) for (const k in zv) { const r = GEN_RANGE[k]; let v = zv[k] | 0; if (r) v = Math.max(r[0], Math.min(r[1], v)); out[k] = v; }
  return out;
}
