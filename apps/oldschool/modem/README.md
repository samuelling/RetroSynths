# Modem (Old School)

A dial-up modem as an instrument. You type AT commands and phone numbers. Both ends of the call are
synthesised sample by sample: your modem, the phone network, and whatever answers. Nothing is pre-recorded.
You hear the session from your modem's little speaker, and a live spectrogram and handshake timeline show
what each end is sending.

```js
import { mountModem } from './apps/oldschool/modem/modem.js';
const m = mountModem(container, { ctx, destination, setStatus });   // also include modem.css
m.command('ATDT555-0142');   // optional: run a line as if typed
m.unmount();
```

## Files

| file | what |
|---|---|
| `modem.js` | `mountModem()`: UI, AT interpreter wiring, spectrogram, timeline |
| `worklet.js` | AudioWorklet `retrosynths-modem`: runs the engine at 8 kHz, resamples to the context rate, and adds relay/dial clicks at full rate |
| `session.js` | negotiation, per-protocol handshake timelines (both ends), and the streaming engine (line model, speaker, events) |
| `signals.js` | signal generators: call progress, DTMF, FSK, DPSK/QAM pumps, V.8, INFO, line probe, PCM/DIL, voice, ringer |
| `dsp.js` | primitives: G.711 μ-law/A-law, SRRC passband modulator, scramblers, CRC/HDLC, biquads |
| `at.js` | AT command interpreter (pure logic) |
| `models.js` | model presets (invented brands), regions, the dialing directory |
| `bbs.js` | the scripted BBS / ISP / caller. Its text is really modulated onto the line by the far modem. |
| `notes-core.js` | Secret Notes modem: framing, FEC, synthesis, streaming decoder (pure JS, runs in Node) |
| `notes-crypto.js` | Secret Notes payload: deflate + PBKDF2 → AES-256-GCM (WebCrypto) |
| `notes-photo.js` | Secret Notes photos: stripe codec, photo frame trains, `PhotoReceiver` (shared with Screech; spec in Screech's `PHOTO.md`) |
| `notes-ui.js` | the Secret Notes panel (notes and photos: send, save as .wav, listen through the mic, decode a sound file) |

## How it works

When you dial, the engine lays out a **script**: timed segments on three tracks (calling modem, answering
modem, network). The answering side's choices depend on what the caller offers. Each segment is a generator
(an FSK modulator, a QAM pump, a tone, …) pulled one sample at a time at 8 kHz, so long handshakes are
streamed, never rendered ahead. `ATH`, Hang up, or any key during a handshake cuts the sound within a few ms.
The worklet uses 3 ms fades and roughly 2 ms of resampler latency.

The signal chain is: far modem + exchange tones → one G.711 codec stage (μ-law in North America, A-law in
the UK/EU) → 300–3400 Hz line band → loss → drop-outs, hiss, mains hum (60/50 Hz plus harmonics), crackle →
plus your own transmitter (through the DAA) and the far hybrid's echo of it (30 ms) → the speaker. The
speaker stage applies ATM gating (M1 cuts at carrier detect), ATL level, and per-model colour: a resonant
high-pass, a peak, and soft overdrive. Couplers also get a muffled acoustic comb.

## What each segment follows

* **Call progress**
  * North America: dial tone 350+440 Hz, ringback 440+480 Hz 2 s on/4 s off, busy 480+620 Hz 0.5/0.5,
    reorder 0.25/0.25, receiver-off-hook howler 1400+2060+2450+2600 Hz.
  * UK: dial 350+450 Hz, ring 400+450 Hz 0.4/0.2/0.4/2.0, busy 400 Hz 0.375/0.375.
  * CEPT: everything at 425 Hz.
  * SIT intercept: 913.8 / 1370.6 / 1776.7 Hz.
* **DTMF**: the standard 4×4 pairs, low group −7 dBm0, high group −5 dBm0. Tone duration and spacing come
  from S11.
* **Pulse dialing**: 10 pps; North America 60/40 ms break/make, UK 67/33; 700 ms between digits. Each pulse
  opens the loop (line audio drops out), puts a transient on the line, and clicks the relay. Rotary
  "couplers" add the dial's ratchet.
* **Bell 103**: originate 1070/1270 Hz, answer 2025/2225 Hz (space/mark), 300 baud continuous-phase FSK. The
  answer modem's mark is the answer tone.
* **V.21**: channel 1 980/1180 Hz, channel 2 1650/1850 Hz. V.25 answer tone first.
* **V.25 answer tone**: 2100 Hz for 3.3 s, with abrupt 180° reversals every 450 ms when the answerer has an
  echo canceller to disable (V.32 and up). It's sent after a 1.8–2.5 s billing delay.
* **Bell 212A / V.22**: 600 baud DPSK on 1200 Hz (caller) and 2400 Hz (answerer). The dibit phase changes are
  00→+90°, 01→0°, 11→+270°, 10→+180°. Scrambler 1+x⁻¹⁴+x⁻¹⁷ with V.22's 64-ones rule; SRRC shaping at 75 %.
  V.22 sends USB1 (unscrambled ones), which comes out as a 2250 Hz line. SB1 timings are 155/456/270/765 ms.
  212A answers with 2225 Hz.
* **V.22bis**: S1 (unscrambled 00/11 double dibits gives lines at fc ± 300 Hz), SB1 at 1200 then 2400 bit/s,
  and 16-point QAM (differential quadrant plus point-in-quadrant). The UK option (&G2, the UK default) adds
  an 1800 Hz guard tone at −6 dB, or 550 Hz at −3 dB with &G1.
* **V.32 / V.32bis**: 2400 baud on an 1800 Hz carrier.
  * The caller sends AA (1800 Hz). The answerer replies AC, then CA, then AC (600+3000 Hz) for ranging, and
    the caller answers with CC exactly 64 symbols after the reversal.
  * Training uses S (ABAB), S̄ (CDCD) and TRN (scrambled ones on the 4-point A/B/C/D set), then the R1/R2/R3
    rate signals, E and B1.
  * Scramblers: GPC 1+x⁻¹⁸+x⁻²³ for the caller, GPA 1+x⁻⁵+x⁻²³ for the answerer.
* **V.8**: ANSam (2100 Hz, 15 Hz AM at ±20 %, reversals every 450 ms) and CM over V.21 channel 1. Each message
  is ten ones, the 0xE0 sync octet, then the call-function, modulation, protocol, PSTN-access and
  PCM-availability octets, framed with start/stop bits. JM goes over channel 2 after two identical CMs; the
  caller finishes the current CM octet and sends CJ (three zero octets); then 75 ms of silence.
* **V.34 phase 2**: 600 bit/s DPSK on 1200 Hz (caller) and 2400 Hz (answerer); a 1 is a 180° flip.
  * INFO0 is 49 bits (fill, sync 01110010, info, CRC-16, fill); INFO1c is 109 bits and INFO1a 70.
  * Tone A 2400 Hz and Tone B 1200 Hz, with their phase reversals for round-trip timing.
  * L1/L2 line probe: 21 tones every 150 Hz from 150 to 3750 Hz, with 900/1200/1800/2400 Hz omitted. L1 is
    160 ms at +6 dB, L2 550 ms at nominal level. The answerer probes first, then the caller.
* **V.34 phases 3/4**: symbol rate and carrier from V.34's table (2400–3429 baud, carrier = baud·d/e, e.g.
  3429 baud on 1959 Hz, 3200 baud on 1829/1920 Hz).
  * Sequence: S, S̄, PP (6 × 48 symbols), TRN (scrambled ones, 4-point), J (0x8990), J′, then TRN, MP, MP′,
    E and B1, in the full-duplex order: answerer first, then caller, then both.
  * The rate follows the line-quality control (33.6k down to 14.4k).
