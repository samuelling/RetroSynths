// Secret Notes panel for the Modem: send a note as sound, or listen through the microphone and decode one.
// mountNotes(host, { ctx, dest, ready, spectro, setStatus }) -> { unmount() }
//   ready:   Promise that resolves when the modem's worklet module (which has the capture processor) is loaded
//   spectro: { use('line'|'notes', label), feed(samples8k) } — the Modem's spectrogram
import { synthesize, NoteDecoder, frameSeconds, MODES, MODE_KEYS, INTRO_SECONDS } from './notes-core.js';
import { packNote, unpackNote, PBKDF2_ITERATIONS } from './notes-crypto.js';

const MAXLEN = 280;
let uid = 0;
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
/** a cheap anti-aliased decimator to 8 kHz for the spectrogram */
class Down8k {
  constructor(fs) { this.step = fs / 8000; this.acc = 0; this.prev = 0; const w = 2 * Math.PI * 3600 / fs, c = Math.cos(w), al = Math.sin(w) / 1.0; this.b = [(1 - c) / 2 / (1 + al), (1 - c) / (1 + al), (1 - c) / 2 / (1 + al)]; this.a = [-2 * c / (1 + al), (1 - al) / (1 + al)]; this.z = [0, 0, 0, 0]; }
  run(x) {
    const out = []; const [b0, b1, b2] = this.b, [a1, a2] = this.a, z = this.z;
    for (let i = 0; i < x.length; i++) {
      let v = b0 * x[i] + z[0]; z[0] = b1 * x[i] - a1 * v + z[1]; z[1] = b2 * x[i] - a2 * v;
      const u = b0 * v + z[2]; z[2] = b1 * v - a1 * u + z[3]; z[3] = b2 * v - a2 * u; v = u;
      this.acc += 1; while (this.acc >= this.step) { this.acc -= this.step; out.push(this.prev + (v - this.prev) * (1 - this.acc)); }
      this.prev = v;
    }
    return Float32Array.from(out);
  }
}
const pcm16Wav = (x, fs) => {
  const n = x.length, b = new DataView(new ArrayBuffer(44 + n * 2)); const w = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, fs, true); b.setUint32(28, fs * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), true);
  return new Blob([b.buffer], { type: 'audio/wav' });
};
const fmtS = (s) => s < 10 ? s.toFixed(1) + ' s' : Math.round(s) + ' s';

