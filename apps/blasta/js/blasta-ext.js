// Blasta on the RetroSynths machine framework: era slider (four cards, neighbours crossfade with cos^1.5
// weights rendered together by the host), ISA-card art, sound-bank slots (FM .op2, AWE32 / Live! .sf2 with
// ROM-budget boxes), banks kept in IndexedDB ('blasta' store), and the Bank Locker (private + public sharing).
import { Locker, DEFAULT_LOCKER } from '../../../common/locker.js';
import { setSource, getSource, emuEvents } from '../../../common/machines/emu-prep.js';
import { parseOP2 } from '../../../common/machines/opl-bank.js';

const $ = (id) => document.getElementById(id);
const ORDER = ['opl2', 'opl3', 'awe32', 'live'];
const CORE_ID = { 2: 'awe32', 3: 'live' };
const BUDGET = { 2: 'awe', 3: 'live' };
const SLOT_KEY = { fm: 'fm', 2: 'sf2', 3: 'sf3' };
const SLOT_NAME = { fm: 'FM', sf2: 'AWE32', sf3: 'Live!' };
const CHIPS = { opl2: ['YM3812', '', 'SOUND BLASTER 2.0', '#1f6b35'], opl3: ['YMF262', 'CT1745', 'SOUND BLASTER 16', '#1f6b35'],
  awe32: ['EMU8000', 'YMF262', 'AWE32', '#1d5a2d'], live: ['EMU10K1', 'AC97', 'SB LIVE!', '#24426b'] };
const SHORT = { opl2: 'OPL2', opl3: 'OPL3', awe32: 'AWE32', live: 'Live!' };
const PIN = ' · 📌 saved in this browser', SITE = ' · 🌐 site default';
const FM_MARK = 'blasta.fm.applied';
let A = null, era = 1, primed = new Set(), selecting = null;
const locker = new Locker();

// ------------------------------------------------------------ IndexedDB: banks kept in this browser
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
    return new Promise((res, rej) => { const q = fn(db.transaction('banks', mode).objectStore('banks')); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  },
  get(k) { return this.op('readonly', s => s.get(k)).catch(() => null); },
  put(k, v) { return this.op('readwrite', s => s.put(v, k)); },
  del(k) { return this.op('readwrite', s => s.delete(k)).catch(() => {}); },
};

// ------------------------------------------------------------ hooks called by machine-app
export async function init(api) {
  A = api;
  // like the original Blasta, a first visit starts on the Sound Blaster 16
  if (!new URLSearchParams(location.search).get('machine') && !localStorage.getItem('retrosynths.blasta.machine')) A.app.id = 'opl3';
  const saved = parseFloat(localStorage.getItem('blasta.era'));
  era = ORDER.indexOf(A.app.id); if (era < 0) era = 1;
  if (!isNaN(saved) && Math.round(saved) === era) era = saved;
  typeBoot();
  $('era').value = era;
  $('era').oninput = (e) => setEra(+e.target.value, true);
  document.querySelectorAll('.ticks button').forEach(b => b.onclick = () => setEra(+b.dataset.era));
  wireBanks(); wireLocker();
  $('lkUrl').value = locker.url || DEFAULT_LOCKER;
  if (emuEvents) emuEvents.addEventListener('progress', onBurn);
  if (publicOk()) locker.publicInfo().then(renderShelf).catch(() => {});
}
// the public shelf lives on the deployed locker; only ask for it from https pages or a configured locker
const publicOk = () => locker.configured || location.protocol === 'https:' || !!localStorage.getItem('blasta.locker.url');
/** before the first prep: use banks kept in this browser so the first burn is the right one */
export async function beforeAudio() {
  const [fmL, s2L, s3L] = await Promise.all([store.get('fm'), store.get('sf2'), store.get('sf3')]);
  for (const [core, rec] of [[2, s2L], [3, s3L]]) {
    if (!rec) continue;
    $('budget' + core).checked = rec.budget !== 'raw';
    setSource(CORE_ID[core], { name: rec.name, blob: rec.blob, budget: rec.budget || BUDGET[core], etag: rec.etag });
    $('st' + core).textContent = rec.name + ' — burning…';
  }
  if (fmL) await loadOP2(fmL.blob, fmL.name, { save: false, etag: fmL.etag, sync: false, pub: fmL.pub });
}
export async function afterAudio() {
  applyBlend();
  for (const id of ['awe32', 'live']) if (id !== A.app.id) A.runPrep(id);   // both wavetable banks burn in the background
  restoreSaved().catch(err => lkStat('Locker: ' + err.message));
}
export function renderMachine(id) {
  const c = CHIPS[id]; if (!c) return;
  $('chipLabel').textContent = c[0]; $('chip2').textContent = c[1]; $('silk').textContent = c[2];
  document.querySelector('.pcb').style.background = `linear-gradient(${c[3]}, ${shade(c[3])})`;
  updateMix();
}
export function editorCtx(id) { return id === 'opl2' || id === 'opl3' ? { loadOP2: (f) => loadOP2(f, f.name) } : {}; }
export async function onDrop(f) {
  const n = f.name.toLowerCase();
  if (n.endsWith('.sf2')) { await loadUserSF2(f, f.name, era >= 2.5 ? 3 : 2); return true; }
  if (n.endsWith('.op2')) { await loadOP2(f, f.name); return true; }
  return false;
}

