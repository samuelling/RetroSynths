// Help window for the RetroSynths apps (Console, Old School, Blasta) + accessible dialog plumbing.
// openHelp(ctx, topic) shows a two-pane help browser; topics are written for someone who has never
// touched a synth, with the app-specific bits (machine list, Blasta's banks) filled in from ctx.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const KEYMAP = `<pre class="keymap" aria-label="Keyboard layout: the middle letter row plays white keys, the row above plays black keys">
black keys:    W  E     T  Y  U     O  P
white keys:  A  S  D  F  G  H  J  K  L  ;
notes:       C  D  E  F  G  A  B  C  D  E
</pre>`;

function topics(c) {
  const blasta = c.GROUP === 'blasta';
  const thing = blasta ? 'sound card' : 'machine';
  const T = [];
  T.push(['start', 'Quick start', `
    <ol>
      <li><b>Press Demo</b> (or the <b>Space</b> bar) to hear a song.</li>
      <li><b>${blasta ? 'Drag the era slider' : 'Pick a machine'}</b> at the top. The same song now plays through that ${thing}'s own sound chip.</li>
      <li><b>Play notes yourself</b> by typing on your computer keyboard. The letters printed on the on-screen keys at the bottom show which key plays which note. You can also click or tap the keys.</li>
      <li><b>Change the sound</b> with the <i>Keyboard plays</i> menu at the bottom, or by picking from the Instruments list. Every instrument is made for that particular chip.</li>
      <li><b>Play your own music:</b> choose <b>Open…</b> or drag a MIDI file (<code>.mid</code>) onto the window.</li>
    </ol>
    <p>Nothing you do can break anything. If a note ever gets stuck, choose <b>Panic</b> in the menu.</p>`]);
  T.push(['keys', 'Playing with your computer keyboard', `
    <p>You don't need a music keyboard. Your computer keyboard works like a small piano:</p>
    ${KEYMAP}
    <ul>
      <li><b>Z</b> moves everything down an octave and <b>X</b> moves it up. You can also use the <b>◀ ▶</b> buttons next to <i>Oct</i>. The letters on the on-screen keys move along with you.</li>
      <li>Hold several letters at once to play a chord. Old chips have only a few voices, so if you hold more notes than the chip can play, the oldest note is cut off. That's how it really worked.</li>
      <li>Letters don't play notes while a menu, list or text box is active, because there they type or search. Click an empty spot (or press <b>Esc</b>) to go back to playing.</li>
      <li>The keyboard always plays the instrument shown in <i>Keyboard plays</i>. The demo or MIDI file can keep going underneath, so you can play along.</li>
      <li><b>Hide keys</b> folds the on-screen piano away. Your typing still plays.</li>
    </ul>
    <h3>A real MIDI keyboard</h3>
    <p>Plug it in, click the <b>MIDI in</b> menu and choose it. This works in Chrome, Edge and Firefox (the browser will ask permission). Safari doesn't support MIDI keyboards.</p>`]);
  const list = c.IDS.map((id) => {
    const i = c.MACHINES[id].info;
    return `<li><b>${esc(i.name)}</b> <span class="fine">(${esc(i.maker)}, ${i.year})</span><br>${esc(i.chip)}: ${esc(i.voices)}.</li>`;
  }).join('');
  T.push(['machines', blasta ? 'The four sound cards' : 'The machines', `
    <p>Each ${thing} is an emulation of its real sound chip, running at the chip's own speed. Its <b>Voices</b> panel shows how many sounds it can make at once, and that limit is real.</p>
    <ul class="mlist">${list}</ul>
    <p>Some ${thing}s have extra switches (chip revision, filter, stereo…) under the name at the top.</p>`]);
  T.push(['player', 'Playing MIDI files', `
    <p>General MIDI files (<code>.mid</code>, <code>.midi</code>, <code>.rmi</code>, <code>.kar</code>) play on any ${thing}. Load one with <b>Open…</b> or drag it onto the window.</p>
    <ul>
      <li><b>▶</b> plays and pauses (or press <b>Space</b>). <b>■</b> stops and goes back to the start.</li>
      <li>Drag the long slider to jump around the song. Tick <b>Loop</b> to repeat it.</li>
      <li><b>Volume</b> sets the overall level. The green <b>Output</b> trace shows the actual waveform the chip is making.</li>
    </ul>
    <p>A General MIDI song can use up to 16 instruments at once. Old chips have far fewer voices, so a period-style "driver" decides who gets which voice, just like game composers had to. The <b>Arranger</b> lets you take over.</p>`]);
  T.push(['voices', 'Voices', `
    <p>Each row is one of the chip's real sound channels. You can see what it's playing right now and how loud it is.</p>
    <ul>
      <li><b>Click</b> a row (or Tab to it and press <b>Enter</b>) to <b>mute</b> it. Do the same again to unmute.</li>
      <li><b>Double-click</b> (or <b>Shift+Enter</b>) to <b>solo</b> it, so you hear only that channel. Do it again to hear everything.</li>
    </ul>`]);
  T.push(['arranger', 'Arranger', `
    <p>The Arranger appears once a song is loaded. It has one row for each part of the song (each MIDI channel).</p>
    <ul>
      <li><b>MIDI part</b> is what the song asked for (for example "Electric Bass").</li>
      <li><b>Instrument</b>: <i>Auto</i> uses this ${thing}'s closest instrument. The name after "Auto ·" shows which one. Choose any other instrument to change that part.</li>
      <li><b>Voice</b>: <i>Auto</i> lets the driver share voices. Choose a channel to pin the part there (say, bass always on the triangle).</li>
      <li>Click a channel <b>number</b> to mute that part. <b>All Auto</b> undoes your choices.</li>
    </ul>
    <p>Your arrangement is remembered for each song on each ${thing}.</p>`]);
  T.push(['instruments', 'Instruments & editors', `
    <p>The Instruments list holds this ${thing}'s factory sounds, grouped by type, plus any you make. Click one to hear it on the keyboard and see its editor.</p>
    <ul>
      <li>The editor shows the chip's real settings: sliders, switches, envelopes, and wave or sequence drawings. Click or drag in a drawing to change it. Changes are heard right away and saved in this browser.</li>
      <li><b>Reset</b> puts a factory sound back the way it was.</li>
      <li><b>Copy</b> makes your own version, listed under <i>My instruments</i>. Only your own copies can be <b>Rename</b>d or <b>Delete</b>d.</li>
      <li><b>Export</b> saves all this ${thing}'s instrument changes to a file. <b>Import</b> loads them back, for example in another browser.</li>
    </ul>
    ${c.IDS.includes('snes') ? '<p class="fine">Super Nintendo: all samples must fit in 64 KB, so the machine re-packs them a moment after you change instruments.</p>' : ''}`]);
  T.push(['drums', 'Drum kit', `
    <p>Drums in a MIDI song (channel 10) are individual notes, such as kick, snare and hi-hat. <b>Drum kit…</b> (under the Instruments list) shows which of this ${thing}'s instruments plays each drum.</p>
    <ul>
      <li><b>▶</b> plays that drum.</li>
      <li>Choose an instrument to replace it, or leave <i>Auto</i> for the ${thing}'s own mapping.</li>
      <li>Press <b>Drum kit…</b> again to go back to the instrument editor.</li>
    </ul>`]);
  for (const x of c.extra || []) T.push(x);
  T.push(['saving', 'What gets saved', `
    <p>Everything stays in <b>this browser</b> on this device. Nothing is uploaded${blasta ? ' unless you unlock a Bank Locker' : ''}:</p>
    <ul>
      <li>which ${thing} you picked and its switches</li>
      <li>your instrument edits, your own instruments and drum kits</li>
      <li>your Arranger choices for each song</li>
      ${blasta ? '<li>sound banks you loaded</li>' : ''}
    </ul>
    <p>Clearing your browser's site data erases them. Use <b>Export</b> in Instruments to keep a copy.</p>`]);
  T.push(['access', 'Shortcuts & accessibility', `
    <table class="keys-table">
      <tr><th scope="row">Letters A…;</th><td>play notes (see <a href="#" data-topic="keys">Playing with your computer keyboard</a>)</td></tr>
      <tr><th scope="row">Z / X</th><td>octave down / up</td></tr>
      <tr><th scope="row">Space</th><td>play / pause the song (or press the focused button)</td></tr>
      <tr><th scope="row">Tab, Shift+Tab</th><td>move between controls</td></tr>
      <tr><th scope="row">Enter / Space</th><td>press a button, mute a voice</td></tr>
      <tr><th scope="row">Shift+Enter</th><td>solo a voice</td></tr>
      <tr><th scope="row">Arrow keys</th><td>change a slider, choose in lists, edit drawings (←/→ pick a step, ↑/↓ change it)</td></tr>
      <tr><th scope="row">F1</th><td>this Help</td></tr>
      <tr><th scope="row">Esc</th><td>close a window like this one, or leave a list so letters play notes again</td></tr>
    </table>
    <p>Every control works by keyboard and has a name for screen readers. The selected instrument, octave and status messages are announced. The on-screen piano is hidden from screen readers because the letter keys do the same job. Motion is reduced if your system asks for it.</p>`]);
  const about = $('aboutText');
  if (about) { const d = about.cloneNode(true); d.querySelectorAll('.row.right').forEach(n => n.remove()); T.push(['about', 'About ' + c.APP_NAME, d.innerHTML]); }
  return T;
}

