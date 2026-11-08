// Live! prep: SoundFont → early-Live!-style bank (32 kHz, shorter attacks and loops).
import { makePrep } from './emu-prep.js';
const p = makePrep('live', 'live', async () => (await import('./live.js')).default);
export const prepare = p.prepare;
export const transfer = p.transfer;
