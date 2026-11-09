// RetroSynths desktop: a little Windows 3.1 shell hosting the apps in movable windows.
const $ = (id) => document.getElementById(id);
const touch = matchMedia('(pointer: coarse)').matches;
const small = () => innerWidth <= 760;

// 16×16 pixel icons (original drawings)
const px = (rects) => `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">${rects.map(([x, y, w, h, c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join('')}</svg>`;
const ICONS = {
  blasta: px([[1, 3, 14, 8, '#0b3317'], [2, 4, 12, 6, '#1f6b35'], [3, 5, 5, 3, '#111'], [9, 5, 3, 2, '#111'], [13, 5, 1, 1, '#999'], [13, 7, 1, 1, '#999'],
    [3, 11, 1, 2, '#d9a52b'], [5, 11, 1, 2, '#d9a52b'], [7, 11, 1, 2, '#d9a52b'], [9, 11, 1, 2, '#d9a52b'], [11, 11, 1, 2, '#d9a52b'], [0, 3, 1, 9, '#808080']]),
  console: px([[2, 6, 12, 6, '#000'], [3, 5, 10, 6, '#9a9a9a'], [2, 7, 12, 4, '#9a9a9a'], [4, 7, 3, 1, '#111'], [5, 6, 1, 3, '#111'], [10, 6, 2, 2, '#c62828'], [12, 8, 2, 2, '#c62828'],
    [7, 9, 2, 1, '#555'], [3, 11, 3, 1, '#9a9a9a'], [10, 11, 3, 1, '#9a9a9a'], [7, 2, 2, 3, '#000']]),
  oldschool: px([[3, 1, 10, 8, '#000'], [4, 2, 8, 6, '#d8ccad'], [5, 3, 6, 4, '#0d2a0d'], [6, 4, 3, 1, '#4cff6a'], [6, 5, 2, 1, '#4cff6a'], [1, 10, 14, 4, '#000'], [2, 11, 12, 2, '#d8ccad'],
    [3, 11, 2, 1, '#e2463b'], [5, 11, 2, 1, '#f6c33c'], [7, 11, 2, 1, '#3aa84f'], [9, 11, 2, 1, '#2f9ad7'], [7, 9, 2, 1, '#808080']]),
  readme: px([[3, 1, 10, 14, '#000'], [4, 2, 8, 12, '#fff'], [5, 4, 6, 1, '#2f6fd0'], [5, 6, 6, 1, '#2f6fd0'], [5, 8, 6, 1, '#2f6fd0'], [5, 10, 4, 1, '#2f6fd0'], [4, 1, 1, 2, '#808080'], [7, 1, 1, 2, '#808080'], [10, 1, 1, 2, '#808080']]),
};
const APPS = {
  blasta: { title: 'Blasta', label: 'Blasta', src: 'apps/blasta/index.html?embed=1', w: 1040 },
  console: { title: 'Console', label: 'Console', src: 'apps/console/index.html?embed=1', w: 1040 },
  oldschool: { title: 'Old School', label: 'Old School', src: 'apps/oldschool/index.html?embed=1', w: 1040 },
  readme: { title: 'Notepad - README.TXT', label: 'Read Me', notepad: true, w: 560 },
};
const README = `RetroSynths 3.1 — a toolbox of retro sound chips
================================================

Double-click an icon to open it. Every app plays General MIDI
(MIDI files, the on-screen keys, your QWERTY keyboard or a
Web MIDI keyboard) through emulated period sound hardware.

BLASTA      PC sound cards, 1989–1998: AdLib / SB 2.0 (OPL2),
            Sound Blaster 16 (cycle-accurate OPL3), AWE32
            (EMU8000) and Sound Blaster Live! (EMU10K1).
            Slide between eras. Bank Locker for your own banks.

CONSOLE     NES · Super Nintendo · Genesis / Mega Drive ·
            TurboGrafx-16 · Game Boy.

OLD SCHOOL  Apple IIe + Mockingboard · Commodore 64 (SID) ·
            Atari 2600 (TIA) · Atari 800 (POKEY) ·
            ZX Spectrum 128 · MSX · IBM PC speaker.

Each machine runs an emulation of its own chip at the chip's
native clock, driven by a period-style music driver that
squeezes General MIDI into the hardware's few voices — the
way game composers had to.

Tips
----
* Drop a .mid file onto any app window.
* Space = play/pause. Z / X = octave down / up.
* Click a channel to mute it, double-click to solo.
* Windows can be dragged, resized, minimized and maximized.

No game, ROM or console sample data is included. Machine
names are trademarks of their owners, used only to describe
the hardware being emulated.
`;

