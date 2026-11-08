// Shared UI for the Console and Old School apps. Each machine is played through its OWN voices and
// instruments; General MIDI files are mapped onto it by the Arranger (Auto = the machine's GM mapping).
import { parseSMF } from './smf.js';
import { demoSong } from './demo.js';
import { GM_NAMES, GM_DRUMS, noteName } from './gm.js';
import { MACHINES, GROUPS } from './machines/registry.js';
import kit from './editor-kit.js';

const $ = (id) => document.getElementById(id);
const GROUP = document.body.dataset.group;
const IDS = GROUPS[GROUP];
const APP_NAME = document.body.dataset.title || 'RetroSynths';
const PREP = new Set(['snes']);                 // machines with a <id>.prep.js main-thread step
const SF2_URL = '../../soundfonts/GeneralUser-GS.sf2';
const KB_CH = 15;                               // keyboard / MIDI-in plays on MIDI channel 16 with the selected instrument
const params = new URLSearchParams(location.search);
const embed = params.has('embed');
if (embed) document.body.classList.add('embed');
const clone = (o) => JSON.parse(JSON.stringify(o));

let ctx = null, node = null;
const app = {
  id: params.get('machine') || localStorage.getItem('retrosynths.' + GROUP + '.machine') || IDS[0],
  midiMute: new Uint8Array(16), voiceMute: 0, voiceSolo: -1, octave: 4,
  programs: new Array(16).fill(0), drums: new Array(16).fill(false),
};
if (!IDS.includes(app.id)) app.id = IDS[0];
const M = () => MACHINES[app.id];
const presetsOf = (id) => MACHINES[id].presets || [];
const voicesOf = (id) => MACHINES[id].voices || [];

// ------------------------------------------------------------ plates (evocative colours, no logos)
const PLATES = {
  nes: { bg: 'linear-gradient(#d8d6d0, #bdbab3)', fg: '#222', stripe: '#b21f24', chip: 'RP2A03' },
  snes: { bg: 'linear-gradient(#dcdcde, #c4c3c9)', fg: '#2c2650', stripe: 'linear-gradient(90deg,#6e5aa8,#9a8bd0)', chip: 'S-DSP' },
  genesis: { bg: 'linear-gradient(#1d1d1f, #0c0c0d)', fg: '#eee', stripe: 'linear-gradient(90deg,#c71f2d,#e2b23a)', chip: 'YM2612' },
  tg16: { bg: 'linear-gradient(#202022, #111)', fg: '#f2f2f2', stripe: 'linear-gradient(90deg,#e08b1e,#e8d23c)', chip: 'HuC6280' },
  gb: { bg: 'linear-gradient(#d5d2c8, #bfbbae)', fg: '#2b2a5c', stripe: 'linear-gradient(90deg,#8bac0f,#306230)', chip: 'DMG APU' },
  apple2: { bg: 'linear-gradient(#e7dcc2, #cfc2a3)', fg: '#3a3324', stripe: 'linear-gradient(90deg,#5fb84a,#f6c33c,#f08a24,#e2463b,#963d97,#2f9ad7)', chip: '2×AY-3-8910' },
  c64: { bg: 'linear-gradient(#cbbfa8, #b1a58c)', fg: '#3b2f22', stripe: 'linear-gradient(90deg,#d62e2e,#f08a24,#f2d23a,#3a9c4f,#2f6fd0)', chip: 'SID' },
  atari2600: { bg: 'repeating-linear-gradient(90deg,#6b3e1e 0 6px,#5a3318 6px 9px)', fg: '#f2e6cf', stripe: '#111', chip: 'TIA' },
  atari800: { bg: 'linear-gradient(#e6dccb, #d0c4ad)', fg: '#3b3226', stripe: '#6b4a2b', chip: 'POKEY' },
  zx: { bg: 'linear-gradient(#202020, #0e0e0e)', fg: '#eee', stripe: 'linear-gradient(90deg,#e2463b,#f6c33c,#3aa84f,#2f9ad7)', chip: 'AY-3-8912' },
  msx: { bg: 'linear-gradient(#3a3a3e, #26262a)', fg: '#eee', stripe: '#c43a3a', chip: 'YM2149' },
  pcspeaker: { bg: 'linear-gradient(#e2dccd, #ccc4b0)', fg: '#2f2c26', stripe: '#3c3c3c', chip: '8253 PIT' },
};

// ------------------------------------------------------------ boot / audio
$('bootText').textContent = 'C:\\> CD \\RETRO\nC:\\RETRO> ' + APP_NAME.toUpperCase().replace(/\s+/g, '') + '.EXE\n';
$('bootHint').textContent = embed ? `▶ Click to power on ${APP_NAME}` : 'Click or press any key to power on';
const powerOn = async () => {
  window.removeEventListener('keydown', powerOn); $('boot').removeEventListener('pointerdown', powerOn);
  $('boot').classList.add('gone');
  await initAudio();
};
window.addEventListener('keydown', powerOn);
$('boot').addEventListener('pointerdown', powerOn);