// ------------------------------------------------------------ era
const shade = (hex) => '#' + hex.slice(1).match(/../g).map(h => Math.max(0, parseInt(h, 16) - 18).toString(16).padStart(2, '0')).join('');
function weights(e) {
  const w = {};
  ORDER.forEach((id, i) => { const d = Math.abs(e - i); w[id] = d >= 1 ? 0 : Math.pow(Math.cos(d * Math.PI / 2), 1.5); });
  return w;
}
function applyBlend() {
  const w = weights(era);
  A.post({ t: 'blend', w });
  for (const id of ORDER) {
    if (w[id] > 0 && id !== A.app.id && !primed.has(id)) { primed.add(id); A.primeMachine(id); if (id === 'awe32' || id === 'live') A.runPrep(id); }
    if (w[id] === 0) primed.delete(id);
  }
}
async function setEra(v, fromSlider) {
  era = Math.max(0, Math.min(3, v));
  if (!fromSlider) $('era').value = era;
  localStorage.setItem('blasta.era', String(era));
  const id = ORDER[Math.round(era)];
  if (A.node) applyBlend();
  updateMix();
  if (id !== A.app.id) {
    selecting = id;
    primed.add(A.app.id);               // the card we leave already has its instruments in the worklet
    primed.delete(id);
    await A.selectMachine(id, { seamless: true });
    if (selecting === id && A.node) applyBlend();
  }
}
function updateMix() {
  const lo = Math.floor(era), hi = Math.min(3, lo + 1), f = era - lo;
  $('eraMix').textContent = f > 0.02 && f < 0.98 ? `Crossfading ${SHORT[ORDER[lo]]} ${Math.round((1 - f) * 100)}% ↔ ${SHORT[ORDER[hi]]} ${Math.round(f * 100)}%` : '';
  document.querySelectorAll('.ticks button').forEach((b, k) => b.classList.toggle('on', Math.abs(era - k) < 0.02));
}

// ------------------------------------------------------------ boot text
function typeBoot() {
  const BOOT = ['RetroBIOS v4.51 · Plug and Pray Edition', 'PnP init ... OK', '',
    'Main Processor : PENTIUM-S 133MHz', 'Memory Testing : 16384K OK', '',
    'C:\\> SET BLASTER=A220 I5 D1 H5 P330 T6', 'C:\\> CD \\BLASTA', 'C:\\BLASTA> BLASTA.EXE /GM'];
  const el = $('bootText'); el.textContent = '';
  let i = 0;
  const step = () => { if (i < BOOT.length) { el.textContent += BOOT[i++] + '\n'; setTimeout(step, i < 3 ? 120 : 160); } };
  step();
}

