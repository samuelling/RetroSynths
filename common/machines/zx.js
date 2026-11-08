// ZX Spectrum 128 — General Instrument AY-3-8912 at 1.7734 MHz (the 128's 3.5469 MHz CPU clock ÷ 2),
// driven by a 50 Hz frame-interrupt music driver (see ay-driver.js). Mono through the TV/beeper path by
// default, or "ABC" stereo (A left, B centre, C right) as on later Spectrums / interfaces.
// Bass patches use the hardware envelope as a buzzer waveform, the classic Spectrum bass sound.
import { AYDriver } from './ay-driver.js';

export default class ZX extends AYDriver {
  static info = {
    id: 'zx', name: 'ZX Spectrum 128', maker: 'Sinclair', year: 1986,
    chip: 'GI AY-3-8912 @ 1.7734 MHz', voices: '3 square + noise + envelope',
    spec: 'AY-3-8912 at 1.7734 MHz, 50 Hz driver, arpeggio chords, envelope "buzzer" bass, noise drums',
  };
  static options = [
    { key: 'stereo', label: 'Output', choices: [['mono', 'Mono'], ['ABC', 'ABC stereo']], default: 'mono' },
  ];
  constructor(host) {
    super(host, { chips: [{ clock: 1773400, variant: 'AY' }], frameHz: 50, panMode: 'mono', buzz: true, drumVoices: 1, gain: 0.36 });
  }
  setOption(key, value) {
    if (key === 'stereo' && (value === 'mono' || value === 'ABC')) this.setPanMode(value);
  }
}
