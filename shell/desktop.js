// RetroSynths desktop: a make-believe early-'90s shell hosting the apps in movable windows.
// Every control here is a real button, every menu item does something, and it all works by keyboard.
const $ = (id) => document.getElementById(id);
const touch = matchMedia('(pointer: coarse)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = () => innerWidth <= 760;

// 16×16 pixel icons (original drawings)
const px = (rects) => `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${rects.map(([x, y, w, h, c]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`).join('')}</svg>`;
const ICONS = {
  blasta: px([[1, 3, 14, 8, '#0b3317'], [2, 4, 12, 6, '#1f6b35'], [3, 5, 5, 3, '#111'], [9, 5, 3, 2, '#111'], [13, 5, 1, 1, '#999'], [13, 7, 1, 1, '#999'],
    [3, 11, 1, 2, '#d9a52b'], [5, 11, 1, 2, '#d9a52b'], [7, 11, 1, 2, '#d9a52b'], [9, 11, 1, 2, '#d9a52b'], [11, 11, 1, 2, '#d9a52b'], [0, 3, 1, 9, '#808080']]),
  console: px([[2, 6, 12, 6, '#000'], [3, 5, 10, 6, '#9a9a9a'], [2, 7, 12, 4, '#9a9a9a'], [4, 7, 3, 1, '#111'], [5, 6, 1, 3, '#111'], [10, 6, 2, 2, '#c62828'], [12, 8, 2, 2, '#c62828'],
    [7, 9, 2, 1, '#555'], [3, 11, 3, 1, '#9a9a9a'], [10, 11, 3, 1, '#9a9a9a'], [7, 2, 2, 3, '#000']]),
  oldschool: px([[3, 1, 10, 8, '#000'], [4, 2, 8, 6, '#d8ccad'], [5, 3, 6, 4, '#0d2a0d'], [6, 4, 3, 1, '#4cff6a'], [6, 5, 2, 1, '#4cff6a'], [1, 10, 14, 4, '#000'], [2, 11, 12, 2, '#d8ccad'],
    [3, 11, 2, 1, '#e2463b'], [5, 11, 2, 1, '#f6c33c'], [7, 11, 2, 1, '#3aa84f'], [9, 11, 2, 1, '#2f9ad7'], [7, 9, 2, 1, '#808080']]),
  readme: px([[3, 1, 10, 14, '#000'], [4, 2, 8, 12, '#fff'], [5, 4, 6, 1, '#2f6fd0'], [5, 6, 6, 1, '#2f6fd0'], [5, 8, 6, 1, '#2f6fd0'], [5, 10, 4, 1, '#2f6fd0'], [4, 1, 1, 2, '#808080'], [7, 1, 1, 2, '#808080'], [10, 1, 1, 2, '#808080']]),
  bigapple: px([[0, 0, 16, 16, '#0b1030'], [2, 2, 1, 1, '#fff6a0'], [7, 1, 1, 1, '#fff6a0'], [13, 3, 1, 1, '#fff6a0'], [10, 1, 1, 1, '#c9d4ff'],
    [1, 7, 4, 9, '#000'], [5, 4, 3, 12, '#111'], [8, 8, 3, 8, '#000'], [11, 5, 4, 11, '#111'], [6, 3, 1, 1, '#111'],
    [2, 9, 1, 1, '#ffd23c'], [3, 11, 1, 1, '#ffd23c'], [6, 6, 1, 1, '#ffd23c'], [6, 9, 1, 1, '#ffd23c'], [7, 12, 1, 1, '#ffd23c'], [9, 10, 1, 1, '#ffd23c'],
    [12, 7, 1, 1, '#ffd23c'], [13, 9, 1, 1, '#ffd23c'], [12, 12, 1, 1, '#ffd23c'], [14, 11, 1, 1, '#ffd23c'], [2, 13, 1, 1, '#ffd23c']]),
  qslowdem: px([[3, 3, 10, 2, '#000'], [2, 4, 3, 3, '#000'], [11, 4, 3, 3, '#000'], [7, 5, 2, 2, '#000'],
    [1, 8, 14, 1, '#000'], [1, 9, 14, 4, '#d8d2c4'], [1, 13, 14, 1, '#808080'], [0, 8, 1, 6, '#000'], [15, 8, 1, 6, '#000'],
    [3, 10, 1, 1, '#e2463b'], [5, 10, 1, 1, '#3aa84f'], [7, 10, 1, 1, '#f2c63a'], [9, 10, 1, 1, '#3aa84f'], [11, 11, 3, 1, '#404040']]),
  shelf: px([[1, 2, 14, 12, '#000'], [2, 3, 12, 10, '#fff'], [2, 3, 12, 2, '#000080'], [4, 7, 2, 2, '#e2463b'], [7, 7, 2, 2, '#3aa84f'], [10, 7, 2, 2, '#2f6fd0'], [4, 10, 2, 2, '#f2c63a'], [7, 10, 2, 2, '#0b1030']]),
  townies: px([[0, 13, 16, 3, '#3a8a3a'], [3, 8, 7, 5, '#e9dcc0'], [2, 7, 9, 1, '#b0402a'], [3, 6, 7, 1, '#b0402a'], [5, 5, 3, 1, '#b0402a'],
    [6, 10, 1, 3, '#5a3a1a'], [4, 9, 1, 1, '#6fb0e0'], [8, 9, 1, 1, '#6fb0e0'], [12, 10, 1, 3, '#6b4a2b'], [11, 6, 3, 4, '#2f7d32'], [12, 5, 1, 1, '#2f7d32']]),
};
const APPS = {
  blasta: { title: 'Blasta', label: 'Blasta', src: 'apps/blasta/index.html?embed=1', w: 1040, desc: 'PC sound cards, 1989 to 1998' },
  console: { title: 'Console', label: 'Console', src: 'apps/console/index.html?embed=1', w: 1040, desc: 'Game console sound chips' },
  oldschool: { title: 'Old School', label: 'Old School', src: 'apps/oldschool/index.html?embed=1', w: 1040, desc: 'Home computer sound chips' },
  readme: { title: 'Read Me - README.TXT', label: 'Read Me', text: true, w: 600, h: 560, desc: 'How to use RetroSynths' },
  bigapple: { title: 'Big Apple Sam', label: 'Big Apple Sam', src: 'https://samuelling.github.io/Big-Apple-Sam/', w: 1100, h: 760, ext: true, desc: 'A city of lit windows, every one a life' },
  qslowdem: { title: 'Q-Slowdem — MEGAzine BBS', label: 'Q-Slowdem', src: 'https://samuelling.github.io/BBS/', w: 900, h: 680, ext: true, desc: 'Terminal program, dials the MEGAzine BBS' },
  townies: { title: 'Townies', label: 'Townies', src: 'https://samuelling.github.io/Townies/', w: 1200, h: 820, ext: true, desc: 'Run the real town of Watertown, MA' },
};
const GROUP1 = ['blasta', 'console', 'oldschool', 'readme'], GROUP2 = ['bigapple', 'qslowdem', 'townies'];
const README = `RetroSynths 3.1
===============

