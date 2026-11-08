// Parses SoundFonts and burns era "ROMs" off the main thread.
import { parseSF2, toWorkletBank } from './sf2.js';
import { romBudget, BUDGETS } from './rombudget.js';

self.onmessage = (e) => {
  const { id, buf, budgets } = e.data;
  try {
    const sf = toWorkletBank(parseSF2(buf));
    const out = {};
    const transfer = [];
    for (const b of budgets) {
      if (b === 'raw') { out.raw = sf; transfer.push(sf.pool.buffer); continue; }
      const bank = romBudget(sf, BUDGETS[b], (p) => self.postMessage({ id, progress: p, stage: b }));
      out[b] = bank; transfer.push(bank.pool.buffer);
    }
    self.postMessage({ id, ok: true, banks: out, name: sf.name }, [...new Set(transfer)]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
