// TurboGrafx-16 / PC Engine — HuC6280 PSG driven by a 6-voice, frame-rate music driver.
//
// Like a Hudson-era sound driver: each instrument owns a 32-step × 5-bit wave (uploaded into the
// channel's wave RAM when a voice changes instrument) or uses the noise generator (channels 5–6) or
// DDA mode (5-bit samples streamed from the 6.99 kHz timer interrupt, optionally re-pitched by stepping
// through the sample at a fractional rate). Volume / arpeggio / pitch / noise-frequency macros step the
// 5-bit log volume and 12-bit period once per frame; stereo comes from the 4-bit L/R balance.
// Original code for RetroSynths.
import { Resampler, DCBlock, drumKind, panGains } from './util.js';
import { PSG, PSG_CLOCK, PSG_CHUNK, PSG_RATE, PSG_FRAME_CYCLES, PSG_TIMER_CYCLES } from './tg16-psg.js';
import { WAVES, DDA_BANK, buildDDA, noiseMacro } from './tg16-data.js';
import { Driver, CLASS, DRUM_PRIO, mac, envMacro, pitchMacro, qLog, gmTable } from './atari-driver.js';

/** Frequency → 12-bit period. */
export const period = (hz) => { const p = Math.round(PSG_CLOCK / (32 * hz)); return p < 1 ? 1 : p > 4095 ? 4095 : p; };
const nib = (g) => { if (g <= 0.001) return 0; const v = 15 + Math.round(20 * Math.log10(g) / 3); return v < 0 ? 0 : v > 15 ? 15 : v; };
export const DDA_RATE = PSG_CLOCK / PSG_TIMER_CYCLES;

// ---------------------------------------------------------------- native instrument library
const W = (name) => Array.from(WAVES[name]);
const shape = (f) => { const a = Array.from({ length: 32 }, (_, i) => f(i)); const lo = Math.min(...a), hi = Math.max(...a); return a.map((x) => Math.round((x - lo) / (hi - lo) * 31)); };
const CUSTOM = {
  splitSaw: shape((i) => (i % 16) * 0.55 + i * 0.45),                                         // saw + octave saw: the "PCE" lead
  sync: shape((i) => Math.sin(2 * Math.PI * 2.5 * i / 32) * (1 - i / 40)),                      // hard-sync-like sweep shape
  fatSub: shape((i) => Math.tanh(1.8 * (Math.sin(2 * Math.PI * i / 32) + 0.35 * Math.sin(4 * Math.PI * i / 32)))),
  };
function mel(name, category, cls, wave, x = {}) {
  const c = CLASS[cls], env = x.env || c.env, vib = x.vib !== undefined ? x.vib : c.vib, gain = x.gain || 1;
  return {
    name, category, kind: x.noise ? 'noise' : 'any', role: x.role || c.role, drum: false,
    mode: x.noise ? 'noise' : 'wave', wave: Array.isArray(wave) ? wave.slice() : W(wave || 'SQUARE'),
    nf: x.nf ?? 18, nfTrack: x.noise ? true : false, sample: 'kick', balL: 15, balR: 15,
    vol: envMacro(env, (l) => qLog(l * gain), { trem: x.trem || c.trem }),
    arp: c.trill ? mac([0, 0, c.trill, c.trill], 0) : mac(),
    pitch: pitchMacro({ sweep: x.sweep !== undefined ? x.sweep : c.sweep, bird: c.bird }),
    freq: mac(),
    rel: Math.max(1, Math.round(env[3] * 60)),
    vibDelay: vib ? Math.round(vib[0] * 60) : 0, vibDepth: vib ? Math.round(vib[1] * 100) : 0, vibRate: vib ? vib[2] : 5.5,
  };
}
const drumBase = (name, kind) => ({ name, category: 'Drums', role: 'drum', drum: true, prio: DRUM_PRIO[kind] ?? 46, choke: kind.startsWith('hat') ? 'hat' : '',
  wave: W('SQUARE'), nf: 31, nfTrack: false, balL: 15, balR: 15, arp: mac(), pitch: mac(), rel: 1, vibDelay: 0, vibDepth: 0, vibRate: 5.5 });
