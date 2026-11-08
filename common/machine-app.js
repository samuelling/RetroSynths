// Shared UI for the Console and Old School apps: pick a machine, play MIDI / keyboard / Web MIDI through its chip.
import { parseSMF } from './smf.js';
import { demoSong } from './demo.js';
import { GM_NAMES } from './gm.js';
import { MACHINES, GROUPS } from './machines/registry.js';

const $ = (id) => document.getElementById(id);
const GROUP = document.body.dataset.group;
const IDS = GROUPS[GROUP];
const APP_NAME = document.body.dataset.title || 'RetroSynths';
const PREP = new Set(['snes']);                 // machines with a <id>.prep.js main-thread step
const SF2_URL = '../../soundfonts/GeneralUser-GS.sf2';
const embed = new URLSearchParams(location.search).has('embed');
if (embed) document.body.classList.add('embed');

let ctx = null, node = null;
const app = {
  id: localStorage.getItem('retrosynths.' + GROUP + '.machine') || IDS[0],
  mute: new Uint8Array(16), userMute: new Uint8Array(16), solo: -1,
  liveCh: 0, octave: 4, programs: new Array(16).fill(0), banks: new Array(16).fill(0), drums: new Array(16).fill(false),
};
if (!IDS.includes(app.id)) app.id = IDS[0];

// ------------------------------------------------------------ plates (evocative colours, no logos)
const PLATES = {
  nes: { bg: 'linear-gradient(#d8d6d0, #bdbab3)', fg: '#222', stripe: '#b21f24', chip: 'RP2A03' },
  snes: { bg: 'linear-gradient(#dcdcde, #c4c3c9)', fg: '#2c2650', stripe: 'linear-gradient(90deg,#6e5aa8,#9a8bd0)', chip: 'S-DSP' },
  genesis: { bg: 'linear-gradient(#1d1d1f, #0c0c0d)', fg: '#eee', stripe: 'linear-gradient(90deg,#c71f2d,#e2b23a)', chip: 'YM2612' },
  tg16: { bg: 'linear-gradient(#202022, #111)', fg: '#f2f2f2', stripe: 'linear-gradient(90deg,#e08b1e,#e8d23c)', chip: 'HuC6280' },
  gb: { bg: 'linear-gradient(#d5d2c8, #bfbbae)', fg: '#2b2a5c', stripe: 'linear-gradient(90deg,#8bac0f,#306230)', chip: 'DMG APU' },
  apple2: { bg: 'linear-gradient(#e7dcc2, #cfc2a3)', fg: '#3a3324', stripe: 'linear-gradient(90deg,#5fb84a,#f6c33c,#f08a24,#e2463b,#963d97,#2f9ad7)', chip: '2×AY-3-8910' },
  c64: { bg: 'linear-gradient(#cbbfa8, #b1a58c)', fg: '#3b2f22', stripe: 'linear-gradient(90deg,#d62e2e,#f08a24,#f2d23a,#3a9c4f,#2f6fd0)', chip: '6581 SID' },
  atari2600: { bg: 'repeating-linear-gradient(90deg,#6b3e1e 0 6px,#5a3318 6px 9px)', fg: '#f2e6cf', stripe: '#111', chip: 'TIA' },
  atari800: { bg: 'linear-gradient(#e6dccb, #d0c4ad)', fg: '#3b3226', stripe: '#6b4a2b', chip: 'POKEY' },
  zx: { bg: 'linear-gradient(#202020, #0e0e0e)', fg: '#eee', stripe: 'linear-gradient(90deg,#e2463b,#f6c33c,#3aa84f,#2f9ad7)', chip: 'AY-3-8912' },
  msx: { bg: 'linear-gradient(#3a3a3e, #26262a)', fg: '#eee', stripe: '#c43a3a', chip: 'YM2149' },
  pcspeaker: { bg: 'linear-gradient(#e2dccd, #ccc4b0)', fg: '#2f2c26', stripe: '#3c3c3c', chip: '8253 PIT' },
};

// ------------------------------------------------------------ boot
const BOOT = ['C:\\> CD \\RETRO', 'C:\\RETRO> ' + APP_NAME.toUpperCase().replace(/\s+/g, '') + '.EXE'];
$('bootText').textContent = BOOT.join('\n') + '\n';
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