* **V.90**: the V.8 menu with the PCM octet, a V.34-style phase 2, then the digital modem's μ-law PCM
  sequences: Sd/S̄d, TRN1d (scrambled signs, a bright broadband hiss), Jd, DIL, Ri, TRN2d, CPd. Upstream is
  V.34. 56K only happens against a *digital* server: two analogue modems, or a poor line, give V.34.
  Downstream rates step by 8000/6 (e.g. 49333, 50666, 52000, 53333).
* **Fax** (optional extra): CNG 1100 Hz 0.5 s on / 3 s off, CED 2100 Hz for 3 s, and V.21 channel 2 HDLC
  (1 s of flags, then DIS) repeated. With `AT+FCLASS=1;D…` to a fax machine you get an abbreviated T.30:
  DIS, DCS, V.29 training + TCF at 9600 (2400 baud, 1700 Hz, 8-phase/4-amplitude), CFR, page data, EOP, MCF,
  DCN.
* **Voice**: a tiny formant synthesiser (glottal pulses plus aspiration through three moving resonators)
  says "hello?" … "HELLO?", then hangs up.

## Negotiation and fallback

The answering modem walks down its automode ladder: ANSam (V.8) or ANS, then a V.32 AC probe, then V.22
USB1, then the Bell 2225 Hz tone, then the V.21 mark. The caller responds to the first offer it understands,
so you hear the real stumbles:

