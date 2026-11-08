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
export async function prepare({ fetchSF2, song, instruments, used }) {
  // instruments = the current instrument table (presets + edits + user instruments); used = table indices needed now
  // (Arranger picks, drum kit, keyboard instrument, and gmPreset/gmDrum of the song). Build RAM for exactly these.
  // fetchSF2() → Promise<ArrayBuffer> of soundfonts/GeneralUser-GS.sf2 (a fresh copy per call)
  // song = { programs: number[] (GM programs used on melodic channels), drums: boolean } or null (live play)
  return data;   // structured-cloneable; delivered to machine.setData(data)
}
export const transfer = (data) => [];   // optional: list of ArrayBuffers in data to transfer
```

The app reruns `prepare` whenever a new song loads.

---

# Interface v2: native instruments, voices, Arranger

Each machine is played through its **own** instruments, voices and controls. General MIDI is only a default mapping that the Arranger lets the user override.

## Static, readable on the main thread

```js
static voices = [                          // the chip's real channels, in display order
  { id: 'p1', name: 'Pulse 1', kind: 'pulse' },
  { id: 'p2', name: 'Pulse 2', kind: 'pulse' },
  { id: 'tri', name: 'Triangle', kind: 'triangle' },
  { id: 'noise', name: 'Noise', kind: 'noise' },
  { id: 'dpcm', name: 'DPCM', kind: 'dpcm' },
];
static presets = [                         // native preset library, in chip terms. Index = preset id.
  { name: 'Pulse 12.5% Lead', category: 'Lead', kind: 'pulse', /* …all native params… */ },
  …                                        // include melodic AND drum presets (category 'Drums')
];
static gmPreset(program) { return idx; }   // GM program → preset index (the "Auto" mapping for MIDI files)
static gmDrum(note) { return idx; }        // GM drum note (35–81, others too) → preset index, or -1 for silent
```

- `kind` says which voices can play an instrument. Use one of the kinds in `static voices`, or `'any'`. Kinds may be shared, e.g. every Genesis FM channel is `'fm'`.
- Preset params are plain JSON numbers/strings/arrays, structured-cloneable. Use the chip's real register units (duty 0–3, SID ADSR 0–15, OPN TL 0–127, wave steps 0–15/0–31…) so the editor shows true values. Instrument names are your own designs, described in chip terms ("Pulse 25% Pluck", "Tri Kick", "FM Slap Bass", "Saw+Ring Bell").
- Aim for a rich library: about 30–80 presets, covering what's needed to map all 128 GM programs + the GM drum kit sensibly, plus a few showcase sounds unique to the chip.

## Instance methods (worklet)

```js
setInstruments(list)    // replaces the instrument table. list[i] has the same shape as presets[i]; list starts with the
                        // presets in order (possibly edited), then user-made instruments. Before the first call, use presets.
updateInstrument(i, inst)  // one entry edited live: update the table and, where cheap, voices sounding with it
setArrangement(arr)     // arr[16] = { inst: -1 | tableIndex, voice: 'auto' | voiceId }
                        // inst -1 = Auto (GM mapping via gmPreset; drum channels via the kit).
                        // voice = a specific voice id pins that MIDI channel to that chip voice (if kind-compatible).
setKit(kit)             // { [note]: tableIndex } drum-kit overrides for drum channels; notes not present → gmDrum(note)
setVoiceMute(mask)      // bit i set → static voices[i] silent
voiceState()            // flat array, 4 numbers per static voice: [level 0..1, midiCh (0–15, -1 idle), note (-1), tableIndex (-1)]
```

Note-on with an explicit instrument looks up `table[arr[c].inst]`. With Auto it looks up `table[gmPreset(ch.program)]` (or the kit/`gmDrum` for drums). So editing a preset changes how every GM program mapped to it sounds. Keep the existing period-driver behaviour: allocation, priority, arps, frame-rate envelopes.

## Editor module: `common/machines/<id>-editor.js` (main thread)

```js
export function mountEditor(el, inst, kit, onChange, ctx) {
  // el:   empty <div> to fill
  // inst: a copy of the selected instrument; mutate it, then call onChange(inst) after each edit
  // kit:  widgets from common/editor-kit.js (sliders, selects, segmented buttons, wave drawer, macro editor, canvas…)
  // ctx:  { Machine (the class), presets, voices }
  return { destroy() {} };   // optional
}
```

The editor shows only what that chip really has, laid out like a period tracker or editor (FamiTracker, DefleMask/Furnace, GoatTracker…). Show live graphs where they help: ADSR curve, FM algorithm routing, the drawn wave, the duty-cycle shape, macros. Read `common/editor-kit.js` for the widgets. Prefer them; add a custom canvas where the chip needs one.
