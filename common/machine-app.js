// Shared UI for the Console and Old School apps. Each machine is played through its OWN voices and
// instruments; General MIDI files are mapped onto it by the Arranger (Auto = the machine's GM mapping).
import { parseSMF } from './smf.js';
import { demoSong } from './demo.js';
import { GM_NAMES, GM_DRUMS, noteName } from './gm.js';
import { MACHINES, GROUPS } from './machines/registry.js';
import kit from './editor-kit.js';
import { openHelp, wireDialogs } from './help.js';

const $ = (id) => document.getElementById(id);
const GROUP = document.body.dataset.group;
const IDS = GROUPS[GROUP];
const APP_NAME = document.body.dataset.title || 'RetroSynths';
const PREP = new Set(['snes', 'awe32', 'live']); // machines with a <id>.prep.js main-thread step
const SF2_URL = '../../soundfonts/GeneralUser-GS.sf2';
const KB_CH = 15;                               // keyboard / MIDI-in plays on MIDI channel 16 with the selected instrument
const params = new URLSearchParams(location.search);
const embed = params.has('embed');
if (embed) document.body.classList.add('embed');
const clone = (o) => JSON.parse(JSON.stringify(o));
const EXT_URL = document.body.dataset.ext || '';
let EXT = null;                                 // app extension module (Blasta: era slider, banks, locker)

