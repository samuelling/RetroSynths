import { builtinFMBank } from './fmbank.js';
import { parseOP2 } from './op2.js';
import { parseSMF } from './smf.js';
import { demoSong } from './demo.js';
import { GM_NAMES, ERAS } from './gm.js';
import { Locker, DEFAULT_LOCKER } from './locker.js';

const $ = (id) => document.getElementById(id);
const BUILTIN_SF2 = '../../soundfonts/GeneralUser-GS.sf2';

let ctx = null, node = null;
const app = { era: 1, mute: new Uint8Array(16), solo: -1, userMute: new Uint8Array(16), liveCh: 0, octave: 4, programs: new Array(16).fill(0), banks: new Array(16).fill(0) };

// ------------------------------------------------------------ boot
const BOOT = [
  'Award Modular BIOS v4.51PG, An Energy Star Ally',
  'Copyright (C) 1984-95, Award Software, Inc.',
  '',
  'Main Processor : PENTIUM-S 133MHz',
  'Memory Testing : 16384K OK',
  '',
  'C:\\> SET BLASTER=A220 I5 D1 H5 P330 T6',
  'C:\\> CD \\BLASTA',
  'C:\\BLASTA> BLASTA.EXE /GM',
];
(function typeBoot() {
  const el = $('bootText');
  let i = 0;
  const step = () => { if (i < BOOT.length) { el.textContent += BOOT[i++] + '\n'; setTimeout(step, i < 3 ? 120 : 160); } };
  step();
})();
const powerOn = async () => {
  window.removeEventListener('keydown', powerOn);
  $('boot').removeEventListener('pointerdown', powerOn);
  $('boot').classList.add('gone');
  await initAudio();
};
window.addEventListener('keydown', powerOn);
$('boot').addEventListener('pointerdown', powerOn);

// ------------------------------------------------------------ audio
async function initAudio() {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('js/blasta-worklet.js');
  node = new AudioWorkletNode(ctx, 'blasta', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.connect(ctx.destination);
  node.port.onmessage = (e) => onStat(e.data);
  if (ctx.state !== 'running') await ctx.resume();
  post({ t: 'fmbank', bank: builtinFMBank() });
  post({ t: 'era', v: app.era });
  post({ t: 'master', v: +$('vol').value });
  setStatus('FM cards ready. Burning wavetable ROMs…');
  player.load(demoSong());
  await restoreSaved();
}
const post = (m, tr) => node && node.port.postMessage(m, tr || []);
const sendNow = (st, d1, d2 = 0) => post({ t: 'now', ev: [[st, d1, d2]] });
const setStatus = (s) => { $('status').textContent = s; };

// ------------------------------------------------------------ sound banks
const worker = new Worker('js/rom-worker.js', { type: 'module' });
let jobId = 0;
const jobs = new Map();
worker.onmessage = (e) => {
  const d = e.data, j = jobs.get(d.id);
  if (!j) return;
  if (d.progress !== undefined) { j.progress && j.progress(d.stage, d.progress); return; }
  jobs.delete(d.id);
  d.ok ? j.res(d) : j.rej(new Error(d.error));
};
function burn(buf, budgets, progress) {
  return new Promise((res, rej) => {
    const id = ++jobId; jobs.set(id, { res, rej, progress });
    worker.postMessage({ id, buf, budgets }, [buf]);
  });
}
const prog = (f) => { $('progBar').style.width = Math.round(f * 100) + '%'; };
const mb = (b) => (b / 1048576).toFixed(b < 1048576 * 10 ? 2 : 1) + ' MB';

async function fetchWithProgress(url, onp) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total) return r.arrayBuffer();
  const reader = r.body.getReader();
  const out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got); got += value.length; onp(got / total);
  }
  return out.buffer;
}

