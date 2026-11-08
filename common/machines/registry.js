// All machine modules. The host worklet and the app UIs import this list.
import nes from './nes.js';
import gb from './gb.js';
import genesis from './genesis.js';
import tg16 from './tg16.js';
import snes from './snes.js';
import apple2 from './apple2.js';
import c64 from './c64.js';
import atari2600 from './atari2600.js';
import atari800 from './atari800.js';
import zx from './zx.js';
import msx from './msx.js';
import pcspeaker from './pcspeaker.js';
import opl2 from './opl2.js';
import opl3 from './opl3.js';
import awe32 from './awe32.js';
import live from './live.js';

export const MACHINES = { nes, gb, genesis, tg16, snes, apple2, c64, atari2600, atari800, zx, msx, pcspeaker, opl2, opl3, awe32, live };
export const GROUPS = {
  console: ['nes', 'snes', 'genesis', 'tg16', 'gb'],
  oldschool: ['apple2', 'c64', 'atari2600', 'atari800', 'zx', 'msx', 'pcspeaker'],
  blasta: ['opl2', 'opl3', 'awe32', 'live'],
};