let ctx = null, node = null;
const app = {
  id: params.get('machine') || localStorage.getItem('retrosynths.' + GROUP + '.machine') || IDS[0],
  midiMute: new Uint8Array(16), voiceMute: 0, vmuteSet: new Set(), voiceSolo: -1, octave: 4,
  programs: new Array(16).fill(0), drums: new Array(16).fill(false),
};
const startId = app.id;                          // may name a non-MIDI extra (Old School: modem)
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
// No power-on gate: the boot screen is a brief flourish (none inside the desktop), the audio engine
// loads straight away, and the first click or key anywhere wakes the sound (browsers require one).
const dismissBoot = () => $('boot').classList.add('gone');
if (embed) dismissBoot();
else { $('boot').addEventListener('pointerdown', dismissBoot); setTimeout(dismissBoot, +(document.body.dataset.bootMs || 900)); }
const wake = () => {
  if (!ctx) { initAudio(); return; }
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
};
for (const t of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(t, wake, { capture: true });
window.retroSynthsWake = wake;                  // the desktop forwards its own clicks here
const powerOn = () => initAudio();

let audioReady = null;
function initAudio() { return audioReady || (audioReady = startAudio()); }
async function startAudio() {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  ctx.onstatechange = () => document.body.classList.toggle('asleep', ctx.state !== 'running');
  document.body.classList.toggle('asleep', ctx.state !== 'running');
  await ctx.audioWorklet.addModule('../../common/host-worklet.js');
  node = new AudioWorkletNode(ctx, 'retrosynths', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(ctx.destination);
  node.port.onmessage = (e) => onMsg(e.data);
  if (ctx.state !== 'running') ctx.resume().catch(() => {});   // runs now if allowed, else on the first click/key
  post({ t: 'master', v: +$('vol').value });
  if (EXT && EXT.beforeAudio) await EXT.beforeAudio();
  await selectMachine(app.id);
  if (EXT && EXT.afterAudio) await EXT.afterAudio();
  if (!player.song) player.load(demoSong());
}
const post = (m, tr) => node && node.port.postMessage(m, tr || []);
const sendNow = (st, d1, d2 = 0) => post({ t: 'now', ev: [[st, d1, d2]] });
const setStatus = (s) => { $('status').textContent = s; };

// ------------------------------------------------------------ per-machine state: instrument table, kit, arrangement
const S = { table: [], kit: {}, arr: [], sel: 0, songKey: 'demo' };
const nPresets = () => presetsOf(app.id).length;
const instKey = (id) => 'retrosynths.inst.' + id + (MACHINES[id].bankKey ? '|' + MACHINES[id].bankKey : '');
/** saved instrument table / kit for any machine (edits keyed by preset name, plus user instruments) */
function savedTable(id) {
  const P = presetsOf(id);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(instKey(id)) || '{}'); } catch { saved = {}; }
  const table = P.map(p => (saved.edits && saved.edits[p.name]) ? { ...clone(saved.edits[p.name]), name: p.name } : clone(p));
  for (const u of saved.user || []) table.push({ ...u, user: true });
  return { table, kit: saved.kit || {}, sel: saved.sel || 0, saved };
}
function writeTable(id, table, kit, sel) {
  const P = presetsOf(id), edits = {};
  P.forEach((p, i) => { if (table[i] && JSON.stringify(table[i]) !== JSON.stringify(p)) edits[p.name] = table[i]; });
  try { localStorage.setItem(instKey(id), JSON.stringify({ edits, user: table.slice(P.length), kit, sel })); } catch (err) { setStatus('Could not save instruments: ' + err.message); }
}
function loadState() {
  const P = presetsOf(app.id);
  S.bankKey = MACHINES[app.id].bankKey || '';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(instKey(app.id)) || '{}'); } catch { saved = {}; }
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
    try { localStorage.setItem(instKey(app.id), JSON.stringify(data)); } catch (err) { setStatus('Could not save instruments: ' + err.message); }
  }, 300);
}
const arrKey = (id = app.id) => `retrosynths.arr.${id}${MACHINES[id].bankKey ? '|' + MACHINES[id].bankKey : ''}.${S.songKey}`;
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
const delivered = new Set();                    // machines whose prep result already reached this worklet
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
async function runPrep(id, force = false) {
  if (!PREP.has(id)) return;
  if (force) prepDone.delete(id);
  const song = player.song, used = id === app.id ? usedInstruments(id) : [];
  const key = (song ? song.title + ':' + song.events.length : 'live') + '|' + used.join(',') + '|' + (id === app.id ? JSON.stringify(used.map(i => S.table[i])) : '');
  if (prepDone.get(id) === key) return;
  prepBusy = prepBusy.then(async () => {
    try {
      const mod = await import(`./machines/${id}.prep.js`);
      if (id === app.id) setStatus(`Loading ${MACHINES[id].info.name} sample RAM…`);
      const data = await mod.prepare({ fetchSF2, song: songInfo(song), instruments: id === app.id ? S.table : savedTable(id).table, used, delivered: delivered.has(id) });
      post({ t: 'data', id, data }, mod.transfer ? mod.transfer(data) : []);
      delivered.add(id);
      prepDone.set(id, key);
      // a machine whose instrument list follows its bank (AWE32 / Live!): the bank changed → reload its table
      if (MACHINES[id].bankKey != null) {
        if (id === app.id && S.bankKey !== MACHINES[id].bankKey) { loadState(); renderInstList(); renderArranger(); selectInst(S.sel, true); pushAll(); }
        else if (id !== app.id) primeMachine(id);
      }
      if (id === app.id) setStatus(`${MACHINES[id].info.name} ready.`);
    } catch (err) { setStatus(`${MACHINES[id].info.name}: ${err.message}`); }
  });
  return prepBusy;
}
/** push another machine's saved instruments / kit / arrangement to the worklet (Blasta blends two machines) */
function primeMachine(id) {
  if (!node || id === app.id) return;
  const st = savedTable(id);
  let a = null;
  try { a = JSON.parse(localStorage.getItem(arrKey(id)) || 'null'); } catch { a = null; }
  const arr = Array.from({ length: 16 }, (_, c) => (a && a[c] && c !== KB_CH) ? { inst: a[c].inst < st.table.length ? a[c].inst : -1, voice: a[c].voice || 'auto' } : { inst: -1, voice: 'auto' });
  arr[KB_CH] = { inst: Math.min(st.sel, st.table.length - 1), voice: 'auto' };
  post({ t: 'instruments', id, list: st.table });
  post({ t: 'kit', id, kit: st.kit });
  post({ t: 'arrangement', id, arr });
  post({ t: 'voicemute', id, mask: 0 });
  for (const o of optionsOf(id)) post({ t: 'option', id, key: o.key, value: loadOpt(id, o) });
}
async function selectMachine(id, { seamless = false } = {}) {
  app.id = id;
  localStorage.setItem('retrosynths.' + GROUP + '.machine', id);
  app.voiceMute = 0; app.vmuteSet.clear(); app.voiceSolo = -1;
  loadState();
  renderMachine(); buildVoices(); renderArranger(); renderInstList(); selectInst(S.sel, true);
  if (!node) return;
  const wasPlaying = player.playing && !seamless;
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
  if (EXT && EXT.renderMachine) EXT.renderMachine(app.id);
}
// ------------------------------------------------------------ extras: instruments that aren't MIDI machines (Old School: Modem)
const EXTRAS = ({
  oldschool: [{
    id: 'modem', name: 'Modem', maker: 'Dial-up', year: '1962–1999', chip: 'Phone line + two modems · Bell 103 → V.90',
    spec: 'Type AT commands and dial out: dial tone, touch-tone or pulse clicks, ringing, then both modems\' handshake — every tone generated from the protocol specs.',
    module: '../apps/oldschool/modem/modem.js', css: '../apps/oldschool/modem/modem.css',
    help: ['modem', 'The Modem', `
      <p>The Modem isn't played with the piano. It's a dial-up modem and phone line: type commands, dial a number and listen to two modems negotiate. Every tone is generated from the actual protocol specs.</p>
      <ol>
        <li><b>Pick a modem</b> from the row of models, from a 1978 acoustic coupler to a 1998 56K. Its setup string is typed for you.</li>
        <li><b>Dial</b> someone in the <b>Dialing Directory</b> with <b>Dial</b>, or type <code>ATDT555-0142</code> and press Enter. That's the MEGAzine BBS.</li>
        <li>Listen: dial tone, touch-tones, ringing, then the answer tone and the handshake. The <b>Line Monitor</b> shows it as a spectrogram, with a timeline of what each side is sending.</li>
        <li><b>Hang up</b> (or type <code>ATH</code>) to stop.</li>
      </ol>
      <ul>
        <li><b>Answers with</b> chooses what's on the other end of each number: another modem, a busy signal, a fax machine, a person, or nobody.</li>
        <li><b>Ring me</b> makes that number call <i>you</i>; type <code>ATA</code> to answer, and you hear it from the answering end.</li>
        <li>Classic commands work: <code>ATDP</code> pulse dialing, <code>ATM2</code> keeps the speaker on after connecting, <code>ATL3</code> louder, <code>ATX0</code>, <code>AT&amp;V</code>, <code>ATI</code>, <code>+++</code> and many more. Unknown ones answer ERROR, like the real thing.</li>
        <li><b>Line quality</b> adds noise, which can push the modems down to slower speeds.</li>
        <li>Up/Down in the command box recalls earlier commands.</li>
      </ul>
      <p class="fine">Brand names here are invented; the protocols (Bell 103, V.21, V.22bis, V.32bis, V.34, V.90…) are the real standards.</p>`],
    plate: { bg: 'linear-gradient(#e4ded0, #c9c1ae)', fg: '#2a2a2a', stripe: 'repeating-linear-gradient(90deg, #e2463b 0 10px, #222 10px 14px, #3aa84f 14px 24px, #222 24px 28px, #f2c63a 28px 38px, #222 38px 42px)', chip: 'AT · V.34' },
  }],
})[GROUP] || [];
(function buildPicker() {
  const box = $('mpick');
  for (const id of IDS) {
    const info = MACHINES[id].info, b = document.createElement('button');
    b.dataset.id = id;
    b.innerHTML = `<span></span><br><small>${info.year}</small>`;
    b.querySelector('span').textContent = info.name.replace(' / Mega Drive', '').replace(' + Mockingboard', '');
    b.onclick = () => { if (extra) leaveExtra(); selectMachine(id); };
    box.appendChild(b);
  }
  for (const x of EXTRAS) {
    const b = document.createElement('button');
    b.dataset.id = x.id; b.className = 'extra-pick';
    b.innerHTML = `<span></span><br><small></small>`;
    b.querySelector('span').textContent = x.name; b.querySelector('small').textContent = x.year;
    b.onclick = () => enterExtra(x);
    box.appendChild(b);
  }
})();