async function initAudio() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('../../common/host-worklet.js');
  node = new AudioWorkletNode(ctx, 'retrosynths', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(ctx.destination);
  node.port.onmessage = (e) => onMsg(e.data);
  if (ctx.state !== 'running') await ctx.resume();
  post({ t: 'master', v: +$('vol').value });
  await selectMachine(app.id);
  if (!player.song) player.load(demoSong());
}
const post = (m, tr) => node && node.port.postMessage(m, tr || []);
const sendNow = (st, d1, d2 = 0) => post({ t: 'now', ev: [[st, d1, d2]] });
const setStatus = (s) => { $('status').textContent = s; };

// ------------------------------------------------------------ per-machine state: instrument table, kit, arrangement
const S = { table: [], kit: {}, arr: [], sel: 0, songKey: 'demo' };
const nPresets = () => presetsOf(app.id).length;
function loadState() {
  const P = presetsOf(app.id);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('retrosynths.inst.' + app.id) || '{}'); } catch { saved = {}; }
  S.table = P.map(p => (saved.edits && saved.edits[p.name]) ? { ...clone(saved.edits[p.name]), name: p.name } : clone(p));
  for (const u of saved.user || []) S.table.push({ ...u, user: true });
  S.kit = saved.kit || {};
  S.sel = Math.min(saved.sel || 0, Math.max(0, S.table.length - 1));
  loadArrangement();
}
let saveT = 0;
function saveState() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const P = presetsOf(app.id), edits = {};
    P.forEach((p, i) => { if (S.table[i] && JSON.stringify(S.table[i]) !== JSON.stringify(p)) edits[p.name] = S.table[i]; });
    const data = { edits, user: S.table.slice(P.length), kit: S.kit, sel: S.sel };
    try { localStorage.setItem('retrosynths.inst.' + app.id, JSON.stringify(data)); } catch (err) { setStatus('Could not save instruments: ' + err.message); }
  }, 300);
}
const arrKey = () => `retrosynths.arr.${app.id}.${S.songKey}`;
function loadArrangement() {
  let a = null;
  try { a = JSON.parse(localStorage.getItem(arrKey()) || 'null'); } catch { a = null; }
  S.arr = Array.from({ length: 16 }, (_, c) => (a && a[c]) ? a[c] : { inst: -1, voice: 'auto' });
  S.arr = S.arr.map(x => ({ inst: x.inst < S.table.length ? x.inst : -1, voice: x.voice || 'auto' }));
}
function saveArrangement() { try { localStorage.setItem(arrKey(), JSON.stringify(S.arr.map((x, c) => c === KB_CH ? { inst: -1, voice: 'auto' } : x))); } catch {} }
function arrForChip() { const a = S.arr.map(x => ({ ...x })); a[KB_CH] = { inst: S.sel, voice: 'auto' }; return a; }
function pushAll() {
  post({ t: 'instruments', id: app.id, list: S.table });
  post({ t: 'kit', id: app.id, kit: S.kit });
  post({ t: 'arrangement', id: app.id, arr: arrForChip() });
  post({ t: 'voicemute', id: app.id, mask: effectiveVoiceMute() });
}
let reprepT = 0;
function reprep() { if (!PREP.has(app.id) || !node) return; clearTimeout(reprepT); reprepT = setTimeout(() => runPrep(app.id), 400); }
const pushArr = () => { saveArrangement(); post({ t: 'arrangement', id: app.id, arr: arrForChip() }); reprep(); };
function autoPreset(c) {
  const Mc = M();
  if (app.drums[c]) return -1;
  try { return Mc.gmPreset ? Mc.gmPreset(app.programs[c]) : -1; } catch { return -1; }
}
const instName = (i) => (i >= 0 && S.table[i]) ? S.table[i].name : '—';

