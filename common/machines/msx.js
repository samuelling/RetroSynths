// MSX — Yamaha YM2149 PSG at 1.789773 MHz (3.579545 MHz ÷ 2), 60 Hz VDP-interrupt replay routine
// (ay-driver.js) playing native tracker-style instruments (ay-instruments.js). Mono. The YM's 32-step
// envelope and 5-bit DAC make the hardware-envelope sounds smoother than on the AY.
import { AYDriver } from './ay-driver.js';
import { buildAYLibrary } from './ay-instruments.js';

const LIB = buildAYLibrary({ fps: 60, buzzBass: true, ym: true });

export default class MSX extends AYDriver {
  static info = {
    id: 'msx', name: 'MSX', maker: 'ASCII / Microsoft', year: 1983,
    chip: 'Yamaha YM2149 @ 1.789773 MHz', voices: '3 square + noise + envelope',
    spec: 'YM2149 PSG at 1.79 MHz, 60 Hz replay, arpeggio chords, 32-step envelope bass, noise drums',
  };
  static voices = [
    { id: 'A', name: 'Tone A', kind: 'ay' },
    { id: 'B', name: 'Tone B', kind: 'ay' },
    { id: 'C', name: 'Tone C', kind: 'ay' },
  ];
  static presets = LIB.presets;
  static gmPreset(program) { return LIB.gmPreset(program); }
  static gmDrum(note) { return LIB.gmDrum(note); }
  static chipInfo = { clock: 1789773, variant: 'YM', fps: 60 };
  constructor(host) {
    super(host, { chips: [{ clock: 1789773, variant: 'YM' }], frameHz: 60, panMode: 'mono', drumVoices: 1, gain: 0.39, lib: LIB, voiceIds: ['A', 'B', 'C'] });
  }
}
