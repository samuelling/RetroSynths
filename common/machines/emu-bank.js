// SoundFont → playable bank for the AWE32 / Live! machines: parse (common/sf2.js), optional ROM-budget squeeze
// (emu-rombudget.js), plus the preset list (bank, program, name) and instrument names for the editor.
import { parseSF2, toWorkletBank } from '../sf2.js';
import { romBudget, BUDGETS } from './emu-rombudget.js';

function instNames(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), out = [];
  const id = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  let found = null;
  const walk = (s, e) => { let o = s; while (o + 8 <= e && !found) { const c = id(o), l = dv.getUint32(o + 4, true); if (c === 'LIST') walk(o + 12, o + 8 + l); else if (c === 'inst') found = { o: o + 8, l }; o += 8 + l + (l & 1); } };
  walk(12, Math.min(u8.length, 8 + dv.getUint32(4, true)));
  if (!found) return out;
  for (let o = found.o; o + 22 <= found.o + found.l; o += 22) { let s = ''; for (let k = 0; k < 20; k++) { const c = u8[o + k]; if (!c) break; s += String.fromCharCode(c); } out.push(s.trim()); }
  return out;
}
export function burnBank(buf, budget, progress) {
  const names = instNames(buf);
  const sf = parseSF2(buf);
  const seen = new Map();
  for (const p of sf.presets) { const bank = p.bank >= 128 ? 128 : p.bank; const k = bank * 128 + p.program; if (!seen.has(k) || p.bank < 128 || k >= 128 * 128) seen.set(k, [bank, p.program, p.name]); }
  const list = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const raw = toWorkletBank(sf);
  const bank = budget === 'raw' || !BUDGETS[budget] ? raw : romBudget(raw, BUDGETS[budget], progress);
  return { bank: { name: bank.name, pool: bank.pool, presets: bank.presets }, list, instNames: names, sfName: sf.name };
}
