// Sound Blaster Live! — E-mu EMU10K1: 64-voice SoundFont wavetable, 8-point interpolation, SF2.01 modulators,
// stereo reverb and chorus (see emu-sampler.js).
import { emuClass } from './emu-machine.js';

export default class Live extends emuClass(3, 'live') {
  static info = {
    id: 'live', name: 'Sound Blaster Live!', maker: 'Creative', year: 1998, chip: 'E-mu EMU10K1',
    voices: '64 wavetable voices · SoundFont bank', spec: '64 voices · SoundFont bank · 8-point interp · SF2.01 modulators',
  };
  static voices = Array.from({ length: 64 }, (_, i) => ({ id: 'v' + (i + 1), name: `V${i + 1}`, kind: 'sample' }));
  static options = [
    { key: 'reverb', label: 'Reverb', choices: [['hall', 'Hall'], ['room', 'Room'], ['plate', 'Plate'], ['cathedral', 'Cathedral'], ['off', 'Off']], default: 'hall' },
  ];
}
