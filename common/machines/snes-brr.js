/*
 * BRR ("Bit Rate Reduction") codec for the SNES S-DSP — RetroSynths' own implementation from the
 * public format description (fullsnes / anomie / SNESdev wiki).
 *
 * Block = 9 bytes: header SSSSFFLE (shift, filter, loop, end) + 16 signed 4-bit nibbles, high first.
 * Decoded value = clamp16(((n << shift) >> 1) + prediction(filter, p1, p2)), then doubled and wrapped
 * to 16 bits (the hardware's 15-bit sample path). Shifts 13..15 give −2048 for negative nibbles, 0 else.
 */

const clamp16 = (x) => (x > 32767 ? 32767 : x < -32768 ? -32768 : x);

/** Hardware prediction; p1 = previous stored sample, p2 = the one before (both doubled 15-bit values). */
export function brrPredict(filter, p1, p2raw) {
  const p2 = p2raw >> 1;
  switch (filter) {
    case 1: return (p1 >> 1) + ((-p1) >> 5);
    case 2: return p1 - p2 + (p2 >> 4) + ((p1 * -3) >> 6);
    case 3: return p1 - p2 + ((p1 * -13) >> 7) + ((p2 * 3) >> 4);
    default: return 0;
  }
}
/** One decoded sample (stored form) from a signed nibble. */
export function brrSample(nib, shift, filter, p1, p2) {
  let s = shift <= 12 ? (nib << shift) >> 1 : (nib < 0 ? -2048 : 0);
  s = clamp16(s + brrPredict(filter, p1, p2));
  return (s << 17) >> 16;
}

/** Reference decoder: whole BRR stream → Int16Array (stops after the END block). */
export function brrDecode(bytes, offset = 0, maxBlocks = 1 << 16) {
  const out = [];
  let p1 = 0, p2 = 0;
  for (let b = 0; b < maxBlocks; b++) {
    const o = offset + b * 9;
    if (o + 9 > bytes.length) break;
    const h = bytes[o], sh = h >> 4, f = (h >> 2) & 3;
    for (let i = 0; i < 16; i++) {
      const byte = bytes[o + 1 + (i >> 1)];
      const nib = ((i & 1 ? byte << 4 : byte) << 24) >> 28;
      const s = brrSample(nib, sh, f, p1, p2);
      p2 = p1; p1 = s; out.push(s);
    }
    if (h & 1) break;
  }
  return Int16Array.from(out);
}

/**
 * Encode 16-bit PCM (length a multiple of 16) to BRR.
 *   loopBlock: block index the loop returns to (or −1 for a one-shot)
 * One-shots get an extra silent END block (the hardware silences a voice as soon as it reaches
 * an END-without-LOOP block, so that block is never heard). Blocks that can be entered from
 * nowhere-defined history (the first block, the loop target) are forced to filter 0.
 * For each block every filter × shift is tried with exact decoder simulation (including the
 * 15-bit wrap), choosing the per-sample best nibble; the lowest squared error wins.
 */
export function brrEncode(pcm, loopBlock = -1) {
  const nb = pcm.length >> 4, oneShot = loopBlock < 0;
  const out = new Uint8Array((nb + (oneShot ? 1 : 0)) * 9);
  const nib = new Int8Array(16), bestNib = new Int8Array(16);
  let p1 = 0, p2 = 0;
  for (let b = 0; b < nb; b++) {
    const x0 = b << 4;
    const filters = (b === 0 || b === loopBlock) ? 1 : 4;
    let best = Infinity, bf = 0, bs = 0, b1 = 0, b2 = 0;
    for (let f = 0; f < filters; f++) {
      for (let sh = 0; sh <= 12; sh++) {
        let q1 = p1, q2 = p2, err = 0;
        for (let i = 0; i < 16; i++) {
          const x = pcm[x0 + i], pred = brrPredict(f, q1, q2);
          // want ((n << sh) >> 1) + pred ≈ x / 2
          const want = (x / 2 - pred) * 2 / (1 << sh);
          let n = Math.round(want); n = n > 7 ? 7 : n < -8 ? -8 : n;
          let s = brrSample(n, sh, f, q1, q2), e = s - x;
          // neighbouring nibble can win because of rounding / clamp / wrap
          for (const d of [-1, 1]) {
            const m = n + d; if (m > 7 || m < -8) continue;
            const s2 = brrSample(m, sh, f, q1, q2), e2 = s2 - x;
            if (e2 * e2 < e * e) { n = m; s = s2; e = e2; }
          }
          nib[i] = n; err += e * e;
          if (err >= best) break;
          q2 = q1; q1 = s;
        }
        if (err < best) { best = err; bf = f; bs = sh; b1 = q1; b2 = q2; bestNib.set(nib); }
      }
    }
    const o = b * 9, last = b === nb - 1;
    out[o] = (bs << 4) | (bf << 2) | (last && !oneShot ? 3 : 0);
    for (let i = 0; i < 8; i++) out[o + 1 + i] = ((bestNib[2 * i] & 15) << 4) | (bestNib[2 * i + 1] & 15);
    p1 = b1; p2 = b2;
  }
  if (oneShot) out[nb * 9] = 0x01;   // silent END block (shift 0, filter 0)
  return out;
}