let lastFocus = null, built = false;
function build() {
  if (built) return; built = true;
  const d = document.createElement('div');
  d.id = 'help'; d.className = 'dialog help'; d.hidden = true;
  d.innerHTML = `<div class="window" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
    <div class="titlebar"><button type="button" class="sysbox" data-close aria-label="Close Help">&#9644;</button><h2 class="title" id="helpTitle">Help</h2></div>
    <div class="help-bar"><button type="button" class="btn small" id="helpContents">Contents</button><button type="button" class="btn small" id="helpBack" disabled>Back</button><span class="help-gap"></span><button type="button" class="btn small" data-close>Close</button></div>
    <div class="help-panes"><nav class="help-nav" aria-label="Help topics" id="helpNav"></nav><article class="help-text" id="helpText" tabindex="-1"></article></div>
  </div>`;
  document.body.appendChild(d);
}
let hist = [], cur = null, TOP = [];
function show(id, push = true) {
  const t = TOP.find(x => x[0] === id) || TOP[0];
  if (push && cur && cur !== t[0]) hist.push(cur);
  cur = t[0];
  $('helpText').innerHTML = `<h3 class="help-h">${esc(t[1])}</h3>${t[2]}`;
  $('helpText').scrollTop = 0;
  $('helpNav').querySelectorAll('button').forEach(b => { const on = b.dataset.topic === cur; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  $('helpBack').disabled = !hist.length;
  $('helpText').querySelectorAll('a[data-topic]').forEach(a => a.onclick = (e) => { e.preventDefault(); show(a.dataset.topic); $('helpText').focus(); });
}
export function openHelp(ctx, topic) {
  build();
  TOP = topics(ctx);
  $('helpTitle').textContent = ctx.APP_NAME + ' Help';
  const nav = $('helpNav'); nav.innerHTML = '';
  for (const [id, title] of TOP) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.topic = id; b.textContent = title;
    b.onclick = () => { show(id); };
    nav.appendChild(b);
  }
  $('helpContents').onclick = () => { show(TOP[0][0]); nav.querySelector('button').focus(); };
  $('helpBack').onclick = () => { if (hist.length) show(hist.pop(), false); };
  hist = []; cur = null;
  show(topic || 'start', false);
  openDialog($('help'));
  nav.querySelector('button.on').focus();
}

// ------------------------------------------------------------ dialogs: focus in, Tab stays inside, Esc / close boxes close
export function openDialog(dlg) {
  lastFocus = document.activeElement;
  dlg.hidden = false;
  const f = dlg.querySelector('[autofocus], .help-nav button, .btn, button');
  if (f) f.focus();
}
export function closeDialog(dlg) {
  dlg.hidden = true;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}
export function wireDialogs() {
  build();
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]'); if (c) { closeDialog(c.closest('.dialog')); return; }
    if (e.target.classList && e.target.classList.contains('dialog')) closeDialog(e.target);   // click on the shade
  });
  const about = $('about');
  if (about) { const ok = $('aboutOK'); if (ok) ok.onclick = () => closeDialog(about); }
  document.addEventListener('keydown', (e) => {
    const open = [...document.querySelectorAll('.dialog')].find(d => !d.hidden);
    if (!open) {
      if (e.key === 'Escape' && document.activeElement && document.activeElement.matches('select, input')) document.activeElement.blur();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(open); return; }
    if (e.key === 'Tab') {
      const items = [...open.querySelectorAll('button:not([disabled]), a[href], input, select, [tabindex="0"]')].filter(x => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}