function dda(name, kind, sample, x = {}) {
  return { ...drumBase(name, kind), kind: 'any', mode: 'dda', sample, track: !!x.track, vol: mac([x.vol ?? 31]), freq: mac() };
}
function noiseDrum(name, kind, note) {
  const fr = noiseMacro(note);
  return { ...drumBase(name, kind), kind: 'noise', mode: 'noise', sample: 'kick', track: false,
    vol: mac(fr.map((f) => qLog(Math.min(1, f[1])))), freq: mac(fr.map((f) => f[0])) };
}

const PRESETS = [
  // leads
  mel('Saw Wave Lead', 'Lead', 'saw', 'SAW'),
  mel('Split-Saw PCE Lead', 'Lead', 'saw', CUSTOM.splitSaw, { vib: [0.25, 0.16, 6] }),
  mel('Sync-Shape Lead', 'Lead', 'saw', CUSTOM.sync),
  mel('Square Wave Lead', 'Lead', 'square', 'SQUARE'),
  mel('Pulse 25% Lead', 'Lead', 'square', 'PULSE25'),
  mel('Pulse 12% Nasal Lead', 'Lead', 'reed', 'PULSE12'),
  mel('Dist Wave Lead', 'Lead', 'dist', 'DIST'),
  mel('Flute Wave', 'Lead', 'flute', 'FLUTE'),
  mel('Reed Wave (odd harm.)', 'Lead', 'reed', 'REED'),
  mel('Sax Wave', 'Lead', 'reed', 'SAX'),
  // brass
  mel('Brass Wave Section', 'Brass', 'brass', 'BRASS'),
  mel('Synth Brass Saw', 'Brass', 'brass', 'SAW', { env: [0.01, 0.4, 0.7, 0.12] }),
  // keys / chromatic
  mel('Piano Wave', 'Keys', 'piano', 'PIANO'),
  mel('E.Piano Wave', 'Keys', 'epiano', 'EPIANO'),
  mel('Harpsi Wave', 'Keys', 'harpsi', 'HARPSI'),
  mel('Clav Wave', 'Keys', 'clav', 'CLAV'),
  mel('Drawbar Organ Wave', 'Keys', 'organ', 'ORGAN'),
  mel('Bell Wave', 'Chromatic', 'bell', 'BELL'),
  mel('Sine Vibes Tremolo', 'Chromatic', 'vibes', 'SINE'),
  mel('Mallet Wave', 'Chromatic', 'mallet', 'MALLET'),
  // guitar / strings / pads
  mel('Pluck Wave', 'Guitar', 'pluck', 'PLUCK'),
  mel('Pulse 12% Sitar', 'Guitar', 'pluck', 'PULSE12'),
  mel('Dist Wave Guitar', 'Guitar', 'dist', 'DIST'),
  mel('Solo String Wave', 'Strings', 'string', 'STRING', { role: 'lead' }),
  mel('String Wave Ensemble', 'Strings', 'string', 'STRING'),
  mel('Harp Pluck', 'Strings', 'pluck', 'PLUCK', { env: [0.001, 1.4, 0, 0.3] }),
  mel('Brass Wave Hit', 'Strings', 'hit', 'BRASS'),
  mel('Saw Pad', 'Pad', 'pad', 'SAW', { env: [0.2, 0.5, 0.8, 0.5] }),
  mel('Soft Pad Wave', 'Pad', 'pad', 'PAD'),
  mel('Voice Wave Choir', 'Pad', 'voice', 'VOICE'),
  // bass
  mel('Bass Wave', 'Bass', 'bass', 'BASS'),
  mel('Fretless Bass Wave', 'Bass', 'bass', 'BASS', { env: [0.005, 1.0, 0.6, 0.1], vib: [0.3, 0.1, 5] }),
  mel('Saw-Sub Synth Bass', 'Bass', 'synbass', 'SYNBASS'),
  mel('Pulse 25% Bass', 'Bass', 'synbass', 'PULSE25'),
  mel('Fat Sub Bass', 'Bass', 'synbass', CUSTOM.fatSub, { env: [0.002, 0.8, 0.7, 0.08] }),
  // percussive / fx
  mel('Timpani Sine', 'Percussive', 'timpani', 'SINE'),
  mel('Tom Tri Sweep', 'Percussive', 'tomperc', 'TRI'),
  mel('Block Sine Click', 'Percussive', 'block', 'SINE'),
  mel('Noise Hiss', 'FX', 'noise', null, { noise: true, nf: 18, gain: 0.8 }),
  mel('Noise Surf', 'FX', 'noise', null, { noise: true, nf: 12, gain: 0.8, env: [0.8, 1.0, 0.7, 1.0], trem: [0.25, 0.7] }),
  mel('Noise Helicopter', 'FX', 'noise', null, { noise: true, nf: 0, gain: 0.8, env: [0.3, 0.3, 0.9, 0.5], trem: [12, 0.8] }),
  mel('Noise Applause', 'FX', 'noise', null, { noise: true, nf: 21, gain: 0.8, env: [0.4, 0.5, 0.8, 0.6], trem: [7, 0.35] }),
  mel('Noise Gunshot', 'FX', 'noise', null, { noise: true, nf: 14, gain: 0.8, env: [0.001, 0.5, 0, 0.1] }),
  mel('Noise Reverse Cymbal', 'FX', 'noise', null, { noise: true, nf: 22, gain: 0.8, env: [1.2, 0.05, 0, 0.05] }),
  mel('Bird Chirp Sine', 'FX', 'bird', 'SINE'),
  mel('Phone Trill Pulse', 'FX', 'phone', 'PULSE25'),
  // drums
  dda('DDA Kick', 'kick', 'kick'), dda('DDA Kick Deep', 'kick', 'kickDeep'),
  dda('DDA Snare', 'snare', 'snare'), dda('DDA Snare Bright', 'snare', 'snareBright'),
  dda('DDA Clap', 'clap', 'clap'), dda('DDA Side Stick', 'stick', 'stick'),
  dda('DDA Tom (tracks)', 'tom', 'tom', { track: true }), dda('DDA Conga (tracks)', 'conga', 'conga', { track: true }),
  dda('DDA Cowbell', 'cowbell', 'cowbell'),
  dda('DDA Agogo (tracks)', 'cowbell', 'agogo', { track: true }), dda('DDA Wood Block (tracks)', 'block', 'block', { track: true }),
  dda('DDA Ride Bell', 'bell', 'rideBell'), dda('DDA Triangle', 'triangle', 'triangle'), dda('DDA Triangle Open', 'triangle', 'triangleOpen'),
  dda('DDA Vibraslap', 'perc', 'vibraslap'), dda('DDA Whistle', 'perc', 'whistle'), dda('DDA Guiro', 'perc', 'guiro'), dda('DDA Cuica (tracks)', 'perc', 'cuica', { track: true }),
  noiseDrum('Noise Hat Closed', 'hatClosed', 42), noiseDrum('Noise Hat Pedal', 'hatPedal', 44), noiseDrum('Noise Hat Open', 'hatOpen', 46),
  noiseDrum('Noise Crash', 'crash', 49), noiseDrum('Noise Ride', 'ride', 51),
  noiseDrum('Noise Tambourine', 'shaker', 54), noiseDrum('Noise Shaker', 'shaker', 70),
];

