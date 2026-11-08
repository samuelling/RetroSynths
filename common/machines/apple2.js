// Apple IIe + Mockingboard — two GI AY-3-8910 PSGs clocked by the Apple's 1.0227 MHz phase-0 clock,
// chip 1 → left, chip 2 → right, driven at 60 Hz by a 6522-timer interrupt replay routine (ay-driver.js),
// plus the Apple's own 1-bit speaker (beeper.js) for drum clicks and one-shot effects. With no card the
// speaker plays everything the way Apple II games did: one voice, fast arpeggios, pulse width for loudness.
import { AYDriver } from './ay-driver.js';
import { OneBitDriver } from './beeper.js';
import { buildAYLibrary } from './ay-instruments.js';
import { appleSpeakerLibrary, appleSpeakerDrum } from './beeper-instruments.js';

const CPU = 1022727;
const AYL = buildAYLibrary({ fps: 60, buzzBass: false });
const SPK = appleSpeakerLibrary();
const OFF = AYL.presets.length;
const PRESETS = [...AYL.presets, ...SPK];
const gmPreset = (p) => AYL.gmPreset(p);
const gmDrumSpeaker = (n) => { const i = appleSpeakerDrum(SPK, n); return i >= 0 ? OFF + i : -1; };
const VIDS = ['ay1a', 'ay1b', 'ay1c', 'ay2a', 'ay2b', 'ay2c'];

export default class Apple2 {
  static info = {
    id: 'apple2', name: 'Apple IIe + Mockingboard', maker: 'Apple / Sweet Micro', year: 1983,
    chip: '1-bit speaker + 2 × GI AY-3-8910', voices: '1-bit speaker · 6 square + 2 noise',
    spec: 'Two AY-3-8910 at 1.0227 MHz (left / right), 60 Hz replay, speaker drum clicks',
  };
  static options = [
    { key: 'card', label: 'Sound', choices: [['mockingboard', 'Mockingboard'], ['none', 'Speaker only']], default: 'mockingboard' },
    { key: 'speakerDrums', label: 'Speaker drums', choices: [[true, 'On'], [false, 'Off']], default: true },
  ];
  static voices = [
    { id: 'ay1a', name: 'AY1 Tone A', kind: 'ay' }, { id: 'ay1b', name: 'AY1 Tone B', kind: 'ay' }, { id: 'ay1c', name: 'AY1 Tone C', kind: 'ay' },
    { id: 'ay2a', name: 'AY2 Tone A', kind: 'ay' }, { id: 'ay2b', name: 'AY2 Tone B', kind: 'ay' }, { id: 'ay2c', name: 'AY2 Tone C', kind: 'ay' },
    { id: 'spk', name: 'Speaker', kind: 'speaker' },
  ];
  static presets = PRESETS;
  static gmPreset(program) { return gmPreset(program); }
  static gmDrum(note) { return gmDrumSpeaker(note); }
  static chipInfo = { clock: CPU, variant: 'AY', fps: 60, timer: 'cpu' };

  constructor(host) {
    this.h = host;
    this.speakerDrums = true; this.card = true;
    const gmDrum = (n) => this.speakerDrums ? gmDrumSpeaker(n) : AYL.gmDrum(n);
    const lib = { presets: PRESETS, gmPreset, gmDrum };
    this.mb = new AYDriver(host, { chips: [{ clock: CPU, variant: 'AY' }, { clock: CPU, variant: 'AY' }], frameHz: 60, panMode: 'chips', drumVoices: 2, drumGain: 0.75, gain: 0.56, lib, voiceIds: VIDS });
    this.spk = new OneBitDriver(host, { clock: CPU, timer: 'cpu', quantum: 5, gateOff: false, speaker: 'apple', frameHz: 60, mode: 'priority', gain: 0.25, lib, ayPwm: true });
    this.mb.route = (inst, idx, c, note, vel) => {
      if (inst.kind !== 'speaker') return false;
      this.spk.playInst(inst, idx, c, note, vel); return true;
    };
    this.vs = new Float32Array(7 * 4);
  }
  get d() { return this.card ? this.mb : this.spk; }
  // ---- v2
  setInstruments(list) { this.mb.setInstruments(list); this.spk.setInstruments(list); }
  updateInstrument(i, inst) { this.mb.updateInstrument(i, inst); this.spk.updateInstrument(i, inst); }
  setArrangement(arr) { this.mb.setArrangement(arr); this.spk.setArrangement(arr); }
  setKit(kit) { this.mb.setKit(kit); this.spk.setKit(kit); }
  setVoiceMute(mask) { this.mb.setVoiceMute(mask & 63); this.spk.setVoiceMute((mask >> 6) & 1); }
  voiceState() {
    const v = this.vs;
    if (this.card) v.set(this.mb.voiceState(), 0); else for (let i = 0; i < 24; i += 4) { v[i] = 0; v[i + 1] = v[i + 2] = v[i + 3] = -1; }
    v.set(this.spk.voiceState(), 24);
    return v;
  }
  // ---- MIDI
  noteOn(c, n, v) { this.d.noteOn(c, n, v); }
  noteOff(c, n) { this.mb.noteOff(c, n); this.spk.noteOff(c, n); }
  sustainOff(c) { this.mb.sustainOff(c); this.spk.sustainOff(c); }
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