// ------------------------------------------------------------ extras: instruments that aren't MIDI machines (Old School: Modem)
let extra = null;                                // { x, handle }
async function enterExtra(x) {
  if (extra && extra.x === x) return;
  if (extra) leaveExtra();
  player.stop(); post({ t: 'reset' });
  for (const n of [...held.keys()]) liveOff(n);
  extra = { x, handle: null };
  document.body.classList.add('extra-mode');
  try { localStorage.setItem('retrosynths.' + GROUP + '.machine', x.id); } catch {}
  document.querySelectorAll('.mpick button').forEach(b => b.classList.toggle('on', b.dataset.id === x.id));
  const pl = x.plate, plate = $('plate');
  plate.style.background = pl.bg; plate.style.color = pl.fg;
  plate.innerHTML = `<div class="p-maker"></div><div class="p-name"></div><div class="p-chip"></div><div class="p-stripe"></div><div class="p-year"></div>`;
  plate.querySelector('.p-maker').textContent = x.maker.toUpperCase();
  plate.querySelector('.p-name').textContent = x.name;
  plate.querySelector('.p-chip').textContent = pl.chip;
  plate.querySelector('.p-stripe').style.background = pl.stripe;
  plate.querySelector('.p-year').textContent = x.year;
  $('mName').textContent = x.name; $('mChip').textContent = x.chip; $('mSpec').textContent = x.spec; $('mopts').innerHTML = '';
  if (x.css && !document.querySelector(`link[data-extra="${x.id}"]`)) {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = new URL(x.css, import.meta.url).href; l.dataset.extra = x.id; document.head.appendChild(l);
  }
  const fs = document.createElement('section'); fs.className = 'extrabox'; fs.id = 'extraPanel'; fs.setAttribute('aria-label', x.name);
  fs.innerHTML = '<div id="extraMount"></div>';
  document.querySelector('fieldset.machine').after(fs);
  try {
    if (!ctx) await initAudio();
    const mod = await import(new URL(x.module, import.meta.url).href);
    if (!extra || extra.x !== x) return;
    extra.handle = await mod.mountModem($('extraMount'), { ctx, destination: ctx.destination, setStatus });
    setStatus(`${x.name} ready. Type a command, or pick a number from the phonebook.`);
  } catch (err) { console.error(err); setStatus(`${x.name}: ${err.message}`); }
}
function leaveExtra() {
  if (!extra) return;
  try { extra.handle && extra.handle.unmount(); } catch (err) { console.error(err); }
  extra = null;
  const fs = $('extraPanel'); if (fs) fs.remove();
  document.body.classList.remove('extra-mode');
}

