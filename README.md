# RetroSynths

A Windows 3.1-style desktop of retro sound chips that you play with General MIDI. Each app plays MIDI files, the on-screen keys, your QWERTY keyboard or a Web MIDI keyboard through emulated period hardware.

**Open:** https://samuelling.github.io/RetroSynths/. Deep links: `#blasta`, `#console`, `#oldschool`.

| App | Machines |
|---|---|
| **Blasta** | PC sound cards, 1989–1998. AdLib / SB 2.0 and Sound Blaster 16 use cycle-accurate OPL emulation (a Nuked OPL3 port, bit-exact). AWE32 and SB Live! use GeneralUser GS burned into period ROM shapes. You can slide between eras, and the Bank Locker holds your own SoundFonts. |
| **Console** | NES (2A03), Super Nintendo (SPC700 + S-DSP), Genesis / Mega Drive (YM2612 + SN76489), TurboGrafx-16 (HuC6280), Game Boy (DMG APU). |
| **Old School** | Apple IIe + Mockingboard (2× AY-3-8910 + speaker), Commodore 64 (SID), Atari 2600 (TIA), Atari 800 (POKEY), ZX Spectrum 128 (AY), MSX (YM2149), IBM PC speaker (8253 PIT). |

Each machine runs an emulation of its own sound chip at the chip's native clock, with native bit depths, and is played through its **own** instruments:

- **Voices:** the chip's real channels (e.g. NES Pulse 1/2, Triangle, Noise, DPCM), with live meters, mute and solo.
- **Instruments:** a native preset library in chip terms, plus your own copies, with an editor per chip:
  - NES / Game Boy: FamiTracker-style editors, including the GB wave drawer.
  - Genesis: algorithm diagram and operator envelopes.
  - C64: GoatTracker-style wavetable and the 6581/8580 filter curve.
  - SNES: sample source plus the ADSR rate-table graph.
  - AY machines: R13 envelope shapes.
  - Atari 2600: AUDC tuning charts.
  - OPL: 2-op/4-op routing and waveform tiles.
  - AWE32 / Live!: SoundFont zone and generator editor.
  - Edits save automatically, and Export/Import moves them as files.
- **Arranger:** shows how a General MIDI file lands on the chip. Each channel is on *Auto* (the machine's own GM mapping, run by a period-style frame-rate driver) or set to any native instrument, and can be pinned to a specific voice.
- **Keyboard:** the on-screen or QWERTY keyboard, or a Web MIDI keyboard, plays the selected instrument.

## Layout

```
index.html, shell/, css/      the Windows 3.1 desktop (Program Manager + app windows)
apps/blasta/                  Blasta
apps/console/, apps/oldschool/  thin pages over common/machine-app.js
common/host-core.js           AudioWorklet host: MIDI state, scheduling, machine switching
common/machines/              one module per machine (interface: common/machines/README.md)
soundfonts/                   GeneralUser GS (Blasta's wavetable eras, SNES sample RAM)
locker/                       Bank Locker: Cloudflare Worker + R2 for your own banks
tests/run-machine.mjs         offline render test for one machine (levels, speed, GM coverage)
```

## Licenses

The RetroSynths code is © Sam Ling. Third-party parts keep their own licenses, listed in `LICENSES/` (Nuked OPL3 and Nuked OPN2 are LGPL-2.1) and `soundfonts/` (GeneralUser GS). No ROMs, game data or console sample data are included. Machine names are trademarks of their owners and are used only to describe the hardware being emulated.
