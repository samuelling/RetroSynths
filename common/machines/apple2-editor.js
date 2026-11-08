// Apple IIe + Mockingboard instrument editor: AY-3-8910 instruments use the AY editor, speaker instruments
// the 1-bit speaker editor.
import { mountAYEditor } from './ay-editor.js';
import { mountSpeakerEditor } from './pcspeaker-editor.js';

export function mountEditor(el, inst, kit, onChange, ctx) {
  return inst.kind === 'speaker' ? mountSpeakerEditor(el, inst, kit, onChange, ctx) : mountAYEditor(el, inst, kit, onChange, ctx);
}
