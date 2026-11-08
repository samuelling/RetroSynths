// Apple IIe + Mockingboard — two GI AY-3-8910 PSGs clocked by the Apple's 1.0227 MHz phase-0 clock,
// chip 1 → left, chip 2 → right, driven at 60 Hz by a 6522-timer interrupt music driver (ay-driver.js),
// plus the Apple's own 1-bit speaker (beeper.js) for drum clicks. With no card, the speaker plays
// everything the way Apple II games did: one voice, fast arpeggios, pulse width for loudness.
import { AYDriver } from './ay-driver.js';
import { OneBitDriver } from './beeper.js';

const CPU = 1022727;

export default class Apple2 {
  static info = {
    id: 'apple2', name: 'Apple IIe + Mockingboard', maker: 'Apple / Sweet Micro', year: 1983,
    chip: '1-bit speaker + 2 × GI AY-3-8910', voices: '1-bit speaker · 6 square + 2 noise',
    spec: 'Two AY-3-8910 at 1.0227 MHz (left / right), 60 Hz driver, speaker drum clicks',
  };
  static options = [
    { key: 'card', label: 'Sound', choices: [['mockingboard', 'Mockingboard'], ['none', 'Speaker only']], default: 'mockingboard' },
    { key: 'speakerDrums', label: 'Speaker drums', choices: [[true, 'On'], [false, 'Off']], default: true },
  ];
  constructor(host) {
    this.h = host;
    this.mb = new AYDriver(host, { chips: [{ clock: CPU, variant: 'AY' }, { clock: CPU, variant: 'AY' }], frameHz: 60, panMode: 'chips', buzz: false, drumVoices: 2, drumGain: 0.75, gain: 0.56 });
    this.spk = new OneBitDriver(host, { clock: CPU, timer: 'cpu', quantum: 5, gateOff: false, speaker: 'apple', frameHz: 60, volume: 'pwm', mode: 'priority', gain: 0.25 });
    this.card = true; this.speakerDrums = true;
    this.mb.extDrum = (note, vel, amp, c) => {
      if (!this.speakerDrums) return false;
      this.spk.drumHit(note, amp, c); return true;
    };
  }
  get d() { return this.card ? this.mb : this.spk; }
  noteOn(c, n, v) { this.d.noteOn(c, n, v); }
  noteOff(c, n) { this.d.noteOff(c, n); }
  sustainOff(c) { this.d.sustainOff(c); }
  allOff(c, hard) { this.mb.allOff(c, hard); this.spk.allOff(c, hard); }
  pitch(c) {}
  ctrl(c) { this.mb.ctrl(c); this.spk.ctrl(c); }
  reset() { this.mb.reset(); this.spk.reset(); }
  activeCount() { return this.card ? this.mb.activeCount() + this.spk.activeCount() : this.spk.activeCount(); }
  maxVoices() { return this.card ? 7 : 1; }
  setOption(key, value) {
    if (key === 'card' && (value === 'mockingboard' || value === 'none')) { if (this.card !== (value === 'mockingboard')) { this.reset(); this.card = value === 'mockingboard'; } }
    else if (key === 'speakerDrums' && (value === true || value === false)) this.speakerDrums = value;
  }
  render(L, R, n) {
    if (this.card) this.mb.render(L, R, n); else { L.fill(0, 0, n); R.fill(0, 0, n); }
    this.spk.renderAdd(L, R, n, this.card ? 0.3 : 0.25);
  }
}