// ------------------------------------------------------------ machines
let sf2Cache = null;
const fetchSF2 = async () => {
  if (!sf2Cache) { setStatus('Downloading GeneralUser GS…'); sf2Cache = await (await fetch(SF2_URL)).arrayBuffer(); }
  return sf2Cache.slice(0);
};
const prepDone = new Map();     // id → song key the data was built for
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
async function runPrep(id) {
  if (!PREP.has(id)) return;
  const song = player.song, key = song ? song.title + ':' + song.events.length : 'live';
  if (prepDone.get(id) === key) return;
  prepBusy = prepBusy.then(async () => {
    try {
      const mod = await import(`./machines/${id}.prep.js`);
      setStatus(`Loading ${MACHINES[id].info.name} sample RAM…`);
      const data = await mod.prepare({ fetchSF2, song: songInfo(song) });
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
  renderMachine();
  if (!node) return;
  const wasPlaying = player.playing;
  if (PREP.has(id)) { if (wasPlaying) player.pause(); await runPrep(id); }
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
  const M = MACHINES[app.id], info = M.info, pl = PLATES[app.id] || PLATES.nes;
  const plate = $('plate');
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
    const lab = document.createElement('label');
    const sel = document.createElement('select');
    o.choices.forEach(([v, t], i) => sel.add(new Option(t, i)));
    const cur = loadOpt(app.id, o);
    sel.selectedIndex = Math.max(0, o.choices.findIndex(([v]) => JSON.stringify(v) === JSON.stringify(cur)));
    sel.onchange = () => {
      const v = o.choices[sel.selectedIndex][0];
      localStorage.setItem(optKey(app.id, o), JSON.stringify(v));
      post({ t: 'option', id: app.id, key: o.key, value: v });
    };
    lab.append(o.label + ' ', sel); box.appendChild(lab);
  }
  document.querySelectorAll('.mpick button').forEach(b => b.classList.toggle('on', b.dataset.id === app.id));
}
(function buildPicker() {
  const box = $('mpick');
  for (const id of IDS) {
    const info = MACHINES[id].info;
    const b = document.createElement('button');
    b.dataset.id = id;
    b.innerHTML = `<span></span><br><small>${info.year}</small>`;
    b.querySelector('span').textContent = info.name.replace(' / Mega Drive', '').replace(' + Mockingboard', '');
    if (/placeholder/.test(info.spec || '')) b.classList.add('wip');
    b.onclick = () => selectMachine(id);
    box.appendChild(b);
  }
  renderMachine();
})();

// ------------------------------------------------------------ player
class Player {
  constructor() { this.song = null; this.playing = false; this.pos = 0; this.idx = 0; this.timer = 0; }
  load(song) {
    this.stop(); this.song = song;
    $('songTitle').textContent = song.title || 'Untitled';
    for (const r of chRows) { r.used = false; r.el.classList.add('idle'); }
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
const chRows = [];
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

// ------------------------------------------------------------ mixer
(function buildChannels() {
  const box = $('channels');
  for (let c = 0; c < 16; c++) {
    const r = document.createElement('div');
    r.className = 'chrow idle';
    r.innerHTML = `<span class="num">${c + 1}</span><span class="nm"></span><span class="mt"><i></i></span>`;
    let clickT = 0;
    r.onclick = () => { clearTimeout(clickT); clickT = setTimeout(() => { app.userMute[c] ^= 1; applyMute(); }, 220); };
    r.ondblclick = () => { clearTimeout(clickT); app.solo = app.solo === c ? -1 : c; applyMute(); };
    box.appendChild(r);
    chRows.push({ el: r, nm: r.querySelector('.nm'), bar: r.querySelector('i'), lvl: 0, used: false });
  }
  renderNames();
})();
function applyMute() {
  for (let c = 0; c < 16; c++) {
    app.mute[c] = app.solo >= 0 ? (c !== app.solo) : app.userMute[c];
    chRows[c].el.classList.toggle('muted', !!app.mute[c]);
    chRows[c].el.classList.toggle('solo', app.solo === c);
  }
  post({ t: 'mute', v: app.mute });
}
function renderNames() {
  for (let c = 0; c < 16; c++) {
    const nm = app.drums[c] ? `Drum Kit ${app.programs[c] + 1}` : GM_NAMES[app.programs[c]];
    if (chRows[c].nm.textContent !== nm) chRows[c].nm.textContent = nm;
  }
}

// ------------------------------------------------------------ stats / scope
const scope = $('scope'), sctx = scope.getContext('2d');
let lastScope = null;
function onMsg(d) {
  if (d.t === 'error') { setStatus('⚠ ' + d.message); console.error(d.message); return; }
  if (d.t !== 'stat') return;
  lastScope = d.scope;
  for (let c = 0; c < 16; c++) {
    const lv = Math.min(1, Math.sqrt(d.meter[c]) * 1.1);
    chRows[c].lvl = Math.max(lv, chRows[c].lvl * 0.82);
    if (lv > 0.01 && !chRows[c].used) { chRows[c].used = true; chRows[c].el.classList.remove('idle'); }
  }
  let changed = false;
  for (let c = 0; c < 16; c++) if (d.programs[c] !== app.programs[c] || d.drums[c] !== app.drums[c]) { app.programs[c] = d.programs[c]; app.drums[c] = d.drums[c]; changed = true; }
  if (changed) renderNames();
  const info = d.machine && MACHINES[d.machine] ? MACHINES[d.machine].info : null;
  $('voices').textContent = info ? `${info.name} ${String(d.voices).padStart(2)}${d.max ? '/' + d.max : ''}${d.peak >= 0.999 ? ' · CLIP' : ''}` : '';
}
function frame() {
  for (const r of chRows) r.bar.style.width = (r.lvl * 100).toFixed(1) + '%';
  const w = scope.width, h = scope.height;
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, w, h);
  sctx.strokeStyle = '#0a3a0a'; sctx.beginPath(); sctx.moveTo(0, h / 2); sctx.lineTo(w, h / 2); sctx.stroke();
  if (lastScope) {
    let s0 = 0;
    for (let i = 1; i < 256; i++) if (lastScope[i - 1] < 0 && lastScope[i] >= 0) { s0 = i; break; }
    sctx.strokeStyle = '#4cff6a'; sctx.lineWidth = 1.5; sctx.beginPath();
    for (let x = 0; x < 256; x++) { const y = h / 2 - (lastScope[s0 + x] || 0) * h * 0.9; x ? sctx.lineTo(x * 2, y) : sctx.moveTo(0, y); }
    sctx.stroke();
  }
  if (player.song) player.updateTime();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------ live keyboard + Web MIDI
(function buildLiveControls() {
  const chs = $('liveCh');
  for (let c = 0; c < 16; c++) chs.add(new Option(String(c + 1) + (c === 9 ? ' (drums)' : ''), c));
  chs.onchange = () => { app.liveCh = +chs.value; $('liveProg').value = app.programs[app.liveCh]; };
  const ps = $('liveProg');
  GM_NAMES.forEach((n, i) => ps.add(new Option(`${String(i + 1).padStart(3, '0')} ${n}`, i)));
  ps.onchange = () => sendNow(0xC0 | app.liveCh, +ps.value);
})();
const held = new Map(), pianoKeys = new Map();
function liveOn(note, vel = 100) { if (!ctx || held.has(note)) return; held.set(note, app.liveCh); sendNow(0x90 | app.liveCh, note, vel); keyEl(note, true); }
function liveOff(note) { if (!held.has(note)) return; sendNow(0x80 | held.get(note), note, 0); held.delete(note); keyEl(note, false); }
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
  if (!ctx || e.repeat || e.metaKey || e.ctrlKey || e.target.tagName === 'SELECT' || (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return;
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
    const s = (st & 0xF0) | ((st & 15) === 0 ? app.liveCh : (st & 15));
    post({ t: 'now', ev: [[s, d1, d2]] });
    if ((st & 0xF0) === 0x90 && d2) keyEl(d1, true); else if ((st & 0xF0) === 0x80 || (st & 0xF0) === 0x90) keyEl(d1, false);
  };
};
