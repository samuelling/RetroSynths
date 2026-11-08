// Parses a SoundFont and burns it into an era "ROM" shape (emu-rombudget.js) off the main thread.
// In: { id, buf, budget: 'awe' | 'live' | 'raw' }  Out: { id, ok, bank: { name, pool, presets }, list, instNames }
import { burnBank } from './emu-bank.js';
self.onmessage = (e) => {
  const { id, buf, budget } = e.data;
  try {
    const r = burnBank(buf, budget, (p) => self.postMessage({ id, progress: p }));
    self.postMessage({ id, ok: true, ...r }, [r.bank.pool.buffer]);
  } catch (err) { self.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
};