// ------------------------------------------------------------ Voices panel (chip channels)
let vRows = [];
function effectiveVoiceMute() {
  const n = voicesOf(app.id).length;
  if (n > 31) {            // wide chips (AWE32 30+, Live! 64): send the muted voice indices
    const out = [];
    for (let i = 0; i < n; i++) if (app.voiceSolo >= 0 ? i !== app.voiceSolo : app.vmuteSet.has(i)) out.push(i);
    return out;
  }
  if (app.voiceSolo >= 0) return ((1 << n) - 1) & ~(1 << app.voiceSolo);
  return app.voiceMute;
}
const isVMuted = (m, i) => (Array.isArray(m) ? m.includes(i) : !!(m & (1 << i)));
function buildVoices() {
  const box = $('voiceRows'); box.innerHTML = ''; vRows = [];
  const V = voicesOf(app.id);
  box.classList.toggle('compact', V.length > 18);
  if (!V.length) { box.innerHTML = '<div class="ed-note">This machine does not list its voices yet.</div>'; return; }
  V.forEach((v, i) => {
    const r = document.createElement('button'); r.type = 'button'; r.className = 'vrow'; r.setAttribute('aria-pressed', 'false');
    r.innerHTML = `<span class="vname"></span><span class="vwhat"></span><span class="mt"><i></i></span>`;
    r.querySelector('.vname').textContent = v.name; r.title = `${v.name} (${v.kind}) — click to mute, double-click (or Shift+Enter) to solo`;
    r.querySelector('.vwhat').setAttribute('aria-hidden', 'true'); r.querySelector('.mt').setAttribute('aria-hidden', 'true');
    let t = 0;
    r.onclick = () => { clearTimeout(t); t = setTimeout(() => { if (V.length > 31) { if (app.vmuteSet.has(i)) app.vmuteSet.delete(i); else app.vmuteSet.add(i); } else app.voiceMute ^= (1 << i); applyVoiceMute(); }, 220); };
    r.ondblclick = () => { clearTimeout(t); app.voiceSolo = app.voiceSolo === i ? -1 : i; applyVoiceMute(); };
    r.onkeydown = (e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); r.ondblclick(); } };
    box.appendChild(r);
    vRows.push({ el: r, what: r.querySelector('.vwhat'), bar: r.querySelector('i'), lvl: 0 });
  });
}
function applyVoiceMute() {
  const m = effectiveVoiceMute();
  vRows.forEach((r, i) => {
    const mu = isVMuted(m, i), so = app.voiceSolo === i;
    r.el.classList.toggle('muted', mu); r.el.classList.toggle('solo', so);
    r.el.setAttribute('aria-pressed', String(mu));
    r.el.setAttribute('aria-label', `${r.el.querySelector('.vname').textContent}${so ? ', soloed' : ''}${mu ? ', muted' : ''}`);
  });
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
    r.innerHTML = `<button type="button" class="num" title="Mute / unmute this MIDI channel" aria-pressed="false">${c + 1}</button><span class="gm"></span><select class="ai"></select><select class="av"></select><span class="mt" aria-hidden="true"><i></i></span>`;
    r.querySelector('.gm').textContent = isDrum ? 'Drums' : GM_NAMES[prog];
    const si = r.querySelector('.ai'), sv = r.querySelector('.av');
    const partName = isDrum ? 'Drums' : GM_NAMES[prog];
    si.setAttribute('aria-label', `Channel ${c + 1} (${partName}) instrument`); sv.setAttribute('aria-label', `Channel ${c + 1} (${partName}) voice`);
    r.querySelector('.num').setAttribute('aria-label', `Mute MIDI channel ${c + 1} (${partName})`);
    const autoIdx = isDrum ? -1 : (M().gmPreset ? safeGM(prog) : -1);
    const kitIdx = isDrum && M().gmKit ? (() => { try { return M().gmKit(prog); } catch { return -1; } })() : -1;
    instOptions(si, { auto: isDrum ? (kitIdx >= 0 ? `Auto · ${instName(kitIdx)}` : 'Auto · drum kit') : `Auto · ${instName(autoIdx)}` });
    si.value = S.arr[c].inst;
    const kindNow = () => { const i = S.arr[c].inst >= 0 ? S.arr[c].inst : autoIdx; return i >= 0 && S.table[i] ? S.table[i].kind : null; };
    voiceOptions(sv, isDrum && S.arr[c].inst < 0 ? null : kindNow(), S.arr[c].voice);
    si.onchange = () => { S.arr[c].inst = +si.value; voiceOptions(sv, kindNow(), S.arr[c].voice); S.arr[c].voice = sv.value; pushArr(); if (S.arr[c].inst >= 0) selectInst(S.arr[c].inst); };
    sv.onchange = () => { S.arr[c].voice = sv.value; pushArr(); };
    r.querySelector('.num').onclick = () => { app.midiMute[c] ^= 1; r.classList.toggle('muted', !!app.midiMute[c]); r.querySelector('.num').setAttribute('aria-pressed', String(!!app.midiMute[c])); post({ t: 'mute', v: app.midiMute }); };
    r.classList.toggle('muted', !!app.midiMute[c]); r.querySelector('.num').setAttribute('aria-pressed', String(!!app.midiMute[c]));
    box.appendChild(r);
    aRows.push({ c, bar: r.querySelector('i'), lvl: 0 });
  }
}
function safeGM(p) { try { return M().gmPreset(p); } catch { return -1; } }
$('arrReset').onclick = () => { S.arr = S.arr.map(() => ({ inst: -1, voice: 'auto' })); pushArr(); renderArranger(); };

