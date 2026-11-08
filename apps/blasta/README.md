# Blasta

General MIDI through four generations of PC sound card, in the browser. You drag one slider to age a song forward from 1989 to 1998:

| Era | Card | Engine |
|---|---|---|
| 1989 | AdLib / Sound Blaster 2.0 | Cycle-accurate OPL FM in OPL2 mode: 9 voices, 4 waveforms, mono |
| 1992 | Sound Blaster 16 · Windows 3.1 | Cycle-accurate YMF262 (OPL3): 18 voices, 8 waveforms, hard L/R stereo |
| 1994 | Sound Blaster AWE32 | EMU8000-style wavetable: 30 voices, ROM-budget bank, linear interpolation, gritty reverb |
| 1998 | Sound Blaster Live! | EMU10K1-style wavetable: 64 voices, 8-point interpolation, SF2.01 modulators, smoother reverb |

Between eras the two neighbouring cards crossfade (both machines render; cos^1.5 weights).

Blasta runs on the RetroSynths machine framework (`common/machine-app.js`): each card is a machine module in `common/machines/` (`opl2`, `opl3`, `awe32`, `live`) with its **own** voices, instruments and editor. The **Arranger** shows where each MIDI part lands (Auto = the card's GM mapping); the **Instruments** panel edits FM patches operator by operator (2-op, OP2 double voices, true OPL3 4-op) or layers generator overrides on the loaded SoundFont's own presets.

**Play:** open `index.html` from any static server (GitHub Pages works), click to power on, then hit **Demo** or drop a `.mid` file on the window. The keyboard (on-screen, QWERTY A–K with Z/X for octave, or Web MIDI) plays the selected instrument.

## Where the sounds come from

- **FM**: `common/machines/opl-nuked3.js` is a line-for-line JavaScript port of [Nuked OPL3](https://github.com/nukeykt/Nuked-OPL3) 1.8 by Nuke.YKT (LGPL-2.1, see `LICENSES/`). It is verified **bit-exact** against the original C on a 141k-sample register torture test covering every waveform, feedback, 4-op, rhythm mode and the LFOs. The chip runs at its native **49,716 Hz** with its native integer widths. A MIDI driver programs it through registers, as the DOS and Windows drivers did; that includes the one-sample key-off a real chip needs before it will retrigger a note. The chip's output then goes through the cards' **10-bit-mantissa / 3-bit-exponent floating-point DAC**: the YM3014 on the AdLib/SB 2.0 (mono), and the YAC512 on the SB16. Finally, a 64-tap Blackman-Harris polyphase resampler converts it to your device's rate.
  - Caveat: the AdLib era runs the YMF262 in its OPL2-compatibility mode, not a separate YM3812 emulation. They are very close, but not literally the same silicon.
  - The patches are an **original** GM bank plus 4-op OPL3 showcase patches (`common/machines/opl-bank.js`). Load your own `.op2` bank (such as the free DMXOPL) into the FM slot or from the patch editor: it replaces the 175 GM-slot patches of both FM cards as instrument edits (Default restores the built-in bank).
  - The *Analog grit* switch adds output filtering and hiss after the DAC. These are approximations of the cards' analog stages, not measurements.
- **Wavetable**: [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS) by S. Christian Collins is bundled in `soundfonts/` under its license (see `soundfonts/GeneralUser-GS-LICENSE.txt`). At load time, `common/machines/emu-rombudget.js` (in a Worker, via `awe32.prep.js` / `live.prep.js`) "burns" it into period-shaped banks:
  - The AWE32 version is resampled to 22kHz mono with one velocity layer and half the multisamples. Attacks get cut to about 90ms, followed by loops a few pitch periods long.
  - The Live! version is resampled to 32kHz, with shorter attacks and loops.
- **Your own SoundFont**: load an `.sf2` into either slot. If it's already a period bank, untick *ROM budget*. The instrument list then shows that bank's own presets (bank:program and names); your edits are kept per SoundFont. GM programs the bank lacks fall back to bank 0, then the nearest preset of the same GM family; drum kits fall back to kit 0, then any drum kit.

No Creative, E-mu, Yamaha or Microsoft data is included. Product names are used only to describe the eras.

## Files

- `index.html`, `css/blasta.css`: the app page (built on `common/machine-app.js`)
- `js/blasta-ext.js`: Blasta's extension to the shared app: era slider and ISA-card art, sound-bank slots (IndexedDB store `blasta`), Bank Locker
- `js/locker.js` (same as `common/locker.js`): the Bank Locker client; the Worker is in `/locker`
- `common/machines/opl-*.js`, `opl2.js`, `opl3.js`: the FM cards; `emu-*.js`, `awe32.js`, `live.js` (+ `.prep.js`): the wavetable cards
- `tests/run-machine.mjs <id>` and `tests/shot-machine.mjs <id>` (repo root): offline level checks and app screenshots per card
