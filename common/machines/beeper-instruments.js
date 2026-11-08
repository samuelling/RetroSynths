// Native 1-bit speaker instruments (own designs) for the IBM PC speaker and the Apple II speaker.
//
// type 'tone' — a note on the 1-bit line, stepped by the driver every tick:
//   vol      macro 0–15: 0 = speaker gated off; >0 = on. With pwm on, the level sets the pulse width
//            (the "PWM volume" trick: narrow pulses are quieter); without it the line is a plain square.
//   duty     high time at full level, % of the period (PIT mode 3 = 50)
//   arp      arpeggio macro (semitones; arpMode 'fixed' = absolute notes), pitch macro in timer counts
//            (PIT divisor / CPU cycles, + = lower), vib (cents, delay ticks, ticks per cycle), slide (cents/tick)
//   arpSpeed driver ticks per step when several held notes share the one voice (fake chords)
//   noisy    1 = random edge timing around the note period instead of a tone
// type 'blip' — a one-shot drum burst that interrupts the tone, timed in µs like a game's sound routine:
//   blip { mode 'sweep' | 'noise' | 'tone', hz (start), sweep (‰ period growth per cycle), ms,
//          gapMin / gapMax (µs between random edges), rel (pitch follows the key, hz is for C4) }

const M = (values, loop = -1, release = -1) => ({ values, loop, release });
const base = { kind: 'speaker', type: 'tone', role: 'lead', vol: M([15, 0], 0, 1), volSpeed: 1, arp: M([0]), arpMode: 'rel', pitch: M([0]),
  vib: { depth: 0, delay: 0, speed: 8 }, slide: { speed: 0, limit: 0 }, transpose: 0, pwm: 0, duty: 50, arpSpeed: 1, noisy: 0, prio: 0 };
const T = (name, category, o) => ({ ...base, name, category, ...o, vol: o.vol || base.vol });
const B = (name, prio, blip, o = {}) => ({ ...base, name, category: 'Drums', role: 'drum', type: 'blip', prio, vol: M([15, 0]), blip: { rel: 0, sweep: 0, gapMin: 20, gapMax: 200, ...blip }, ...o });
const decay = (from, n) => Array.from({ length: n }, (_, i) => Math.max(1, Math.round(from - (from - 1) * i / (n - 1))));

