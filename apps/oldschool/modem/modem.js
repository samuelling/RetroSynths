// RetroSynths "Old School" → Modem. A sound generator that synthesises dial-up sessions from both ends.
//   mountModem(container, { ctx, destination, setStatus }) -> { unmount(), command(str) }
import { ATModem, lookupNumber, farPlan, modemPlan } from './at.js';
import { MODELS, SERVERS, PHONEBOOK, REGIONS, ANSWER_KINDS, PROTO_NAME, modelById } from './models.js';
import { farSession } from './bbs.js';

const WORKLET_URL = new URL('./worklet.js', import.meta.url);
const loaded = new WeakMap();              // AudioContext -> Promise (addModule once per context)
let uid = 0;

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

export function mountModem(container, { ctx, destination, setStatus = () => {} } = {}) {
  if (!ctx) throw new Error('mountModem needs an AudioContext');
  const id = 'md' + (++uid);
  const dest = destination || ctx.destination;
  const book = PHONEBOOK.map(e => ({ ...e }));
  const timers = new Set(); const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  let node = null, out = null, dead = false, raf = 0, queue = [], session = null, tNow = 0, region = 'na', quality = 0.85;
  const tap = { on: false, line: [], spk: [] };
  const evLog = [], debugWait = [];

  // ------------------------------------------------------------ DOM
  container.classList.add('modem');
  const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };

  const plate = h('div', { class: 'plate md-plate', 'aria-hidden': 'true' });
  const mName = h('div', { class: 'mname' }), mKind = h('div', { class: 'mchip' }), mSpec = h('div', { class: 'mspec' });
  const LEDS = [['HS', 'High speed'], ['AA', 'Auto answer'], ['CD', 'Carrier detect'], ['OH', 'Off hook'], ['RD', 'Receive data'], ['SD', 'Send data'], ['TR', 'Terminal ready'], ['MR', 'Modem ready']];
  const ledEls = {};
  const ledBox = h('div', { class: 'md-leds', role: 'group', 'aria-label': 'Front panel lights' },
    LEDS.map(([k, t]) => { const l = h('span', { class: 'md-led', title: t }, h('i', { 'aria-hidden': 'true' }), h('b', { text: k }), h('span', { class: 'md-sr', text: ' ' + t + ': off' })); ledEls[k] = l; return l; }));
  const presets = h('div', { class: 'mpick md-presets', role: 'group', 'aria-label': 'Modem model (loads its init string)' },
    MODELS.map(m => h('button', { type: 'button', 'data-id': m.id, title: m.blurb, onclick: () => pickModel(m.id) }, m.name, h('br'), h('small', { text: `${m.year} · ${m.kind}` }))));
  const modelBox = h('fieldset', { class: 'group md-model' }, h('legend', {}, 'Modem ', h('small', { text: '(invented brands, real protocols)' })),
    h('div', { class: 'mtop' }, plate, h('div', { class: 'minfo' }, mName, mKind, mSpec), ledBox), presets);

  const screen = h('div', { class: 'md-screen lcd', role: 'log', 'aria-label': 'Terminal', tabindex: '0' });
  const cmd = h('input', { class: 'md-cmd', id: id + '-cmd', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': id + '-hint' });
  const hint = h('div', { class: 'md-hint', id: id + '-hint', text: 'Type AT commands, e.g. ATDT555-0142. Enter sends, Up/Down recalls history. While dialling, any key aborts. +++ escapes to command mode.' });
  const btnSend = h('button', { type: 'button', class: 'btn', onclick: () => submit() }, 'Send');
  const btnHang = h('button', { type: 'button', class: 'btn md-hang', onclick: () => { resume(); at.hangupButton(); cmd.focus(); } }, 'Hang up');
  const termBox = h('fieldset', { class: 'group md-term' }, h('legend', { text: 'Terminal' }), screen,
    h('div', { class: 'row md-cmdrow' }, h('label', { for: id + '-cmd', text: 'Command' }), cmd, btnSend, btnHang), hint);

  // phonebook
  const bookRows = h('tbody');
  const ansSelect = (e, i) => {
    const s = h('select', { 'aria-label': `What answers ${e.name}`, onchange: () => { book[i].answer = s.value; } }, ANSWER_KINDS.map(o => h('option', { value: o.value, text: o.label })));
    s.value = e.answer; return s;
  };
  book.forEach((e, i) => bookRows.append(h('tr', {},
    h('th', { scope: 'row' }, e.name, h('small', { text: ' ' + e.note })), h('td', { class: 'md-num', text: e.number }), h('td', {}, ansSelect(e, i)),
    h('td', { class: 'md-bk' }, h('button', { type: 'button', class: 'btn small', 'aria-label': `Dial ${e.name}`, onclick: () => dialEntry(i) }, 'Dial'),
      h('button', { type: 'button', class: 'btn small', 'aria-label': `Ring me: ${e.name} calls you`, title: 'An incoming call from this entry (answer with ATA, or set S0=1)', onclick: () => ringFrom(i) }, 'Ring me')))));
  const bookBox = h('fieldset', { class: 'group md-book' }, h('legend', {}, 'Dialing Directory ', h('small', { text: '(fictional 555-01xx numbers)' })),
    h('div', { class: 'md-booktable' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'System' }), h('th', { scope: 'col', text: 'Number' }), h('th', { scope: 'col', text: 'Answers with' }), h('th', { scope: 'col' }, h('span', { class: 'md-sr', text: 'Actions' })))), bookRows)));

  // line & speaker
  const sel = (label, opts, val, on) => { const s = h('select', { 'aria-label': label, onchange: () => on(s.value) }, opts.map(([v, t]) => h('option', { value: v, text: t }))); s.value = val; return s; };
  const selRegion = sel('Region', Object.entries(REGIONS).map(([k, r]) => [k, r.name]), 'na', (v) => { region = v; at.setRegion(v); post({ type: 'config', region: v }); });
  const selM = sel('Speaker mode (ATM)', [['0', 'M0 always off'], ['1', 'M1 on until carrier'], ['2', 'M2 always on'], ['3', 'M3 off while dialling']], '1', (v) => { at.st.M = +v; sendCfg(); });
  const selL = sel('Speaker volume (ATL)', [['0', 'L0 low'], ['1', 'L1 low'], ['2', 'L2 medium'], ['3', 'L3 high']], '2', (v) => { at.st.L = +v; sendCfg(); });
  const vol = h('input', { type: 'range', min: '0', max: '1.5', step: '0.01', value: '0.9', 'aria-label': 'Master volume', oninput: () => post({ type: 'config', vol: +vol.value }) });
  const qual = h('input', { type: 'range', min: '0', max: '100', step: '1', value: '85', 'aria-label': 'Line quality', 'aria-valuetext': '85: good', oninput: () => { quality = +qual.value / 100; qual.setAttribute('aria-valuetext', qual.value + ': ' + qWord(quality)); qOut.textContent = qWord(quality); post({ type: 'config', q: quality }); } });
  const qOut = h('span', { class: 'md-qout', text: 'good' });
  const unplug = h('input', { type: 'checkbox', onchange: () => post({ type: 'config', dead: unplug.checked }) });
  const lineBox = h('fieldset', { class: 'group md-line' }, h('legend', { text: 'Line & Speaker' }),
    h('div', { class: 'md-grid' },
      h('label', { text: 'Region' }), selRegion,
      h('label', { text: 'Line quality' }), h('span', { class: 'md-inline' }, qual, qOut),
      h('label', { text: 'Speaker' }), selM,
      h('label', { text: 'Speaker level' }), selL,
      h('label', { text: 'Master volume' }), vol),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, unplug, ' Phone cord unplugged (dead line)')),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => { resume(); submit('ATA'); } }, 'Answer (ATA)'),
      h('button', { type: 'button', class: 'btn', onclick: () => { resume(); submit('ATH1'); } }, 'Pick up (ATH1)'),
      h('button', { type: 'button', class: 'btn md-hang', onclick: () => { resume(); at.hangupButton(); } }, 'Hang up')));
  const qWord = (q) => q > 0.9 ? 'pristine' : q > 0.7 ? 'good' : q > 0.5 ? 'fair' : q > 0.3 ? 'noisy' : 'terrible';

  // line monitor: spectrogram + handshake timeline
  const W = 640, SH = 160, LH = 72;
  const spec = h('canvas', { class: 'md-spec', width: W, height: SH, role: 'img', 'aria-label': 'Spectrogram of the phone line: frequency 0 to 4 kHz upward, time scrolling to the left, about five seconds wide' });
  const lanes = h('canvas', { class: 'md-lanes', width: W, height: LH, 'aria-hidden': 'true' });
  const nowBox = h('div', { class: 'md-now' });
  const live = h('div', { class: 'md-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const logList = h('ol', { class: 'md-log' });
  const scopeBox = h('fieldset', { class: 'group md-scope' }, h('legend', {}, 'Line Monitor ', h('small', { text: '(what is on the wire, both ends)' })),
    h('div', { class: 'md-specwrap' }, spec, h('div', { class: 'md-axis', 'aria-hidden': 'true' }, h('span', { text: '4k' }), h('span', { text: '3k' }), h('span', { text: '2k' }), h('span', { text: '1k' }), h('span', { text: '0' }))),
    lanes, nowBox, live, h('details', { class: 'md-details' }, h('summary', { text: 'Handshake log' }), logList));

  const wrap = h('div', { class: 'md-wrap' }, modelBox, termBox, scopeBox, bookBox, lineBox);
  container.append(wrap);
  const stopKeys = (e) => e.stopPropagation();
  container.addEventListener('keydown', stopKeys); container.addEventListener('keyup', stopKeys);

  // ------------------------------------------------------------ terminal
  let openLine = null;
  const MAXL = 500;
  const termLine = (text, cls = '') => {
    const d = h('div', { class: 'md-l ' + cls, text: text === '' ? ' ' : text }); screen.append(d); openLine = null;
    while (screen.childNodes.length > MAXL) screen.firstChild.remove();
    screen.scrollTop = screen.scrollHeight;
  };
  const termStream = (txt) => {
    for (const ch of txt) {
      if (ch === '\n') { openLine = null; continue; }
      if (ch === '\r') continue;
      if (!openLine) { openLine = h('div', { class: 'md-l rx' }); screen.append(openLine); }
      const c = ch.charCodeAt(0); openLine.textContent += c < 32 || (c > 126 && c < 160) ? '·' : ch;
    }
    while (screen.childNodes.length > MAXL) screen.firstChild.remove();
    screen.scrollTop = screen.scrollHeight;
  };
  const hist = []; let hi = 0;
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'ArrowUp') { if (hist.length) { hi = Math.max(0, hi - 1); cmd.value = hist[hi] || ''; e.preventDefault(); } }
    else if (e.key === 'ArrowDown') { if (hist.length) { hi = Math.min(hist.length, hi + 1); cmd.value = hist[hi] || ''; e.preventDefault(); } }
  });
  function submit(text) {
    resume();
    const v = text !== undefined ? text : cmd.value; if (text === undefined) cmd.value = '';
    if (v.trim() && hist[hist.length - 1] !== v) hist.push(v); hi = hist.length;
    at.input(v);
  }

  // ------------------------------------------------------------ AT interpreter wiring
  const post = (m) => { if (node) node.port.postMessage(m); else queue.push(m); };
  const at = new ATModem({
    send: (m) => { if (m.type === 'dial' || m.type === 'answer') { clearScope(); session = null; } post(m); },
    print: (t, cls) => termLine(t, cls),
    state: (s) => onState(s),
    connect: (conn) => startSession(conn),
    data: (line) => { post({ type: 'send', text: line + '\r' }); if (session) session.input(line); },
    disconnect: () => { session = null; },
    lookup: (digits) => lookupNumber(digits, book),
    quality: () => quality,
  }, 'r336', region);
  const sendCfg = () => post({ type: 'config', M: at.st.M, L: at.st.L, model: at.model.id });
  post({ type: 'config', model: at.model.id, region, q: quality, M: 1, L: 2, vol: 0.9 });

  function startSession(conn) {
    const plan = at.plan || {}; const far = at.mode && plan.answerer;
    const local = lastWasAnswer ? 'answerer' : 'caller';
    const info = local === 'answerer' ? { kind: 'caller', name: 'caller', conn, local } :
      { kind: far && far.id && far.id.startsWith('srv') ? 'server' : 'bbs', name: (far && far.entry) || (far && far.number) || 'BBS', conn, local };
    session = farSession(info, (text) => post({ type: 'remoteSend', text }), () => post({ type: 'remoteHangup' }));
  }
  let lastWasAnswer = false;
  const origCmdAnswer = at.cmdAnswer.bind(at); at.cmdAnswer = () => { lastWasAnswer = true; return origCmdAnswer(); };
  const origCmdDial = at.cmdDial.bind(at); at.cmdDial = (r) => { lastWasAnswer = false; return origCmdDial(r); };

  // ------------------------------------------------------------ models & directory
  function pickModel(mid) {
    resume();
    if (at.mode !== 'command' || at.offhook) at.hangupButton();
    at.setModel(mid); const m = at.model;
    post({ type: 'config', model: mid });
    renderModel();
    termLine(''); termLine(`-- ${m.name} (${m.year}) powered on --`, 'note');
    typeInto(m.init);
  }
  function typeInto(s) {
    let k = 0; cmd.value = ''; cmd.focus();
    const step = () => { if (dead) return; if (k < s.length) { cmd.value += s[k++]; later(step, 28); } else later(() => submit(), 160); };
    step();
  }
  function renderModel() {
    const m = at.model, p = m.plate || {};
    plate.style.background = p.bg || '#ccc'; plate.style.color = p.fg || '#000';
    plate.replaceChildren(h('div', { class: 'p-maker', text: m.kind.toUpperCase() }), h('div', { class: 'p-name', text: m.name }),
      h('div', { class: 'p-stripe', style: `background:${p.stripe || '#888'}` }), h('div', { class: 'p-chip', text: p.chip || '' }), h('div', { class: 'p-year', text: String(m.year) }));
    mName.textContent = m.name; mKind.textContent = `${m.year} · ${m.kind} · ${m.caps.map(c => PROTO_NAME[c].replace(/ \(.*/, '')).join(', ')}`;
    mSpec.textContent = m.blurb + '  Init: ' + m.init;
    for (const b of presets.querySelectorAll('button')) { const on = b.dataset.id === m.id; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  }
  function dialEntry(i) {
    const e = book[i]; resume();
    if (at.mode !== 'command') at.hangupButton();
    submit(`ATD${at.model.rotary ? 'P' : 'T'}${e.number}`); cmd.focus();
  }
  function ringFrom(i) {
    const e = book[i]; resume();
    if (at.mode !== 'command' || at.offhook) at.hangupButton();
    const caller = farPlan(book[i].answer, 1);
    termLine(`(incoming call from ${e.name}, ${e.number})`, 'note');
    post({ type: 'incoming', plan: { incoming: true, caller } }); cmd.focus();
  }

  // ------------------------------------------------------------ state, LEDs
  const led = (k, on) => { const l = ledEls[k]; if (!l) return; l.classList.toggle('on', !!on); l.lastChild.textContent = ` ${l.title}: ${on ? 'on' : 'off'}`; };
  const blink = (k) => { led(k, true); later(() => led(k, false), 60); };
  function onState(s) {
    led('OH', s.offhook); led('CD', s.carrier); led('AA', s.aa); led('TR', true); led('MR', true);
    led('HS', s.conn && s.conn.rate >= 9600);
    selM.value = String(at.st.M); selL.value = String(at.st.L);
    sendCfg();
    container.classList.toggle('md-online', s.mode === 'online');
  }

  // ------------------------------------------------------------ engine events
  const segs = [];             // { t, side, label, phase, dur }
  const nowLab = { local: '', remote: '', net: '' };
  let lastAnnounce = 0, pendingAnnounce = '';
  function announce(text) {
    pendingAnnounce = text; const now = performance.now();
    if (now - lastAnnounce > 900) { live.textContent = text; lastAnnounce = now; pendingAnnounce = ''; }
    else later(() => { if (pendingAnnounce) { live.textContent = pendingAnnounce; pendingAnnounce = ''; lastAnnounce = performance.now(); } }, 950);
  }
  function addLog(t, who, text) {
    logList.append(h('li', {}, h('span', { class: 'md-t', text: t.toFixed(2) + ' s' }), ' ', h('b', { text: who }), ' ', text));
    while (logList.childNodes.length > 400) logList.firstChild.remove();
  }
  const whoName = (side) => side === 'local' ? 'You' : side === 'remote' ? 'Remote' : 'Line';
  function onEvent(e) {
    evLog.push(e); if (evLog.length > 4000) evLog.splice(0, 1000);
    switch (e.kind) {
      case 'seg':
        segs.push(e); if (segs.length > 600) segs.splice(0, 200);
        addLog(e.t, whoName(e.side), e.label); break;
      case 'phase': addLog(e.t, '»', e.name); announce(e.name); setStatus('Modem: ' + e.name); break;
      case 'rx': termStream(e.text); blink('RD'); break;
      case 'tx': blink('SD'); break;
      case 'dialing': break;
      case 'hook': at.onEngine(e); break;
      default: at.onEngine(e);
    }
  }
  function renderNow() {
    nowBox.replaceChildren(...['local', 'remote', 'net'].map(k => h('div', {}, h('b', { text: whoName(k) + ': ' }), nowLab[k] || '—')));
  }
  renderNow();

  // ------------------------------------------------------------ spectrogram
  const sctx = spec.getContext('2d'), lctx = lanes.getContext('2d');
  sctx.fillStyle = '#000'; sctx.fillRect(0, 0, W, SH);
  const N = 256, HOP = 64, COLS = 8000 / HOP;  // 125 columns per second
  const ring = new Float32Array(N); let rfill = 0, sinceHop = 0, pendingCols = [];
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
  const re = new Float32Array(N), im = new Float32Array(N);
  const rev = new Uint16Array(N); for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < 8; b++) r |= ((i >> b) & 1) << (7 - b); rev[i] = r; }
  function fft() {
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, ang = -2 * Math.PI / size;
      for (let i = 0; i < N; i += size) for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k), a = i + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  const PAL = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) { const x = i / 255; PAL[i * 3] = 255 * Math.min(1, Math.max(0, 1.6 * x - 0.15)); PAL[i * 3 + 1] = 255 * Math.min(1, Math.max(0, 1.9 * x - 0.85)); PAL[i * 3 + 2] = 255 * Math.min(1, Math.max(0, x < 0.45 ? 1.4 * x : 1.2 - 1.6 * (x - 0.45)) + Math.max(0, x - 0.85) * 4); }
  function pushLine(data) {
    for (let i = 0; i < data.length; i++) {
      ring[rfill] = data[i]; rfill = (rfill + 1) % N;
      if (++sinceHop >= HOP) {
        sinceHop = 0;
        for (let k = 0; k < N; k++) { const v = ring[(rfill + k) % N] * win[k]; re[rev[k]] = v; im[rev[k]] = 0; }
        fft();
        const col = new Uint8ClampedArray(SH * 4);
        for (let y = 0; y < SH; y++) {
          const bin = Math.min(127, Math.floor((SH - 1 - y) * 128 / SH));
          const mag = Math.hypot(re[bin], im[bin]) / 32 + 1e-9, db = 20 * Math.log10(mag);
          const v = Math.max(0, Math.min(255, Math.round((db + 78) * 255 / 70))) * 3;
          col[y * 4] = PAL[v]; col[y * 4 + 1] = PAL[v + 1]; col[y * 4 + 2] = PAL[v + 2]; col[y * 4 + 3] = 255;
        }
        pendingCols.push(col);
      }
    }
  }
  function clearScope() { sctx.fillStyle = '#000'; sctx.fillRect(0, 0, W, SH); segs.length = 0; }
  const PHC = {};
  const phaseColor = (p = '') => { if (!PHC[p]) { let x = 0; for (const c of p) x = (x * 31 + c.charCodeAt(0)) >>> 0; PHC[p] = `hsl(${x % 360} 55% 62%)`; } return PHC[p]; };
  function draw() {
    if (dead) return;
    if (pendingCols.length) {
      const n = pendingCols.length; const keep = Math.min(n, W);
      sctx.drawImage(spec, -keep, 0);
      const img = sctx.createImageData(1, SH);
      for (let i = n - keep; i < n; i++) { img.data.set(pendingCols[i]); sctx.putImageData(img, W - n + i, 0); }
      pendingCols = [];
    }
    // lanes, aligned with the spectrogram's time axis
    lctx.fillStyle = '#c0c0c0'; lctx.fillRect(0, 0, W, LH);
    const lane = { local: 0, remote: 1, net: 2 }, lh = LH / 3;
    lctx.font = '10px "Lucida Console", monospace'; lctx.textBaseline = 'middle';
    for (const side of ['local', 'remote', 'net']) {
      const y = lane[side] * lh;
      lctx.fillStyle = '#e8e8e8'; lctx.fillRect(0, y + 1, W, lh - 2);
      const list = segs.filter(s => s.side === side);
      for (let i = 0; i < list.length; i++) {
        const s = list[i], nx = list[i + 1];
        let end = s.dur < 0 ? Infinity : s.t + s.dur; if (nx) end = Math.min(end, nx.t);
        end = Math.min(end, tNow);
        const x0 = W - (tNow - s.t) * COLS, x1 = W - (tNow - end) * COLS;
        if (x1 < 0 || x0 > W || x1 - x0 < 0.5) continue;
        lctx.fillStyle = phaseColor(s.phase); lctx.fillRect(Math.max(0, x0), y + 2, Math.min(W, x1) - Math.max(0, x0), lh - 4);
        lctx.strokeStyle = '#404040'; lctx.strokeRect(Math.max(0, x0) + 0.5, y + 2.5, Math.min(W, x1) - Math.max(0, x0) - 1, lh - 5);
        if (x1 - Math.max(0, x0) > 24) { lctx.save(); lctx.beginPath(); lctx.rect(Math.max(0, x0) + 2, y, Math.min(W, x1) - Math.max(0, x0) - 4, lh); lctx.clip(); lctx.fillStyle = '#000'; lctx.fillText(s.label, Math.max(0, x0) + 3, y + lh / 2); lctx.restore(); }
      }
      lctx.fillStyle = '#000080'; lctx.fillRect(0, y + 2, 44, lh - 4); lctx.fillStyle = '#fff'; lctx.fillText(side === 'local' ? 'YOU' : side === 'remote' ? 'REMOTE' : 'LINE', 4, y + lh / 2);
    }
    updateNow();
    raf = requestAnimationFrame(draw);
  }
  let nowKey = '';
  function updateNow() {           // what each end is sending right now (segments still running at tNow)
    for (const side of ['local', 'remote', 'net']) {
      let lab = '';
      for (let i = segs.length - 1; i >= 0; i--) { const s = segs[i]; if (s.side !== side || s.t > tNow) continue; const nx = segs.slice(i + 1).find(x => x.side === side && x.t <= tNow); if (nx) break; if (s.dur < 0 || s.t + s.dur > tNow - 0.02) lab = s.label; break; }
      nowLab[side] = lab;
    }
    const k = nowLab.local + '|' + nowLab.remote + '|' + nowLab.net; if (k !== nowKey) { nowKey = k; renderNow(); }
  }
  raf = requestAnimationFrame(draw);

  // ------------------------------------------------------------ audio
  const ready = (loaded.get(ctx) || (() => { const p = ctx.audioWorklet.addModule(WORKLET_URL); loaded.set(ctx, p); return p; })());
  ready.then(() => {
    if (dead) return;
    node = new AudioWorkletNode(ctx, 'retrosynths-modem', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    out = ctx.createGain(); out.gain.value = 1; node.connect(out); out.connect(dest);
    node.port.onmessage = (ev) => {
      const d = ev.data;
      if (d.type === 'line') { tNow = (d.t0 + d.data.length) / 8000; pushLine(d.data); if (tap.on) { if (!tap.line.length) tap.t0 = d.t0 / 8000; tap.line.push(d.data); if (d.spk) tap.spk.push(d.spk); } }
      else if (d.type === 'events') for (const e of d.list) onEvent(e);
      else if (d.type === 'debug') { const f = debugWait.shift(); if (f) f(d); }
      else if (d.type === 'error') { console.error('[modem worklet]', d.message); termLine('(modem engine error: ' + d.message.split('\n')[0] + ')', 'note'); at.onEngine({ kind: 'result', code: 'NO CARRIER' }); }
    };
    node.onprocessorerror = () => termLine('(the modem audio engine stopped)', 'note');
    for (const m of queue) node.port.postMessage(m); queue = [];
  }).catch((err) => { termLine('Audio worklet failed to load: ' + err.message, 'note'); });

  renderModel(); onState({ mode: 'command', offhook: false, carrier: false, aa: false, conn: null });
  termLine('RetroSynths MODEM — type AT commands, or pick a model and a number from the directory.', 'note');
  termLine('Try: ATDT555-0142  (MEGAzine BBS, V.34)   ·   ATM2 keeps the speaker on after CONNECT', 'note');
  termLine('');

  return {
    unmount() {
      dead = true; cancelAnimationFrame(raf); for (const t of timers) clearTimeout(t); timers.clear();
      container.removeEventListener('keydown', stopKeys); container.removeEventListener('keyup', stopKeys);
      if (node) { try { node.port.postMessage({ type: 'hangup', quiet: true }); node.port.postMessage({ type: 'dispose' }); node.port.onmessage = null; node.disconnect(); } catch (e) {} }
      if (out) { try { out.disconnect(); } catch (e) {} }
      wrap.remove(); container.classList.remove('modem', 'md-online');
    },
    /** run a line as if typed (handy for integration and tests) */
    command(s) { submit(s); },
    /** testing hooks: capture the 8 kHz line and speaker signals, inspect events */
    _test: { tap(on) { tap.on = on; post({ type: 'tap', on }); if (on) { tap.line = []; tap.spk = []; } return tap; }, events: evLog, at: () => at, ring: (i) => ringFrom(i), pick: (m) => pickModel(m),
      debug: () => new Promise((res) => { debugWait.push(res); post({ type: 'debug' }); }) },
  };
}
export default mountModem;