// ------------------------------------------------------------ Instruments panel
let editorHandle = null, editorToken = 0;
function renderInstList() {
  instOptions($('instList')); instOptions($('kbInst'));
  $('instList').value = S.sel; $('kbInst').value = S.sel;
}
async function selectInst(i, quiet) {
  if (!S.table.length) { $('instName').textContent = '(no native instruments yet)'; $('instEditor').innerHTML = ''; return; }
  S.sel = Math.max(0, Math.min(S.table.length - 1, i));
  $('instList').value = S.sel;
  const inst = S.table[S.sel];
  $('instName').textContent = inst.name;
  $('instKind').textContent = inst.kind || '';
  if ($('kbInst').options.length !== $('instList').options.length) instOptions($('kbInst'));
  $('kbInst').value = S.sel;
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
    const ectx = { Machine: M(), presets: presetsOf(app.id), voices: voicesOf(app.id), index: idx, applyTable, setStatus };
    if (EXT && EXT.editorCtx) Object.assign(ectx, EXT.editorCtx(app.id) || {});
    try { editorHandle = mod.mountEditor(el, inst, kit, onChange, ectx); }
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
/** replace several table entries at once ({ index: instrument }) — e.g. an .op2 bank over the GM-slot presets */
function applyTable(entries, id = app.id) {
  if (id !== app.id) {
    const st = savedTable(id);
    for (const [i, inst] of Object.entries(entries)) if (+i < st.table.length) st.table[+i] = { ...clone(inst), name: st.table[+i].name };
    writeTable(id, st.table, st.kit, st.sel);
    return;
  }
  for (const [i, inst] of Object.entries(entries)) if (+i < S.table.length) S.table[+i] = { ...clone(inst), name: S.table[+i].name, ...(S.table[+i].user ? { user: true } : {}) };
  post({ t: 'instruments', id: app.id, list: S.table }); saveState(); reprep(); selectInst(S.sel, true);
}
/** forget all edits of a machine's presets (keeps user instruments) */
function resetTable(id = app.id) {
  const st = savedTable(id), P = presetsOf(id);
  writeTable(id, P.map(p => clone(p)).concat(st.table.slice(P.length)), st.kit, st.sel);
  if (id === app.id) { loadState(); post({ t: 'instruments', id, list: S.table }); renderInstList(); selectInst(S.sel, true); }
}
$('instList').onchange = () => selectInst(+$('instList').value);
$('kbInst').onchange = () => { selectInst(+$('kbInst').value); $('kbInst').blur(); };   // blur so typed letters play notes again
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
    this.playing = true; $('btnPlay').innerHTML = '&#10074;&#10074;'; $('btnPlay').setAttribute('aria-label', 'Pause');
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
    this.playing = false; $('btnPlay').innerHTML = '&#9654;'; $('btnPlay').setAttribute('aria-label', 'Play');
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
$('menuHelp').onclick = () => openHelp(helpCtx());
$('aboutOK').onclick = () => { $('about').hidden = true; };
wireDialogs();
// buttons that open a hidden file input (keyboard-reachable, unlike a bare <label for>)
document.querySelectorAll('[data-file]').forEach(b => b.addEventListener('click', () => $(b.dataset.file).click()));
const helpCtx = () => ({ GROUP, APP_NAME, IDS, MACHINES, current: app.id, extra: [...EXTRAS.map(x => x.help).filter(Boolean), ...(EXT && EXT.helpTopics ? EXT.helpTopics() : [])] });
window.addEventListener('keydown', (e) => { if (e.key === 'F1') { e.preventDefault(); openHelp(helpCtx()); } });
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
document.addEventListener('drop', async (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  for (const f of e.dataTransfer.files) { if (EXT && EXT.onDrop && await EXT.onDrop(f)) continue; await openMidi(f); }
});

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
const QW = 'awsedftgyhujkolp;';                 // a=C … k=C' … ;=E' (white row + black keys above)
function liveOn(note, vel = 100) { if (!ctx || held.has(note)) return; held.set(note, 1); sendNow(0x90 | KB_CH, note, vel); keyEl(note, true); }
function liveOff(note) { if (!held.has(note)) return; sendNow(0x80 | KB_CH, note, 0); held.delete(note); keyEl(note, false); }
function keyEl(n, down) { const el = pianoKeys.get(n); if (el) el.classList.toggle('down', down); }
/** letters of the computer keyboard printed on the keys they play, for the current octave */
function labelKeys() {
  const base = 12 * (app.octave + 1);
  for (const [n, el] of pianoKeys) {
    const i = n - base, lb = el.firstChild;
    const on = i >= 0 && i < QW.length;
    el.classList.toggle('qw', on);
    lb.textContent = on ? (QW[i] === ';' ? ';' : QW[i].toUpperCase()) : (n % 12 === 0 && !el.classList.contains('b') ? 'C' + (n / 12 - 1) : '');
    lb.classList.toggle('oct', !on);
  }
  $('octLabel').textContent = 'Oct ' + app.octave;
}
function setOctave(o) {
  for (const n of [...held.keys()]) liveOff(n);
  app.octave = Math.max(1, Math.min(7, o)); labelKeys();
}
(function buildPiano() {
  const WIDE = window.innerWidth > 760, LO = WIDE ? 36 : 48, HI = WIDE ? 95 : 83;
  const p = $('piano'), whites = [], BL = [1, 3, 6, 8, 10];
  const mk = (cls, n) => { const d = document.createElement('div'); d.className = cls; d.dataset.n = n; const l = document.createElement('span'); l.className = 'lbl'; d.appendChild(l); p.appendChild(d); pianoKeys.set(n, d); return d; };
  for (let n = LO; n <= HI; n++) if (!BL.includes(n % 12)) whites.push(n);
  whites.forEach(n => mk('w', n));
  const ww = 100 / whites.length;
  for (let n = LO; n <= HI; n++) if (BL.includes(n % 12)) {
    const wi = whites.indexOf(n - 1), d = mk('b', n);
    d.style.left = `calc(${(wi + 1) * ww}% - ${ww * 0.3}%)`; d.style.width = `${ww * 0.6}%`;
  }
  const ptr = new Map();
  const noteAt = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); const k = el && el.closest && el.closest('#piano [data-n]'); return k ? +k.dataset.n : null; };
  p.addEventListener('pointerdown', (e) => { const n = noteAt(e); if (n == null) return; p.setPointerCapture(e.pointerId); ptr.set(e.pointerId, n); liveOn(n, 70 + Math.round(Math.random() * 30)); });
  p.addEventListener('pointermove', (e) => { if (!ptr.has(e.pointerId)) return; const n = noteAt(e), o = ptr.get(e.pointerId); if (n != null && n !== o) { liveOff(o); liveOn(n, 90); ptr.set(e.pointerId, n); } });
  const up = (e) => { if (!ptr.has(e.pointerId)) return; liveOff(ptr.get(e.pointerId)); ptr.delete(e.pointerId); };
  p.addEventListener('pointerup', up); p.addEventListener('pointercancel', up);
  labelKeys();
})();
$('octDown').onclick = () => setOctave(app.octave - 1);
$('octUp').onclick = () => setOctave(app.octave + 1);
(function dockToggle() {
  const b = $('dockToggle');
  const set = (hide) => { $('piano').hidden = hide; b.textContent = hide ? 'Show keys' : 'Hide keys'; b.setAttribute('aria-expanded', String(!hide)); try { localStorage.setItem('retrosynths.dock.hidden', hide ? '1' : ''); } catch {} };
  b.onclick = () => set(!$('piano').hidden);
  let hidden = false; try { hidden = localStorage.getItem('retrosynths.dock.hidden') === '1'; } catch {}
  set(hidden);
})();
// typing plays notes everywhere except where letters mean something (text boxes, lists, dropdowns)
const typingTarget = (t) => t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable ||
  (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type)));
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if ([...document.querySelectorAll('.dialog')].some(d => !d.hidden)) return;      // dialogs own the keyboard
  if (extra) return;                                                                 // the modem has its own keyboard
  const t = e.target; if (typingTarget(t)) return;
  const k = e.key.toLowerCase();
  if (k === 'z') { setOctave(app.octave - 1); return; }
  if (k === 'x') { setOctave(app.octave + 1); return; }
  if (k === ' ') {
    if (t.closest && t.closest('button, a, summary, [role=button]')) return;       // Space presses the focused button
    e.preventDefault(); $('btnPlay').click(); return;
  }
  const i = QW.indexOf(k); if (i >= 0) { if (!ctx) initAudio(); liveOn(12 * (app.octave + 1) + i, 100); }
});
window.addEventListener('keyup', (e) => { const i = QW.indexOf(e.key.toLowerCase()); if (i < 0) return; for (let o = 1; o <= 7; o++) liveOff(12 * (o + 1) + i); });
window.addEventListener('blur', () => { for (const n of [...held.keys()]) liveOff(n); });
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

// app API for extensions (Blasta)
export const API = {
  app, S, MACHINES, IDS, GROUP, post, sendNow, setStatus, selectMachine, runPrep, primeMachine, applyTable, resetTable,
  savedTable, presetsOf, voicesOf, optionsOf, loadOpt, player, KB_CH, powerOn, get ctx() { return ctx; }, get node() { return node; },
  reloadInstruments() { loadState(); renderInstList(); renderArranger(); selectInst(S.sel, true); if (node) pushAll(); },
};
// initial paint (before power-on)
if (EXT_URL) { try { EXT = await import(new URL(EXT_URL, document.baseURI).href); if (EXT.init) await EXT.init(API); } catch (err) { console.error(err); setStatus('Extension error: ' + err.message); } }
loadState(); renderMachine(); buildVoices(); renderArranger(); renderInstList(); selectInst(S.sel, true);
{ const x = EXTRAS.find(e => e.id === startId); if (x) enterExtra(x); }
initAudio().catch(err => { console.error(err); setStatus('Audio error: ' + err.message); });