// ------------------------------------------------------------ machine selection + prep
let sf2Cache = null;
const fetchSF2 = async () => {
  if (!sf2Cache) { setStatus('Downloading GeneralUser GS…'); sf2Cache = await (await fetch(SF2_URL)).arrayBuffer(); }
  return sf2Cache.slice(0);
};
const prepDone = new Map();
let prepBusy = Promise.resolve();
function songInfo(song) {
  if (!song) return null;
  const programs = new Set(), prog = new Array(16).fill(0); let drums = false;
  for (const e of song.events) {
    const ty = e[1] & 0xF0, c = e[1] & 15;
    if (ty === 0xC0) prog[c] = e[2];
    if (ty === 0x90 && e[3] > 0) { if (c === 9) drums = true; else programs.add(prog[c]); }
  }
  return { programs: [...programs].sort((a, b) => a - b), drums };
}
// instrument-table indices the chip needs right now: Arranger picks, kit, keyboard, and Auto (GM) mappings for the song
function usedInstruments(id) {
  const Mc = MACHINES[id], used = new Set([S.sel]);
  S.arr.forEach(a => { if (a.inst >= 0) used.add(a.inst); });
  Object.values(S.kit).forEach(i => used.add(i));
  const info = songInfo(player.song);
  if (info) {
    for (const p of info.programs) { try { const i = Mc.gmPreset(p); if (i >= 0) used.add(i); } catch {} }
    if (info.drums) for (let n = 27; n <= 87; n++) { try { const i = Mc.gmDrum(n); if (i >= 0) used.add(i); } catch {} }
  }
  return [...used].filter(i => i >= 0 && i < S.table.length).sort((a, b) => a - b);
}
async function runPrep(id) {
  if (!PREP.has(id)) return;
  const song = player.song, used = usedInstruments(id);
  const key = (song ? song.title + ':' + song.events.length : 'live') + '|' + used.join(',') + '|' + JSON.stringify(used.map(i => S.table[i]));
  if (prepDone.get(id) === key) return;
  prepBusy = prepBusy.then(async () => {
    try {
      const mod = await import(`./machines/${id}.prep.js`);
      setStatus(`Loading ${MACHINES[id].info.name} sample RAM…`);
      const data = await mod.prepare({ fetchSF2, song: songInfo(song), instruments: S.table, used });
      post({ t: 'data', id, data }, mod.transfer ? mod.transfer(data) : []);
      prepDone.set(id, key);
      setStatus(`${MACHINES[id].info.name} ready.`);
    } catch (err) { setStatus(`${MACHINES[id].info.name}: ${err.message}`); }
  });
  return prepBusy;
}
async function selectMachine(id) {
  app.id = id;
  localStorage.setItem('retrosynths.' + GROUP + '.machine', id);
  app.voiceMute = 0; app.voiceSolo = -1;
  loadState();
  renderMachine(); buildVoices(); renderArranger(); renderInstList(); selectInst(S.sel, true);
  if (!node) return;
  const wasPlaying = player.playing;
  if (PREP.has(id)) { if (wasPlaying) player.pause(); await runPrep(id); }
  pushAll();
  post({ t: 'machine', id });
  for (const o of optionsOf(id)) post({ t: 'option', id, key: o.key, value: loadOpt(id, o) });
  if (PREP.has(id) && wasPlaying) player.play();
  setStatus(`${MACHINES[id].info.name} ready.`);
}
const optionsOf = (id) => MACHINES[id].options || [];
const optKey = (id, o) => `retrosynths.opt.${id}.${o.key}`;
function loadOpt(id, o) {
  const raw = localStorage.getItem(optKey(id, o));
  if (raw == null) return o.default;
  const hit = o.choices.find(([v]) => JSON.stringify(v) === raw);
  return hit ? hit[0] : o.default;
}
function renderMachine() {
  const info = M().info, pl = PLATES[app.id] || PLATES.nes, plate = $('plate');
  plate.style.background = pl.bg; plate.style.color = pl.fg;
  plate.innerHTML = `<div class="p-maker"></div><div class="p-name"></div><div class="p-chip"></div><div class="p-stripe"></div><div class="p-year"></div>`;
  plate.querySelector('.p-maker').textContent = info.maker.toUpperCase();
  plate.querySelector('.p-name').textContent = info.name;
  plate.querySelector('.p-chip').textContent = pl.chip;
  plate.querySelector('.p-stripe').style.background = pl.stripe;
  plate.querySelector('.p-year').textContent = info.year;
  $('mName').textContent = info.name.toLowerCase().includes(info.maker.split(/[ /]/)[0].toLowerCase()) ? info.name : `${info.maker} ${info.name}`;
  $('mChip').textContent = `${info.chip} · ${info.year}`;
  $('mSpec').textContent = info.spec || info.voices;
  const box = $('mopts'); box.innerHTML = '';
  for (const o of optionsOf(app.id)) {
    const lab = document.createElement('label'), sel = document.createElement('select');
    o.choices.forEach(([, t], i) => sel.add(new Option(t, i)));
    const cur = loadOpt(app.id, o);
    sel.selectedIndex = Math.max(0, o.choices.findIndex(([v]) => JSON.stringify(v) === JSON.stringify(cur)));
    sel.onchange = () => { const v = o.choices[sel.selectedIndex][0]; localStorage.setItem(optKey(app.id, o), JSON.stringify(v)); post({ t: 'option', id: app.id, key: o.key, value: v }); };
    lab.append(o.label + ' ', sel); box.appendChild(lab);
  }
  document.querySelectorAll('.mpick button').forEach(b => b.classList.toggle('on', b.dataset.id === app.id));
}
(function buildPicker() {
  const box = $('mpick');
  for (const id of IDS) {
    const info = MACHINES[id].info, b = document.createElement('button');
    b.dataset.id = id;
    b.innerHTML = `<span></span><br><small>${info.year}</small>`;
    b.querySelector('span').textContent = info.name.replace(' / Mega Drive', '').replace(' + Mockingboard', '');
    b.onclick = () => selectMachine(id);
    box.appendChild(b);
  }
})();

