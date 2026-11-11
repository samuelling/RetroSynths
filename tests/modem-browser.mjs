// Usage: node tests/modem-browser.mjs
// Loads apps/oldschool/modem/index.html in headless Chrome, runs AT sessions through the real AudioWorklet,
// captures the 8 kHz line + speaker signals via the test tap, checks tones/levels/results, writes WAVs and a screenshot.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { goertzel, rms, writeWav } from './modem-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
fs.mkdirSync('/tmp/rs', { recursive: true });

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1300 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };

await page.goto(`http://127.0.0.1:${port}/apps/oldschool/modem/index.html?autostart`);
await page.waitForFunction(() => window.modem && window.modemCtx && window.modemCtx.state === 'running', null, { timeout: 15000 });
await page.waitForTimeout(800);

/** run one session; returns terminal text, events, captured signals */
async function session(name, cmds, { until = /CONNECT|BUSY|NO CARRIER|NO DIALTONE|NO ANSWER/, extra = 1.5, timeout = 60, quiet = false } = {}) {
  await page.evaluate(() => { const t = window.modem._test; t.tap(true); t.events.length = 0; window.__term0 = document.querySelector('.md-screen').textContent.length; });
  for (const c of cmds) { await page.evaluate((c) => window.modem.command(c), c); await page.waitForTimeout(150); }
  const t0 = Date.now();
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('.md-screen').textContent.slice(window.__term0 || 0)), until.source, { timeout: timeout * 1000 });
  await page.waitForTimeout(extra * 1000);
  const r = await page.evaluate(() => {
    const t = window.modem._test.tap(false);
    const cat = (arr) => { const n = arr.reduce((a, b) => a + b.length, 0), o = new Float32Array(n); let k = 0; for (const a of arr) { o.set(a, k); k += a.length; } return Array.from(o); };
    const ev = window.modem._test.events.filter(e => e.kind !== 'rx' && e.kind !== 'tx').map(e => ({ t: e.t, kind: e.kind, side: e.side, label: e.label, code: e.code, name: e.name }));
    return { t0: t.t0 || 0, line: cat(t.line), spk: cat(t.spk), events: ev, term: document.querySelector('.md-screen').textContent.slice(window.__term0 || 0) };
  });
  r.wall = (Date.now() - t0) / 1000;
  const t0e = r.events.length ? r.events[0].t : 0;
  // time base: line capture starts when the tap was switched on; approximate with the first event time
  r.at = (re) => { const e = r.events.find(e => e.kind === 'seg' && re.test(e.label)); return e ? e.t : null; };
  writeWav(`/tmp/rs/modem-${name}.wav`, r.spk);
  const nan = r.spk.some(v => !Number.isFinite(v)) || r.line.some(v => !Number.isFinite(v));
  check(!nan, `${name}: no NaN/Inf in ${(r.spk.length / 8000).toFixed(1)} s of audio`);
  const lv = rms(r.spk); if (!quiet) check(lv > 0.005 && lv < 0.5, `${name}: speaker RMS ${lv.toFixed(3)} plausible`);
  r.base = r.t0;
  return r;
}
/** Goertzel power of f in the line capture between two event-relative times (capture t=0 ~ first tapped sample) */
function band(r, tStart, f, dur = 0.2) {
  const base = r.base; const i0 = Math.round((tStart - base) * 8000); const x = r.line.slice(Math.max(0, i0), Math.max(0, i0) + Math.round(dur * 8000));
  return goertzel(x, f);
}
async function captureBase(r) { // engine time of the first captured sample = first seg event's time minus offset of capture; we record via tap start
  return r;
}