const GM = gmTable(PRESETS, [
  ['Piano Wave', [0, 1, 2, 3]], ['E.Piano Wave', [4, 5]], ['Harpsi Wave', [6]], ['Clav Wave', [7]],
  ['Bell Wave', [8, 9, 10, 14, 31, 93, 96, 98, 100, 103, 108, 112]], ['Sine Vibes Tremolo', [11]], ['Mallet Wave', [12, 13, 113, 114]],
  ['Drawbar Organ Wave', [16, 17, 18, 19, 20]], ['Reed Wave (odd harm.)', [21, 22, 23, 70, 71]],
  ['Pluck Wave', [15, 24, 25, 26, 27, 28, 99, 105, 106, 107]], ['Pulse 12% Sitar', [104]], ['Dist Wave Guitar', [29, 30]],
  ['Bass Wave', [32, 33, 34]], ['Fretless Bass Wave', [35, 43]], ['Bass Wave', [36, 37]], ['Saw-Sub Synth Bass', [38, 87]], ['Pulse 25% Bass', [39]],
  ['Solo String Wave', [40, 41, 110]], ['String Wave Ensemble', [42, 44, 48, 49]], ['Pluck Wave', [45]], ['Harp Pluck', [46]],
  ['Timpani Sine', [47, 116]], ['Saw Pad', [50, 51, 90]], ['Voice Wave Choir', [52, 53, 54, 91, 94]], ['Brass Wave Hit', [55]],
  ['Brass Wave Section', [56, 57, 58, 59, 60, 61]], ['Synth Brass Saw', [62, 63]],
  ['Sax Wave', [64, 65, 66, 67]], ['Pulse 12% Nasal Lead', [68, 69, 109, 111]], ['Flute Wave', [72, 73, 74, 75, 76, 77, 78, 79, 82, 83]],
  ['Square Wave Lead', [80]], ['Saw Wave Lead', [81, 86]], ['Dist Wave Lead', [84]], ['Voice Wave Choir', [85]],
  ['Soft Pad Wave', [88, 89, 92, 95, 97, 101, 102]], ['Tom Tri Sweep', [117, 118]], ['Block Sine Click', [115]],
  ['Noise Reverse Cymbal', [119]], ['Noise Gunshot', [120, 127]], ['Noise Hiss', [121]], ['Noise Surf', [122]], ['Bird Chirp Sine', [123]],
  ['Phone Trill Pulse', [124]], ['Noise Helicopter', [125]], ['Noise Applause', [126]],
]);
const PI = (n) => PRESETS.findIndex((p) => p.name === n);
const DRUMS = new Int16Array(128).fill(-1);
for (let n = 27; n <= 87; n++) {
  const k = drumKind(n);
  const name = n === 35 ? 'DDA Kick Deep' : n === 40 ? 'DDA Snare Bright' : n === 54 ? 'Noise Tambourine' : n === 81 ? 'DDA Triangle Open' : n === 58 ? 'DDA Vibraslap' : (n === 71 || n === 72) ? 'DDA Whistle' : (n === 73 || n === 74) ? 'DDA Guiro' :
    (n === 78 || n === 79) ? 'DDA Cuica (tracks)' : (n === 67 || n === 68) ? 'DDA Agogo (tracks)' :
    { kick: 'DDA Kick', snare: 'DDA Snare', clap: 'DDA Clap', stick: 'DDA Side Stick', hatClosed: 'Noise Hat Closed', hatPedal: 'Noise Hat Pedal',
      hatOpen: 'Noise Hat Open', crash: 'Noise Crash', ride: 'Noise Ride', shaker: 'Noise Shaker', cowbell: 'DDA Cowbell', bell: 'DDA Ride Bell',
      triangle: 'DDA Triangle', tom: 'DDA Tom (tracks)', conga: 'DDA Conga (tracks)', block: 'DDA Wood Block (tracks)', perc: 'DDA Wood Block (tracks)' }[k];
  DRUMS[n] = PI(name);
}