// ------------------------------------------------------------ boot
const DOS = ['Starting MS-DOS...', '', 'HIMEM is testing extended memory...done.', '', 'C:\\> SET BLASTER=A220 I5 D1 H5 P330 T6', 'C:\\> WIN'];
let booted = false;
function finishBoot() {
  if (booted) return; booted = true;
  $('dos').hidden = true; $('splash').hidden = true;
  sessionStorage.setItem('retrosynths.booted', '1');
  openFromHash();
}
function boot() {
  if (sessionStorage.getItem('retrosynths.booted')) { finishBoot(); return; }
  const el = $('dosText'); let i = 0;
  const step = () => {
    if (booted) return;
    if (i < DOS.length) { el.textContent += DOS[i++] + '\n'; setTimeout(step, i === 1 ? 300 : 170); }
    else setTimeout(() => { if (booted) return; $('dos').hidden = true; $('splash').hidden = false; setTimeout(finishBoot, 1400); }, 300);
  };
  step();
  const skip = () => { window.removeEventListener('keydown', skip); finishBoot(); };
  window.addEventListener('keydown', skip);
  $('dos').addEventListener('pointerdown', skip); $('splash').addEventListener('pointerdown', skip);
}

// ------------------------------------------------------------ windows
let z = 10, cascade = 0;
const open = new Map();          // key → { win, minIcon }
function activate(win) {
  document.querySelectorAll('.win.active').forEach(w => { if (w !== win) w.classList.remove('active'); });
  win.classList.add('active'); win.style.zIndex = ++z;
}
function makeDraggable(win) {
  const tb = win.querySelector('.tb');
  tb.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sys, .tbb') || win.classList.contains('maxed')) return;
    activate(win);
    const r = win.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    tb.setPointerCapture(e.pointerId); win.classList.add('dragging');
    const move = (ev) => {
      win.style.left = Math.max(-r.width + 60, Math.min(innerWidth - 60, ev.clientX - dx)) + 'px';
      win.style.top = Math.max(0, Math.min(innerHeight - 24, ev.clientY - dy)) + 'px';
    };
    const up = () => { win.classList.remove('dragging'); tb.removeEventListener('pointermove', move); tb.removeEventListener('pointerup', up); };
    tb.addEventListener('pointermove', move); tb.addEventListener('pointerup', up);
  });
  tb.addEventListener('dblclick', (e) => { if (!e.target.closest('.sys, .tbb')) win.classList.toggle('maxed'); });
  win.addEventListener('pointerdown', () => activate(win), true);
}
function sysMenu(win, items, x, y) {
  closeMenus();
  const m = document.createElement('div'); m.className = 'sysmenu';
  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    const d = document.createElement('div'); d.innerHTML = `<span>${it[0]}</span><span>${it[2] || ''}</span>`;
    d.onclick = (e) => { e.stopPropagation(); closeMenus(); it[1](); };
    m.appendChild(d);
  }
  m.style.left = x + 'px'; m.style.top = y + 'px'; m.style.zIndex = ++z;
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('pointerdown', closeMenus, { once: true }), 0);
}
function closeMenus() { document.querySelectorAll('.sysmenu').forEach(m => m.remove()); }

function openApp(key) {
  const A = APPS[key];
  if (!A) return;
  const ex = open.get(key);
  if (ex) { restore(key); activate(ex.win); return; }
  const win = document.createElement('div');
  win.className = 'win app';
  const w = Math.min(A.w, innerWidth - 40), h = Math.min(A.notepad ? 520 : 880, innerHeight - 40);
  const off = (cascade++ % 6) * 26;
  win.style.left = Math.max(4, Math.min(innerWidth - w - 4, 70 + off)) + 'px';
  win.style.top = Math.max(4, Math.min(innerHeight - h - 4, 34 + off)) + 'px';
  win.style.width = w + 'px'; win.style.height = h + 'px';
  win.innerHTML = `<div class="tb"><span class="sys" title="Control menu (double-click to close)">&#9644;</span><span class="tt"></span><span class="tbb min" title="Minimize">&#9660;</span><span class="tbb max" title="Maximize">&#9650;</span></div>`;
  win.querySelector('.tt').textContent = A.title;
  if (A.notepad) {
    win.insertAdjacentHTML('beforeend', `<div class="menubar"><span class="menu"><u>F</u>ile</span><span class="menu"><u>E</u>dit</span><span class="menu"><u>S</u>earch</span><span class="menu"><u>H</u>elp</span></div><div class="notepad"></div>`);
    win.querySelector('.notepad').textContent = README;
  } else {
    const f = document.createElement('iframe');
    f.src = A.src; f.title = A.title;
    f.allow = 'autoplay; midi; fullscreen';
    win.appendChild(f);
  }
  if (small()) win.classList.add('maxed');
  $('desktop').appendChild(win);
  makeDraggable(win);
  win.querySelector('.min').onclick = () => minimize(key);
  win.querySelector('.max').onclick = () => win.classList.toggle('maxed');
  const sys = win.querySelector('.sys');
  sys.onclick = (e) => {
    const r = sys.getBoundingClientRect();
    sysMenu(win, [['Restore', () => win.classList.remove('maxed')], ['Minimize', () => minimize(key)], ['Maximize', () => win.classList.add('maxed')], '-', ['Close', () => closeApp(key), 'Alt+F4']], r.left, r.bottom);
  };
  sys.ondblclick = () => closeApp(key);
  open.set(key, { win, minIcon: null });
  activate(win);
  history.replaceState(null, '', '#' + key);
}
function closeApp(key) {
  const o = open.get(key); if (!o) return;
  o.win.remove(); if (o.minIcon) o.minIcon.remove();
  open.delete(key);
  if (location.hash === '#' + key) history.replaceState(null, '', location.pathname + location.search);
}
function minimize(key) {
  const o = open.get(key); if (!o || o.minIcon) return;
  o.win.hidden = true;
  const ic = iconEl(key, APPS[key].label);
  ic.ondblclick = () => restore(key);
  if (touch) ic.onclick = () => restore(key);
  $('minimized').appendChild(ic);
  o.minIcon = ic;
}
function restore(key) {
  const o = open.get(key); if (!o) return;
  o.win.hidden = false; if (o.minIcon) { o.minIcon.remove(); o.minIcon = null; }
  activate(o.win);
}
// a click or key on the desktop also wakes sound in open apps (same origin, so it counts as their gesture)
const wakeApps = () => document.querySelectorAll('.win iframe').forEach(f => { try { f.contentWindow.retroSynthsWake && f.contentWindow.retroSynthsWake(); } catch {} });
for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, wakeApps, { capture: true });
// focus follows clicks inside app iframes
window.addEventListener('blur', () => setTimeout(() => {
  const f = document.activeElement;
  if (f && f.tagName === 'IFRAME') activate(f.closest('.win'));
}, 0));

