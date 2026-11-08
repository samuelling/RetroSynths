// Minimal-but-complete SoundFont 2 parser. Flattens presets → instrument zones into
// playable zones with final generator values and a combined modulator list.

const DEFAULTS = new Int32Array(61);
DEFAULTS[8] = 13500;
for (const g of [21, 23, 25, 26, 27, 28, 30, 33, 34, 35, 36, 38]) DEFAULTS[g] = -12000;
DEFAULTS[43] = 127 << 8; DEFAULTS[44] = 127 << 8;
DEFAULTS[46] = -1; DEFAULTS[47] = -1; DEFAULTS[56] = 100; DEFAULTS[58] = -1;

const NOT_IN_PRESET = new Set([0, 1, 2, 3, 4, 12, 45, 46, 47, 50, 54, 57, 58]);
const RANGE = new Set([43, 44]);
const UNSIGNED = new Set([41, 53, 54]);

export const DEFAULT_MODS = [
  [0x0502, 48, 960, 0, 0],
  [0x0081, 6, 50, 0, 0],
  [0x000D, 6, 50, 0, 0],
  [0x0587, 48, 960, 0, 0],
  [0x058B, 48, 960, 0, 0],
  [0x028A, 17, 1000, 0, 0],
  [0x00DB, 16, 200, 0, 0],
  [0x00DD, 15, 200, 0, 0],
];

function str(b, o, n) {
  let s = '';
  for (let i = 0; i < n; i++) { const c = b[o + i]; if (!c) break; s += String.fromCharCode(c); }
  return s.trim();
}

