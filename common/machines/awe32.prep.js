// AWE32 prep: SoundFont → AWE-style ROM (22 kHz mono, one velocity layer, sparse multisamples, tiny loops).
import { makePrep } from './emu-prep.js';
const p = makePrep('awe32', 'awe', async () => (await import('./awe32.js')).default);
export const prepare = p.prepare;
export const transfer = p.transfer;