A make-believe early-'90s desktop. Each music program plays
your computer keyboard, a MIDI keyboard or MIDI files through
an emulation of a real vintage sound chip.

GETTING AROUND
--------------
* Double-click an icon to open it (one tap on a phone).
  With the keyboard: Tab to an icon, arrow keys to move,
  Enter to open.
* Drag a window by its title bar. Drag the bottom-right corner
  to resize it. The arrows at the top right minimize and
  maximize it. The bar at the top left opens its menu
  (Restore, Minimize, Maximize, Close). Alt+F4 closes a window.
* Window menu: jump between open windows or cascade them.

PLAYING MUSIC (Blasta, Console, Old School)
-------------------------------------------
* Press Demo, or the Space bar, to hear a song.
* No MIDI keyboard? Type on your computer keyboard. The
  letters are printed on the on-screen piano at the bottom:

     black keys:    W  E     T  Y  U     O  P
     white keys:  A  S  D  F  G  H  J  K  L  ;

  Z / X shift the octave down / up.
* "Keyboard plays" (bottom left) picks the sound.
* Open… plays your own MIDI file (or drag one onto the window).
* Each app's Help menu (or F1) explains everything else:
  Voices, Arranger, instrument editors, drum kits and saving.

THE PROGRAMS
------------
BLASTA      PC sound cards, 1989–1998: an FM card, its
            stereo successor, and two wavetable cards.
            Slide between eras; load your own sound banks.

