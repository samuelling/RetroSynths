// Static side shared by the AWE32 and Live! machines: the instrument list follows the loaded SoundFont.
// On the main thread snes-style prep (emu-prep.js) calls setBank(list, key) after burning a bank; until then
// the bundled GeneralUser GS preset list is used. gmPreset/gmDrum/gmKit apply the GM fallback chain.
import { EmuMachine } from './emu-sampler.js';
import { GU_NAME, GU_PRESETS } from './emu-gu-presets.js';
import { presetsFromList, resolveMelodic, resolveKit, bankKey } from './emu-presets.js';

export function emuClass(kind, defBudget) {
  return class extends EmuMachine {
    static _list = GU_PRESETS;
    static _presets = presetsFromList(GU_PRESETS);
    static bankKey = bankKey(GU_NAME, GU_PRESETS.length, defBudget);
    static defBudget = defBudget;
    static get presets() { return this._presets; }
    static setBank(list, key) { this._list = list; this._presets = presetsFromList(list); this.bankKey = key; }
    static gmPreset(program) { return resolveMelodic(this._list, 0, program); }
    static gmDrum(note) { return note >= 27 && note <= 87 ? resolveKit(this._list, 0) : -1; }
    static gmKit(program) { return resolveKit(this._list, program); }
    constructor(host) { super(host, kind); this.table = this.constructor.presets.slice(); this.list = this.constructor._list; this.indexTable(); }
  };
}