// ------------------------------------------------------------ Voices panel (chip channels)
let vRows = [];
function effectiveVoiceMute() {
  const n = voicesOf(app.id).length;
  if (app.voiceSolo >= 0) return ((1 << n) - 1) & ~(1 << app.voiceSolo);
  return app.voiceMute;
}
function buildVoices() {
  const box = $('voiceRows'); box.innerHTML = ''; vRows = [];
  const V = voicesOf(app.id);
  if (!V.length) { box.innerHTML = '<div class="ed-note">This machine does not list its voices yet.</div>'; return; }
  V.forEach((v, i) => {
    const r = document.createElement('div'); r.className = 'vrow';
    r.innerHTML = `<span class="vname"></span><span class="vwhat"></span><span class="mt"><i></i></span>`;
    r.querySelector('.vname').textContent = v.name; r.title = `${v.name} (${v.kind})`;
    let t = 0;
    r.onclick = () => { clearTimeout(t); t = setTimeout(() => { app.voiceMute ^= (1 << i); applyVoiceMute(); }, 220); };
    r.ondblclick = () => { clearTimeout(t); app.voiceSolo = app.voiceSolo === i ? -1 : i; applyVoiceMute(); };
    box.appendChild(r);
    vRows.push({ el: r, what: r.querySelector('.vwhat'), bar: r.querySelector('i'), lvl: 0 });
  });
}
function applyVoiceMute() {
  const m = effectiveVoiceMute();
  vRows.forEach((r, i) => { r.el.classList.toggle('muted', !!(m & (1 << i))); r.el.classList.toggle('solo', app.voiceSolo === i); });
  post({ t: 'voicemute', id: app.id, mask: m });
}

// ------------------------------------------------------------ Arranger (MIDI channel → native instrument / voice)
let aRows = [];
function songChannels() {
  const used = new Map();
  if (player.song) {
    const prog = new Array(16).fill(0);
    for (const e of player.song.events) {
      const ty = e[1] & 0xF0, c = e[1] & 15;
      if (ty === 0xC0) prog[c] = e[2];
      if (ty === 0x90 && e[3] > 0 && !used.has(c)) used.set(c, prog[c]);
    }
  }
  return [...used.entries()].sort((a, b) => a[0] - b[0]);
}
function instOptions(sel, { auto, kindFilter } = {}) {
  sel.innerHTML = '';
  if (auto) sel.add(new Option(auto, -1));
  const groups = new Map();
  S.table.forEach((p, i) => {
    if (kindFilter && !kindFilter(p)) return;
    const g = p.user ? 'My instruments' : (p.category || 'Other');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([i, p.name]);
  });
  for (const [g, items] of groups) {
    const og = document.createElement('optgroup'); og.label = g;
    for (const [i, n] of items) og.appendChild(new Option(n, i));
    sel.appendChild(og);
  }
}
function voiceOptions(sel, kind, cur) {
  sel.innerHTML = ''; sel.add(new Option('Auto', 'auto'));
  for (const v of voicesOf(app.id)) if (!kind || kind === 'any' || v.kind === kind) sel.add(new Option(v.name, v.id));
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'auto';
}
function renderArranger() {
  const box = $('arrRows'); box.innerHTML = ''; aRows = [];
  const head = document.createElement('div'); head.className = 'arow head';
  head.innerHTML = '<span>Ch</span><span>MIDI part</span><span>Instrument</span><span>Voice</span><span></span>';
  box.appendChild(head);
  const chans = songChannels();
  $('arrNote').textContent = chans.length ? '' : 'Load a MIDI file or the demo to arrange it.';
  for (const [c] of chans) {
    if (c === KB_CH) continue;
    const prog = app.programs[c];
    const isDrum = c === 9 || app.drums[c];
    const r = document.createElement('div'); r.className = 'arow';
    r.innerHTML = `<span class="num" title="Click to mute">${c + 1}</span><span class="gm"></span><select class="ai"></select><select class="av"></select><span class="mt"><i></i></span>`;
    r.querySelector('.gm').textContent = isDrum ? 'Drums' : GM_NAMES[prog];
    const si = r.querySelector('.ai'), sv = r.querySelector('.av');
    const autoIdx = isDrum ? -1 : (M().gmPreset ? safeGM(prog) : -1);
    instOptions(si, { auto: isDrum ? 'Auto · drum kit' : `Auto · ${instName(autoIdx)}` });
    si.value = S.arr[c].inst;
    const kindNow = () => { const i = S.arr[c].inst >= 0 ? S.arr[c].inst : autoIdx; return i >= 0 && S.table[i] ? S.table[i].kind : null; };
    voiceOptions(sv, isDrum && S.arr[c].inst < 0 ? null : kindNow(), S.arr[c].voice);
    si.onchange = () => { S.arr[c].inst = +si.value; voiceOptions(sv, kindNow(), S.arr[c].voice); S.arr[c].voice = sv.value; pushArr(); if (S.arr[c].inst >= 0) selectInst(S.arr[c].inst); };
    sv.onchange = () => { S.arr[c].voice = sv.value; pushArr(); };
    r.querySelector('.num').onclick = () => { app.midiMute[c] ^= 1; r.classList.toggle('muted', !!app.midiMute[c]); post({ t: 'mute', v: app.midiMute }); };
    r.classList.toggle('muted', !!app.midiMute[c]);
    box.appendChild(r);
    aRows.push({ c, bar: r.querySelector('i'), lvl: 0 });
  }
}
function safeGM(p) { try { return M().gmPreset(p); } catch { return -1; } }
$('arrReset').onclick = () => { S.arr = S.arr.map(() => ({ inst: -1, voice: 'auto' })); pushArr(); renderArranger(); };

