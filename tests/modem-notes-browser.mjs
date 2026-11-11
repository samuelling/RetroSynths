// Usage: node tests/modem-notes.mjs (writes /tmp/rs/note.wav) && node tests/modem-notes-browser.mjs
// Secret Notes in headless Chrome: Listen through Chrome's FAKE MICROPHONE playing /tmp/rs/note.wav (a secret note
// passed through the simulated room), right/wrong/missing passphrase, "Save as sound" -> "Decode a sound file"
// (also after AAC / Opus / MP3 transcodes), Send playback, and an axe accessibility check of the panel.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = await import('../apps/oldschool/modem/notes-photo.js');
const { MODES } = await import('../apps/oldschool/modem/notes-core.js');
const { Rand, roomAudio, addNoise } = await import('./modem-notes-channel.mjs');
const { writeWav } = await import('./modem-harness.mjs');
const PASS = 'correct horse battery staple', MIC_TEXT = 'Psst. The fake mic heard this through a simulated room.';
if (!fs.existsSync('/tmp/rs/note.wav')) { console.error('run node tests/modem-notes.mjs first (it writes /tmp/rs/note.wav)'); process.exit(2); }
// ---------------------------------------------------------------- photo train for the fake mic (needs pngjs from /tmp/ph)
const PHOTO_PASS = 'owls at dawn';
let photoReady = false;
try {
  const { PNG } = await import('/tmp/ph/node_modules/pngjs/lib/png.js');
  const png = PNG.sync.read(fs.readFileSync('/tmp/ph/rocket.png')); const { w, h } = P.fitSize(png.width, png.height, P.SIZES.tiny);
  const rgba = new Uint8ClampedArray(w * h * 4);       // box-filter downscale
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * png.width / w), x1 = Math.max(x0 + 1, Math.floor((x + 1) * png.width / w)), y0 = Math.floor(y * png.height / h), y1 = Math.max(y0 + 1, Math.floor((y + 1) * png.height / h));
    for (let c = 0; c < 3; c++) { let s = 0, n = 0; for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += png.data[(yy * png.width + xx) * 4 + c]; n++; } rgba[(y * w + x) * 4 + c] = s / n; }
    rgba[(y * w + x) * 4 + 3] = 255;
  }
  const img = P.encodeImage(rgba, w, h, { quality: P.QUALITY.medium });
  const expect = new Uint8ClampedArray(w * h * 4); img.bands.forEach((b, i) => P.decodeBand(b, i, img, expect));
  const pk = await P.packPhoto(img, PHOTO_PASS, MODES.quick.id);
  const { audio } = P.synthesizePhoto(pk.frames, 'quick', { fs: 48000, amp: 0.5 });
  const rng = new Rand(21); const room = roomAudio(audio, 48000, rng, { rt60: 0.35, drr: 9 }); const yy = addNoise(room.y, room.sigPower, 25, 48000, rng);
  let pk2 = 0; for (const v of yy) pk2 = Math.max(pk2, Math.abs(v)); for (let i = 0; i < yy.length; i++) yy[i] *= 0.5 / pk2;
  writeWav('/tmp/rs/photo.wav', yy, 48000);
  fs.writeFileSync('/tmp/rs/photo-expected.json', JSON.stringify({ w, h, bands: img.bands.length, id: pk.id, rgba: Buffer.from(expect).toString('base64') }));
  console.log(`photo train: rocket ${w}×${h}, ${img.bands.length} stripes, ${P.photoSeconds(pk.frames, 'quick').toFixed(1)} s at Quick, through the room at 25 dB -> /tmp/rs/photo.wav`);
  photoReady = true;
} catch (e) { console.log('(photo cases skipped: ' + e.message + ')'); }

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=/tmp/rs/note.wav'] });
const context = await browser.newContext({ viewport: { width: 1200, height: 1700 }, acceptDownloads: true, permissions: ['microphone'] });
const page = await context.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
const logs = []; page.on('console', m => logs.push(m.text()));
await page.goto(`http://127.0.0.1:${port}/apps/oldschool/modem/index.html?autostart`);
await page.waitForFunction(() => window.modem && window.modemCtx && window.modemCtx.state === 'running');
await page.waitForTimeout(500);
const notes = '.md-notes';
const resultText = () => page.$eval(`${notes} .md-result`, el => el.textContent);
const waitResult = async (re, ms = 45000) => { try { await page.waitForFunction(([sel, src]) => new RegExp(src).test(document.querySelector(sel).textContent), [`${notes} .md-result`, re.source], { timeout: ms }); return true; } catch (e) { return false; } };

