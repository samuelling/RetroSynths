// MSX — Yamaha YM2149 PSG at 1.789773 MHz (3.579545 MHz ÷ 2), 60 Hz VDP-interrupt music driver
// (see ay-driver.js). Mono. The YM's 32-step envelope and 5-bit DAC make the hardware-envelope bass
// smoother than on the AY.
import { AYDriver } from './ay-driver.js';

export default class MSX extends AYDriver {
  static info = {
    id: 'msx', name: 'MSX', maker: 'ASCII / Microsoft', year: 1983,
    chip: 'Yamaha YM2149 @ 1.789773 MHz', voices: '3 square + noise + envelope',
    spec: 'YM2149 PSG at 1.79 MHz, 60 Hz driver, arpeggio chords, 32-step envelope bass, noise drums',
  };
  constructor(host) {
    super(host, { chips: [{ clock: 1789773, variant: 'YM' }], frameHz: 60, panMode: 'mono', buzz: true, drumVoices: 1, gain: 0.39 });
  }
}