CONSOLE     NES · Super Nintendo · Genesis / Mega Drive ·
            TurboGrafx-16 · Game Boy.

OLD SCHOOL  Apple IIe + Mockingboard · Commodore 64 (SID) ·
            Atari 2600 · Atari 800 · ZX Spectrum 128 · MSX ·
            IBM PC speaker.

megaZINE    Friends from the zine, running in windows:
            Big Apple Sam (a city at night, every window a
            life), Q-Slowdem (a terminal that dials the
            MEGAzine BBS) and Townies (run the real town of
            Watertown, MA). They also work on their own;
            "Open in new tab" is in each window's menu.

No game, ROM or console sample data is included. Machine
names are trademarks of their owners, used only to describe
the hardware being emulated. This desktop is an affectionate
look-alike, not anyone's operating system.
`;

// ------------------------------------------------------------ boot
const DOS = ['Starting RetroDOS...', '', 'Testing extended memory... 16384K OK', '', 'C:\\> SET BLASTER=A220 I5 D1 H5 P330 T6', 'C:\\> RETRO'];
let booted = false;
function finishBoot() {
  if (booted) return; booted = true;
  $('dos').hidden = true; $('splash').hidden = true;
  sessionStorage.setItem('retrosynths.booted', '1');
  if (!openFromHash()) { const first = document.querySelector('#icons .icon'); if (first) { selectIcon(first); first.focus(); } }
}
function boot() {
  if (reduced || sessionStorage.getItem('retrosynths.booted')) { finishBoot(); return; }
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
const PM = { win: null, minIcon: null };
function activate(win, focus = true) {
  document.querySelectorAll('.win.active').forEach(w => { if (w !== win) w.classList.remove('active'); });
  win.classList.add('active'); win.style.zIndex = ++z;
  // give the app the keyboard straight away, so typing plays notes without clicking inside first
  const f = win.querySelector(':scope > iframe');
  if (focus && f && document.activeElement !== f) f.focus();
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
  tb.addEventListener('dblclick', (e) => { if (!e.target.closest('.sys, .tbb')) toggleMax(win); });
  win.addEventListener('pointerdown', () => activate(win, false), true);
  win.addEventListener('focusin', () => { if (!win.classList.contains('active')) activate(win, false); });
}
function toggleMax(win, on) {
  const m = win.classList.toggle('maxed', on);
  const b = win.querySelector('.tb .max'); if (b) { b.innerHTML = m ? '&#8661;' : '&#9650;'; b.setAttribute('aria-label', (m ? 'Restore ' : 'Maximize ') + win.dataset.name); b.title = m ? 'Restore' : 'Maximize'; }
}

// ------------------------------------------------------------ menus (keyboard: arrows move, Enter picks, Esc closes)
let menuOpener = null;
function popMenu(opener, items) {
  closeMenus();
  const r = opener.getBoundingClientRect();
  const m = document.createElement('div'); m.className = 'sysmenu'; m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') { const hr = document.createElement('hr'); hr.setAttribute('role', 'separator'); m.appendChild(hr); continue; }
    const d = document.createElement('button'); d.type = 'button'; d.setAttribute('role', 'menuitem'); d.tabIndex = -1;
    d.innerHTML = `<span></span><span class="acc"></span>`;
    d.firstChild.textContent = (it[3] ? '✓ ' : '') + it[0]; d.lastChild.textContent = it[2] || '';
    d.onclick = (e) => { e.stopPropagation(); closeMenus(false); it[1](); };
    m.appendChild(d);
  }
  m.style.left = Math.min(r.left, innerWidth - 200) + 'px'; m.style.top = r.bottom + 'px'; m.style.zIndex = 100000;
  document.body.appendChild(m);
  menuOpener = opener; opener.setAttribute('aria-expanded', 'true');
  const btns = [...m.querySelectorAll('button')];
  btns[0] && btns[0].focus();
  m.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); btns[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); btns[btns.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenus(); }
  });
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
}
function onOutside(e) { if (!e.target.closest('.sysmenu')) closeMenus(false); }
function closeMenus(refocus = true) {
  document.removeEventListener('pointerdown', onOutside, true);
  document.querySelectorAll('.sysmenu').forEach(m => m.remove());
  if (menuOpener) { menuOpener.setAttribute('aria-expanded', 'false'); if (refocus) menuOpener.focus(); menuOpener = null; }
}

function titleBar(name, closeLabel) {
  return `<div class="tb"><button type="button" class="sys" aria-label="${name} window menu" aria-haspopup="menu" title="Window menu (double-click to ${closeLabel})">&#9644;</button><h2 class="tt"></h2><button type="button" class="tbb min" aria-label="Minimize ${name}" title="Minimize">&#9660;</button><button type="button" class="tbb max" aria-label="Maximize ${name}" title="Maximize">&#9650;</button></div>`;
}
function openApp(key) {
  const A = APPS[key];
  if (!A) return;
  const ex = open.get(key);
  if (ex) { restore(key); return; }
  const win = document.createElement('section');
  win.className = 'win app'; win.dataset.name = A.title; win.dataset.key = key;
  win.setAttribute('aria-label', A.title);
  const w = Math.min(A.w, innerWidth - 40), h = Math.min(A.h || 880, innerHeight - 40);
  const off = (cascade++ % 6) * 26;
  win.style.left = Math.max(4, Math.min(innerWidth - w - 4, 70 + off)) + 'px';
  win.style.top = Math.max(4, Math.min(innerHeight - h - 4, 34 + off)) + 'px';
  win.style.width = w + 'px'; win.style.height = h + 'px';
  win.innerHTML = titleBar(A.title, 'close');
  win.querySelector('.tt').textContent = A.title;
  if (A.text) {
    const t = document.createElement('div'); t.className = 'textview'; t.tabIndex = 0; t.setAttribute('role', 'document'); t.setAttribute('aria-label', A.title);
    t.textContent = README; win.appendChild(t);
  } else {
    const f = document.createElement('iframe');
    f.src = A.src; f.title = A.title;
    f.allow = 'autoplay; midi; fullscreen; clipboard-write';
    f.addEventListener('load', () => { if (win.classList.contains('active') && !menuOpener) f.focus(); });
    win.appendChild(f);
  }
  if (small()) toggleMax(win, true);
  $('desktop').appendChild(win);
  makeDraggable(win);
  win.querySelector('.min').onclick = () => minimize(key);
  win.querySelector('.max').onclick = () => toggleMax(win);
  const sys = win.querySelector('.sys');
  sys.onclick = () => popMenu(sys, [['Restore', () => toggleMax(win, false)], ['Minimize', () => minimize(key)], ['Maximize', () => toggleMax(win, true)],
    ...(A.src ? ['-', ['Open in new tab', () => window.open(A.ext ? A.src : A.src.replace('?embed=1', ''), '_blank', 'noopener')]] : []),
    '-', ['Close', () => closeApp(key), 'Alt+F4']]);
  sys.ondblclick = () => closeApp(key);
  open.set(key, { win, minIcon: null });
  $('deskHint').hidden = true;
  activate(win);
  if (A.text) win.querySelector('.textview').focus();
  history.replaceState(null, '', '#' + key);
}
function closeApp(key) {
  const o = open.get(key); if (!o) return;
  o.win.remove(); if (o.minIcon) o.minIcon.remove();
  open.delete(key);
  if (location.hash === '#' + key) history.replaceState(null, '', location.pathname + location.search);
  const ic = document.querySelector(`.pm-body .icon[data-key="${key}"]`);
  if (ic && !PM.minIcon) { selectIcon(ic); ic.focus(); }
}
function minIcon(key, label, onOpen) {
  const ic = iconEl(key, label);
  ic.setAttribute('aria-label', `${label} (minimized) — press Enter to restore`);
  ic.ondblclick = onOpen; ic.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } };
  if (touch) ic.onclick = onOpen;
  $('minimized').appendChild(ic);
  ic.focus();
  return ic;
}
function minimize(key) {
  const o = open.get(key); if (!o || o.minIcon) return;
  o.win.hidden = true;
  o.minIcon = minIcon(key, APPS[key].label, () => restore(key));
}
function restore(key) {
  const o = open.get(key); if (!o) return;
  o.win.hidden = false; if (o.minIcon) { o.minIcon.remove(); o.minIcon = null; }
  activate(o.win);
  if (APPS[key].text) o.win.querySelector('.textview').focus();
}
function cascadeAll() {
  let i = 0;
  for (const [, o] of open) {
    if (o.minIcon) continue;
    toggleMax(o.win, false);
    o.win.style.left = (40 + i * 28) + 'px'; o.win.style.top = (20 + i * 28) + 'px'; activate(o.win, false); i++;
  }
}
// focus follows clicks inside app iframes
window.addEventListener('blur', () => setTimeout(() => {
  const f = document.activeElement;
  if (f && f.tagName === 'IFRAME') activate(f.closest('.win'), false);
}, 0));
// a click or key on the desktop also wakes sound in open apps (same origin, so it counts as their gesture)
const wakeApps = () => document.querySelectorAll('.win iframe').forEach(f => { try { f.contentWindow.retroSynthsWake && f.contentWindow.retroSynthsWake(); } catch {} });
for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, wakeApps, { capture: true });

