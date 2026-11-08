// AdLib / Sound Blaster 2.0 — Yamaha YM3812 (OPL2): 9 two-operator FM channels, 4 waveforms, mono DAC.
// Bit-exact Nuked OPL3 core in OPL2-compatible mode (see opl-driver.js), original Blasta FM bank (opl-bank.js).
import { OPLMachine } from './opl-driver.js';
import { PRESETS, gmPreset, gmDrum } from './opl-bank.js';

export default class OPL2 extends OPLMachine {
  static info = {
    id: 'opl2', name: 'AdLib / Sound Blaster 2.0', maker: 'AdLib / Creative', year: 1989, chip: 'Yamaha YM3812 · OPL2',
    voices: '9 FM channels · 2 operators · 4 waveforms',
    spec: '9 voices · 49,716 Hz · 4 waveforms · mono float DAC',
  };
  static voices = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + (i + 1), name: `Ch ${i + 1}`, kind: 'fm' }));
  static presets = PRESETS;
  static gmPreset(program) { return gmPreset(program); }
  static gmDrum(note) { return gmDrum(note); }
  static options = [{ key: 'analog', label: 'Analog grit', choices: [[1, 'On'], [0, 'Off']], default: 1 }];
  constructor(host) { super(host, 0); }
}
