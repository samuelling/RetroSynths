// ZX Spectrum 128 — General Instrument AY-3-8912 at 1.7734 MHz (the 128's 3.5469 MHz CPU clock ÷ 2),
// driven by a 50 Hz frame-interrupt replay routine (ay-driver.js) playing native tracker-style instruments
// (ay-instruments.js). Mono by default, or "ABC" stereo (A left, B centre, C right).
// GM basses use the hardware envelope as a buzzer waveform, the classic Spectrum bass sound.
import { AYDriver } from './ay-driver.js';
import { buildAYLibrary } from './ay-instruments.js';

const LIB = buildAYLibrary({ fps: 50, buzzBass: true });

export default class ZX extends AYDriver {
  static info = {
    id: 'zx', name: 'ZX Spectrum 128', maker: 'Sinclair', year: 1986,
    chip: 'GI AY-3-8912 @ 1.7734 MHz', voices: '3 square + noise + envelope',
    spec: 'AY-3-8912 at 1.7734 MHz, 50 Hz replay, arpeggio chords, envelope "buzzer" bass, noise drums',
  };
  static options = [
    { key: 'stereo', label: 'Output', choices: [['mono', 'Mono'], ['ABC', 'ABC stereo']], default: 'mono' },
  ];
  static voices = [
    { id: 'A', name: 'Tone A', kind: 'ay' },
    { id: 'B', name: 'Tone B', kind: 'ay' },
    { id: 'C', name: 'Tone C', kind: 'ay' },
  ];
  static presets = LIB.presets;
  static gmPreset(program) { return LIB.gmPreset(program); }
  static gmDrum(note) { return LIB.gmDrum(note); }
  static chipInfo = { clock: 1773400, variant: 'AY', fps: 50 };
  constructor(host) {
    super(host, { chips: [{ clock: 1773400, variant: 'AY' }], frameHz: 50, panMode: 'mono', drumVoices: 1, gain: 0.36, lib: LIB, voiceIds: ['A', 'B', 'C'] });
  }
  setOption(key, value) {
    if (key === 'stereo' && (value === 'mono' || value === 'ABC')) this.setPanMode(value);
  }
}