* a V.32 caller sends AA into a 2400 BBS's answer tone, then drops to V.22bis on hearing USB1;
* a V.32 caller answered with ANSam makes the V.34 modem drop to V.32;
* Bell vs CCITT at 300 bps don't interoperate;
* `R` (originate in answer mode) puts two answer tones on the line, and the call gets NO CARRIER.

ATB, `+MS` (V.250 or numeric codes), `S37` with `N0/N1`, and `&N` restrict the local modem. `\N`, `&Q`, `+ES`,
`%C`, and `+DS` set V.42 LAPM / MNP / none and V.42bis / MNP 5. W, X, V, Q, S95, `\V` and `&A` shape the result
codes (`CONNECT 115200`, `CONNECT 33600/ARQ`, `CARRIER/PROTOCOL/COMPRESSION` lines, numeric codes).

## Approximations (honest list)

* Data-mode constellations are differential square QAM. The real trellis coding (V.32/V.32bis/V.34),
  shell mapping and precoding (V.34) are not implemented. In data mode the result sounds like
  correctly-placed band-limited noise, which it is in reality too.
* Field contents are only partly real: INFO0/INFO1, MP and the V.32 rate words have the right lengths,
  framing, CRC and scrambling, but their payload bits are plausible fillers rather than full field encodings.
  The V.32 R-word layout is approximate. PP uses a 48-symbol Chu sequence rather than V.34's exact table.
* The L1/L2 tone phases are a low-crest 0/180° set found by search (crest ≈ 1.75), not V.34's own table.
* V.90 DIL is structurally right (segments of sign and training patterns over μ-law Ucodes) but doesn't
  follow a real descriptor. The two pre-standard 56K "rival" flavours are stylised: different DIL patterns,
  rate steps and a proprietary V.8 octet.
* EC negotiation (V.42 ODP/ADP, XID/SABME; MNP LR/LA) is timed and labelled. The link idles with HDLC
  flags and BBS text travels in LAPM-like I-frames with real FCS and bit stuffing. V.42bis compression is
  only reported.
* Timings follow the specs where they give them. Detection delays are modelled as fixed small latencies,
  not real demodulators.
* `%E` and `&K` etc. are stored and shown in `&V`; there is no mid-call retrain. High-speed numeric result
  codes vary by vendor; the ones used here are representative.
* Unlisted 555-01xx numbers map deterministically to something (a modem, busy, a person…). Every other
  number reaches a SIT intercept.

## Tests

* `node tests/modem-offline.mjs`: Node only, about 3 s. G.711 identity, scrambler self-sync, all 16 DTMF
  pairs, dial/ring/busy cadences, Bell 103 marks, USB1 + guard, S1 lines, the 2100 Hz reversals, AA/AC,
  ANSam AM depth, CM/JM bands, L1/L2 comb and gaps, V.90 hiss, fax tones, voice, answer mode, ATH latency.
  WAVs go to `/tmp/rs/modem-*.wav`.
* `node tests/modem-browser.mjs`: the standalone page in headless Chrome through the real worklet.
  Sessions at 300 / 2400 / V.32bis / V.34 / V.90 / busy, ERROR, numeric codes, an incoming call, hang-up
  latency, unmount. Screenshots go to `/tmp/rs/modem.png`.


## Secret Notes (real data over the air)

One Modem plays a note; another Modem listens through its microphone and decodes it. Notes can also be saved
as a `.wav` file, sent by text or email, and decoded with "Decode a sound file…". Note audio is clean and does
not go through the phone-line simulation. Every tone sits between 900 Hz and 3.3 kHz, where phone speakers and
microphones work well, and plays at −6 dBFS peak times the panel's volume.

### Speeds (measured, see below)