// ------------------------------------------------------------ help topics (added to the shared Help window)
export function helpTopics() {
  return [
    ['era', 'The era slider', `
      <p>The slider at the top moves one song through four generations of PC sound card: AdLib (1989), Sound Blaster 16 (1992), AWE32 (1994) and Live! (1998).</p>
      <ul>
        <li><b>Drag</b> it, or use the arrow keys when it's focused. In between two cards you hear both, crossfaded, so you can morph a song from FM bleeps to sampled orchestra.</li>
        <li>The four buttons under the slider <b>jump</b> straight to one card.</li>
        <li>The Voices, Arranger and Instruments panels always show the card nearest the slider.</li>
      </ul>`],
    ['banks', 'Sound banks', `
      <p>Each card's instruments come from a bank. You can load your own; they're kept in this browser for next time.</p>
      <ul>
        <li><b>FM (AdLib / SB16): Load .OP2…</b> loads a DOS-game FM patch bank, such as the free DMXOPL.</li>
        <li><b>AWE32 / Live!: Load .SF2…</b> loads a SoundFont. Its own presets appear in the Instruments list by name. GM instruments it doesn't have fall back to the closest sound in the same family.</li>
        <li><b>ROM budget</b> squeezes a modern SoundFont down to what the real card could hold (lower sample rate, mono, shorter loops). Untick it if your SoundFont is already period-sized.</li>
        <li><b>Default</b> forgets your bank and goes back to the built-in one.</li>
        <li>You can also drop <code>.sf2</code> or <code>.op2</code> files onto the window.</li>
      </ul>`],
    ['locker', 'Bank Locker', `
      <p>Optional. If you run your own Bank Locker (a small private Cloudflare store, see <code>locker/README.md</code> in the code), enter its address and password and press <b>Unlock</b>. Banks you load are then also saved there, behind your password, and follow you to other devices.</p>
      <ul>
        <li><b>Upload…</b> adds banks. On each row, <b>→ FM</b>, <b>→ AWE32</b> or <b>→ Live!</b> loads it into that slot, <b>Public</b> shares it read-only, and <b>✕</b> deletes it.</li>
        <li><b>Public banks</b> are read-only banks the site owner has shared. Anyone can load one into their own slots, but no one else can change them.</li>
      </ul>`],
  ];
}

