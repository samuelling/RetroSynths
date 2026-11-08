// Main-thread prep for the AWE32 / Live! machines: load a SoundFont (GeneralUser GS by default, or a bank the
// app set with setSource), burn it into the era's ROM shape in a Worker (emu-rom-worker.js) and hand the bank
// to the worklet. The same source is burned once; later calls (instrument edits etc.) return a tiny "same" stub
// when the caller says the worklet already has it. The editor reads zones/instrument names via getMeta().
import { burnBank } from './emu-bank.js';
import { bankKey } from './emu-presets.js';

const SOURCES = {}, CACHE = {}, META = {};
export const emuEvents = typeof EventTarget !== 'undefined' ? new EventTarget() : null;
const emit = (detail) => { if (emuEvents) try { emuEvents.dispatchEvent(new CustomEvent('progress', { detail })); } catch {} };
/** src = { name, blob | buffer, budget: 'awe' | 'live' | 'raw', etag? } or null for the built-in GeneralUser GS */
export function setSource(id, src) { SOURCES[id] = src || null; }
export function getSource(id) { return SOURCES[id] || null; }
export function getMeta(id) { return META[id] || null; }

let worker = null, jobN = 0;
const jobs = new Map();
function burn(buf, budget, onp) {
  if (typeof Worker === 'undefined') return Promise.resolve(burnBank(buf, budget, onp));
  if (!worker) {
    worker = new Worker(new URL('./emu-rom-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const d = e.data, j = jobs.get(d.id); if (!j) return; if (d.progress !== undefined) { j.onp && j.onp(d.progress); return; } jobs.delete(d.id); d.ok ? j.res(d) : j.rej(new Error(d.error)); };
  }
  return new Promise((res, rej) => { const id = ++jobN; jobs.set(id, { res, rej, onp }); worker.postMessage({ id, buf, budget }, [buf]); });
}

export function makePrep(id, defBudget, getMachine) {
  async function prepare({ fetchSF2, delivered } = {}) {
    const src = SOURCES[id];
    const budget = src && src.budget ? src.budget : defBudget;
    const srcKey = (src ? `${src.name}:${src.etag || ''}:${src.blob ? src.blob.size : src.buffer ? src.buffer.byteLength : ''}` : 'builtin') + '|' + budget;
    const c = CACHE[id];
    if (c && c.srcKey === srcKey) {
      if (delivered) return { key: c.key, same: true };
      return { ...c.data, bank: { ...c.data.bank, pool: c.data.bank.pool.slice() } };
    }
    emit({ id, stage: 'load', progress: 0, name: src ? src.name : 'GeneralUser GS' });
    const buf = src ? (src.buffer ? src.buffer.slice(0) : await src.blob.arrayBuffer()) : await fetchSF2();
    emit({ id, stage: 'burn', progress: 0 });
    const r = await burn(buf, budget, (p) => emit({ id, stage: 'burn', progress: p }));
    const key = bankKey(r.sfName || (src && src.name) || 'SoundFont', r.list.length, budget);
    const M = getMachine && await getMachine();
    if (M && M.setBank) M.setBank(r.list, key);
    let bytes = r.bank.pool.length * 2;
    META[id] = { key, name: src ? src.name : r.sfName, sfName: r.sfName, budget, list: r.list, presets: r.bank.presets, instNames: r.instNames, bytes, builtin: !src };
    const data = { key, bank: r.bank, list: r.list, sfName: r.sfName, bytes };
    CACHE[id] = { srcKey, key, data: { ...data, bank: { ...r.bank, pool: r.bank.pool.slice() } } };
    emit({ id, stage: 'done', progress: 1, key, bytes, name: META[id].name, budget });
    return data;
  }
  const transfer = (d) => (d && d.bank && d.bank.pool ? [d.bank.pool.buffer] : []);
  return { prepare, transfer };
}