| speed | modulation | gross | net (after FEC) | 100-char secret note* | 90 % success down to |
|---|---|---|---|---|---|
| **Sturdy** | MFSK-8, 75 baud, 2 interleaved banks of 8 tones | 225 bit/s | 112.5 bit/s = 14 B/s | 11.7 s | **−6 dB** SNR |
| **Quick** | MFSK-8, 150 baud, same tone plan | 450 bit/s | 225 bit/s = 28 B/s | 6.1 s | **0 dB** |
| **Classic** | 300 baud binary FSK, mark/space pair hopping over 4 pairs | 300 bit/s | 150 bit/s = 19 B/s | 8.9 s | **6 dB** |

\* 145 bytes before compression (100 bytes of text + 45 bytes of crypto). English text usually deflates by 20–40 %.
The optional fake handshake intro adds 1.75 s.

* **Why 300 baud FSK isn't the sturdy one.** Measurements showed binary FSK is the *least* robust of the three
  through a room. Its 3.3 ms symbols are shorter than a room's early echoes (2–20 ms), and a binary decision
  has little noise margin. Long MFSK symbols with several bits each do better on both counts, so "Sturdy" is
  75-baud MFSK-8. Classic is kept because it sounds like a modem.
* **Two interleaved banks.** Consecutive symbols alternate between the even and odd tones of a 150 Hz grid,
  so the echo of the previous symbol lands in the other bank. Classic's pair hopping does the same job. In
  tests, banked MFSK-8 beat plain MFSK-16 (same tones and baud) at every SNR.

### Frame

`preamble` (two tones alternating, 0.5 s) → `sync` (8 tones for Sturdy/Quick; 24 bits with peak sidelobe 4 for
Classic) → `header` (version · speed · flags · 16-bit length · CRC-8; FEC-coded) → `payload + CRC-32`
(FEC-coded, interleaved) → 4 tail symbols.

* **Receiver.** All three speeds are decoded in parallel at 9600 Hz with sliding-DFT tone energies.
  * Acquisition uses energy ratios only: the two preamble tones must hold most of the band's energy, both
    must be present, and they must alternate. That makes it level-independent; tests cover −45 dB.
  * Timing is a block tracker. Every 16–24 symbols it picks the offset that maximises each symbol's strongest
    tone, then nudges the symbol period. A ±0.8 % clock mismatch is followed; the spec asked for ±0.5 %.
  * The sync word is peak-picked. The header is then tried at the sync peak and ±2 symbols, keeping the one
    that passes CRC-8, version and speed checks. This matters because echoes blur the sync peak.
* **FEC.** A rate-½ K=7 convolutional code (171/133 octal, the NASA/Voyager code) with a soft-decision
  Viterbi decoder, plus PRBS9 whitening and a block interleaver (24 columns for the payload).
  * Every symbol yields soft values (tone-energy ratios). Soft Viterbi turns these into about 5 dB of gain,
    which a hard-decision Reed-Solomon decoder would mostly leave unused.
  * The interleaver spreads a clap or cough (tens of ms, every bit soft-zero) into isolated erasures the
    Viterbi decoder corrects. A 50 ms clap is absorbed, and in one test 40 % of a payload buried 9.5 dB under
    noise still decoded.
  * It is also small and exact to implement in plain JS.
  * The trade-off is rate ½. A frame that the FEC can't fix fails CRC-32 and is reported as garbled, never
    as a wrong passphrase.

### Crypto (WebCrypto only)

* **Key:** PBKDF2-HMAC-SHA256(passphrase NFC, random 16-byte salt, 200 000 iterations) → 256-bit AES-GCM key.
* **Packet:** `version(1) | salt(16) | iv(12, random) | ciphertext + 16-byte GCM tag`, so 45 bytes of
  overhead.
* **Authentication:** the GCM tag authenticates the note. The frame header's speed and flags are bound in as
  additional data.
* **Order:** text is deflated (if that helps) before encryption.
* **Receiver results:**
  * CRC-32 failure → "Couldn't read it — too garbled".
  * CRC fine but GCM fails → "wrong passphrase".
  * No passphrase entered → 🔒, text not shown; "Try passphrase again" re-decrypts the held note.
* **Logging:** nothing logs passphrases or plaintext.
* **Open notes** (no passphrase) are plain deflated UTF-8 that **anyone with a decoder can read**. The UI says
  so and labels the Send button "Send open note (not secret)".

