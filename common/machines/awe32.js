// Sound Blaster AWE32 — E-mu EMU8000: 30-voice SoundFont wavetable, ROM-budget bank, linear interpolation,
// SF2.0 default modulators, gritty half-rate reverb and chorus (see emu-sampler.js).
import { emuClass } from './emu-machine.js';

export default class AWE32 extends emuClass(2, 'awe') {
  static info = {
    id: 'awe32', name: 'Sound Blaster AWE32', maker: 'Creative', year: 1994, chip: 'E-mu EMU8000',
    voices: '30 wavetable voices · SoundFont bank', spec: '30 voices · ROM-style bank · linear interp · gritty reverb',
  };
  static voices = Array.from({ length: 30 }, (_, i) => ({ id: 'v' + (i + 1), name: `V${i + 1}`, kind: 'sample' }));
  static options = [
    { key: 'reverb', label: 'Reverb', choices: [['room1', 'Room 1'], ['room2', 'Room 2'], ['room3', 'Room 3'], ['hall1', 'Hall 1'], ['hall2', 'Hall 2'], ['plate', 'Plate'], ['delay', 'Delay'], ['pandelay', 'Panning delay']], default: 'hall1' },
    { key: 'chorus', label: 'Chorus', choices: [['chorus1', 'Chorus 1'], ['chorus2', 'Chorus 2'], ['chorus3', 'Chorus 3'], ['chorus4', 'Chorus 4'], ['feedback', 'Feedback'], ['flanger', 'Flanger'], ['short', 'Short delay'], ['shortfb', 'Short delay FB']], default: 'chorus3' },
  ];
}