// ---------------------------------------------------------------- 1. V.34 to MEGAzine BBS, speaker on
let r = await session('v34', ['ATZ', 'ATM2L3', 'ATDT555-0142'], { extra: 2.5 });
{
  // refine base: find the off-hook transient? use the dial tone label time as anchor: dial tone starts at that event time
  const tDial = r.at(/^Dial tone/), tD1 = r.at(/^DTMF "5"/), tANS = r.at(/^ANSam/), tL1 = r.at(/^Line probing L1/), tCM = r.at(/^V\.8 CM/);
  // the tap starts a few hundred ms before the dial command; locate base by the dial tone onset in the line signal
  const dt = (t, f, d) => band(r, t, f, d);
  check(dt(tDial + 0.3, 350, 0.4) > 0.02 && dt(tDial + 0.3, 440, 0.4) > 0.02 && dt(tDial + 0.3, 1000, 0.4) < 0.01, `dial tone 350+440 Hz present (${dt(tDial + 0.3, 350, 0.4).toFixed(3)}, ${dt(tDial + 0.3, 440, 0.4).toFixed(3)})`);
  check(dt(tD1 + 0.01, 770, 0.07) > 0.05 && dt(tD1 + 0.01, 1336, 0.07) > 0.05 && dt(tD1 + 0.01, 1209, 0.07) < 0.02, `DTMF "5" = 770+1336 Hz (${dt(tD1 + 0.01, 770, 0.07).toFixed(3)}, ${dt(tD1 + 0.01, 1336, 0.07).toFixed(3)})`);
  const t8 = r.at(/^DTMF "0"/); check(dt(t8 + 0.01, 941, 0.07) > 0.05 && dt(t8 + 0.01, 1336, 0.07) > 0.05, 'DTMF "0" = 941+1336 Hz');
  check(tANS && dt(tANS + 0.1, 2100, 0.5) > 0.02 && dt(tANS + 0.1, 1800, 0.5) < dt(tANS + 0.1, 2100, 0.5) / 5, `ANSam 2100 Hz present (${tANS && dt(tANS + 0.1, 2100, 0.5).toFixed(3)})`);
  check(tCM && dt(tCM + 0.05, 980, 0.25) + dt(tCM + 0.05, 1180, 0.25) > 0.03, 'V.8 CM on V.21 ch1 (980/1180 Hz)');
  { const v = [450, 750, 1050, 1200, 2100, 3000].map(f => dt(tL1 + 0.2, f, 0.3));
    check(tL1 && [0, 1, 2, 4, 5].every(k => v[k] > 0.002) && v[3] < v[2] / 3, 'L1/L2 probe comb present, 1200 Hz omitted (' + v.map(x => x.toFixed(4)).join(' ') + ')'); }
  check(/CONNECT/.test(r.term), 'V.34 call connects: ' + (r.term.match(/CONNECT[^\n]*/) || [''])[0].trim());
  check(/MEGAzine|welcome|handle/i.test(r.term), 'BBS banner text arrives over the modulated link');
}
await page.screenshot({ path: '/tmp/rs/modem.png', fullPage: true });
await page.evaluate(() => window.modem.command('ATH'));
await page.waitForTimeout(400);

// ---------------------------------------------------------------- 2. hang-up latency: audio must stop within ~50 ms
{
  await page.evaluate(() => { window.modem._test.tap(true); window.modem.command('ATM2DT555-0133'); });
  await page.waitForTimeout(9000);
  const lat = await page.evaluate(async () => {
    const ctx = window.modemCtx, an = ctx.createAnalyser(); an.fftSize = 512;
    // tap the module's output: AudioWorkletNode -> gain -> destination; analyse the destination by a parallel analyser on the node
    return new Promise((res) => {
      const t = window.modem._test; const before = t.tap(true);
      let hung = 0; const buf = []; let stopT = 0;
      const iv = setInterval(() => {}, 1000);
      const h0 = performance.now(); window.modem.command('ATH');
      setTimeout(() => { clearInterval(iv); const tp = t.tap(false); res({ chunks: tp.spk.map(a => Array.from(a)) }); }, 400);
    });
  });
  const x = lat.chunks.flat();
  // find the last loud sample: after ATH, speaker output must fall quiet quickly
  let lastLoud = -1; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.01) lastLoud = i;
  check(x.length > 0 && lastLoud / 8000 < 0.12, `ATH silences the speaker within ${(lastLoud / 8000 * 1000).toFixed(0)} ms of the tapped stream (incl. message latency)`);
}
await page.waitForTimeout(500);

