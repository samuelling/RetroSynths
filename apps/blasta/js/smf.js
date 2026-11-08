// Standard MIDI File parser → flat, time-sorted event list in seconds.

export function parseSMF(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  let o = 0;
  const id = () => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  // RIFF-wrapped MIDI (.rmi)
  if (id() === 'RIFF') {
    o = 12;
    while (o < b.length && id() !== 'data') o += 8 + dv.getUint32(o + 4, true);
    o += 8;
  }
  if (id() !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = dv.getUint32(o + 4);
  const format = dv.getUint16(o + 8), ntrk = dv.getUint16(o + 10), div = dv.getUint16(o + 12);
  o += 8 + hlen;
  const raw = []; // [tick, order, kind, data]
  let order = 0;
  let title = '';
  for (let t = 0; t < ntrk && o < b.length; t++) {
    while (o < b.length && id() !== 'MTrk') o += 8 + dv.getUint32(o + 4);
    if (o >= b.length) break;
    const len = dv.getUint32(o + 4);
    let p = o + 8;
    const end = Math.min(b.length, p + len);
    let tick = 0, run = 0;
    const vlq = () => { let v = 0, c; do { c = b[p++]; v = (v << 7) | (c & 127); } while (c & 128 && p < end); return v; };
    while (p < end) {
      tick += vlq();
      let st = b[p];
      if (st & 0x80) p++; else st = run;
      if (st === 0xFF) {
        const type = b[p++], l = vlq();
        if (type === 0x51 && l === 3) raw.push([tick, order++, 'tempo', (b[p] << 16) | (b[p + 1] << 8) | b[p + 2]]);
        else if ((type === 0x03 || type === 0x01) && !title && t <= 1) {
          title = new TextDecoder('latin1').decode(b.slice(p, p + l)).trim();
        }
        p += l;
        if (type === 0x2F) break;
      } else if (st === 0xF0 || st === 0xF7) {
        const l = vlq();
        const data = b.slice(p, p + l); p += l;
        // GM / GS / XG reset → reset token
        const isGM = data[0] === 0x7E && data[2] === 0x09;
        const isGS = data[0] === 0x41 && data[3] === 0x12 && data[4] === 0x40 && data[5] === 0x00 && data[6] === 0x7F;
        const isXG = data[0] === 0x43 && data[2] === 0x4C && data[3] === 0 && data[4] === 0 && data[5] === 0x7E;
        if (isGM || isGS || isXG) raw.push([tick, order++, 'reset']);
        // GS "use for rhythm part"
        if (data[0] === 0x41 && data[3] === 0x12 && data[4] === 0x40 && (data[5] & 0xF0) === 0x10 && data[6] === 0x15) {
          const part = data[5] & 15; const ch = part === 0 ? 9 : part <= 9 ? part - 1 : part;
          raw.push([tick, order++, 'drum', ch, data[7] !== 0]);
        }
      } else {
        run = st;
        const type = st & 0xF0;
        const d1 = b[p++];
        const d2 = (type === 0xC0 || type === 0xD0) ? 0 : b[p++];
        raw.push([tick, order++, 'ch', st, d1, d2]);
      }
    }
    o = end;
  }
  raw.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  // ticks → seconds
  const events = [];
  let usPerQ = 500000, lastTick = 0, sec = 0;
  const smpte = div & 0x8000;
  const tickSec = () => smpte ? 1 / ((-(div >> 8) << 24 >> 24) * (div & 0xff)) : usPerQ / 1e6 / div;
  for (const r of raw) {
    sec += (r[0] - lastTick) * tickSec(); lastTick = r[0];
    if (r[2] === 'tempo') usPerQ = r[3];
    else if (r[2] === 'ch') events.push([sec, r[3], r[4], r[5]]);
    else if (r[2] === 'reset') events.push([sec, 0xFF, 0, 0]);
    else if (r[2] === 'drum') events.push([sec, 0xFE, r[3], r[4] ? 1 : 0]);
  }
  const duration = events.length ? events[events.length - 1][0] + 1 : 0;
  return { format, title, events, duration };
}