// ---- banks you load are kept in this browser (IndexedDB) and restored on every visit ----
const store = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((res, rej) => {
      const r = indexedDB.open('blasta', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('banks');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async op(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const q = fn(db.transaction('banks', mode).objectStore('banks'));
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
  get(k) { return this.op('readonly', s => s.get(k)).catch(() => null); },
  put(k, v) { return this.op('readwrite', s => s.put(v, k)); },
  del(k) { return this.op('readwrite', s => s.delete(k)).catch(() => {}); },
};
const PIN = ' · 📌 saved in this browser';
const SITE = ' · 🌐 site default';
const BUDGET = { 2: 'awe', 3: 'live' };

// ---- Bank Locker: password-protected cloud copies that follow you across devices ----
const locker = new Locker();
const SLOT_KEY = { fm: 'fm', 2: 'sf2', 3: 'sf3' };
const SLOT_NAME = { fm: 'FM', sf2: 'AWE32', sf3: 'Live!' };

async function pickSource(remote, local) {
  // prefer the locker's assignment; reuse this device's cached copy if it is the same file
  if (!remote) return local;
  if (local && local.name === remote.name && local.etag && local.etag === remote.etag) return { ...local, budget: remote.budget ?? local.budget };
  try {
    lkStat(`Downloading ${remote.name} from the locker…`);
    return { name: remote.name, etag: remote.etag, budget: remote.budget, blob: await locker.download(remote.name) };
  } catch (err) { lkStat('Locker download failed (' + err.message + ') — using this device\'s copy.'); return local; }
}

async function publicSource(entry, local) {
  // the site's default bank for a slot; cached on this device (marked pub) so it downloads once
  if (!entry) return null;
  if (local && local.pub && local.name === entry.name && local.etag === entry.etag) return { ...local, budget: entry.budget ?? local.budget };
  try {
    lkStat(`Fetching the site's ${entry.name}…`);
    return { name: entry.name, etag: entry.etag, budget: entry.budget, pub: true, blob: await locker.publicDownload(entry.name) };
  } catch { return null; }
}

async function restoreSaved({ remoteOnly = false } = {}) {
  if (!remoteOnly && locker.configured) {
    lkStat('Unlocking locker…');
    if (await locker.resume()) lockerOpened();
    else lkStat('Locker unreachable or password changed — using banks saved on this device.');
  }
  if (!remoteOnly) { try { await locker.publicInfo(); } catch {} renderShelf(); }
  const cfg = locker.unlocked ? locker.config : {};
  const pubSlots = (locker.pub && locker.pub.slots) || {};
  const [fmL, s2L, s3L] = await Promise.all([store.get('fm'), store.get('sf2'), store.get('sf3')]);
  // precedence: the owner's own assignment > this device's own choice > the site default > built-in
  const resolve = async (remote, local, pubEntry) => {
    if (remote) return pickSource(remote, local);
    if (local && !local.pub) return local;
    return (await publicSource(pubEntry, local)) || null;
  };
  if (!(remoteOnly && !cfg.fm)) {
    const fm = await resolve(cfg.fm, fmL, pubSlots.fm);
    if (fm) await loadOP2(fm.blob, fm.name, { save: fm !== fmL, etag: fm.etag, sync: false, pub: fm.pub });
  }
  const need = [];
  for (const [core, local, remote, pubEntry] of [[2, s2L, cfg.sf2, pubSlots.sf2], [3, s3L, cfg.sf3, pubSlots.sf3]]) {
    if (remoteOnly && !remote) continue;
    const src = await resolve(remote, local, pubEntry);
    if (src) {
      $('budget' + core).checked = src.budget !== 'raw';
      await loadUserSF2(src.blob, src.name, core, { save: src !== local, jump: false, etag: src.etag, sync: false, pub: src.pub });
    } else need.push(BUDGET[core]);
  }
  if (need.length) await loadBuiltinSF2(need);
  else if (!remoteOnly) setStatus('All four cards ready.');
  lkStat(locker.unlocked ? 'Unlocked.' : (locker.pub.banks.length ? 'Public banks available below. Unlock to manage.' : 'Locked.'));
}

async function loadBuiltinSF2(budgets = ['awe', 'live']) {
  const cores = budgets.map(b => b === 'awe' ? 2 : 3);
  try {
    for (const c of cores) $('st' + c).textContent = 'downloading GeneralUser GS…';
    const buf = await fetchWithProgress(BUILTIN_SF2, (f) => prog(f * 0.5));
    for (const c of cores) $('st' + c).textContent = 'burning ROM…';
    const r = await burn(buf, budgets, (stage, p) => prog(0.5 + p * 0.5));
    if (r.banks.awe) installSF(2, r.banks.awe, 'GeneralUser GS → AWE-style ROM');
    if (r.banks.live) installSF(3, r.banks.live, 'GeneralUser GS → Live!-style bank');
    prog(1); setTimeout(() => prog(0), 800);
    setStatus('All four cards ready.');
  } catch (err) {
    for (const c of cores) $('st' + c).textContent = 'failed: ' + err.message;
    setStatus('Could not load the wavetable bank — load your own .SF2 below.');
  }
}
function installSF(core, bank, label) {
  const bytes = bank.pool.length * 2;
  post({ t: 'sfbank', core, bank }, [bank.pool.buffer]);
  $('st' + core).textContent = `${label} · ${mb(bytes)} of samples`;
}
async function saveBank(key, rec, statusEl, pub = false) {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();   // ask the browser not to evict it
    await store.put(key, rec);
    statusEl.textContent += pub ? SITE : PIN;
  } catch (err) {
    statusEl.textContent += ' · not saved (' + (err.name === 'QuotaExceededError' ? 'browser storage full' : err.message) + ')';
  }
}
// push a slot's bank to the locker (upload if new) and record the assignment
async function syncSlot(key, rec) {
  if (!locker.unlocked || rec.pub) return;
  try {
    let etag = rec.etag;
    if (!etag) {
      if (rec.blob.size > 100 * 1048576) { lkStat(`${rec.name} is over 100 MB — too big for one upload; kept on this device only.`); return; }
      const file = rec.blob instanceof File ? rec.blob : new File([rec.blob], rec.name);
      const r = await locker.upload(file, (f) => { prog(f); lkStat(`Uploading ${rec.name}… ${Math.round(f * 100)}%`); });
      prog(0);
      etag = r.etag;
      const local = await store.get(key);
      if (local && local.name === rec.name) await store.put(key, { ...local, etag });
    }
    await locker.setSlot(key, { name: rec.name, etag, budget: rec.budget });
    lkStat(`${rec.name} is in the locker and assigned to ${SLOT_NAME[key]}.`);
    refreshLocker();
  } catch (err) { lkStat('Locker sync failed: ' + err.message); }
}
async function loadUserSF2(blob, name, core, { save = true, jump = true, etag = null, sync = true, pub = false } = {}) {
  const budget = $('budget' + core).checked ? BUDGET[core] : 'raw';
  $('st' + core).textContent = 'reading ' + name + '…';
  try {
    const r = await burn(await blob.arrayBuffer(), [budget], (s, p) => prog(p));
    installSF(core, r.banks[budget], name + (budget === 'raw' ? '' : budget === 'awe' ? ' → AWE-style' : ' → Live!-style'));
    prog(0);
    const rec = { name, budget, blob, etag, pub };
    if (save) await saveBank('sf' + core, rec, $('st' + core), pub);
    else $('st' + core).textContent += pub ? SITE : PIN;
    if (jump) setEra(core);
    if (sync) syncSlot('sf' + core, rec);
  } catch (err) { $('st' + core).textContent = 'error: ' + err.message; }
}
async function loadOP2(blob, name, { save = true, etag = null, sync = true, pub = false } = {}) {
  try {
    const bank = parseOP2(await blob.arrayBuffer());
    post({ t: 'fmbank', bank });
    $('stFM').textContent = name;
    const rec = { name, blob, etag, pub };
    if (save) await saveBank('fm', rec, $('stFM'), pub);
    else $('stFM').textContent += pub ? SITE : PIN;
    if (sync) { if (app.era > 1.5) setEra(1); syncSlot('fm', rec); }
  } catch (err) { $('stFM').textContent = 'error: ' + err.message; }
}
$('fileOP2').onchange = (e) => { const f = e.target.files[0]; if (f) loadOP2(f, f.name); e.target.value = ''; };
for (const [id, core] of [['fileSF2a', 2], ['fileSF2b', 3]]) {
  $(id).onchange = (e) => { const f = e.target.files[0]; if (f) loadUserSF2(f, f.name, core); e.target.value = ''; };
  // flipping the budget box re-burns the saved bank the new way
  $('budget' + core).onchange = async () => {
    const saved = await store.get('sf' + core);
    if (saved && ctx) loadUserSF2(saved.blob, saved.name, core, { save: true, jump: false, etag: saved.etag });
  };
  $('reset' + core).onclick = async () => {
    await store.del('sf' + core);
    if (locker.unlocked) await locker.setSlot('sf' + core, null).then(refreshLocker).catch(() => {});
    if (!ctx) return;
    const def = await publicSource(locker.pub.slots && locker.pub.slots['sf' + core], null);
    if (def) { $('budget' + core).checked = def.budget !== 'raw'; loadUserSF2(def.blob, def.name, core, { jump: false, etag: def.etag, sync: false, pub: true }); }
    else loadBuiltinSF2([BUDGET[core]]);
  };
}
$('btnFMReset').onclick = async () => {
  await store.del('fm');
  if (locker.unlocked) await locker.setSlot('fm', null).then(refreshLocker).catch(() => {});
  const def = ctx && await publicSource(locker.pub.slots && locker.pub.slots.fm, null);
  if (def) loadOP2(def.blob, def.name, { etag: def.etag, sync: false, pub: true });
  else { post({ t: 'fmbank', bank: builtinFMBank() }); $('stFM').textContent = 'Blasta Original FM'; }
};

// ---- locker panel ----
function lkStat(s) { $('lkStat').textContent = s; }
$('lkUrl').value = locker.url || DEFAULT_LOCKER;
$('lkLogin').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('lkUrl').value.trim(), pw = $('lkPw').value;
  if (!/^https:\/\//.test(url) && !/^http:\/\/localhost/.test(url)) { lkStat('Enter the https:// address of your locker Worker.'); return; }
  lkStat('Unlocking…');
  try {
    await locker.unlock(url, pw, $('lkRemember').checked);
    $('lkPw').value = '';
    lockerOpened();
    lkStat('Unlocked.');
    if (ctx) restoreSaved({ remoteOnly: true });
  } catch (err) { lkStat(err.message === 'wrong password' ? 'Wrong password.' : 'Could not reach the locker: ' + err.message); }
};
$('lkLock').onclick = () => { locker.lock(); $('lkOpen').hidden = true; $('lkLogin').hidden = false; lkStat('Locked. Banks already loaded stay on this device.'); };
$('lkRefresh').onclick = () => refreshLocker();
$('lkFile').onchange = async (e) => {
  for (const f of e.target.files) {
    if (f.size > 100 * 1048576) { lkStat(`${f.name} is over 100 MB — too big for one upload.`); continue; }
    try { await locker.upload(f, (p) => { prog(p); lkStat(`Uploading ${f.name}… ${Math.round(p * 100)}%`); }); lkStat(`Uploaded ${f.name}.`); }
    catch (err) { lkStat(`Upload of ${f.name} failed: ${err.message}`); }
  }
  prog(0); e.target.value = ''; refreshLocker();
};
function lockerOpened() { $('lkLogin').hidden = true; $('lkOpen').hidden = false; refreshLocker(); }
async function refreshLocker() {
  if (!locker.unlocked) return;
  let banks;
  try { banks = await locker.list(); } catch (err) { lkStat('Could not list banks: ' + err.message); return; }
  const cfg = locker.config, box = $('lkList');
  box.innerHTML = '';
  if (!banks.length) box.innerHTML = '<div class="lkempty">Empty — upload .sf2 / .op2 files, or just load one into a slot above.</div>';
  let total = 0;
  for (const b of banks) {
    total += b.size;
    const row = document.createElement('div'); row.className = 'lkrow';
    const inSlots = Object.entries(cfg).filter(([, v]) => v && v.name === b.name).map(([k]) => SLOT_NAME[k]);
    const isPub = locker.pub.banks.some(p => p.name === b.name);
    row.innerHTML = `<span class="lkname"></span><span class="lksize">${mb(b.size)}</span><span class="lkin">${inSlots.length ? '● ' + inSlots.join(', ') : ''}</span><label class="chk lkpub" title="Anyone visiting Blasta can load this bank (read-only)"><input type="checkbox" ${isPub ? 'checked' : ''}> Public</label><span class="lkbtns"></span>`;
    row.querySelector('.lkpub input').onchange = (e) => togglePublic(b.name, e.target.checked, e.target);
    row.querySelector('.lkname').textContent = b.name;
    const btns = row.querySelector('.lkbtns');
    const add = (label, fn, title) => { const x = document.createElement('button'); x.className = 'btn small'; x.textContent = label; x.title = title || ''; x.onclick = fn; btns.appendChild(x); };
    if (b.kind === 'op2') add('→ FM', () => assign(b, 'fm'), 'Use for the AdLib / SB16 cards');
    else { add('→ AWE32', () => assign(b, 2), 'Load into the AWE32 slot'); add('→ Live!', () => assign(b, 3), 'Load into the Live! slot'); }
    add('✕', async () => {
      if (!confirm(`Delete ${b.name} from the locker? (Copies already loaded on devices stay there.)`)) return;
      try {
        await locker.remove(b.name);
        for (const [k, v] of Object.entries(cfg)) if (v && v.name === b.name) await locker.setSlot(k, null);
        refreshLocker();
      } catch (err) { lkStat('Delete failed: ' + err.message); }
    }, 'Delete from the locker');
    box.appendChild(row);
  }
  $('lkInfo').textContent = banks.length ? `${banks.length} bank${banks.length > 1 ? 's' : ''} · ${mb(total)}` : '';
  renderShelf();
}
function pubState() {
  return { banks: locker.pub.banks.map(b => b.name), slots: { ...(locker.pub.slots || {}) } };
}
async function togglePublic(name, on, box) {
  const st = pubState();
  st.banks = on ? [...new Set([...st.banks, name])] : st.banks.filter(n => n !== name);
  if (!on) for (const k of Object.keys(st.slots)) if (st.slots[k].name === name) delete st.slots[k];
  try { await locker.setPublic(st); lkStat(on ? `${name} is now public (read-only for visitors).` : `${name} is private again.`); }
  catch (err) { box.checked = !on; lkStat('Could not change sharing: ' + err.message); }
  renderShelf();
}
$('lkPublish').onclick = async () => {
  const cfg = locker.config, st = pubState(), chosen = [];
  for (const k of ['fm', 'sf2', 'sf3']) {
    if (cfg[k]) { st.slots[k] = { name: cfg[k].name, budget: cfg[k].budget }; chosen.push(`${SLOT_NAME[k]}: ${cfg[k].name}`); if (!st.banks.includes(cfg[k].name)) st.banks.push(cfg[k].name); }
    else delete st.slots[k];
  }
  const msg = chosen.length
    ? `Make these the default sound for everyone who opens Blasta?\n\n${chosen.join('\n')}\n\nThese banks become public (downloadable, read-only). Empty slots go back to the built-in banks.`
    : 'None of your slots use locker banks, so this resets the site to the built-in banks. Continue?';
  if (!confirm(msg)) return;
  try { await locker.setPublic(st); lkStat(chosen.length ? 'Published — visitors now get your banks by default.' : 'Site defaults reset to the built-in banks.'); refreshLocker(); }
  catch (err) { lkStat('Publish failed: ' + err.message); }
};

// ---- public shelf: anyone can load these into their own browser, no one can change them ----
function renderShelf() {
  const box = $('shelfList'), banks = (locker.pub && locker.pub.banks) || [];
  $('shelf').hidden = !banks.length;
  box.innerHTML = '';
  const defs = (locker.pub && locker.pub.slots) || {};
  for (const b of banks) {
    const row = document.createElement('div'); row.className = 'lkrow';
    const isDef = Object.entries(defs).filter(([, v]) => v && v.name === b.name).map(([k]) => SLOT_NAME[k]);
    row.innerHTML = `<span class="lkname"></span><span class="lksize">${mb(b.size)}</span><span class="lkin">${isDef.length ? '★ default ' + isDef.join(', ') : ''}</span><span class="lkbtns"></span>`;
    row.querySelector('.lkname').textContent = b.name;
    const btns = row.querySelector('.lkbtns');
    const add = (label, slot) => { const x = document.createElement('button'); x.className = 'btn small'; x.textContent = label; x.onclick = () => takePublic(b, slot); btns.appendChild(x); };
    if (b.kind === 'op2') add('→ FM', 'fm'); else { add('→ AWE32', 2); add('→ Live!', 3); }
    box.appendChild(row);
  }
}
async function takePublic(b, slot) {
  if (!ctx) await powerOn();
  lkStat(`Fetching ${b.name}…`);
  let blob;
  try { blob = await locker.publicDownload(b.name); } catch (err) { lkStat('Download failed: ' + err.message); return; }
  // the visitor's own choice for this browser; for the owner (unlocked) it also syncs to their locker slot
  const opts = { etag: b.etag, pub: false };
  if (slot === 'fm') await loadOP2(blob, b.name, opts); else await loadUserSF2(blob, b.name, slot, opts);
  lkStat(`${b.name} loaded.`);
}
async function assign(b, slot) {
  if (!ctx) await powerOn();
  const key = SLOT_KEY[slot];
  const local = await store.get(key);
  let blob;
  if (local && local.name === b.name && local.etag === b.etag) blob = local.blob;
  else {
    lkStat(`Downloading ${b.name}…`);
    try { blob = await locker.download(b.name); } catch (err) { lkStat('Download failed: ' + err.message); return; }
  }
  if (slot === 'fm') await loadOP2(blob, b.name, { etag: b.etag });
  else await loadUserSF2(blob, b.name, slot, { etag: b.etag });
}

// ------------------------------------------------------------ era
const CHIPS = [['YM3812', '', 'SOUND BLASTER 2.0', '#1f6b35'], ['YMF262', 'CT1745', 'SOUND BLASTER 16', '#1f6b35'],
  ['EMU8000', 'YMF262', 'AWE32', '#1d5a2d'], ['EMU10K1', 'AC97', 'SB LIVE!', '#24426b']];
function setEra(v, fromSlider) {
  app.era = Math.max(0, Math.min(3, v));
  if (!fromSlider) $('era').value = app.era;
  post({ t: 'era', v: app.era });
  const i = Math.round(app.era), e = ERAS[i];
  $('eraCard').textContent = e.card;
  $('eraChip').textContent = `${e.chip} · ${e.year}`;
  $('eraSpec').textContent = e.spec;
  const lo = Math.floor(app.era), hi = Math.min(3, lo + 1), f = app.era - lo;
  $('eraMix').textContent = f > 0.02 && f < 0.98 ? `Crossfading ${ERAS[lo].short} ${Math.round((1 - f) * 100)}% ↔ ${ERAS[hi].short} ${Math.round(f * 100)}%` : '';
  const c = CHIPS[i];
  $('chipLabel').textContent = c[0]; $('chip2').textContent = c[1]; $('silk').textContent = c[2];
  document.querySelector('.pcb').style.background = `linear-gradient(${c[3]}, ${shade(c[3])})`;
  document.querySelectorAll('.ticks button').forEach((b, k) => b.classList.toggle('on', Math.abs(app.era - k) < 0.02));
}
const shade = (hex) => '#' + hex.slice(1).match(/../g).map(h => Math.max(0, parseInt(h, 16) - 18).toString(16).padStart(2, '0')).join('');
$('era').oninput = (e) => setEra(+e.target.value, true);
document.querySelectorAll('.ticks button').forEach(b => b.onclick = () => setEra(+b.dataset.era));

// ------------------------------------------------------------ player
class Player {
  constructor() { this.song = null; this.playing = false; this.pos = 0; this.idx = 0; this.timer = 0; }
  load(song) {
    this.stop();
    this.song = song;
    for (const r of chRows) { r.used = false; r.el.classList.add('idle'); }
    $('songTitle').textContent = song.title || 'Untitled';
    this.updateTime();
  }
  play() {
    if (!this.song || !ctx) return;
    if (ctx.state !== 'running') ctx.resume();
    if (this.pos >= this.song.duration) this.pos = 0;
    this.chase(this.pos);
    this.t0 = ctx.currentTime + 0.06 - this.pos;
    const ev = this.song.events;
    this.idx = 0;
    while (this.idx < ev.length && ev[this.idx][0] < this.pos) this.idx++;
    this.playing = true;
    $('btnPlay').innerHTML = '&#10074;&#10074;';
    this.pump();
    this.timer = setInterval(() => this.pump(), 25);
  }
  pump() {
    const ev = this.song.events, sr = ctx.sampleRate, horizon = ctx.currentTime + 0.18;
    const batch = [];
    while (this.idx < ev.length && this.t0 + ev[this.idx][0] <= horizon) {
      const e = ev[this.idx++];
      batch.push([Math.round((this.t0 + e[0]) * sr), e[1], e[2], e[3]]);
    }
    if (batch.length) post({ t: 'ev', ev: batch });
    this.pos = ctx.currentTime - this.t0;
    if (this.idx >= ev.length && this.pos >= this.song.duration) {
      if ($('chkLoop').checked) { this.halt(); this.pos = 0; this.play(); }
      else { this.halt(); this.pos = 0; }
    }
  }
  halt() {
    clearInterval(this.timer); this.timer = 0;
    if (this.playing) {
      post({ t: 'clearq' });
      for (let c = 0; c < 16; c++) { sendNow(0xB0 | c, 123, 0); sendNow(0xB0 | c, 64, 0); }
    }
    this.playing = false;
    $('btnPlay').innerHTML = '&#9654;';
  }
  pause() { if (!this.playing) return; this.pos = ctx.currentTime - this.t0; this.halt(); }
  stop() { this.halt(); this.pos = 0; this.updateTime(); }
  seek(f) {
    if (!this.song) return;
    const was = this.playing;
    this.halt();
    this.pos = f * this.song.duration;
    if (was) this.play(); else this.updateTime();
  }
  chase(pos) {
    // replay program / controller / bend state up to pos
    post({ t: 'now', ev: [[0xFF, 0, 0]] });
    const out = [];
    for (const e of this.song.events) {
      if (e[0] >= pos) break;
      const ty = e[1] & 0xF0;
      if (ty === 0xB0 || ty === 0xC0 || ty === 0xE0 || e[1] >= 0xFE) {
        if (ty === 0xB0 && (e[2] === 64 || e[2] >= 120)) continue;
        out.push([e[1], e[2], e[3]]);
      }
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
const player = new Player();
let seeking = false;
$('btnPlay').onclick = () => player.playing ? player.pause() : player.play();
$('btnStop').onclick = () => player.stop();
$('btnDemo').onclick = $('menuDemo').onclick = () => { player.load(demoSong()); player.play(); };
$('seek').oninput = () => { seeking = true; };
$('seek').onchange = (e) => { seeking = false; player.seek(+e.target.value / 1000); };
$('menuPanic').onclick = () => { player.halt(); post({ t: 'reset' }); };
$('menuAbout').onclick = () => { $('about').hidden = false; };
$('aboutOK').onclick = () => { $('about').hidden = true; };
$('fileMidi').onchange = async (e) => { const f = e.target.files[0]; if (f) await openMidi(f); e.target.value = ''; };
async function openMidi(file) {
  try {
    const song = parseSMF(await file.arrayBuffer());
    song.title = song.title ? `${file.name} — ${song.title}` : file.name;
    player.load(song); player.play();
  } catch (err) { setStatus('MIDI error: ' + err.message); }
}
$('vol').oninput = (e) => post({ t: 'master', v: +e.target.value });
$('chkAnalog').onchange = (e) => post({ t: 'analog', v: e.target.checked ? 1 : 0 });

// drag & drop
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', async (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  if (!ctx) await powerOn();
  for (const f of e.dataTransfer.files) {
    const n = f.name.toLowerCase();
    if (n.endsWith('.sf2')) await loadUserSF2(f, f.name, app.era >= 2.5 ? 3 : 2);
    else if (n.endsWith('.op2')) await loadOP2(f, f.name);
    else await openMidi(f);
  }
});

// ------------------------------------------------------------ mixer
const chRows = [];
(function buildChannels() {
  const box = $('channels');
  for (let c = 0; c < 16; c++) {
    const r = document.createElement('div');
    r.className = 'chrow';
    r.innerHTML = `<span class="num">${c + 1}</span><span class="nm"></span><span class="mt"><i></i></span>`;
    let clickT = 0;
    r.onclick = () => {
      clearTimeout(clickT);
      clickT = setTimeout(() => { app.userMute[c] ^= 1; applyMute(); }, 220);
    };
    r.ondblclick = () => { clearTimeout(clickT); app.solo = app.solo === c ? -1 : c; applyMute(); };
    box.appendChild(r);
    chRows.push({ el: r, nm: r.querySelector('.nm'), bar: r.querySelector('i'), lvl: 0 });
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
    const nm = c === 9 ? `Drum Kit ${app.programs[c] + 1}` : (app.banks[c] ? `${GM_NAMES[app.programs[c]]} (var ${app.banks[c]})` : GM_NAMES[app.programs[c]]);
    if (chRows[c].nm.textContent !== nm) chRows[c].nm.textContent = nm;
  }
}

// ------------------------------------------------------------ stats / scope
const scope = $('scope'), sctx = scope.getContext('2d');
let lastScope = null;
function onStat(d) {
  if (d.t !== 'stat') return;
  lastScope = d.scope;
  for (let c = 0; c < 16; c++) {
    const lv = Math.min(1, Math.sqrt(d.meter[c]) * 1.1);
    chRows[c].lvl = Math.max(lv, chRows[c].lvl * 0.82);
    if (lv > 0.01 && !chRows[c].used) { chRows[c].used = true; chRows[c].el.classList.remove('idle'); }
  }
  let changed = false;
  for (let c = 0; c < 16; c++) if (d.programs[c] !== app.programs[c] || d.banks[c] !== app.banks[c]) { app.programs[c] = d.programs[c]; app.banks[c] = d.banks[c]; changed = true; }
  if (changed) renderNames();
  const names = ['OPL2', 'OPL3', 'AWE32', 'Live!'], max = [9, 18, 30, 64];
  $('voices').textContent = d.voices.map((v, i) => v < 0 ? null : `${names[i]} ${String(v).padStart(2)}/${max[i]}`).filter(Boolean).join(' · ') + (d.peak >= 0.999 ? ' · CLIP' : '');
}
function frame() {
  for (const r of chRows) r.bar.style.width = (r.lvl * 100).toFixed(1) + '%';
  const w = scope.width, h = scope.height;
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, w, h);
  sctx.strokeStyle = '#0a3a0a'; sctx.beginPath(); sctx.moveTo(0, h / 2); sctx.lineTo(w, h / 2); sctx.stroke();
  if (lastScope) {
    // trigger on rising zero crossing for a stable trace
    let s0 = 0;
    for (let i = 1; i < 256; i++) if (lastScope[i - 1] < 0 && lastScope[i] >= 0) { s0 = i; break; }
    sctx.strokeStyle = '#4cff6a'; sctx.lineWidth = 1.5; sctx.beginPath();
    for (let x = 0; x < 256; x++) {
      const v = lastScope[s0 + x] || 0;
      const y = h / 2 - v * h * 0.9;
      x ? sctx.lineTo(x * 2, y) : sctx.moveTo(0, y);
    }
    sctx.stroke();
  }
  if (player.song) player.updateTime();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------ live keyboard
(function buildLiveControls() {
  const chs = $('liveCh');
  for (let c = 0; c < 16; c++) chs.add(new Option(String(c + 1) + (c === 9 ? ' (drums)' : ''), c));
  chs.onchange = () => { app.liveCh = +chs.value; $('liveProg').value = app.programs[app.liveCh]; };
  const ps = $('liveProg');
  GM_NAMES.forEach((n, i) => ps.add(new Option(`${String(i + 1).padStart(3, '0')} ${n}`, i)));
  ps.onchange = () => sendNow(0xC0 | app.liveCh, +ps.value);
})();
const held = new Map();
function liveOn(note, vel = 100) {
  if (!ctx) return;
  if (held.has(note)) return;
  held.set(note, app.liveCh);
  sendNow(0x90 | app.liveCh, note, vel);
  keyEl(note, true);
}
function liveOff(note) {
  if (!held.has(note)) return;
  sendNow(0x80 | held.get(note), note, 0);
  held.delete(note);
  keyEl(note, false);
}
const pianoKeys = new Map();
const WIDE = window.innerWidth > 760;
const PIANO_LO = WIDE ? 36 : 48, PIANO_HI = WIDE ? 95 : 83;
(function buildPiano() {
  const p = $('piano');
  const whites = [];
  for (let n = PIANO_LO; n <= PIANO_HI; n++) if (![1, 3, 6, 8, 10].includes(n % 12)) whites.push(n);
  whites.forEach(n => { const d = document.createElement('div'); d.className = 'w'; d.dataset.n = n; p.appendChild(d); pianoKeys.set(n, d); });
  const ww = 100 / whites.length;
  for (let n = PIANO_LO; n <= PIANO_HI; n++) if ([1, 3, 6, 8, 10].includes(n % 12)) {
    const wi = whites.indexOf(n - 1);
    const d = document.createElement('div'); d.className = 'b'; d.dataset.n = n;
    d.style.left = `calc(${(wi + 1) * ww}% - ${ww * 0.3}%)`; d.style.width = `${ww * 0.6}%`;
    p.appendChild(d); pianoKeys.set(n, d);
  }
  const ptr = new Map();
  const noteAt = (e) => { const el = document.elementFromPoint(e.clientX, e.clientY); return el && el.dataset && el.dataset.n ? +el.dataset.n : null; };
  p.addEventListener('pointerdown', (e) => { const n = noteAt(e); if (n == null) return; p.setPointerCapture(e.pointerId); ptr.set(e.pointerId, n); liveOn(n, 70 + Math.round(Math.random() * 30)); });
  p.addEventListener('pointermove', (e) => {
    if (!ptr.has(e.pointerId)) return;
    const n = noteAt(e), o = ptr.get(e.pointerId);
    if (n != null && n !== o) { liveOff(o); liveOn(n, 90); ptr.set(e.pointerId, n); }
  });
  const up = (e) => { if (!ptr.has(e.pointerId)) return; liveOff(ptr.get(e.pointerId)); ptr.delete(e.pointerId); };
  p.addEventListener('pointerup', up); p.addEventListener('pointercancel', up);
})();
function keyEl(n, down) { const el = pianoKeys.get(n); if (el) el.classList.toggle('down', down); }
const QW = 'awsedftgyhujkolp;';
window.addEventListener('keydown', (e) => {
  if (!ctx || e.repeat || e.metaKey || e.ctrlKey || e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  const k = e.key.toLowerCase();
  if (k === 'z') { app.octave = Math.max(1, app.octave - 1); $('octLabel').textContent = 'Oct ' + app.octave; return; }
  if (k === 'x') { app.octave = Math.min(7, app.octave + 1); $('octLabel').textContent = 'Oct ' + app.octave; return; }
  if (k === ' ') { e.preventDefault(); $('btnPlay').click(); return; }
  const i = QW.indexOf(k);
  if (i >= 0) liveOn(12 * (app.octave + 1) + i, 100);
});
window.addEventListener('keyup', (e) => {
  const i = QW.indexOf(e.key.toLowerCase());
  if (i < 0) return;
  for (let o = 1; o <= 7; o++) liveOff(12 * (o + 1) + i);
});

// ------------------------------------------------------------ Web MIDI input
let midiAccess = null;
$('midiIn').addEventListener('pointerdown', async () => {
  if (midiAccess || !navigator.requestMIDIAccess) {
    if (!navigator.requestMIDIAccess) setStatus('Web MIDI is not available in this browser.');
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    const refresh = () => {
      const sel = $('midiIn'), cur = sel.value;
      sel.innerHTML = '<option value="">(none)</option>';
      for (const inp of midiAccess.inputs.values()) sel.add(new Option(inp.name, inp.id));
      sel.value = cur;
    };
    refresh(); midiAccess.onstatechange = refresh;
  } catch { setStatus('MIDI access was refused.'); }
});
$('midiIn').onchange = (e) => {
  if (!midiAccess) return;
  for (const inp of midiAccess.inputs.values()) inp.onmidimessage = null;
  const inp = midiAccess.inputs.get(e.target.value);
  if (inp) inp.onmidimessage = (m) => {
    const [st, d1 = 0, d2 = 0] = m.data;
    if (st >= 0xF0) return;
    // route the keyboard's channel 1 to the selected live channel
    const s = (st & 0xF0) | ((st & 15) === 0 ? app.liveCh : (st & 15));
    post({ t: 'now', ev: [[s, d1, d2]] });
    if ((st & 0xF0) === 0x90 && d2) keyEl(d1, true); else if ((st & 0xF0) === 0x80 || (st & 0xF0) === 0x90) keyEl(d1, false);
  };
};

setEra(1);