// ---------------------------------------------------------------- 3. more eras
r = await session('300', ['ATZ', 'ATM2W2', 'ATDT555-0101']);
check(/CONNECT 300/.test(r.term), '300 bps Bell 103: ' + (r.term.match(/CONNECT[^\n]*/) || ['(none)'])[0]);
check(r.events.some(e => /Bell 103 originate mark 1270/.test(e.label || '')), 'Bell 103 originate 1270 Hz segment');
await page.evaluate(() => window.modem.command('ATH')); await page.waitForTimeout(300);

r = await session('2400', ['ATZ', 'ATM2', 'ATDT555-0118']);
check(/CONNECT/.test(r.term) && r.events.some(e => /USB1/.test(e.label || '')) && r.events.some(e => /^S1:/.test(e.label || '')), 'V.34 caller falls back to V.22bis (USB1 + S1) at a 2400 BBS');
await page.evaluate(() => window.modem.command('ATH')); await page.waitForTimeout(300);

r = await session('v32bis', ['ATZ', 'ATM2', 'ATDT555-0133']);
check(/CONNECT/.test(r.term) && r.events.some(e => /^AC:/.test(e.label || '')) && r.events.some(e => /R3 rate signal \(final: 14400/.test(e.label || '')), 'V.32bis handshake to 14400 (AA/AC/CA/CC, R1-R3)');
{
  const tA = r.events.find(e => /^ANS 2100/.test(e.label || '')).t;
  check(band(r, tA + 0.3, 2100, 0.4) > 0.008 && band(r, tA + 0.3, 2100, 0.4) > 5 * band(r, tA + 0.3, 1700, 0.4), `2100 Hz answer tone present in the answer-tone segment (${band(r, tA + 0.3, 2100, 0.4).toFixed(3)})`);
}
await page.evaluate(() => window.modem.command('ATH')); await page.waitForTimeout(300);

await page.evaluate(() => window.modem._test.pick('m56'));
await page.waitForTimeout(2500);
r = await session('v90', ['ATDT555-0156'], { extra: 2 });
check(/CONNECT/.test(r.term) && r.events.some(e => /^DIL:/.test(e.label || '')), 'V.90 call with DIL and PCM training');
await page.evaluate(() => window.modem.command('ATH')); await page.waitForTimeout(300);

r = await session('busy', ['ATZ', 'ATX4M2DT555-0167'], { extra: 0.5 });
check(/BUSY/.test(r.term), 'busy signal detected with X4 -> BUSY');
r = await session('busy-x0', ['ATZ', 'ATX0S7=8M2DT555-0167'], { extra: 0.3 });
check(/NO CARRIER/.test(r.term) && !/BUSY/.test(r.term), 'X0 does not detect busy -> NO CARRIER after S7');

r = await session('err', ['ATQ0V1', 'ATFOO'], { until: /ERROR/, extra: 0.2, quiet: true });
check(/ERROR/.test(r.term), 'unknown command returns ERROR');
r = await session('numeric', ['ATV0', 'ATE1'], { until: /\n0|0$/m, extra: 0.2, quiet: true });
check(/0/.test(r.term), 'ATV0 -> numeric result codes');
await page.evaluate(() => window.modem.command('ATV1'));

// answer mode: ring from MEGAzine, auto-answer on ring 1
await page.evaluate(() => window.modem.command('ATV1')); await page.waitForTimeout(300);
r = await session('answer', ['ATZ', 'ATS0=1M2'], { until: /OK/, extra: 0.2, quiet: true });
await page.evaluate(() => window.modem._test.tap(true));
await page.evaluate(() => { window.modem._test.events.length = 0; window.__term1 = document.querySelector('.md-screen').textContent.length; window.modem._test.ring(6); });
await page.waitForFunction(() => /RING[\s\S]*CONNECT/.test(document.querySelector('.md-screen').textContent.slice(window.__term1)), null, { timeout: 40000 }).catch(() => {});
const term = await page.evaluate(() => document.querySelector('.md-screen').textContent.slice(window.__term1));
check(/RING/.test(term) && /CONNECT/.test(term), 'incoming call: RING, auto-answer (S0=1), CONNECT');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/rs/modem-answer.png', fullPage: true });
await page.evaluate(() => window.modem.command('ATH'));

// unmount cleanly
const um = await page.evaluate(() => { window.modem.unmount(); return document.querySelector('#host').children.length; });
check(um === 0, 'unmount removes the UI');
check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
