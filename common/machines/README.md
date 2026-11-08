# Machine modules

Each retro machine is one ES module in this folder, `<id>.js`. It is loaded in two places:

- **in the AudioWorklet** (`common/host-worklet.js`), where it makes sound;
- **on the main thread**, where the app UI reads only its static `info`.

So a module must not touch AudioWorklet globals (`sampleRate`, `currentFrame`, `registerProcessor`) at the top level. Use `host.sampleRate` instead.

## Interface

```js
export default class MyMachine {
  static info = {
    id: 'nes', name: 'NES', maker: 'Nintendo', year: 1985,
    chip: 'Ricoh 2A03 APU', voices: '2 pulse · triangle · noise · DPCM',
    spec: 'one-line description shown under the machine name',
  };

  constructor(host) {}      // host = { sampleRate, ch: Chan[16], mute: Uint8Array(16), meter: Float32Array(16) }

  // MIDI → chip. Channel state (program, cc[], bend, bendRange, pan, vol, expr, sustain, drum) is in host.ch[c].
  noteOn(c, note, vel) {}
  noteOff(c, note) {}       // honour host.ch[c].sustain: mark held, release later in sustainOff
  sustainOff(c) {}
  allOff(c, hard) {}        // hard = cut immediately (CC120), else release (CC123)
  pitch(c) {}               // pitch bend changed: retune that channel's sounding voices
  ctrl(c) {}                // CC7 / CC10 / CC11 / mute changed: update levels and pan
  reset() {}                // silence everything and return to the power-on state

  render(L, R, n) {}        // OVERWRITE L[0..n) and R[0..n) (Float32Array)
  activeCount() { return 0; }   // sounding voices, for the status bar
  maxVoices() { return 0; }
  setData(data) {}          // optional: receives the result of <id>.prep.js (e.g. a sample RAM image)
  setOption(key, value) {}  // optional: e.g. 'analog' 0..1
}

// Optional: user-facing switches the app renders under the machine picker.
MyMachine.options = [
  { key: 'model', label: 'SID', choices: [['6581', '6581 (1982)'], ['8580', '8580 (1987)']], default: '6581' },
  { key: 'arp', label: 'Chord arps', choices: [[true, 'On'], [false, 'Off']], default: true },
];
```

## Conventions

- **Levels**: on the Blasta demo song, aim for an overall RMS of about −20 dBFS and peaks under 0.9. `tests/run-machine.mjs` reports both.
- **Meters**: per MIDI channel, write `host.meter[c] = Math.max(host.meter[c], level0to1)` during `render`.
- **Mute**: if `host.mute[c]` is set, that MIDI channel must be silent (re-checked in `ctrl`).
- **Channel 10 (index 9)** is drums when `host.ch[9].drum` is true; other channels can become drum parts via GS SysEx too.
- **Drivers tick at frame rate**: like the real music engines (50/60 Hz), step software envelopes, vibrato and arpeggios per frame, and quantise to the chip's real volume/pitch registers. `FrameClock` in `util.js` helps.
- **Performance**: offline rendering of the demo must run at ≥ 8× real time in headless Chrome. Allocate nothing per sample.
- **Licensing**: write emulation from public hardware documentation. You may port an LGPL/MIT/BSD emulator only with its licence header kept and its licence text added to `/LICENSES/`. No ROM dumps, no commercial game data, no Nintendo/Sega/etc. sample data.

## Optional prep step (`<id>.prep.js`)

Machines that need sample data (e.g. SNES) can export a main-thread function:

```js
export async function prepare({ fetchSF2, song }) {
  // fetchSF2() → Promise<ArrayBuffer> of soundfonts/GeneralUser-GS.sf2 (a fresh copy per call)
  // song = { programs: number[] (GM programs used on melodic channels), drums: boolean } or null (live play)
  return data;   // structured-cloneable; delivered to machine.setData(data)
}
export const transfer = (data) => [];   // optional: list of ArrayBuffers in data to transfer
```

The app reruns `prepare` whenever a new song loads.