// ---------------------------------------------------------------- 1. fake microphone, right passphrase
await page.fill(`${notes} input[type=password]`, PASS);
await page.click(`${notes} button:has-text("Start listening")`);
let maxProg = 0, sawCarrier = false;
const poll = setInterval(async () => { try { const s = await page.evaluate((sel) => ({ p: +document.querySelector(sel + ' progress').value, c: document.querySelector(sel + ' .md-cd').classList.contains('on') }), notes); maxProg = Math.max(maxProg, s.p); sawCarrier ||= s.c; } catch (e) {} }, 150);
const ok1 = await waitResult(/Secret note \(passphrase matched\)/);
check(ok1, 'Listen (fake mic, room-simulated recording): secret note decoded and decrypted');
const t1 = await resultText(); check(t1.includes(MIC_TEXT), 'decoded text matches: ' + JSON.stringify(t1.slice(0, 120)));
check(sawCarrier && maxProg > 0.5, `carrier detect lit and receive progress advanced (max ${maxProg.toFixed(2)})`);
const live = await page.$eval(`${notes} .md-result`, el => el.getAttribute('aria-live')); check(live === 'assertive' || live === 'polite', 'result is an aria-live region');
const lvl = await page.$eval(`${notes} meter`, el => +el.value); check(lvl > 0, `input level meter moves (${lvl.toFixed(2)})`);
const specLabel = await page.$eval('.md-spec', el => el.getAttribute('aria-label')); check(/microphone/.test(specLabel), 'spectrogram switches to the microphone');
await page.screenshot({ path: '/tmp/rs/modem-notes.png', fullPage: true });

// ---------------------------------------------------------------- 2. keep listening: wrong passphrase on the next loop, then none, then retry
await page.fill(`${notes} input[type=password]`, 'not the passphrase');
check(await waitResult(/wrong passphrase/, 40000), 'next note with a wrong passphrase: "Couldn’t read it — wrong passphrase" (CRC passed, GCM failed)');
await page.fill(`${notes} input[type=password]`, '');
check(await waitResult(/🔒 Secret note/, 40000), 'with no passphrase entered: locked, contents not shown');
check(!(await resultText()).includes(MIC_TEXT), 'locked note does not reveal the text');
await page.fill(`${notes} input[type=password]`, PASS);
await page.click(`${notes} button:has-text("Try passphrase again")`);
check(await waitResult(/Secret note \(passphrase matched\)/, 10000), '"Try passphrase again" decrypts the held note');
const inboxN = await page.$$eval(`${notes} .md-inbox li`, l => l.length); check(inboxN >= 4, `kept listening: ${inboxN} notes in the received list`);
await page.click(`${notes} button:has-text("Stop listening")`);
clearInterval(poll);

// ---------------------------------------------------------------- 3. Save as sound -> Decode a sound file (+ lossy transcodes)
await page.fill(`${notes} textarea`, 'Saved as a sound file, texted, and decoded. 🎉');
await page.check(`${notes} input[value=quick]`);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`${notes} button:has-text("Save secret note as sound")`)]);
const saved = '/tmp/rs/note-saved.wav'; await dl.saveAs(saved);
check(fs.statSync(saved).size > 100000 && /secret-note\.wav/.test(dl.suggestedFilename()), `Save as sound wrote ${dl.suggestedFilename()} (${(fs.statSync(saved).size / 1024).toFixed(0)} KB)`);
const files = [[saved, 'saved WAV']];
try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', saved, '-c:a', 'aac', '-b:a', '64k', '/tmp/rs/note-saved.m4a']); files.push(['/tmp/rs/note-saved.m4a', 'AAC 64 kbps .m4a']);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', saved, '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '/tmp/rs/note-saved.ogg']); files.push(['/tmp/rs/note-saved.ogg', 'Opus 24 kbps .ogg']);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', '/tmp/rs/note-quick-room.wav', '-c:a', 'libmp3lame', '-b:a', '64k', '/tmp/rs/note-quick-room.mp3']); files.push(['/tmp/rs/note-quick-room.mp3', 'room recording as MP3 64 kbps']);
} catch (e) { console.log('(ffmpeg transcodes skipped: ' + e.message + ')'); }
for (const [f, label] of files) {
  await page.evaluate(() => { document.querySelector('.md-notes .md-result').textContent = ''; });
  await page.setInputFiles(`${notes} input[type=file][accept^="audio"]`, f);
  const ok = await waitResult(/Secret note \(passphrase matched\)/, 30000);
  const txt = await resultText();
  check(ok && /Saved as a sound file|fake mic|Quick note via the fake microphone/.test(txt), `Decode a sound file: ${label}`);
}