// ------------------------------------------------------------ Program Manager
function iconEl(key, label) {
  const d = document.createElement('div');
  d.className = 'icon'; d.tabIndex = 0; d.dataset.key = key;
  d.innerHTML = ICONS[key] + '<span></span>';
  d.querySelector('span').textContent = label;
  d.addEventListener('click', () => { document.querySelectorAll('.icon.sel').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); });
  return d;
}
(function buildIcons() {
  const box = $('icons');
  for (const key of ['blasta', 'console', 'oldschool', 'readme']) {
    const ic = iconEl(key, APPS[key].label);
    ic.ondblclick = () => openApp(key);
    if (touch) ic.onclick = () => openApp(key);
    ic.onkeydown = (e) => { if (e.key === 'Enter') openApp(key); };
    box.appendChild(ic);
  }
  const pm = $('progman');
  makeDraggable(pm); activate(pm);
  pm.querySelector('.max').onclick = () => pm.classList.toggle('maxed');
  pm.querySelector('.min').onclick = () => { pm.classList.toggle('maxed', false); };
  const sys = pm.querySelector('.sys');
  sys.onclick = () => { const r = sys.getBoundingClientRect(); sysMenu(pm, [['Restore', () => pm.classList.remove('maxed')], ['Maximize', () => pm.classList.add('maxed')], '-', ['Close', exitPrompt, 'Alt+F4']], r.left, r.bottom); };
  sys.ondblclick = exitPrompt;
  document.querySelectorAll('[data-open]').forEach(el => el.addEventListener(touch ? 'click' : 'dblclick', () => openApp(el.dataset.open)));
  document.querySelector('.menubar [data-open]').addEventListener('click', () => openApp('readme'));
  pm.querySelector('.menubar .menu').onclick = (e) => { const r = e.target.getBoundingClientRect(); sysMenu(pm, [['Open', () => { const s = document.querySelector('#icons .icon.sel'); if (s) openApp(s.dataset.key); }, 'Enter'], '-', ['Exit Windows…', exitPrompt]], r.left, r.bottom); };
})();
function exitPrompt() { $('exitDlg').hidden = false; }
$('exitCancel').onclick = () => { $('exitDlg').hidden = true; };
$('exitOK').onclick = () => {
  $('exitDlg').hidden = true;
  for (const k of [...open.keys()]) closeApp(k);
  sessionStorage.removeItem('retrosynths.booted');
  $('dosText').textContent = 'C:\\> '; $('dos').hidden = false; booted = false;
  const again = () => { $('dos').removeEventListener('pointerdown', again); window.removeEventListener('keydown', again); $('dosText').textContent = ''; boot(); };
  setTimeout(() => { $('dos').addEventListener('pointerdown', again); window.addEventListener('keydown', again); }, 300);
};
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'F4') { e.preventDefault(); const a = document.querySelector('.win.app.active'); const k = a && [...open].find(([, o]) => o.win === a); if (k) closeApp(k[0]); }
});
function openFromHash() { const k = location.hash.slice(1); if (APPS[k]) openApp(k); }
window.addEventListener('hashchange', openFromHash);
boot();
