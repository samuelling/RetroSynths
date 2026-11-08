# Blasta

General MIDI through four generations of PC sound card, in the browser. You drag one slider to age a song forward from 1989 to 1998:

| Era | Card | Engine |
|---|---|---|
| 1989 | AdLib / Sound Blaster 2.0 | Cycle-accurate OPL FM in OPL2 mode: 9 voices, 4 waveforms, mono |
| 1992 | Sound Blaster 16 · Windows 3.1 | Cycle-accurate YMF262 (OPL3): 18 voices, 8 waveforms, hard L/R stereo |
| 1994 | Sound Blaster AWE32 | EMU8000-style wavetable: 30 voices, ROM-budget bank, linear interpolation, gritty reverb |
| 1998 | Sound Blaster Live! | EMU10K1-style wavetable: 64 voices, 8-point interpolation, SF2.01 modulators, smoother reverb |

Between eras the two neighbouring cards crossfade.

**Play:** open `index.html` from any static server (GitHub Pages works), click to power on, then hit **Demo** or drop a `.mid` file on the window. You can also play live with the on-screen keys, QWERTY (A–K, Z/X for octave) or a Web MIDI keyboard.

## Where the sounds come from

- **FM**: `js/nuked-opl3.js` is a line-for-line JavaScript port of [Nuked OPL3](https://github.com/nukeykt/Nuked-OPL3) 1.8 by Nuke.YKT (LGPL-2.1, see `LICENSES/`). It is verified **bit-exact** against the original C on a 141k-sample register torture test covering every waveform, feedback, 4-op, rhythm mode and the LFOs. The chip runs at its native **49,716 Hz** with its native integer widths. A MIDI driver programs it through registers, as the DOS and Windows drivers did; that includes the one-sample key-off a real chip needs before it will retrigger a note. The chip's output then goes through the cards' **10-bit-mantissa / 3-bit-exponent floating-point DAC**: the YM3014 on the AdLib/SB 2.0 (mono), and the YAC512 on the SB16. Finally, a 64-tap Blackman-Harris polyphase resampler converts it to your device's rate.
  - Caveat: the AdLib era runs the YMF262 in its OPL2-compatibility mode, not a separate YM3812 emulation. They are very close, but not literally the same silicon.
  - The patches are an **original** GM bank (`js/fmbank.js`). You can load your own `.op2` bank, such as the free DMXOPL.
  - The *Analog grit* switch adds output filtering and hiss after the DAC. These are approximations of the cards' analog stages, not measurements.
- **Wavetable**: [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS) by S. Christian Collins is bundled in `soundfonts/` under its license (see `soundfonts/GeneralUser-GS-LICENSE.txt`). At load time, `js/rombudget.js` "burns" it into period-shaped banks:
  - The AWE32 version is resampled to 22kHz mono with one velocity layer and half the multisamples. Attacks get cut to about 90ms, followed by loops a few pitch periods long.
  - The Live! version is resampled to 32kHz, with shorter attacks and loops.
- **Your own SoundFont**: load an `.sf2` into either slot. If it's already a period bank, untick *ROM budget*.

No Creative, E-mu, Yamaha or Microsoft data is included. Product names are used only to describe the eras.

## Files

- `js/blasta-worklet.js`: the AudioWorklet containing all four synth cores and the effects
- `js/sf2.js`, `js/rombudget.js`, `js/rom-worker.js`: SoundFont parsing and ROM burning, run off the main thread
- `js/smf.js`, `js/demo.js`: the MIDI file parser and the original demo tune
- `tests/render.html`: an offline render harness for headless Chrome that checks levels and NaNs and reports per-patch RMS