// ---------------------------------------------------------------- 4. Send plays the note (and an open note is labelled as such)
await page.fill(`${notes} input[type=password]`, '');
const label = await page.$eval(`${notes} .md-send button:has-text("Send")`, b => b.textContent); check(/open note \(not secret\)/i.test(label), `without a passphrase the button says "${label}"`);
await page.fill(`${notes} textarea`, 'hi');
await page.click(`${notes} button:has-text("Send open note")`);
await page.waitForFunction((sel) => /Sending open note/.test(document.querySelector(sel + ' .md-send .md-status').textContent), notes, { timeout: 5000 }).catch(() => {});
check(/Sending open note/.test(await page.$eval(`${notes} .md-send .md-status`, el => el.textContent)), 'Send starts playback');
await page.waitForFunction((sel) => /Sent\./.test(document.querySelector(sel + ' .md-send .md-status').textContent), notes, { timeout: 20000 }).catch(() => {});
check(/Sent\./.test(await page.$eval(`${notes} .md-send .md-status`, el => el.textContent)), 'Send finishes');

// ---------------------------------------------------------------- 5. accessibility (axe-core)
const AXE = '/tmp/axe/node_modules/axe-core/axe.min.js';
if (fs.existsSync(AXE)) {
  await page.addScriptTag({ path: AXE });
  const res = await page.evaluate(async () => { const r = await window.axe.run(document.querySelector('.modem'), { resultTypes: ['violations'] }); return r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 2).map(n => n.target.join(' ')) })); });
  for (const v of res) console.log(`  axe ${v.impact}: ${v.id} ×${v.n}  e.g. ${v.ex.join(' | ')}`);
  check(res.filter(v => v.impact === 'critical' || v.impact === 'serious').length === 0, `axe: no serious/critical violations in the Modem UI (${res.length} total)`);
}
check(!logs.some(l => l.includes(PASS) || l.includes(MIC_TEXT)), 'console never shows the passphrase or plaintext');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();