export default class TG16 extends Driver {
  static info = {
    id: 'tg16', name: 'TurboGrafx-16', maker: 'NEC / Hudson', year: 1987,
    chip: 'Hudson HuC6280 PSG', voices: '6 × 32-step 5-bit wavetable · noise · DDA',
    spec: 'six 5-bit wavetable channels with log volume and stereo balance; DDA drums, noise on 5–6',
  };
  static voices = [
    { id: 'ch1', name: 'Ch 1', kind: 'wave' }, { id: 'ch2', name: 'Ch 2', kind: 'wave' }, { id: 'ch3', name: 'Ch 3', kind: 'wave' },
    { id: 'ch4', name: 'Ch 4', kind: 'wave' }, { id: 'ch5', name: 'Ch 5 (noise)', kind: 'noise' }, { id: 'ch6', name: 'Ch 6 (noise)', kind: 'noise' },
  ];
  static presets = PRESETS;
  static gmPreset(p) { return GM[p & 127]; }
  static gmDrum(n) { return n >= 0 && n < 128 ? DRUMS[n] : -1; }
  static options = [
    { key: 'rev', label: 'PSG', choices: [['A', 'HuC6280A (Duo)'], ['orig', 'HuC6280 (DC pops)']], default: 'A' },
  ];

  constructor(host) {
    super(host, [1, 2, 4, 8, 16, 32], 6, PSG_CLOCK / PSG_FRAME_CYCLES);
    this.volMax = 31;
    this.psg = new PSG();
    this.rs = new Resampler(PSG_RATE, host.sampleRate);
    this.dcL = new DCBlock(host.sampleRate, 10); this.dcR = new DCBlock(host.sampleRate, 10);
    this.o = [0, 0]; this.fcyc = 0; this.tcyc = 0;
    this.gain = 0.58;
    this.melOrder = [0, 1, 2, 3, 4, 5]; this.drumOrder = [5, 4, 3, 2, 1, 0]; this.noiseOrder = [5, 4];
    this.bank = buildDDA();
    this.vc = Array.from({ length: 6 }, () => ({ wave: null, ctl: -1, per: -1, bal: -1, nz: -1, smp: null, pos: 0, inc: 1 }));
    this.reset();
  }
  setOption(key, value) { if (key === 'rev') this.psg.off = value === 'orig' ? 0 : 16; }
  maxVoices() { return 6; }
  reset() {
    this.resetDriver();
    const off = this.psg.off; this.psg.reset(); this.psg.off = off;
    for (const v of this.vc) Object.assign(v, { wave: null, ctl: -1, per: -1, bal: -1, nz: -1, smp: null, pos: 0, inc: 1 });
    this.psg.w(1, 0xff);
    for (let i = 0; i < 6; i++) { this.psg.w(0, i); this.psg.w(4, 0); this.psg.w(5, 0xff); this.psg.w(7, 0); }
    this.psg.w(9, 0x80);    // LFO off
    this.applyVoiceMute(this.vmask);
  }
  applyVoiceMute(m) { for (let i = 0; i < 6; i++) this.psg.ch[i].mute = (m >> i) & 1; }
  volNorm(v) { return v <= 0 ? 0 : Math.pow(10, (v - 31) * 1.5 / 20); }
  fadeVol(v, f) { return Math.max(0, v + Math.round(20 * Math.log10(Math.max(1e-4, f)) / 1.5)); }
  busy(vn) { return vn.inst.mode === 'dda' && vn.voice >= 0 && !!this.vc[vn.voice].smp; }

