// Sound Blaster 16 — Yamaha YMF262 (OPL3): 18 FM channels, 8 waveforms, L/R stereo, 4-op channel pairs.
// Bit-exact Nuked OPL3 core (see opl-driver.js), original Blasta FM bank + 4-op showcase patches (opl-bank.js).
import { OPLMachine } from './opl-driver.js';
import { PRESETS, gmPreset, gmDrum } from './opl-bank.js';

const PAIR = { 0: 3, 1: 4, 2: 5, 9: 12, 10: 13, 11: 14 };
const PART = Object.fromEntries(Object.entries(PAIR).map(([a, b]) => [b, +a]));
export default class OPL3 extends OPLMachine {
  static info = {
    id: 'opl3', name: 'Sound Blaster 16', maker: 'Creative', year: 1992, chip: 'Yamaha YMF262 · OPL3',
    voices: '18 FM channels · 4-op pairs · 8 waveforms · stereo',
    spec: '18 voices · 49,716 Hz · 8 waveforms · L/R stereo · 4-op pairs',
  };
  static voices = Array.from({ length: 18 }, (_, i) => {
    const mate = PAIR[i] != null ? PAIR[i] : PART[i];
    return { id: 'c' + (i + 1), name: mate != null ? `Ch ${i + 1} ⇄${mate + 1}` : `Ch ${i + 1}`, kind: 'fm' };
  });
  static presets = PRESETS;
  static gmPreset(program) { return gmPreset(program); }
  static gmDrum(note) { return gmDrum(note); }
  static options = [{ key: 'analog', label: 'Analog grit', choices: [[1, 'On'], [0, 'Off']], default: 1 }];
  constructor(host) { super(host, 1); }
}