// ------------------------------------------------------------ sound banks
const prog = (f) => { $('progBar').style.width = Math.round(f * 100) + '%'; };
const mb = (b) => (b / 1048576).toFixed(b < 1048576 * 10 ? 2 : 1) + ' MB';
function onBurn(e) {
  const d = e.detail, core = d.id === 'awe32' ? 2 : d.id === 'live' ? 3 : 0;
  if (!core) return;
  if (d.stage === 'load') { $('st' + core).textContent = (d.name || 'bank') + ' — reading…'; prog(0.05); }
  else if (d.stage === 'burn') { $('st' + core).textContent = 'burning ROM…'; prog(0.1 + d.progress * 0.9); }
  else if (d.stage === 'done') {
    const src = getSource(d.id);
    const label = (src ? src.name : 'GeneralUser GS') + (d.budget === 'raw' ? '' : d.budget === 'awe' ? ' → AWE-style ROM' : ' → Live!-style bank');
    $('st' + core).textContent = `${label} · ${mb(d.bytes)} of samples` + (src ? (src.pub ? SITE : PIN) : '');
    prog(1); setTimeout(() => prog(0), 800);
    burned.add(d.id);
    if (burned.has('awe32') && burned.has('live')) A.setStatus('All four cards ready.');
  }
}
const burned = new Set();
async function saveBank(key, rec, statusEl, pub = false) {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    await store.put(key, rec);
    if (statusEl && !statusEl.textContent.includes('📌')) statusEl.textContent += pub ? SITE : PIN;
  } catch (err) {
    if (statusEl) statusEl.textContent += ' · not saved (' + (err.name === 'QuotaExceededError' ? 'browser storage full' : err.message) + ')';
  }
}
async function loadUserSF2(blob, name, core, { save = true, jump = true, etag = null, sync = true, pub = false } = {}) {
  const id = CORE_ID[core], budget = $('budget' + core).checked ? BUDGET[core] : 'raw';
  setSource(id, { name, blob, budget, etag, pub });
  $('st' + core).textContent = 'reading ' + name + '…';
  try {
    if (A.node) await A.runPrep(id, true);
    const rec = { name, budget, blob, etag, pub };
    if (save) await saveBank('sf' + core, rec, null, pub);
    if (jump) setEra(core);
    if (sync) syncSlot('sf' + core, rec);
  } catch (err) { $('st' + core).textContent = 'error: ' + err.message; }
}
async function useBuiltin(core) {
  setSource(CORE_ID[core], null);
  $('budget' + core).checked = true;
  $('st' + core).textContent = 'GeneralUser GS — burning…';
  if (A.node) await A.runPrep(CORE_ID[core], true);
}
/** an .op2 bank replaces the 175 GM-slot patches of both FM cards (kept as instrument edits) */
async function loadOP2(blob, name, { save = true, etag = null, sync = true, pub = false } = {}) {
  try {
    const mark = `${name}|${etag || (blob.size || '')}`;
    if (!save && localStorage.getItem(FM_MARK) === mark) { $('stFM').textContent = name + (pub ? SITE : PIN); return; }   // already applied (keeps later edits)
    const list = parseOP2(await blob.arrayBuffer());
    const entries = Object.fromEntries(list.map((p, i) => [i, p]));
    for (const id of ['opl2', 'opl3']) { A.applyTable(entries, id); if (id !== A.app.id && A.node && weights(era)[id] > 0) A.primeMachine(id); }
    localStorage.setItem(FM_MARK, mark);
    $('stFM').textContent = name;
    const rec = { name, blob, etag, pub };
    if (save) await saveBank('fm', rec, $('stFM'), pub);
    else $('stFM').textContent += pub ? SITE : PIN;
    if (sync) { if (era > 1.5) setEra(1); syncSlot('fm', rec); }
  } catch (err) { $('stFM').textContent = 'error: ' + err.message; }
}
function resetFM() {
  for (const id of ['opl2', 'opl3']) { A.resetTable(id); if (id !== A.app.id && A.node && weights(era)[id] > 0) A.primeMachine(id); }
  localStorage.removeItem(FM_MARK);
  $('stFM').textContent = 'Blasta Original FM';
}
function wireBanks() {
  $('fileOP2').onchange = (e) => { const f = e.target.files[0]; if (f) loadOP2(f, f.name); e.target.value = ''; };
  for (const [fid, core] of [['fileSF2a', 2], ['fileSF2b', 3]]) {
    $(fid).onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; if (!A.node) await A.powerOn(); loadUserSF2(f, f.name, core); };
    $('budget' + core).onchange = async () => {      // flipping the box re-burns the saved bank the new way
      const saved = await store.get('sf' + core);
      if (saved) loadUserSF2(saved.blob, saved.name, core, { save: true, jump: false, etag: saved.etag, sync: false });
      else if (getSource(CORE_ID[core])) { const s = getSource(CORE_ID[core]); loadUserSF2(s.blob, s.name, core, { save: false, jump: false, etag: s.etag, sync: false, pub: s.pub }); }
      // the built-in bank always burns to the card's ROM shape; the box applies to the next bank you load
    };
    $('reset' + core).onclick = async () => {
      await store.del('sf' + core);
      if (locker.unlocked) await locker.setSlot('sf' + core, null).then(refreshLocker).catch(() => {});
      const def = await publicSource(locker.pub.slots && locker.pub.slots['sf' + core], null);
      if (def) { $('budget' + core).checked = def.budget !== 'raw'; loadUserSF2(def.blob, def.name, core, { jump: false, etag: def.etag, sync: false, pub: true, save: true }); }
      else useBuiltin(core);
    };
  }
  $('btnFMReset').onclick = async () => {
    await store.del('fm');
    if (locker.unlocked) await locker.setSlot('fm', null).then(refreshLocker).catch(() => {});
    const def = await publicSource(locker.pub.slots && locker.pub.slots.fm, null);
    if (def) loadOP2(def.blob, def.name, { etag: def.etag, sync: false, pub: true });
    else resetFM();
  };
}