/** PC speaker library (no hardware volume: most sounds are plain PIT squares). */
export function pcLibrary() {
  const P = [
    T('Square Lead', 'Lead', {}),
    T('Vibrato Lead', 'Lead', { vib: { depth: 25, delay: 14, speed: 10 } }),
    T('Piano Blip', 'Piano', { role: 'chord', vol: M([...Array(36).fill(15), 0]), arpSpeed: 1 }),
    T('Octave Chirp Pluck', 'Guitar', { role: 'chord', vol: M([...Array(20).fill(15), 0]), arp: M([12, 12, 0]) }),
    T('Major Arp Chord', 'Showcase', { role: 'chord', arp: M([0, 4, 7], 0) }),
    T('Minor Arp Chord', 'Showcase', { role: 'chord', arp: M([0, 3, 7], 0) }),
    T('Dom7 Arp Chord', 'Showcase', { role: 'chord', arp: M([0, 4, 7, 10], 0) }),
    T('Octave Arp Organ', 'Organ', { role: 'chord', arp: M([0, 12], 0) }),
    T('Square Bass', 'Bass', { role: 'bass' }),
    T('Slap Bass Chirp', 'Bass', { role: 'bass', vol: M([...Array(24).fill(15), 0]), arp: M([12, 0, 12, 0]) }),
    T('Trill Lead', 'Lead', { arp: M([0, 0, 2, 2], 0) }),
    T('PWM Fade Piano', 'Showcase', { role: 'chord', pwm: 1, vol: M([15, 15, 14, 13, 12, 11, 11, 10, 9, 9, 8, 7, 7, 6, 5, 5, 4, 3, 3, 2, 1, 0]), volSpeed: 3 }),
    T('PWM Swell Pad', 'Pad', { role: 'pad', pwm: 1, vol: M([3, 5, 7, 9, 11, 13, 14, 14, 6, 3, 0], 7, 8), volSpeed: 3, vib: { depth: 12, delay: 0, speed: 16 } }),
    T('PWM Strings', 'Strings', { role: 'pad', pwm: 1, vol: M([9, 11, 12, 12, 5, 0], 3, 4), volSpeed: 2, vib: { depth: 18, delay: 10, speed: 11 } }),
    T('Siren Sweep', 'SFX', { role: 'fx', vib: { depth: 400, delay: 0, speed: 60 } }),
    T('Laser Zap', 'SFX', { role: 'fx', vol: M([...Array(14).fill(15), 0]), slide: { speed: -90, limit: 2400 }, transpose: 12 }),
    T('Bell Chirp', 'Chromatic', { role: 'chord', pwm: 1, vol: M([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]), volSpeed: 3, arp: M([24, 12, 0]) }),
    T('Noise Wind', 'SFX', { role: 'fx', noisy: 1, vol: M([15, 0], 0, 1) }),
    B('Sweep Kick', 9, { mode: 'sweep', hz: 170, sweep: 75, ms: 75 }),
    B('Noise Snare', 8, { mode: 'noise', gapMin: 45, gapMax: 380, ms: 85 }),
    B('Click Hat', 2, { mode: 'noise', gapMin: 14, gapMax: 80, ms: 16 }),
    B('Open Hat', 3, { mode: 'noise', gapMin: 14, gapMax: 90, ms: 90 }),
    B('Crash Burst', 6, { mode: 'noise', gapMin: 14, gapMax: 150, ms: 260 }),
    B('Sweep Tom', 7, { mode: 'sweep', hz: 260, sweep: 22, ms: 100, rel: 1 }),
    B('Clap Burst', 7, { mode: 'noise', gapMin: 35, gapMax: 300, ms: 55 }),
    B('Cowbell Blip', 5, { mode: 'tone', hz: 800, ms: 60 }),
    B('Stick Click', 5, { mode: 'tone', hz: 1650, ms: 12 }),
    B('Triangle Ping', 3, { mode: 'tone', hz: 4450, ms: 120 }),
    B('Conga Blip', 5, { mode: 'sweep', hz: 330, sweep: 8, ms: 55, rel: 1 }),
  ];
  return finish(P, PC_GM, PC_DRUMS);
}

/** Apple II speaker set: pulse-width loudness on everything (the CPU times every toggle). */
export function appleSpeakerLibrary() {
  return [
    B('Speaker Click Kick', 9, { mode: 'sweep', hz: 150, sweep: 75, ms: 75 }, { pwm: 1 }),
    B('Speaker Noise Snare', 8, { mode: 'noise', gapMin: 45, gapMax: 380, ms: 85 }, { pwm: 1 }),
    B('Speaker Tick Hat', 2, { mode: 'noise', gapMin: 14, gapMax: 80, ms: 16 }, { pwm: 1 }),
    B('Speaker Open Hat', 3, { mode: 'noise', gapMin: 14, gapMax: 90, ms: 90 }, { pwm: 1 }),
    B('Speaker Crash', 6, { mode: 'noise', gapMin: 14, gapMax: 150, ms: 260 }, { pwm: 1 }),
    B('Speaker Tom', 7, { mode: 'sweep', hz: 260, sweep: 22, ms: 100, rel: 1 }, { pwm: 1 }),
    B('Speaker Clap', 7, { mode: 'noise', gapMin: 35, gapMax: 300, ms: 55 }, { pwm: 1 }),
    B('Speaker Cowbell', 5, { mode: 'tone', hz: 800, ms: 60 }, { pwm: 1 }),
    B('Speaker Click', 5, { mode: 'tone', hz: 1650, ms: 12 }, { pwm: 1 }),
    B('Speaker Ping', 3, { mode: 'tone', hz: 4450, ms: 120 }, { pwm: 1 }),
    B('Speaker Conga', 5, { mode: 'sweep', hz: 330, sweep: 8, ms: 55, rel: 1 }, { pwm: 1 }),
    T('Speaker Beep', 'Speaker', { pwm: 1, vol: M([15, 6, 0], 0, 1) }),
    T('Speaker PWM Arp Chord', 'Speaker', { role: 'chord', pwm: 1, arp: M([0, 4, 7], 0), vol: M([15, 13, 0], 1, 2) }),
    T('Speaker Laser', 'Speaker', { role: 'fx', pwm: 1, vol: M([...decay(15, 14), 0]), slide: { speed: -90, limit: 2400 }, transpose: 12 }),
  ];
}

