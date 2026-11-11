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
const PASS = 'correct horse battery staple', MIC_TEXT = 'Psst. The fake mic heard this through a simulated room.';
if (!fs.existsSync('/tmp/rs/note.wav')) { console.error('run node tests/modem-notes.mjs first (it writes /tmp/rs/note.wav)'); process.exit(2); }
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
  await page.setInputFiles(`${notes} input[type=file]`, f);
  const ok = await waitResult(/Secret note \(passphrase matched\)/, 30000);
  const txt = await resultText();
  check(ok && /Saved as a sound file|fake mic|Quick note via the fake microphone/.test(txt), `Decode a sound file: ${label}`);
}

// ---------------------------------------------------------------- 4. Send plays the note (and an open note is labelled as such)
await page.fill(`${notes} input[type=password]`, '');
const label = await page.$eval(`${notes} .md-send button`, b => b.textContent); check(/open note \(not secret\)/i.test(label), `without a passphrase the button says "${label}"`);
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
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