// ------------------------------------------------------------ Program Shelf
function iconEl(key, label) {
  const d = document.createElement('div');
  d.className = 'icon'; d.tabIndex = -1; d.dataset.key = key;
  d.setAttribute('role', 'button');
  d.innerHTML = ICONS[key] + '<span></span>';
  d.querySelector('span').textContent = label;
  d.addEventListener('click', () => selectIcon(d));
  return d;
}
function selectIcon(d) {
  document.querySelectorAll('.icon.sel').forEach(x => { x.classList.remove('sel'); if (x.closest('.pm-body')) x.tabIndex = -1; });
  d.classList.add('sel'); d.tabIndex = 0;
}
function buildGroup(box, keys) {
  for (const key of keys) {
    const A = APPS[key], ic = iconEl(key, A.label);
    ic.setAttribute('aria-label', `${A.label}: ${A.desc}`);
    ic.title = A.desc + (A.ext ? ' (from megaZINE)' : '');
    ic.ondblclick = () => openApp(key);
    if (touch) ic.onclick = () => openApp(key);
    ic.onkeydown = (e) => {
      const all = [...document.querySelectorAll('.pm-body .icon')], i = all.indexOf(ic);
      const go = (j) => { e.preventDefault(); const t = all[(j + all.length) % all.length]; selectIcon(t); t.focus(); };
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openApp(key); }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(i - 1);
      else if (e.key === 'Home') go(0); else if (e.key === 'End') go(all.length - 1);
    };
    box.appendChild(ic);
  }
}
(function buildShelf() {
  buildGroup($('icons'), GROUP1); buildGroup($('icons2'), GROUP2);
  const first = document.querySelector('#icons .icon'); first.tabIndex = 0;
  const pm = $('progman'); PM.win = pm; pm.dataset.name = 'Program Shelf';
  makeDraggable(pm); activate(pm, false);
  pm.querySelector('.max').onclick = () => toggleMax(pm);
  const minPM = () => { if (PM.minIcon) return; pm.hidden = true; PM.minIcon = minIcon('shelf', 'Program Shelf', restorePM); };
  const restorePM = () => { pm.hidden = false; if (PM.minIcon) { PM.minIcon.remove(); PM.minIcon = null; } activate(pm, false); const s = pm.querySelector('.icon.sel') || first; s.focus(); };
  pm.querySelector('.min').onclick = minPM;
  const sys = pm.querySelector('.sys');
  sys.onclick = () => popMenu(sys, [['Restore', () => toggleMax(pm, false)], ['Minimize', minPM], ['Maximize', () => toggleMax(pm, true)], '-', ['Exit RetroSynths…', exitPrompt, 'Alt+F4']]);
  sys.ondblclick = exitPrompt;
  $('mFile').onclick = () => popMenu($('mFile'), [
    ['Open', () => { const s = document.querySelector('.pm-body .icon.sel'); if (s) openApp(s.dataset.key); }, 'Enter'],
    '-', ['Exit RetroSynths…', exitPrompt]]);
  $('mWindow').onclick = () => {
    const list = [...open].map(([k, o]) => [APPS[k].title, () => restore(k), '', o.win.classList.contains('active') && !o.minIcon]);
    popMenu($('mWindow'), [['Cascade', cascadeAll], ['Program Shelf', restorePM, '', false], ...(list.length ? ['-', ...list] : [])]);
  };
  $('mHelp').onclick = () => popMenu($('mHelp'), [['How to use RetroSynths', () => openApp('readme')], ['About RetroSynths…', about]]);
  window.retroShelf = { restorePM };
})();
function about() {
  $('exitTitle').textContent = 'About RetroSynths'; $('exitText').innerHTML = 'RetroSynths 3.1<br>Retro sound chips you can play, in a desktop that never was.<br><br>Part of megaZINE.';
  $('exitCancel').hidden = true; $('exitDlg').dataset.mode = 'about'; showDlg();
}
function exitPrompt() {
  $('exitTitle').textContent = 'Exit RetroSynths'; $('exitText').textContent = 'This will end your RetroSynths session.';
  $('exitCancel').hidden = false; $('exitDlg').dataset.mode = 'exit'; showDlg();
}
let dlgReturn = null;
function showDlg() { dlgReturn = document.activeElement; $('exitDlg').hidden = false; $('exitOK').focus(); }
function hideDlg() { $('exitDlg').hidden = true; if (dlgReturn && dlgReturn.focus && document.contains(dlgReturn)) dlgReturn.focus(); }
$('exitCancel').onclick = hideDlg;
$('exitDlg').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); hideDlg(); }
  if (e.key === 'Tab') { const b = [$('exitOK'), $('exitCancel')].filter(x => !x.hidden); const i = b.indexOf(document.activeElement); e.preventDefault(); b[(i + (e.shiftKey ? -1 : 1) + b.length) % b.length].focus(); }
});
$('exitOK').onclick = () => {
  if ($('exitDlg').dataset.mode === 'about') { hideDlg(); return; }
  $('exitDlg').hidden = true;
  for (const k of [...open.keys()]) closeApp(k);
  sessionStorage.removeItem('retrosynths.booted');
  $('dosText').textContent = 'C:\\> '; $('dos').hidden = false; $('dos').removeAttribute('aria-hidden'); booted = false;
  $('dos').setAttribute('aria-label', 'Session ended. Press any key or click to start again.'); $('dos').tabIndex = 0; $('dos').focus();
  const again = () => { $('dos').removeEventListener('pointerdown', again); window.removeEventListener('keydown', again); $('dos').setAttribute('aria-hidden', 'true'); $('dosText').textContent = ''; boot(); };
  setTimeout(() => { $('dos').addEventListener('pointerdown', again); window.addEventListener('keydown', again); }, 300);
};
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'F4') {
    e.preventDefault();
    const a = document.querySelector('.win.app.active'); const k = a && [...open].find(([, o]) => o.win === a);
    if (k) closeApp(k[0]); else exitPrompt();
  }
});
function openFromHash() { const k = location.hash.slice(1); if (APPS[k]) { openApp(k); return true; } return false; }
window.addEventListener('hashchange', openFromHash);
boot();