// ------------------------------------------------------------ Bank Locker
function lkStat(s) { $('lkStat').textContent = s; }
async function pickSource(remote, local) {
  if (!remote) return local;
  if (local && local.name === remote.name && local.etag && local.etag === remote.etag) return { ...local, budget: remote.budget ?? local.budget };
  try {
    lkStat(`Downloading ${remote.name} from the locker…`);
    return { name: remote.name, etag: remote.etag, budget: remote.budget, blob: await locker.download(remote.name) };
  } catch (err) { lkStat('Locker download failed (' + err.message + ') — using this device\'s copy.'); return local; }
}
async function publicSource(entry, local) {
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
  if (!remoteOnly && publicOk()) { try { await locker.publicInfo(); } catch {} renderShelf(); }
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
    if (fm && !(fmL && fm.name === fmL.name && fm.etag === fmL.etag)) await loadOP2(fm.blob, fm.name, { save: true, etag: fm.etag, sync: false, pub: fm.pub });
    else if (!fm && !fmL) $('stFM').textContent = 'Blasta Original FM';
  }
  for (const [core, local, remote, pubEntry] of [[2, s2L, cfg.sf2, pubSlots.sf2], [3, s3L, cfg.sf3, pubSlots.sf3]]) {
    if (remoteOnly && !remote) continue;
    const src = await resolve(remote, local, pubEntry);
    const cur = getSource(CORE_ID[core]);
    if (src && !(cur && cur.name === src.name && (cur.etag || null) === (src.etag || null) && (cur.budget === (src.budget || BUDGET[core])))) {
      $('budget' + core).checked = src.budget !== 'raw';
      await loadUserSF2(src.blob, src.name, core, { save: src !== local, jump: false, etag: src.etag, sync: false, pub: src.pub });
    }
  }
  lkStat(locker.unlocked ? 'Unlocked.' : (locker.pub.banks.length ? 'Public banks available below. Unlock to manage.' : 'Locked.'));
}
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
function wireLocker() {
  $('lkLogin').onsubmit = async (e) => {
    e.preventDefault();
    const url = $('lkUrl').value.trim(), pw = $('lkPw').value;
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) { lkStat('Enter the https:// address of your locker Worker.'); return; }
    lkStat('Unlocking…');
    try {
      await locker.unlock(url, pw, $('lkRemember').checked);
      $('lkPw').value = '';
      lockerOpened();
      lkStat('Unlocked.');
      if (A.node) restoreSaved({ remoteOnly: true });
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
}
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
    const add = (label, fn, title) => { const x = document.createElement('button'); x.className = 'btn small'; x.type = 'button'; x.textContent = label; x.title = title || ''; x.setAttribute('aria-label', `${title || label}: ${b.name}`); x.onclick = fn; btns.appendChild(x); };
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
function pubState() { return { banks: locker.pub.banks.map(b => b.name), slots: { ...(locker.pub.slots || {}) } }; }
async function togglePublic(name, on, box) {
  const st = pubState();
  st.banks = on ? [...new Set([...st.banks, name])] : st.banks.filter(n => n !== name);
  if (!on) for (const k of Object.keys(st.slots)) if (st.slots[k].name === name) delete st.slots[k];
  try { await locker.setPublic(st); lkStat(on ? `${name} is now public (read-only for visitors).` : `${name} is private again.`); }
  catch (err) { box.checked = !on; lkStat('Could not change sharing: ' + err.message); }
  renderShelf();
}
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
    const add = (label, slot) => { const x = document.createElement('button'); x.className = 'btn small'; x.type = 'button'; x.textContent = label; x.setAttribute('aria-label', `Load ${b.name} into the ${label.slice(2)} slot`); x.onclick = () => takePublic(b, slot); btns.appendChild(x); };
    if (b.kind === 'op2') add('→ FM', 'fm'); else { add('→ AWE32', 2); add('→ Live!', 3); }
    box.appendChild(row);
  }
}
async function takePublic(b, slot) {
  if (!A.node) await A.powerOn();
  lkStat(`Fetching ${b.name}…`);
  let blob;
  try { blob = await locker.publicDownload(b.name); } catch (err) { lkStat('Download failed: ' + err.message); return; }
  const opts = { etag: b.etag, pub: false };
  if (slot === 'fm') await loadOP2(blob, b.name, opts); else await loadUserSF2(blob, b.name, slot, opts);
  lkStat(`${b.name} loaded.`);
}
async function assign(b, slot) {
  if (!A.node) await A.powerOn();
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