// ================================================================ photos: a second browser whose fake mic plays the photo train
if (photoReady) {
  const exp = JSON.parse(fs.readFileSync('/tmp/rs/photo-expected.json', 'utf8')); const expRgba = Buffer.from(exp.rgba, 'base64');
  const b2 = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=/tmp/rs/photo.wav'] });
  const c2 = await b2.newContext({ viewport: { width: 1200, height: 1900 }, acceptDownloads: true, permissions: ['microphone'] });
  const pg = await c2.newPage(); const err2 = [], log2 = [];
  pg.on('pageerror', e => err2.push(e.message)); pg.on('console', m => { log2.push(m.text()); if (m.type() === 'error' && !/favicon/.test(m.text())) err2.push(m.text()); });
  await pg.goto(`http://127.0.0.1:${port}/apps/oldschool/modem/index.html?autostart`);
  await pg.waitForFunction(() => window.modem && window.modemCtx && window.modemCtx.state === 'running'); await pg.waitForTimeout(400);
  // watch every result shown, to prove no photo frame is ever treated as a text note
  await pg.evaluate(() => { window.__results = []; new MutationObserver(() => { const b = document.querySelector('.md-notes .md-result b'); if (b) window.__results.push(b.textContent); }).observe(document.querySelector('.md-notes .md-result'), { childList: true, subtree: true }); });
  const photo = () => pg.evaluate(() => { const p = window.modem._test.notes().photos()[0]; return p && { status: p.status, done: p.done, next: p.next, bands: p.bands, lost: p.lost.size, w: p.w, h: p.h, enc: p.encrypted }; });
  const waitPhoto = async (pred, ms = 90000) => { const t0 = Date.now(); let p; while (Date.now() - t0 < ms) { p = await photo(); if (p && pred(p)) return p; await pg.waitForTimeout(250); } return p; };
  await pg.click(`${notes} button:has-text("Start listening")`);
  let scanSeen = false; const sp = setInterval(async () => { try { if (await pg.evaluate(() => { const p = window.modem._test.notes().photos()[0]; return !!p && p.status === 'receiving' && !p.done; })) scanSeen = true; } catch (e) {} }, 200);
  let p = await waitPhoto(p => p.status === 'locked' && p.done);
  check(p && p.status === 'locked' && p.done, `photo train heard without a passphrase: locked (🔒), all ${exp.bands} stripes held (${JSON.stringify(p)})`);
  const lockedTxt = await pg.$eval(`${notes} .md-photost`, el => el.textContent); check(/🔒/.test(lockedTxt) && /passphrase/.test(lockedTxt), 'locked status shown: ' + lockedTxt);
  await pg.fill(`${notes} input[type=password]`, 'not it');
  p = await waitPhoto(p => p.status === 'badpass', 20000);
  check(p && p.status === 'badpass', 'wrong passphrase: "Couldn’t read it — wrong passphrase"');
  await pg.fill(`${notes} input[type=password]`, PHOTO_PASS);
  p = await waitPhoto(p => p.status === 'done', 20000);
  check(p && p.status === 'done' && p.lost === 0 && p.w === exp.w && p.h === exp.h, `right passphrase: retry() unlocks, photo complete ${p && p.w}×${p && p.h}, ${p && p.lost} damaged stripes`);
  const same = await pg.evaluate((b64) => { const p = window.modem._test.notes().photos()[0]; const e = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); if (!p.rgba || p.rgba.length !== e.length) return -1; let d = 0; for (let i = 0; i < e.length; i++) if (p.rgba[i] !== e[i]) d++; return d; }, exp.rgba);
  check(same === 0, `received photo is pixel-identical to decodeBand() on the sent stripes (${same} bytes differ)`);
  const canvasSame = await pg.evaluate(() => { const p = window.modem._test.notes().photos()[0]; const cv = document.querySelector('.md-photoitem canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 0; i < d.length; i++) if (d[i] !== p.rgba[i]) n++; return n; });
  check(canvasSame === 0, 'the list canvas shows exactly those pixels (no scan line once done)');
  const results = await pg.evaluate(() => window.__results);
  check(!results.some(t => /Secret note|Open note|too garbled/.test(t)), 'routing: a photo train never produced a text-note result (' + [...new Set(results)].join(' | ') + ')');
  const textItems = await pg.$$eval(`${notes} .md-inbox li:not(.md-photoitem)`, l => l.length); check(textItems === 0, 'routing: no text entries in the received list');
  const [dlp] = await Promise.all([pg.waitForEvent('download'), pg.click(`${notes} .md-photoitem button:has-text("Save picture")`)]);
  const pngPath = '/tmp/rs/photo-saved.png'; await dlp.saveAs(pngPath);
  const { PNG } = await import('/tmp/ph/node_modules/pngjs/lib/png.js'); const sv = PNG.sync.read(fs.readFileSync(pngPath));
  let nn = 0; for (let y = 0; y < sv.height; y++) for (let x = 0; x < sv.width; x++) for (let c = 0; c < 3; c++) if (sv.data[(y * sv.width + x) * 4 + c] !== expRgba[((y / 6 | 0) * exp.w + (x / 6 | 0)) * 4 + c]) nn++;
  check(sv.width === exp.w * 6 && sv.height === exp.h * 6 && nn === 0, `Save picture: ${dlp.suggestedFilename()} ${sv.width}×${sv.height}, nearest-neighbour ×6 of the received pixels (${nn} mismatches)`);
  clearInterval(sp);
  // a fresh listening session with the passphrase already set: the photo is visible while it arrives, scan line and all
  await pg.click(`${notes} button:has-text("Stop listening")`);
  await pg.click(`${notes} button:has-text("Start listening")`);
  let scanPx = 0, midRows = [];
  for (let i = 0; i < 400 && !scanPx; i++) {
    const r = await pg.evaluate(() => { const p = window.modem._test.notes().photos()[0]; if (!p || p.status !== 'receiving' || p.done) return null;
      const cv = document.querySelector('.md-photoitem canvas'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0;
      for (let k = 0; k < d.length; k += 4) if (d[k] === 120 && d[k + 1] === 255 && d[k + 2] === 140) n++; return { n, next: p.next, st: document.querySelector('.md-photost').textContent }; });
    if (r) { midRows.push(r.st); if (r.n >= exp.w) scanPx = r.n; }
    await pg.waitForTimeout(100);
  }
  check(scanSeen || scanPx > 0, `while a photo arrives its canvas shows a bright scan line (${scanPx} px; status "${midRows[midRows.length - 1]}")`);
  p = await waitPhoto(p => p.status === 'done', 40000);
  check(p && p.status === 'done' && p.lost === 0, 'second session: photo completes without needing a retry');
  await pg.click(`${notes} button:has-text("Stop listening")`);
  await pg.screenshot({ path: '/tmp/rs/modem-photo-rx.png', fullPage: true });

  // ---- sender: choose a picture, preview = decoded stripes, save as sound, decode the file, paint while sending
  await pg.fill(`${notes} input[type=password]`, '');
  await pg.check(`${notes} input[value=photo]`);
  check(await pg.isVisible(`${notes} button:has-text("Choose picture…")`) && !(await pg.isVisible(`${notes} textarea`)), 'Note | Photo choice switches the send panel to photo');
  await pg.check(`${notes} input[value=quick]`);
  await pg.setInputFiles(`${notes} input[type=file][accept="image/*"]`, '/tmp/ph/coffee.png');
  await pg.waitForFunction((sel) => /stripes/.test(document.querySelector(sel).textContent), `${notes} .md-photopart .md-hint[aria-live]`, { timeout: 10000 });
  const info = await pg.$eval(`${notes} .md-photopart .md-hint[aria-live]`, el => el.textContent); check(/\d+×\d+ px · \d+ stripes · \d+ bytes · about [\d.]+ s of airtime at Quick/.test(info), 'preview info: ' + info);
  const pv = await pg.evaluate(() => { const p = window.modem._test.notes().preview(); return { w: p.w, h: p.h, bands: p.img.bands.length }; });
  check(pv.w === 96 || pv.h === 96, `default size Small fits the picture to 96 px (${pv.w}×${pv.h})`);
  await pg.selectOption(`${notes} select[id$=psize]`, 'tiny'); await pg.selectOption(`${notes} select[id$=pdetail]`, 'low');
  const pv2 = await pg.evaluate(() => { const p = window.modem._test.notes().preview(); return { w: p.w, h: p.h }; }); check(Math.max(pv2.w, pv2.h) === 64, `Tiny re-encodes to 64 px (${pv2.w}×${pv2.h})`);
  const [dls] = await Promise.all([pg.waitForEvent('download'), pg.click(`${notes} button:has-text("Save open photo as sound")`)]);
  const wavP = '/tmp/rs/photo-saved.wav'; await dls.saveAs(wavP);
  check(/open-photo\.wav/.test(dls.suggestedFilename()), 'Save as sound for photos: ' + dls.suggestedFilename());
  try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavP, '-c:a', 'aac', '-b:a', '64k', '/tmp/rs/photo-saved.m4a']); } catch (e) {}
  for (const f of [wavP, '/tmp/rs/photo-saved.m4a']) {
    if (!fs.existsSync(f)) continue;
    const before = await pg.evaluate(() => window.modem._test.notes().photos().length);
    await pg.setInputFiles(`${notes} input[type=file][accept^="audio"]`, f);
    await pg.waitForFunction((n) => { const ps = window.modem._test.notes().photos(); return ps.length > n && ps[0].status === 'done'; }, before, { timeout: 60000 }).catch(() => {});
    const d = await pg.evaluate(() => { const p = window.modem._test.notes().photos()[0], q = window.modem._test.notes().preview(); if (!p || p.status !== 'done') return { st: p && p.status }; let n = 0; for (let i = 0; i < q.preview.length; i++) if (p.rgba[i] !== q.preview[i]) n++; return { st: p.status, n, lost: p.lost.size }; });
    check(d.st === 'done' && d.n === 0, `Decode a sound file (${path.basename(f)}): open photo complete and identical to the sender's preview (${JSON.stringify(d)})`);
  }
  await pg.click(`${notes} button:has-text("Send open photo")`);
  let rowsSeen = []; for (let i = 0; i < 30; i++) { const r = await pg.evaluate(() => { const s = window.modem._test.notes().sending(); return s ? s.rows : -1; }); rowsSeen.push(r); if (r > 0 && r < pv2.h) break; await pg.waitForTimeout(300); }
  check(rowsSeen.some(r => r > 0 && r < pv2.h), `sender's preview paints top to bottom while sending (rows ${rowsSeen.filter(r => r >= 0).join(',')})`);
  await pg.screenshot({ path: '/tmp/rs/modem-photo-tx.png', fullPage: true });
  await pg.click(`${notes} .md-send button:has-text("Stop")`);
  if (fs.existsSync(AXE)) {
    await pg.addScriptTag({ path: AXE });
    const res = await pg.evaluate(async () => { const r = await window.axe.run(document.querySelector('.modem'), { resultTypes: ['violations'] }); return r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 2).map(n => n.target.join(' ')) })); });
    for (const v of res) console.log(`  axe ${v.impact}: ${v.id} ×${v.n}  e.g. ${v.ex.join(' | ')}`);
    check(res.length === 0, `axe (photo mode, with received photos): ${res.length} violations`);
  }
  check(!log2.some(l => l.includes(PHOTO_PASS)), 'console never shows the photo passphrase');
  check(err2.length === 0, 'no page errors (photos)' + (err2.length ? ': ' + err2.join(' | ') : ''));
  await b2.close();
}
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