  noisy(vn) { return vn.inst.mode === 'noise'; }
  allowed(vi, vn) { return vi >= 4 || !this.noisy(vn); }
  prefer(vn) { return this.noisy(vn) ? this.noiseOrder : vn.isDrum ? this.drumOrder : this.melOrder; }

  sel(vi) { this.psg.w(0, vi); }
  setCtl(vi, v) { const c = this.vc[vi]; if (c.ctl !== v) { c.ctl = v; this.sel(vi); this.psg.w(4, v); } }

  program(vi, vn) {
    const c = this.vc[vi], psg = this.psg, inst = vn.inst;
    this.sel(vi);
    c.smp = null;
    if (inst.mode === 'dda') {
      if (vi >= 4 && c.nz !== 0) { psg.w(7, 0); c.nz = 0; }
      const smp = this.bank[inst.sample] || this.bank.kick;
      if (vn.started) { c.smp = null; return; }          // one-shot: a stolen DDA hit does not restart
      vn.started = true;
      c.smp = smp; c.pos = 0;
      c.inc = inst.track ? Math.pow(2, (vn.pitch - (DDA_BANK[inst.sample] || DDA_BANK.kick)[2]) / 12) : 1;
      psg.w(4, 0xc0); c.ctl = 0xc0; psg.w(6, smp[0]);
      return;
    }
    if (inst.mode === 'noise') return;                      // set up in update
    if (vi >= 4 && c.nz !== 0) { psg.w(7, 0); c.nz = 0; }
    const w = inst.wave;
    if (c.wave !== w) {                                     // upload the instrument's wave into wave RAM
      psg.w(4, 0x40); psg.w(4, 0x00);
      for (let i = 0; i < 32; i++) psg.w(6, w[i] & 31);
      c.wave = w; c.ctl = 0;
    }
  }
  update(vi, vn) {
    const c = this.vc[vi], psg = this.psg, ch = this.h.ch[vn.ch], inst = vn.inst;
    const [gl, gr] = panGains(ch);
    const bal = (Math.max(0, nib(gl * 1.414) - (15 - (inst.balL ?? 15))) << 4) | Math.max(0, nib(gr * 1.414) - (15 - (inst.balR ?? 15)));
    if (c.bal !== bal) { c.bal = bal; this.sel(vi); psg.w(5, bal); }
    const k = vn.isDrum ? Math.min(1, vn.gm * 1.7) : vn.gm;
    let v = vn.vol <= 0 ? 0 : vn.vol + Math.round(20 * Math.log10(Math.max(1e-4, k)) / 1.5);
    v = v < 0 ? 0 : v > 31 ? 31 : v;
    if (inst.mode === 'dda') { if (c.smp || c.ctl & 0x40) this.setCtl(vi, 0xc0 | v); return; }
    if (inst.mode === 'noise') {
      let nf = vn.freq >= 0 ? vn.freq : inst.nf;
      if (inst.nfTrack) nf += Math.round((vn.pitch - 60) / 3);
      const nz = 0x80 | (nf < 0 ? 0 : nf > 31 ? 31 : nf);
      if (c.nz !== nz) { c.nz = nz; this.sel(vi); psg.w(7, nz); }
    } else {
      const p = period(440 * Math.pow(2, (vn.pitch - 69) / 12));
      if (c.per !== p) { c.per = p; this.sel(vi); psg.w(2, p & 255); psg.w(3, p >> 8); }
    }
    this.setCtl(vi, 0x80 | v);
  }
  silence(vi) {
    const c = this.vc[vi];
    c.smp = null;
    this.setCtl(vi, 0);
    if (vi >= 4 && c.nz !== 0) { this.sel(vi); this.psg.w(7, 0); c.nz = 0; }
  }
  /** Timer IRQ: stream the next 5-bit DDA sample (fractional step = re-pitch) to every DDA channel. */
  timerIrq() {
    for (let vi = 0; vi < 6; vi++) {
      const c = this.vc[vi];
      if (!c.smp) continue;
      c.pos += c.inc;
      const i = c.pos | 0;
      this.sel(vi);
      if (i >= c.smp.length) { this.psg.w(6, 16); c.smp = null; continue; }
      this.psg.w(6, c.smp[i]);
    }
  }

  render(L, R, n) {
    const rs = this.rs, psg = this.psg, o = this.o, g = this.gain;
    for (let i = 0; i < n; i++) {
      for (let k = rs.advance(); k > 0; k--) {
        psg.chunk(o);
        rs.push(o[0], o[1]);
        this.tcyc += PSG_CHUNK;
        if (this.tcyc >= PSG_TIMER_CYCLES) { this.tcyc -= PSG_TIMER_CYCLES; this.timerIrq(); }
        this.fcyc += PSG_CHUNK;
        if (this.fcyc >= PSG_FRAME_CYCLES) { this.fcyc -= PSG_FRAME_CYCLES; this.frame(); }
      }
      const y = rs.out();
      L[i] = this.dcL.run(y[0]) * g; R[i] = this.dcR.run(y[1]) * g;
    }
  }
}