// ------------------------------------------------------------ Instruments panel
let editorHandle = null, editorToken = 0;
function renderInstList() {
  instOptions($('instList'));
  $('instList').value = S.sel;
}
async function selectInst(i, quiet) {
  if (!S.table.length) { $('instName').textContent = '(no native instruments yet)'; $('instEditor').innerHTML = ''; return; }
  S.sel = Math.max(0, Math.min(S.table.length - 1, i));
  $('instList').value = S.sel;
  const inst = S.table[S.sel];
  $('instName').textContent = inst.name;
  $('instKind').textContent = inst.kind || '';
  $('kbInst').textContent = inst.name;
  const users = S.arr.map((a, c) => a.inst === S.sel ? c + 1 : 0).filter(Boolean);
  $('instUse').textContent = users.length ? `used by MIDI ch ${users.join(', ')}` : '';
  $('instReset').disabled = !!inst.user || S.sel >= nPresets();
  $('instDelete').disabled = !inst.user;
  $('kitPanel').hidden = true; $('instEditor').hidden = false;
  if (!quiet) saveState();
  post({ t: 'arrangement', id: app.id, arr: arrForChip() });
  if (!quiet) reprep();
  await mountEditor();
}
async function mountEditor() {
  const tok = ++editorToken, el = $('instEditor');
  if (editorHandle && editorHandle.destroy) try { editorHandle.destroy(); } catch {}
  editorHandle = null; el.innerHTML = '';
  const idx = S.sel, inst = clone(S.table[idx]);
  const onChange = (v) => {
    const copy = clone(v); copy.name = S.table[idx].name; if (S.table[idx].user) copy.user = true;
    S.table[idx] = copy;
    post({ t: 'inst', id: app.id, index: idx, inst: copy });
    saveState(); reprep();
  };
  let mod = null;
  try { mod = await import(`./machines/${app.id}-editor.js`); } catch { mod = null; }
  if (tok !== editorToken) return;
  if (mod && mod.mountEditor) {
    try { editorHandle = mod.mountEditor(el, inst, kit, onChange, { Machine: M(), presets: presetsOf(app.id), voices: voicesOf(app.id) }); }
    catch (err) { el.textContent = 'Editor error: ' + err.message; console.error(err); }
  } else genericEditor(el, inst, onChange);
}
function genericEditor(el, inst, onChange) {
  const g = kit.group(el, 'Parameters');
  for (const [k, v] of Object.entries(inst)) {
    if (['name', 'category', 'kind', 'user'].includes(k)) continue;
    if (typeof v === 'number') kit.number(g, { label: k, min: -100000, max: 100000, value: v, onChange: (x) => { inst[k] = x; onChange(inst); } });
    else if (typeof v === 'boolean') kit.toggle(g, { label: k, value: v, onChange: (x) => { inst[k] = x; onChange(inst); } });
    else kit.note(g, `${k}: ${JSON.stringify(v).slice(0, 120)}`);
  }
}
$('instList').onchange = () => selectInst(+$('instList').value);
$('instCopy').onclick = () => {
  const src = S.table[S.sel]; if (!src) return;
  const copy = clone(src); copy.name = uniqueName(src.name.replace(/ \(copy.*\)$/, '') + ' (copy)'); copy.user = true;
  S.table.push(copy); pushAll(); renderInstList(); selectInst(S.table.length - 1); renderArranger();
};
$('instRename').onclick = () => {
  const cur = S.table[S.sel]; if (!cur) return;
  if (!cur.user) { setStatus('Factory presets keep their names — Copy it to make your own.'); return; }
  const n = prompt('Instrument name', cur.name); if (!n) return;
  cur.name = uniqueName(n.trim().slice(0, 40), S.sel); pushAll(); saveState(); renderInstList(); selectInst(S.sel); renderArranger();
};
$('instReset').onclick = () => {
  if (S.sel >= nPresets()) return;
  S.table[S.sel] = clone(presetsOf(app.id)[S.sel]); post({ t: 'inst', id: app.id, index: S.sel, inst: S.table[S.sel] }); saveState(); selectInst(S.sel);
};
$('instDelete').onclick = () => {
  const cur = S.table[S.sel]; if (!cur || !cur.user) return;
  if (!confirm(`Delete "${cur.name}"?`)) return;
  const i = S.sel;
  S.table.splice(i, 1);
  S.arr.forEach(a => { if (a.inst === i) a.inst = -1; else if (a.inst > i) a.inst--; });
  for (const k of Object.keys(S.kit)) { if (S.kit[k] === i) delete S.kit[k]; else if (S.kit[k] > i) S.kit[k]--; }
  pushAll(); saveState(); saveArrangement(); renderInstList(); selectInst(Math.min(i, S.table.length - 1)); renderArranger();
};
function uniqueName(n, except = -1) {
  let name = n, k = 2;
  while (S.table.some((p, i) => i !== except && p.name === name)) name = `${n} ${k++}`;
  return name;
}
$('instExport').onclick = () => {
  const P = presetsOf(app.id);
  const data = { machine: app.id, version: 1, edits: Object.fromEntries(P.map((p, i) => [p.name, S.table[i]]).filter(([n, x], i) => JSON.stringify(x) !== JSON.stringify(P[i]))), user: S.table.slice(P.length), kit: S.kit };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = `${app.id}-instruments.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('instImport').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.machine !== app.id) { setStatus(`That file is for "${d.machine}", not ${M().info.name}.`); return; }
    localStorage.setItem('retrosynths.inst.' + app.id, JSON.stringify({ edits: d.edits || {}, user: d.user || [], kit: d.kit || {}, sel: 0 }));
    loadState(); pushAll(); renderInstList(); selectInst(0); renderArranger(); setStatus('Instruments imported.');
  } catch (err) { setStatus('Import failed: ' + err.message); }
};
// drum kit mapping
$('kitBtn').onclick = () => {
  const p = $('kitPanel');
  if (!p.hidden) { p.hidden = true; $('instEditor').hidden = false; return; }
  $('instEditor').hidden = true; p.hidden = false; p.innerHTML = '';
  $('instName').textContent = 'Drum kit'; $('instKind').textContent = 'GM drums → native instruments'; $('instUse').textContent = '';
  const g = kit.group(p, 'Drum kit (MIDI channel 10)');
  kit.note(g, 'Each GM drum note plays a native instrument. "Auto" uses the machine\'s own drum mapping.');
  const box = document.createElement('div'); box.className = 'kitbox'; g.appendChild(box);
  for (let n = 35; n <= 81; n++) {
    const lab = document.createElement('label');
    const sp = document.createElement('span'); sp.textContent = `${n} ${GM_DRUMS[n]}`; sp.title = noteName(n);
    const sel = document.createElement('select');
    let def = -1; try { def = M().gmDrum ? M().gmDrum(n) : -1; } catch {}
    instOptions(sel, { auto: `Auto · ${def >= 0 ? instName(def) : 'silent'}` });
    sel.value = S.kit[n] != null ? S.kit[n] : -1;
    sel.onchange = () => { if (+sel.value < 0) delete S.kit[n]; else S.kit[n] = +sel.value; post({ t: 'kit', id: app.id, kit: S.kit }); saveState(); reprep(); };
    const play = document.createElement('button'); play.className = 'ed-btn'; play.textContent = '▶'; play.type = 'button';
    play.onclick = () => { sendNow(0x99, n, 110); setTimeout(() => sendNow(0x89, n, 0), 200); };
    lab.append(sp, sel); box.appendChild(lab);
    lab.prepend(play); lab.style.gridTemplateColumns = '26px 96px 1fr';
  }
};

// ------------------------------------------------------------ player
class Player {
  constructor() { this.song = null; this.playing = false; this.pos = 0; this.idx = 0; this.timer = 0; }
  load(song) {
    this.stop(); this.song = song;
    $('songTitle').textContent = song.title || 'Untitled';
    S.songKey = (song.title || 'untitled').slice(0, 80);
    firstPrograms(song);
    loadArrangement(); renderArranger();
    if (node) post({ t: 'arrangement', id: app.id, arr: arrForChip() });
    this.updateTime();
    if (node && PREP.has(app.id)) runPrep(app.id);
  }
  async play() {
    if (!this.song || !ctx) return;
    if (ctx.state !== 'running') ctx.resume();
    if (PREP.has(app.id)) await runPrep(app.id);
    if (this.pos >= this.song.duration) this.pos = 0;
    this.chase(this.pos);
    this.t0 = ctx.currentTime + 0.06 - this.pos;
    const ev = this.song.events;
    this.idx = 0; while (this.idx < ev.length && ev[this.idx][0] < this.pos) this.idx++;
    this.playing = true; $('btnPlay').innerHTML = '&#10074;&#10074;';
    this.pump(); this.timer = setInterval(() => this.pump(), 25);
  }
  pump() {
    const ev = this.song.events, sr = ctx.sampleRate, horizon = ctx.currentTime + 0.18, batch = [];
    while (this.idx < ev.length && this.t0 + ev[this.idx][0] <= horizon) {
      const e = ev[this.idx++]; batch.push([Math.round((this.t0 + e[0]) * sr), e[1], e[2], e[3]]);
    }
    if (batch.length) post({ t: 'ev', ev: batch });
    this.pos = ctx.currentTime - this.t0;
    if (this.idx >= ev.length && this.pos >= this.song.duration) { this.halt(); this.pos = 0; if ($('chkLoop').checked) this.play(); }
  }
  halt() {
    clearInterval(this.timer); this.timer = 0;
    if (this.playing) { post({ t: 'clearq' }); for (let c = 0; c < 16; c++) { sendNow(0xB0 | c, 123, 0); sendNow(0xB0 | c, 64, 0); } }
    this.playing = false; $('btnPlay').innerHTML = '&#9654;';
  }
  pause() { if (!this.playing) return; this.pos = ctx.currentTime - this.t0; this.halt(); }
  stop() { this.halt(); this.pos = 0; this.updateTime(); }
  seek(f) { if (!this.song) return; const was = this.playing; this.halt(); this.pos = f * this.song.duration; if (was) this.play(); else this.updateTime(); }
  chase(pos) {
    post({ t: 'now', ev: [[0xFF, 0, 0]] });
    const out = [];
    for (const e of this.song.events) {
      if (e[0] >= pos) break;
      const ty = e[1] & 0xF0;
      if (ty === 0xB0 || ty === 0xC0 || ty === 0xE0 || e[1] >= 0xFE) { if (ty === 0xB0 && (e[2] === 64 || e[2] >= 120)) continue; out.push([e[1], e[2], e[3]]); }
    }
    if (out.length) post({ t: 'now', ev: out });
  }
  updateTime() {
    const d = this.song ? this.song.duration : 0;
    const p = Math.max(0, Math.min(d, this.playing && ctx ? ctx.currentTime - this.t0 : this.pos));
    const f = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
    $('songTime').textContent = `${f(p)} / ${f(d)}`;
    if (!seeking) $('seek').value = d ? Math.round(p / d * 1000) : 0;
  }
}
function firstPrograms(song) {
  // the programme each channel starts with, for Auto labels in the Arranger
  const seen = new Set();
  app.programs.fill(0); app.drums = app.drums.map((_, c) => c === 9);
  for (const e of song.events) {
    const ty = e[1] & 0xF0, c = e[1] & 15;
    if (ty === 0xC0 && !seen.has(c)) { app.programs[c] = e[2]; seen.add(c); }
    if (e[1] === 0xFE) app.drums[e[2] & 15] = !!e[3];
  }
}
const player = new Player();
let seeking = false;
$('btnPlay').onclick = () => player.playing ? player.pause() : player.play();
$('btnStop').onclick = () => player.stop();
$('btnDemo').onclick = $('menuDemo').onclick = async () => { if (!ctx) await powerOn(); player.load(demoSong()); player.play(); };
$('seek').oninput = () => { seeking = true; };
$('seek').onchange = (e) => { seeking = false; player.seek(+e.target.value / 1000); };
$('menuPanic').onclick = () => { player.halt(); post({ t: 'reset' }); };
$('menuAbout').onclick = () => { $('about').hidden = false; };
$('aboutOK').onclick = () => { $('about').hidden = true; };
$('fileMidi').onchange = async (e) => { const f = e.target.files[0]; if (f) await openMidi(f); e.target.value = ''; };
async function openMidi(file) {
  try {
    if (!ctx) await powerOn();
    const song = parseSMF(await file.arrayBuffer());
    song.title = song.title ? `${file.name} — ${song.title}` : file.name;
    player.load(song); player.play();
  } catch (err) { setStatus('MIDI error: ' + err.message); }
}
$('vol').oninput = (e) => post({ t: 'master', v: +e.target.value });
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', async (e) => { e.preventDefault(); document.body.classList.remove('dragging'); const f = e.dataTransfer.files[0]; if (f) await openMidi(f); });

// ------------------------------------------------------------ stats / scope
const scope = $('scope'), sctx = scope.getContext('2d');
let lastScope = null;
function onMsg(d) {
  if (d.t === 'error') { setStatus('⚠ ' + d.message); console.error(d.message); return; }
  if (d.t !== 'stat') return;
  lastScope = d.scope;
  for (const r of aRows) { const lv = Math.min(1, Math.sqrt(d.meter[r.c]) * 1.1); r.lvl = Math.max(lv, r.lvl * 0.82); }
  if (d.vs && d.machine === app.id) {
    vRows.forEach((r, i) => {
      const lv = d.vs[i * 4] || 0, ch = d.vs[i * 4 + 1], nt = d.vs[i * 4 + 2], ins = d.vs[i * 4 + 3];
      r.lvl = Math.max(Math.min(1, Math.sqrt(lv) * 1.1), r.lvl * 0.8);
      const txt = ch >= 0 ? `ch ${ch + 1} · ${noteName(nt)} · ${instName(ins)}` : '';
      if (r.what.textContent !== txt) r.what.textContent = txt;
    });
  }
  const info = d.machine && MACHINES[d.machine] ? MACHINES[d.machine].info : null;
  $('voices').textContent = info ? `${info.name} ${String(d.voices).padStart(2)}${d.max ? '/' + d.max : ''}${d.peak >= 0.999 ? ' · CLIP' : ''}` : '';
}
function frame() {
  for (const r of vRows) r.bar.style.width = (r.lvl * 100).toFixed(1) + '%';
  for (const r of aRows) r.bar.style.width = (r.lvl * 100).toFixed(1) + '%';
  const w = scope.width, hh = scope.height;
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, w, hh);
  sctx.strokeStyle = '#0a3a0a'; sctx.beginPath(); sctx.moveTo(0, hh / 2); sctx.lineTo(w, hh / 2); sctx.stroke();
  if (lastScope) {
    let s0 = 0;
    for (let i = 1; i < 256; i++) if (lastScope[i - 1] < 0 && lastScope[i] >= 0) { s0 = i; break; }
    sctx.strokeStyle = '#4cff6a'; sctx.lineWidth = 1.5; sctx.beginPath();
    for (let x = 0; x < 256; x++) { const y = hh / 2 - (lastScope[s0 + x] || 0) * hh * 0.9; x ? sctx.lineTo(x * 2, y) : sctx.moveTo(0, y); }
    sctx.stroke();
  }
  if (player.song) player.updateTime();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------ keyboard + Web MIDI (play the selected instrument on ch 16)
const held = new Map(), pianoKeys = new Map();
function liveOn(note, vel = 100) { if (!ctx || held.has(note)) return; held.set(note, 1); sendNow(0x90 | KB_CH, note, vel); keyEl(note, true); }
function liveOff(note) { if (!held.has(note)) return; sendNow(0x80 | KB_CH, note, 0); held.delete(note); keyEl(note, false); }
function keyEl(n, down) { const el = pianoKeys.get(n); if (el) el.classList.toggle('down', down); }
(function buildPiano() {
  const WIDE = window.innerWidth > 760, LO = WIDE ? 36 : 48, HI = WIDE ? 95 : 83;
  const p = $('piano'), whites = [], BL = [1, 3, 6, 8, 10];
  for (let n = LO; n <= HI; n++) if (!BL.includes(n % 12)) whites.push(n);
  whites.forEach(n => { const d = document.createElement('div'); d.className = 'w'; d.dataset.n = n; p.appendChild(d); pianoKeys.set(n, d); });
  const ww = 100 / whites.length;
  for (let n = LO; n <= HI; n++) if (BL.includes(n % 12)) {
    const wi = whites.indexOf(n - 1), d = document.createElement('div');
    d.className = 'b'; d.dataset.n = n; d.style.left = `calc(${(wi + 1) * ww}% - ${ww * 0.3}%)`; d.style.width = `${ww * 0.6}%`;
    p.appendChild(d); pianoKeys.set(n, d);
  }
  const ptr = new Map();
  const noteAt = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el.dataset && el.dataset.n ? +el.dataset.n : null; };
  p.addEventListener('pointerdown', (e) => { const n = noteAt(e); if (n == null) return; p.setPointerCapture(e.pointerId); ptr.set(e.pointerId, n); liveOn(n, 70 + Math.round(Math.random() * 30)); });
  p.addEventListener('pointermove', (e) => { if (!ptr.has(e.pointerId)) return; const n = noteAt(e), o = ptr.get(e.pointerId); if (n != null && n !== o) { liveOff(o); liveOn(n, 90); ptr.set(e.pointerId, n); } });
  const up = (e) => { if (!ptr.has(e.pointerId)) return; liveOff(ptr.get(e.pointerId)); ptr.delete(e.pointerId); };
  p.addEventListener('pointerup', up); p.addEventListener('pointercancel', up);
})();
const QW = 'awsedftgyhujkolp;';
window.addEventListener('keydown', (e) => {
  if (!ctx || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target; if (t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') || t.isContentEditable) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { app.octave = Math.max(1, app.octave - 1); $('octLabel').textContent = 'Oct ' + app.octave; return; }
  if (k === 'x') { app.octave = Math.min(7, app.octave + 1); $('octLabel').textContent = 'Oct ' + app.octave; return; }
  if (k === ' ') { e.preventDefault(); $('btnPlay').click(); return; }
  const i = QW.indexOf(k); if (i >= 0) liveOn(12 * (app.octave + 1) + i, 100);
});
window.addEventListener('keyup', (e) => { const i = QW.indexOf(e.key.toLowerCase()); if (i < 0) return; for (let o = 1; o <= 7; o++) liveOff(12 * (o + 1) + i); });
let midiAccess = null;
$('midiIn').addEventListener('pointerdown', async () => {
  if (midiAccess || !navigator.requestMIDIAccess) { if (!navigator.requestMIDIAccess) setStatus('Web MIDI is not available in this browser.'); return; }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    const refresh = () => { const sel = $('midiIn'), cur = sel.value; sel.innerHTML = '<option value="">(none)</option>'; for (const inp of midiAccess.inputs.values()) sel.add(new Option(inp.name, inp.id)); sel.value = cur; };
    refresh(); midiAccess.onstatechange = refresh;
  } catch { setStatus('MIDI access was refused.'); }
});
$('midiIn').onchange = (e) => {
  if (!midiAccess) return;
  for (const inp of midiAccess.inputs.values()) inp.onmidimessage = null;
  const inp = midiAccess.inputs.get(e.target.value);
  if (inp) inp.onmidimessage = (m) => {
    const [st, d1 = 0, d2 = 0] = m.data; if (st >= 0xF0) return;
    post({ t: 'now', ev: [[(st & 0xF0) | KB_CH, d1, d2]] });       // your controller plays the selected instrument
    if ((st & 0xF0) === 0x90 && d2) keyEl(d1, true); else if ((st & 0xF0) === 0x80 || (st & 0xF0) === 0x90) keyEl(d1, false);
  };
};

// initial paint (before power-on)
loadState(); renderMachine(); buildVoices(); renderArranger(); renderInstList(); selectInst(S.sel, true);