export function parseSF2(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const id = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (id(0) !== 'RIFF' || id(8) !== 'sfbk') throw new Error('Not a SoundFont 2 file');
  const chunks = {};
  let name = 'SoundFont';
  const walk = (start, end) => {
    let o = start;
    while (o + 8 <= end) {
      const cid = id(o), len = dv.getUint32(o + 4, true);
      if (cid === 'LIST') walk(o + 12, o + 8 + len);
      else chunks[cid] = { o: o + 8, len };
      o += 8 + len + (len & 1);
    }
  };
  walk(12, Math.min(u8.length, 8 + dv.getUint32(4, true)));
  if (chunks.INAM) name = str(u8, chunks.INAM.o, chunks.INAM.len) || name;
  const smpl = chunks.smpl;
  if (!smpl) throw new Error('SoundFont has no sample data');
  const pool = new Int16Array(buf.slice(smpl.o, smpl.o + (smpl.len & ~1)));

  const recs = (cid, size, fn) => {
    const c = chunks[cid]; if (!c) throw new Error('Missing ' + cid);
    const out = []; for (let o = c.o; o + size <= c.o + c.len; o += size) out.push(fn(o)); return out;
  };
  const phdr = recs('phdr', 38, o => ({ name: str(u8, o, 20), program: dv.getUint16(o + 20, true), bank: dv.getUint16(o + 22, true), bag: dv.getUint16(o + 24, true) }));
  const pbag = recs('pbag', 4, o => ({ gen: dv.getUint16(o, true), mod: dv.getUint16(o + 2, true) }));
  const genRec = o => ({ op: dv.getUint16(o, true), lo: u8[o + 2], hi: u8[o + 3], s: dv.getInt16(o + 2, true), u: dv.getUint16(o + 2, true) });
  const modRec = o => [dv.getUint16(o, true), dv.getUint16(o + 2, true), dv.getInt16(o + 4, true), dv.getUint16(o + 6, true), dv.getUint16(o + 8, true)];
  const pgen = recs('pgen', 4, genRec), pmod = recs('pmod', 10, modRec);
  const inst = recs('inst', 22, o => ({ name: str(u8, o, 20), bag: dv.getUint16(o + 20, true) }));
  const ibag = recs('ibag', 4, o => ({ gen: dv.getUint16(o, true), mod: dv.getUint16(o + 2, true) }));
  const igen = recs('igen', 4, genRec), imod = recs('imod', 10, modRec);
  const shdr = recs('shdr', 46, o => ({
    name: str(u8, o, 20), start: dv.getUint32(o + 20, true), end: dv.getUint32(o + 24, true),
    ls: dv.getUint32(o + 28, true), le: dv.getUint32(o + 32, true), sr: dv.getUint32(o + 36, true),
    pitch: u8[o + 40], corr: dv.getInt8(o + 41), link: dv.getUint16(o + 42, true), type: dv.getUint16(o + 44, true),
  }));

  // zones of a bag list: [{gens: Map(op -> rec), mods: []}]
  const zonesOf = (bags, gens, mods, b0, b1) => {
    const zs = [];
    for (let b = b0; b < b1; b++) {
      const gm = new Map();
      for (let g = bags[b].gen; g < bags[b + 1].gen; g++) gm.set(gens[g].op, gens[g]);
      const ms = [];
      for (let m = bags[b].mod; m < bags[b + 1].mod; m++) ms.push(mods[m]);
      zs.push({ gens: gm, mods: ms });
    }
    return zs;
  };
  const modKey = m => m[0] + ':' + m[1] + ':' + m[3] + ':' + m[4];
  const mergeMods = (glob, loc) => {
    const out = new Map();
    for (const m of glob) out.set(modKey(m), m.slice());
    for (const m of loc) out.set(modKey(m), m.slice());
    return [...out.values()];
  };

  // pre-flatten instruments
  const instZones = inst.slice(0, -1).map((ins, i) => {
    const zs = zonesOf(ibag, igen, imod, ins.bag, inst[i + 1].bag);
    let glob = null;
    if (zs.length && !zs[0].gens.has(53)) glob = zs.shift();
    return { glob, zs };
  });

  const presets = [];
  for (let p = 0; p < phdr.length - 1; p++) {
    const ph = phdr[p];
    const pz = zonesOf(pbag, pgen, pmod, ph.bag, phdr[p + 1].bag);
    let pglob = null;
    if (pz.length && !pz[0].gens.has(41)) pglob = pz.shift();
    const zones = [];
    for (const z of pz) {
      if (!z.gens.has(41)) continue;
      const iIdx = z.gens.get(41).u;
      const I = instZones[iIdx]; if (!I) continue;
      // preset generators (global + local)
      const pg = new Map(pglob ? pglob.gens : []);
      for (const [k, v] of z.gens) pg.set(k, v);
      const pmods = mergeMods(pglob ? pglob.mods : [], z.mods);
      const pk = pg.get(43), pv = pg.get(44);
      for (const iz of I.zs) {
        const ig = new Map(I.glob ? I.glob.gens : []);
        for (const [k, v] of iz.gens) ig.set(k, v);
        const sh = shdr[ig.get(53).u];
        if (!sh || (sh.type & 0x8000)) continue;
        const g = new Int32Array(DEFAULTS);
        for (const [k, r] of ig) {
          if (k > 60) continue;
          g[k] = RANGE.has(k) ? (r.lo | (r.hi << 8)) : UNSIGNED.has(k) ? r.u : r.s;
        }
        // key / velocity range = intersection
        const ik = ig.get(43), iv = ig.get(44);
        let kl = ik ? ik.lo : 0, kh = ik ? ik.hi : 127, vl = iv ? iv.lo : 0, vh = iv ? iv.hi : 127;
        if (pk) { kl = Math.max(kl, pk.lo); kh = Math.min(kh, pk.hi); }
        if (pv) { vl = Math.max(vl, pv.lo); vh = Math.min(vh, pv.hi); }
        if (kl > kh || vl > vh) continue;
        for (const [k, r] of pg) {
          if (k > 60 || NOT_IN_PRESET.has(k) || RANGE.has(k) || k === 41 || k === 53) continue;
          g[k] += r.s;
        }
        // modulators: defaults <- instrument (override) ; then preset (additive)
        const mm = new Map(DEFAULT_MODS.map(m => [modKey(m), m.slice()]));
        for (const m of mergeMods(I.glob ? I.glob.mods : [], iz.mods)) mm.set(modKey(m), m.slice());
        for (const m of pmods) {
          const k = modKey(m);
          if (mm.has(k)) mm.get(k)[2] += m[2]; else mm.set(k, m.slice());
        }
        const start = sh.start + g[0] + g[4] * 32768;
        const end = sh.end + g[1] + g[12] * 32768;
        const ls = sh.ls + g[2] + g[45] * 32768;
        const le = sh.le + g[3] + g[50] * 32768;
        if (end <= start || end > pool.length) continue;
        zones.push({
          kl, kh, vl, vh, g, mods: [...mm.values()],
          start, end, ls, le, sr: sh.sr || 44100,
          root: g[58] >= 0 ? g[58] : (sh.pitch > 127 ? 60 : sh.pitch),
          corr: -sh.corr, type: sh.type, inst: iIdx,
        });
      }
    }
    presets.push({ name: ph.name, bank: ph.bank, program: ph.program, zones });
  }
  return { name, pool, presets };
}

// Convert parsed presets to the worklet's lookup table.
export function toWorkletBank(sf) {
  const P = {};
  for (const p of sf.presets) {
    const key = (p.bank >= 128 ? 128 : p.bank) * 128 + p.program;
    if (!P[key] || p.bank < 128 || key >= 128 * 128) P[key] = p.zones;
  }
  return { name: sf.name, pool: sf.pool, presets: P };
}
