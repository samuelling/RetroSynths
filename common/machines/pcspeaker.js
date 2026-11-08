// IBM PC speaker — Intel 8253 PIT channel 2 in mode 3 (square wave, 1.193182 MHz ÷ divisor) gated through
// port 61h into a small speaker cone. Driven like a DOS game's sound routine (see beeper.js): one note at
// a time by priority (melody > bass > chords), chords as fast arpeggios at the timer-interrupt rate,
// drums as short pitch-sweep / noise blips that interrupt the tone.
import { OneBitDriver } from './beeper.js';

export default class PCSpeaker extends OneBitDriver {
  static info = {
    id: 'pcspeaker', name: 'IBM PC speaker', maker: 'IBM', year: 1981,
    chip: 'Intel 8253 PIT → speaker', voices: '1-bit square · arpeggiated chords',
    spec: 'PIT channel 2 square at 1.193182 MHz ÷ N, one voice by priority, 60/120 Hz arpeggios, drum blips',
  };
  static options = [
    { key: 'rate', label: 'Driver', choices: [[60, '60 Hz'], [120, '120 Hz']], default: 60 },
    { key: 'mode', label: 'Voices', choices: [['priority', 'Priority'], ['multiplex', 'Multiplex']], default: 'priority' },
    { key: 'volume', label: 'Volume', choices: [['square', 'Square (none)'], ['pwm', 'Pulse width']], default: 'square' },
  ];
  constructor(host) {
    super(host, { clock: 1193182, timer: 'pit', gateOff: true, speaker: 'pc', frameHz: 60, volume: 'square', mode: 'priority', gain: 0.25 });
  }
  setOption(key, value) {
    if (key === 'rate' && (value === 60 || value === 120)) this.setRate(value);
    else if (key === 'mode' && (value === 'priority' || value === 'multiplex')) this.cfg.mode = value;
    else if (key === 'volume' && (value === 'square' || value === 'pwm')) this.cfg.volume = value;
  }
}