### Measured robustness (`node tests/modem-notes.mjs`, 50 trials per condition)

The channel is:

* phone speaker band-pass (300 Hz – 7 kHz);
* a synthetic room: direct path, 5 early reflections at 2–20 ms with amplitude 0.2–0.5, and an exponentially
  decaying noise tail with RT60 0.3–0.6 s and DRR 2–10 dB;
* clock skew ±0.5 %, random gain −35…0 dB, 0.2–2.5 s of leading and 0.3–1 s of trailing silence;
* a clap about 20 dB above the signal mid-packet;
* white noise, 100 Hz – 8 kHz, at the stated SNR (signal power over the packet ÷ noise power).

| SNR | 20 | 12 | 6 | 3 | 0 | −3 | −6 | −9 dB |
|---|---|---|---|---|---|---|---|---|
| Sturdy | 98 % | 98 % | 98 % | 98 % | 100 % | 98 % | 92 % | 34 % |
| Quick | 98 % | 96 % | 94 % | 92 % | 90 % | 74 % | 20 % | 0 % |
| Classic | 94 % | 92 % | 92 % | 86 % | 76 % | 44 % | 4 % | 0 % |

The 2–6 % failures at high SNR are draws with very strong early reflections. Further checks:

* Separate 50-trial runs at 15 dB: ±0.5 % and ±0.8 % skew, RT60 0.6 s with DRR 2 dB, −45 dB level, and two
  claps all stay between 92 % and 100 % for every speed.
* No false notes from 60 s of noise, 60 s of random-tone babble, or the intro flourish.
* Notes survive AAC 64 kbps, Opus 24 kbps (voip) and MP3 64 kbps transcodes, including room recordings.
* `node tests/modem-notes-browser.mjs` drives Chrome's fake microphone with a room-simulated recording. It
  covers the right, wrong and missing passphrase; keep-listening; Save as sound → Decode a sound file (WAV,
  m4a, ogg, mp3); and axe (0 violations).

### Photos

Photos travel as a train of ordinary note frames with frame-header **version 2**: a header, one frame per
16-pixel stripe (a small JPEG-like DCT codec), then the header again. Encrypted photos use AES-256-GCM per
stripe. The receiver routes every version-2 frame that passes its CRC to a `PhotoReceiver`, never to the
text-note path; this applies to the microphone and to "Decode a sound file", with one receiver per listening
session or file.

* **Send:** choose **Photo**, then a picture, a size (Tiny 64 / Small 96 / Large 128 px) and a detail level
  (Low / Medium / High).
  * The preview is drawn by decoding the stripes that will be sent, so it is pixel-identical to what
    arrives. It shows w×h, the stripe count and the airtime.
  * While the photo plays, the preview paints in from the top in time with the sound, with a bright scan
    line. "Save as sound" works for photos too.
* **Receive:** each photo is a live, pixelated canvas in the received list.
  * A scan line marks the stripe that is arriving, using the decoder's progress within the current frame.
  * The status reads "stripe k of n", ✓ done, 🔒 locked (no passphrase) or wrong passphrase, with a count of
    damaged stripes; those are drawn smeared.
  * Changing the passphrase calls `retry()`, so a locked photo unlocks by itself. "Save picture" writes a
    PNG scaled up ×6, nearest-neighbour.
* **Self-decoding is muted:** while this device is sending a note or photo, and for 0.7 s afterwards, the
  listener is fed silence so it doesn't decode its own sound.
* **Airtime** (measured on four test photos): Tiny takes 20–70 s at Quick (about twice that at Sturdy). Large/High
  takes up to about 3 min at Quick and 6 min at Sturdy. Busy pictures cost more than smooth ones.

### Caveats

* The microphone and WebCrypto need a secure context (https or localhost). An embedding iframe needs
  `allow="microphone"`.
* The mic is requested with echoCancellation, noiseSuppression and autoGainControl all off. Some browsers
  (notably iOS Safari) may still apply voice processing, and on iPhone an open mic can route playback to the
  earpiece or lower it. Sending and listening work best on two devices.
* Ogg/Opus files need a browser that decodes them: older Safari doesn't. Messaging apps that re-encode voice
  with narrowband speech codecs (AMR) were not tested.