export function mountNotes(host, { ctx, dest, ready, spectro, setStatus = () => {} }) {
  const id = 'mn' + (++uid);
  const timers = new Set(); const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  let dead = false, playing = null, listening = null, lastLocked = null, fileBusy = false;

  // ------------------------------------------------------------ shared passphrase
  const pass = h('input', { type: 'password', id: id + '-pass', autocomplete: 'off', spellcheck: 'false', class: 'md-field', 'aria-describedby': id + '-passhint' });
  const showPass = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', 'aria-controls': id + '-pass', onclick: () => {
    const on = pass.type === 'password'; pass.type = on ? 'text' : 'password'; showPass.setAttribute('aria-pressed', String(on)); showPass.textContent = on ? 'Hide' : 'Show'; } }, 'Show');
  const passHint = h('div', { class: 'md-hint', id: id + '-passhint', role: 'status' });

  // ------------------------------------------------------------ send
  const msg = h('textarea', { id: id + '-msg', class: 'md-field md-msg', rows: '3', maxlength: String(MAXLEN), spellcheck: 'true', 'aria-describedby': id + '-count' });
  const count = h('div', { class: 'md-hint', id: id + '-count', 'aria-live': 'polite' });
  const speedBox = h('fieldset', { class: 'md-speed' }, h('legend', { text: 'Speed' }),
    MODE_KEYS.map(k => { const m = MODES[k]; const net = m.baud * m.bps / 16;
      const desc = { sturdy: `slow & sure · MFSK-8, ${m.baud} baud · ~${net.toFixed(0)} bytes/s`, quick: `MFSK-8, ${m.baud} baud · ~${net.toFixed(0)} bytes/s`, classic: `the modem sound · FSK, ${m.baud} baud · ~${net.toFixed(0)} bytes/s` }[k];
      return h('label', { class: 'chk' }, h('input', { type: 'radio', name: id + '-speed', value: k, checked: k === 'sturdy', onchange: () => updateCount() }), ` ${m.name} `, h('small', { text: `(${desc})` })); }));
  const intro = h('input', { type: 'checkbox', id: id + '-intro', onchange: () => updateCount() });
  const btnSend = h('button', { type: 'button', class: 'btn', onclick: () => send() }, 'Send');
  const btnStop = h('button', { type: 'button', class: 'btn', disabled: true, onclick: () => stopPlaying() }, 'Stop');
  const btnSave = h('button', { type: 'button', class: 'btn', onclick: () => save() }, 'Save as sound (.wav)');
  const sendStatus = h('div', { class: 'md-status', role: 'status', 'aria-live': 'polite' });
  const vol = h('input', { type: 'range', min: '0.05', max: '1', step: '0.01', value: '0.7', id: id + '-vol', 'aria-label': 'Note playback volume' });
  const speed = () => (host.querySelector(`input[name="${id}-speed"]:checked`) || { value: 'sturdy' }).value;

  const sendBox = h('fieldset', { class: 'group md-send' }, h('legend', { text: 'Send a note' }),
    h('label', { for: id + '-msg', class: 'md-lab', text: `Message (up to ${MAXLEN} characters)` }), msg, count,
    speedBox,
    h('div', { class: 'row' }, h('label', { class: 'chk' }, intro, ' Fake handshake intro'), h('small', { class: 'md-hint', text: '(a dial-up flourish first; the receiver ignores it)' })),
    h('div', { class: 'row' }, h('label', { for: id + '-vol', text: 'Volume' }), vol),
    h('div', { class: 'row' }, btnSend, btnStop, btnSave), sendStatus);

  // ------------------------------------------------------------ listen
  const btnListen = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', onclick: () => (listening ? stopListening() : startListening()) }, 'Start listening');
  const fileIn = h('input', { type: 'file', accept: 'audio/*,.wav,.m4a,.mp3,.ogg,.opus,.webm,.aac,.caf', hidden: true, onchange: () => { if (fileIn.files[0]) decodeFile(fileIn.files[0]); fileIn.value = ''; } });
  const btnFile = h('button', { type: 'button', class: 'btn', onclick: () => fileIn.click() }, 'Decode a sound file…');
  const level = h('meter', { min: '0', max: '1', low: '0.15', high: '0.9', optimum: '0.5', value: '0', id: id + '-lvl', class: 'md-meter' });
  const levelTxt = h('span', { class: 'md-num', text: '—' });
  const cd = h('span', { class: 'md-cd', title: 'Carrier detect' }, h('i', { 'aria-hidden': 'true' }), h('span', { text: 'no carrier' }));
  const prog = h('progress', { max: '1', value: '0', id: id + '-prog', class: 'md-prog' });
  const progTxt = h('span', { class: 'md-num' });
  const listenStatus = h('div', { class: 'md-status', role: 'status' });
  const result = h('div', { class: 'md-result', 'aria-live': 'assertive', 'aria-atomic': 'true' });
  const btnRetry = h('button', { type: 'button', class: 'btn small', hidden: true, onclick: () => retryLocked() }, 'Try passphrase again');
  const inbox = h('ol', { class: 'md-inbox', 'aria-label': 'Received notes, newest first', reversed: true });
  const listenBox = h('fieldset', { class: 'group md-listen' }, h('legend', { text: 'Listen' }),
    h('div', { class: 'row' }, btnListen, btnFile, fileIn),
    h('div', { class: 'md-grid' },
      h('label', { for: id + '-lvl', text: 'Mic level' }), h('span', { class: 'md-inline' }, level, levelTxt),
      h('span', { text: 'Carrier' }), cd,
      h('label', { for: id + '-prog', text: 'Receiving' }), h('span', { class: 'md-inline' }, prog, progTxt)),
    listenStatus, result, btnRetry,
    h('details', { class: 'md-details' }, h('summary', { text: 'Received notes' }), inbox));

  const box = h('fieldset', { class: 'group md-notes' }, h('legend', {}, 'Secret Notes ', h('small', { text: '(real data over the air: one Modem plays, another listens)' })),
    h('div', { class: 'row md-passrow' }, h('label', { for: id + '-pass', text: 'Shared passphrase' }), pass, showPass), passHint,
    h('p', { class: 'md-hint md-explain', text: `With a passphrase, notes are encrypted (AES-256-GCM, key from PBKDF2-SHA256 with ${PBKDF2_ITERATIONS.toLocaleString('en-US')} rounds and a random salt). Only someone with the same passphrase can read them, and any tampering is detected. Share the passphrase another way: it is never sent. With no passphrase, a note is an open note: anyone with a decoder (like this one) can read it.` }),
    h('div', { class: 'md-notesgrid' }, sendBox, listenBox));
  host.append(box);

  // ------------------------------------------------------------ helpers
  const pickMode = () => MODES[speed()];
  function updatePassHint() {
    const secret = !!pass.value;
    passHint.textContent = secret ? 'Secret notes: encrypted with this passphrase.' : 'No passphrase: notes are open — not secret.';
    btnSend.textContent = secret ? 'Send secret note' : 'Send open note (not secret)';
    btnSave.textContent = secret ? 'Save secret note as sound (.wav)' : 'Save open note as sound (.wav)';
    box.classList.toggle('md-open', !secret);
    updateCount();
  }
  let countSeq = 0;
  async function updateCount() {
    const seq = ++countSeq, text = msg.value, m = pickMode(), secret = !!pass.value;
    let bytes = new TextEncoder().encode(text).length;
    try { if (typeof CompressionStream !== 'undefined' && text.length > 20) { const s = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw')); const z = (await new Response(s).arrayBuffer()).byteLength; if (z + 1 < bytes) bytes = z; } } catch (e) {}
    if (seq !== countSeq) return;
    const secs = frameSeconds(bytes + (secret ? 45 : 0), m.key) + (intro.checked ? INTRO_SECONDS : 0);
    count.textContent = `${[...text].length}/${MAXLEN} characters · about ${fmtS(secs)} of airtime at ${m.name}${secret ? ' (incl. 45 bytes of encryption)' : ''}`;
  }
  msg.addEventListener('input', () => updateCount());
  pass.addEventListener('input', () => { updatePassHint(); });
  updatePassHint();

  async function build(fs) {
    const text = msg.value; if (!text.trim()) { sendStatus.textContent = 'Type a message first.'; msg.focus(); return null; }
    const m = pickMode(), secret = !!pass.value;
    sendStatus.textContent = secret ? 'Encrypting…' : 'Preparing…';
    try {
      const { payload, flags } = await packNote(text, pass.value, m.id);
      return { m, secret, payload, flags, wave: synthesize(payload, flags, m.key, { fs, amp: 0.5, intro: intro.checked }), w8: synthesize(payload, flags, m.key, { fs: 8000, amp: 0.5, intro: intro.checked }) };
    } catch (e) { sendStatus.textContent = 'Could not prepare the note: ' + e.message; return null; }
  }
  // ------------------------------------------------------------ send / save
  async function send() {
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    stopPlaying(true);
    const n = await build(ctx.sampleRate); if (!n || dead) return;
    const buf = ctx.createBuffer(1, n.wave.length, ctx.sampleRate); buf.copyToChannel(n.wave, 0);
    const src = ctx.createBufferSource(), g = ctx.createGain(); g.gain.value = +vol.value; src.buffer = buf; src.connect(g); g.connect(dest);
    const t0 = ctx.currentTime + 0.05; src.start(t0);
    const dur = n.wave.length / ctx.sampleRate;
    playing = { src, g, t0, w8: n.w8, fed: 0 };
    src.onended = () => { if (playing && playing.src === src) stopPlaying(); };
    vol.oninput = () => { if (playing) playing.g.gain.value = +vol.value; };
    btnStop.disabled = false;
    sendStatus.textContent = `Sending ${n.secret ? 'secret' : 'open'} note at ${n.m.name}: ${fmtS(dur)}…`;
    setStatus('Secret Notes: sending');
    if (!listening) spectro.use('notes', 'note being sent');
    feedLoop();
  }
  function feedLoop() {
    if (!playing || dead) return;
    const want = Math.min(playing.w8.length, Math.floor((ctx.currentTime - playing.t0) * 8000));
    if (want > playing.fed) { if (!listening) spectro.feed(playing.w8.subarray(playing.fed, want)); playing.fed = want; }
    later(feedLoop, 40);
  }
  function stopPlaying(silent) {
    if (!playing) return;
    const p = playing; playing = null; try { p.src.onended = null; p.src.stop(); } catch (e) {} p.g.disconnect();
    btnStop.disabled = true; if (!silent) { sendStatus.textContent = 'Sent.'; setStatus('Secret Notes: sent'); }
    if (!listening) spectro.use('line');
  }
  async function save() {
    const n = await build(48000); if (!n) return;
    const url = URL.createObjectURL(pcm16Wav(n.wave, 48000));
    const a = h('a', { href: url, download: n.secret ? 'secret-note.wav' : 'open-note.wav' }); document.body.append(a); a.click(); a.remove();
    later(() => URL.revokeObjectURL(url), 30000);
    sendStatus.textContent = `Saved ${n.secret ? 'secret' : 'open'} note as a ${fmtS(n.wave.length / 48000)} sound file. Text or email it; the receiver uses “Decode a sound file…”.`;
  }

  // ------------------------------------------------------------ receiving
  const setCD = (on, mode) => { cd.classList.toggle('on', on); cd.lastChild.textContent = on ? `carrier (${MODES[mode].name})` : 'no carrier'; };
  let carriers = new Set();
  function onDecoderEvent(e, source) {
    switch (e.kind) {
      case 'carrier': if (e.on) carriers.add(e.mode); else carriers.delete(e.mode); setCD(carriers.size > 0, [...carriers][0] || e.mode);
        if (!e.on && e.reason !== 'done' && e.reason !== 'header') { prog.value = 0; progTxt.textContent = ''; } break;
      case 'sync': listenStatus.textContent = `Hearing a ${MODES[e.mode].name} note…`; break;
      case 'header': listenStatus.textContent = `Receiving a ${MODES[e.mode].name} note: ${e.len} bytes, about ${fmtS(e.seconds)}${e.flags & 1 ? ' (encrypted)' : ''}.`; prog.value = 0; progTxt.textContent = '0 %'; break;
      case 'progress': prog.value = e.frac; progTxt.textContent = Math.round(e.frac * 100) + ' %'; break;
      case 'frame': if (e.why === 'header') return; prog.value = e.ok ? 1 : 0; progTxt.textContent = e.ok ? '100 %' : ''; finish(e, source); break;
    }
  }
  async function finish(e, source) {
    const m = MODES[e.mode];
    if (!e.ok) { show('bad', 'Couldn’t read it — too garbled', 'The note arrived damaged (checksum failed). Move closer, turn the volume up, or try Sturdy.', source, m); return; }
    const r = await unpackNote(e.bytes, e.flags, pass.value, m.id);
    if (r.status === 'secret') show('secret', '✓ Secret note (passphrase matched)', r.text, source, m);
    else if (r.status === 'open') show('open', 'Open note', r.text, source, m);
    else if (r.status === 'locked') { lastLocked = { e, source }; show('locked', '🔒 Secret note', 'Enter the shared passphrase above, then press “Try passphrase again”.', source, m); btnRetry.hidden = false; return; }
    else if (r.status === 'badpass') { lastLocked = { e, source }; show('bad', 'Couldn’t read it — wrong passphrase', 'The note arrived intact (checksum OK) but did not decrypt: the passphrase differs, or it was tampered with.', source, m); btnRetry.hidden = false; return; }
    else show('bad', 'Couldn’t read it — too garbled', 'The note could not be unpacked.', source, m);
    btnRetry.hidden = true; lastLocked = null;
  }
  async function retryLocked() { if (!lastLocked) return; const { e, source } = lastLocked; await finish(e, source); }
  function show(kind, title, body, source, m) {
    result.className = 'md-result md-' + kind;
    result.replaceChildren(h('b', { text: title }), h('div', { class: 'md-body', text: body }), h('small', { text: `${m.name} · ${source}` }));
    inbox.prepend(h('li', { class: 'md-' + kind }, h('b', { text: title + ' ' }), h('span', { text: body }), h('small', { text: ` (${m.name}, ${source}, ${new Date().toLocaleTimeString()})` })));
    while (inbox.childNodes.length > 20) inbox.lastChild.remove();
    listenStatus.textContent = listening ? 'Still listening for the next note.' : '';
    setStatus('Secret Notes: ' + title);
  }

  async function startListening() {
    if (listening) return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { listenStatus.textContent = 'This browser cannot use the microphone here (it needs https or localhost).'; return; }
    listenStatus.textContent = 'Asking for the microphone…';
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } }); }
    catch (err) { listenStatus.textContent = err && err.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'No microphone available (' + (err && err.name || err) + ').'; return; }
    if (dead) { stream.getTracks().forEach(t => t.stop()); return; }
    try { await ready; } catch (e) { listenStatus.textContent = 'Audio engine not available.'; stream.getTracks().forEach(t => t.stop()); return; }
    const srcNode = ctx.createMediaStreamSource(stream);
    const cap = new AudioWorkletNode(ctx, 'retrosynths-modem-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = ctx.createGain(); mute.gain.value = 0; srcNode.connect(cap); cap.connect(mute); mute.connect(dest);
    const dec = new NoteDecoder({ sampleRate: ctx.sampleRate, onEvent: (e) => onDecoderEvent(e, 'microphone') });
    const down = new Down8k(ctx.sampleRate); let lv = 0;
    cap.port.onmessage = (ev) => {
      const x = ev.data; dec.push(x);
      let p = 0; for (let i = 0; i < x.length; i++) p += x[i] * x[i];
      const db = 10 * Math.log10(p / x.length + 1e-12); lv = Math.max(db, lv - 1.5);
      level.value = Math.max(0, Math.min(1, (lv + 70) / 70)); levelTxt.textContent = lv > -90 ? `${Math.round(lv)} dBFS` : '—';
      spectro.feed(down.run(x));
    };
    listening = { stream, srcNode, cap, mute, dec };
    btnListen.textContent = 'Stop listening'; btnListen.setAttribute('aria-pressed', 'true');
    listenStatus.textContent = 'Listening… play a note near the microphone.'; setStatus('Secret Notes: listening');
    spectro.use('notes', 'microphone');
    const track = stream.getAudioTracks()[0]; if (track) track.onended = () => stopListening();
  }
  function stopListening() {
    if (!listening) return;
    const L = listening; listening = null;
    try { L.cap.port.postMessage('stop'); L.cap.port.onmessage = null; L.srcNode.disconnect(); L.cap.disconnect(); L.mute.disconnect(); } catch (e) {}
    L.stream.getTracks().forEach(t => t.stop());
    btnListen.textContent = 'Start listening'; btnListen.setAttribute('aria-pressed', 'false');
    listenStatus.textContent = 'Stopped listening.'; level.value = 0; levelTxt.textContent = '—'; setCD(false); carriers.clear();
    spectro.use(playing ? 'notes' : 'line', playing ? 'note being sent' : undefined);
  }
  async function decodeFile(file) {
    if (fileBusy) return; fileBusy = true;
    listenStatus.textContent = `Decoding ${file.name}…`;
    try {
      const ab = await file.arrayBuffer();
      const audio = await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab.slice(0), res, rej); if (p && p.then) p.then(res, rej); });
      const n = audio.length, x = new Float32Array(n);
      for (let c = 0; c < audio.numberOfChannels; c++) { const d = audio.getChannelData(c); for (let i = 0; i < n; i++) x[i] += d[i] / audio.numberOfChannels; }
      let found = 0;
      const dec = new NoteDecoder({ sampleRate: audio.sampleRate, onEvent: (e) => { if (e.kind === 'frame' && e.why !== 'header') found++; onDecoderEvent(e, 'file “' + file.name + '”'); } });
      const CH = Math.round(audio.sampleRate * 0.5);
      for (let i = 0; i < n && !dead; i += CH) { dec.push(x.subarray(i, Math.min(n, i + CH))); await new Promise(r => later(r, 0)); }
      dec.flush(0.6);
      if (!found) { listenStatus.textContent = `No note found in ${file.name}.`; result.className = 'md-result md-bad'; result.replaceChildren(h('b', { text: 'No note found' }), h('div', { class: 'md-body', text: 'That sound file does not seem to contain a note.' })); }
      else listenStatus.textContent = `Finished decoding ${file.name}.`;
    } catch (e) { listenStatus.textContent = `Couldn’t open ${file.name} as audio.`; }
    fileBusy = false;
  }

  updateCount();
  return {
    unmount() { dead = true; for (const t of timers) clearTimeout(t); timers.clear(); stopPlaying(true); stopListening(); box.remove(); },
    _test: { send, save, startListening, stopListening, decodeFile, setPass: (v) => { pass.value = v; updatePassHint(); }, setMsg: (v) => { msg.value = v; updateCount(); } },
  };
}
