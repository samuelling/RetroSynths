# RetroSynths

A make-believe early-'90s desktop of retro sound chips that you play with General MIDI. Each app plays MIDI files, the on-screen keys, your computer keyboard or a Web MIDI keyboard through emulated period hardware. The desktop also opens three megaZINE friends in windows: Big Apple Sam, Q-Slowdem (the MEGAzine BBS terminal) and Townies.

**Open:** https://samuelling.github.io/RetroSynths/. Deep links: `#blasta`, `#console`, `#oldschool`, `#bigapple`, `#qslowdem`, `#townies`, `#readme`.

| App | Machines |
|---|---|
| **Blasta** | PC sound cards, 1989–1998. AdLib / SB 2.0 and Sound Blaster 16 use cycle-accurate OPL emulation (a Nuked OPL3 port, bit-exact). AWE32 and SB Live! use GeneralUser GS burned into period ROM shapes. You can slide between eras, and the Bank Locker holds your own SoundFonts. |
| **Console** | NES (2A03), Super Nintendo (SPC700 + S-DSP), Genesis / Mega Drive (YM2612 + SN76489), TurboGrafx-16 (HuC6280), Game Boy (DMG APU). |
| **Old School** | Apple IIe + Mockingboard (2× AY-3-8910 + speaker), Commodore 64 (SID), Atari 2600 (TIA), Atari 800 (POKEY), ZX Spectrum 128 (AY), MSX (YM2149), IBM PC speaker (8253 PIT), plus the **Modem**: a dial-up modem and phone line you drive with AT commands, synthesizing both ends of every handshake from Bell 103 to V.90 (see `apps/oldschool/modem/README.md`). |

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
- **Keyboard:** docked at the bottom of every app, always on screen. The computer-keyboard letters are printed on the keys (A–; white, W E T Y U O P black, Z/X octave). The on-screen keys or a Web MIDI keyboard work too.
- **Help** (menu or F1): a full how-to for each app.
- **Accessibility:** everything works by keyboard and is labeled for screen readers, with focus rings in the period dotted style and reduced motion when the system asks for it.

## Layout

```
index.html, shell/, css/      the desktop (Program Shelf + app windows)
apps/blasta/                  Blasta
apps/console/, apps/oldschool/  thin pages over common/machine-app.js
common/help.js                Help window + accessible dialogs
common/host-core.js           AudioWorklet host: MIDI state, scheduling, machine switching
common/machines/              one module per machine (interface: common/machines/README.md)
soundfonts/                   GeneralUser GS (Blasta's wavetable eras, SNES sample RAM)
locker/                       Bank Locker: Cloudflare Worker + R2 for your own banks
tests/run-machine.mjs         offline render test for one machine (levels, speed, GM coverage)
```

## Licenses

The RetroSynths code is © Sam Ling. Third-party parts keep their own licenses, listed in `LICENSES/` (Nuked OPL3 and Nuked OPN2 are LGPL-2.1) and `soundfonts/` (GeneralUser GS). No ROMs, game data or console sample data are included. Machine names are trademarks of their owners and are used only to describe the hardware being emulated.
