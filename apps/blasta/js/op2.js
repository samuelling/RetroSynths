// Loader for DMX ".op2" FM banks (the GENMIDI format used by many OPL MIDI players,
// e.g. the free DMXOPL bank). The user supplies the file; nothing is bundled.

function readOp(b, o) {
  const t = b[o], at = b[o + 1], su = b[o + 2], wf = b[o + 3], sc = b[o + 4], lv = b[o + 5];
  return {
    am: (t >> 7) & 1, vib: (t >> 6) & 1, egt: (t >> 5) & 1, ksr: (t >> 4) & 1, mult: t & 15,
    ar: at >> 4, dr: at & 15, sl: su >> 4, rr: su & 15, ws: wf & 7, ksl: (sc >> 6) & 3, tl: lv & 63,
  };
}
function readVoice(b, o, dv) {
  const fbB = b[o + 6];
  return { m: readOp(b, o), fb: (fbB >> 1) & 7, cnt: fbB & 1, c: readOp(b, o + 7), offset: dv.getInt16(o + 14, true) };
}

export function parseOP2(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  const sig = String.fromCharCode(...b.slice(0, 8));
  if (sig !== '#OPL_II#') throw new Error('Not an OP2 (GENMIDI) bank');
  const patches = [];
  for (let i = 0; i < 175; i++) {
    const o = 8 + i * 36;
    const flags = dv.getUint16(o, true), fine = b[o + 2], note = b[o + 3];
    const voices = [readVoice(b, o + 4, dv)];
    if (flags & 4) voices.push(readVoice(b, o + 20, dv));
    patches.push({ voices, fixed: !!(flags & 1), fixedNote: note, detune: ((fine / 2) - 64) / 32 });
  }
  const melodic = patches.slice(0, 128);
  const drums = {};
  for (let n = 35; n <= 81; n++) {
    const p = patches[128 + n - 35];
    if (!p.fixed) { p.fixed = true; p.fixedNote = 60; }
    drums[n] = p;
  }
  return { name: 'OP2 bank', melodic, drums };
}
