// Atari TIA (Television Interface Adaptor) audio section — original implementation for RetroSynths,
// written from the public descriptions of the TIA sound circuit (Stella programmer's guide, "TIA sound"
// notes, Paul Slocum's 2600 music guide).
//
// Two identical channels, each clocked by the audio clock = colour clock / 114 = 3.579545 MHz / 114
// ≈ 31,399.5 Hz (two pulses per scanline). Each channel:
//   AUDF (5 bit)  divide-by-(AUDF+1) counter; every underflow is a "tick"
//   AUDC (4 bit)  selects how ticks drive the output bit (pure divider, 4/5/9-bit polynomial
//                 counters, the div-31 pattern, and ×3 prescale for AUDC 12–15)
//   AUDV (4 bit)  output volume (linear-ish 4-bit DAC)
// The 5-bit poly advances on every tick; the 4- and 9-bit polys advance only on ticks that pass the
// AUDC clock modifier, so e.g. AUDC 3 (5-bit → 4-bit) yields a 465-tick pattern.

export const TIA_CLOCK = 3579545;
export const TIA_RATE = TIA_CLOCK / 114;                  // audio clock, Hz
export const TIA_FRAME_CLOCKS = 262 * 2;                  // audio clocks per NTSC frame (262 lines × 2)

/** Maximal-length LFSR sequence for x^n + x^m + 1 (a[t+n] = a[t+m] ^ a[t]), length 2^n − 1. */
export function polySeq(n, m) {
  const L = (1 << n) - 1, a = new Uint8Array(L + n);
  for (let i = 0; i < n; i++) a[i] = 1;
  for (let t = 0; t < L; t++) a[t + n] = a[t + m] ^ a[t];
  return a.slice(0, L);
}
/** Smallest period of a cyclic bit sequence. */
export function seqPeriod(a) {
  const L = a.length;
  outer: for (let p = 1; p <= L; p++) {
    if (L % p) continue;
    for (let i = 0; i < L; i++) if (a[i] !== a[(i + p) % L]) continue outer;
    return p;
  }
  return L;
}

export const BIT4 = polySeq(4, 3);      // 15
export const BIT5 = polySeq(5, 3);      // 31
export const BIT9 = polySeq(9, 5);      // 511
// div-31 pattern: two clock pulses per 31 ticks, 18 apart (18:13 duty). Placed where the 5-bit poly
// differs, so AUDC 10 (poly5 sampled on the div-31 pulses) is a tone, as on hardware.
export const DIV31 = new Uint8Array(31);
{
  let p0 = 0;
  for (let p = 0; p < 31; p++) if (BIT5[p] !== BIT5[(p + 18) % 31]) { p0 = p; break; }
  DIV31[p0] = 1; DIV31[(p0 + 18) % 31] = 1;
}

/** Output period (in AUDF ticks × (AUDF+1)) of each AUDC mode's tonal pattern; 0 = no pitch. */
export const MODE_PERIOD = [0, 15, 465, 465, 2, 2, 31, 31, 511, 31, 31, 0, 6, 6, 93, 93];

/** Pitch (Hz) of AUDC/AUDF. */
export const tiaHz = (audc, audf) => MODE_PERIOD[audc] ? TIA_RATE / (MODE_PERIOD[audc] * (audf + 1)) : 0;

class TIAChannel {
  constructor() { this.reset(); }
  reset() { this.audc = 0; this.audf = 0; this.audv = 0; this.cnt = 0; this.max = 0; this.p4 = 0; this.p5 = 0; this.p9 = 0; this.out = 1; }
  setup() {
    let m;
    if (this.audc === 0 || this.audc === 0x0b) { m = 0; this.out = 1; }       // "set to 1": volume only
    else { m = this.audf + 1; if ((this.audc & 0x0c) === 0x0c) m *= 3; }     // AUDC 12–15: ÷3 prescale
    if (m !== this.max) { this.max = m; if (this.cnt === 0 || m === 0) this.cnt = m; }
  }
  clock() {
    if (this.cnt > 1) { this.cnt--; return; }
    if (this.cnt !== 1) return;
    this.cnt = this.max;
    const c = this.audc;
    if (++this.p5 === 31) this.p5 = 0;
    if (!(c & 2) || (!(c & 1) && DIV31[this.p5]) || ((c & 1) && BIT5[this.p5])) {
      if (c & 4) this.out ^= 1;                                   // pure (divide-by-2 of the modified clock)
      else if (c & 8) {
        if (c === 8) { if (++this.p9 === 511) this.p9 = 0; this.out = BIT9[this.p9]; }
        else this.out = BIT5[this.p5];
      } else { if (++this.p4 === 15) this.p4 = 0; this.out = BIT4[this.p4]; }
    }
  }
}

export class TIA {
  constructor() {
    this.ch = [new TIAChannel(), new TIAChannel()];
    // The two channel DACs share one output node; the sum compresses slightly as both channels rise
    // (resistor-network behaviour). Approximation: y = s/30 · (1+c)/(1+c·s/30), c = 0.5.
    this.mix = new Float32Array(31);
    for (let s = 0; s <= 30; s++) this.mix[s] = (s / 30) * 1.5 / (1 + 0.5 * s / 30);
  }
  reset() { for (const c of this.ch) c.reset(); }
  /** Write a TIA audio register: 0x15/0x16 AUDC0/1, 0x17/0x18 AUDF0/1, 0x19/0x1A AUDV0/1. */
  write(reg, v) {
    const c = this.ch[(reg - 0x15) & 1];
    switch (reg) {
      case 0x15: case 0x16: c.audc = v & 15; break;
      case 0x17: case 0x18: c.audf = v & 31; break;
      case 0x19: case 0x1a: c.audv = v & 15; return;
      default: return;
    }
    c.setup();
  }
  /** Advance one audio clock; returns the mixed output 0..1. */
  clock() {
    const a = this.ch[0], b = this.ch[1];
    a.clock(); b.clock();
    return this.mix[(a.out ? a.audv : 0) + (b.out ? b.audv : 0)];
  }
}