// GM program → PC preset name
const PC_GM = (p) => {
  const f = p >> 3;
  if (p === 4 || p === 5) return 'PWM Fade Piano';
  if (f === 0) return 'Piano Blip';
  if (f === 1) return 'Bell Chirp';
  if (f === 2) return p === 18 || p === 19 ? 'Octave Arp Organ' : 'Square Lead';
  if (f === 3) return p === 29 || p === 30 ? 'Trill Lead' : 'Octave Chirp Pluck';
  if (f === 4) return p === 36 || p === 37 ? 'Slap Bass Chirp' : 'Square Bass';
  if (f === 5) return p <= 42 ? 'Vibrato Lead' : p === 43 ? 'Square Bass' : p === 47 ? 'Sweep Tom' : p === 44 ? 'PWM Strings' : 'Octave Chirp Pluck';
  if (f === 6) return p === 55 ? 'Octave Chirp Pluck' : 'PWM Strings';
  if (f === 7) return p === 58 ? 'Square Bass' : 'Vibrato Lead';
  if (f === 8 || f === 9) return 'Vibrato Lead';
  if (f === 10) return p === 86 ? 'Trill Lead' : 'Square Lead';
  if (f === 11) return 'PWM Swell Pad';
  if (f === 12) return p === 98 || p === 100 ? 'Bell Chirp' : 'PWM Swell Pad';
  if (f === 13) return 'Octave Chirp Pluck';
  if (f === 14) return p === 116 || p === 117 || p === 118 ? 'Sweep Tom' : p === 119 ? 'Noise Wind' : 'Bell Chirp';
  return p === 122 || p === 125 || p === 126 || p === 121 || p === 120 ? 'Noise Wind' : p === 127 ? 'Noise Snare' : p === 123 ? 'Trill Lead' : p === 124 ? 'Major Arp Chord' : 'Laser Zap';
};
const PC_DRUMS = (n, name) => {
  if (n === 35 || n === 36) return name('Sweep Kick');
  if (n === 38 || n === 40) return name('Noise Snare');
  if (n === 39) return name('Clap Burst');
  if (n === 42 || n === 44 || n === 54 || n === 69 || n === 70 || n === 82) return name('Click Hat');
  if (n === 46) return name('Open Hat');
  if ([49, 52, 55, 57, 51, 59, 58].includes(n)) return name('Crash Burst');
  if ([41, 43, 45, 47, 48, 50].includes(n)) return name('Sweep Tom');
  if (n >= 60 && n <= 66) return name('Conga Blip');
  if (n === 56 || n === 67 || n === 68 || n === 53) return name('Cowbell Blip');
  if (n === 80 || n === 81 || n === 71 || n === 72) return name('Triangle Ping');
  if (n >= 27 && n <= 87) return name('Stick Click');
  return -1;
};
function finish(P, gmName, drumOf) {
  const name = (s) => P.findIndex(p => p.name === s);
  const gm = Array.from({ length: 128 }, (_, p) => name(gmName(p)));
  return { presets: P, gmPreset: (p) => gm[p & 127], gmDrum: (n) => drumOf(n, name) };
}
/** Apple speaker drum index (within a list) for a GM drum note. */
export function appleSpeakerDrum(list, n) {
  const name = (s) => list.findIndex(p => p.name === s);
  const map = { 'Sweep Kick': 'Speaker Click Kick', 'Noise Snare': 'Speaker Noise Snare', 'Click Hat': 'Speaker Tick Hat', 'Open Hat': 'Speaker Open Hat',
    'Crash Burst': 'Speaker Crash', 'Sweep Tom': 'Speaker Tom', 'Clap Burst': 'Speaker Clap', 'Cowbell Blip': 'Speaker Cowbell', 'Stick Click': 'Speaker Click',
    'Triangle Ping': 'Speaker Ping', 'Conga Blip': 'Speaker Conga' };
  return PC_DRUMS(n, (s) => name(map[s]));
}
