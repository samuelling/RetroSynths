// Usage: node tests/shot-machine.mjs <machineId> [presetIndex …]
// Opens the real Console/Old School app on one machine, powers on, plays the demo, checks the Voices panel and
// Arranger, selects instruments (default: first, middle, last) and screenshots the editor:
//   /tmp/rs/<id>_app.png (whole app), /tmp/rs/<id>_inst<N>.png (instrument panel), and plays a few keyboard notes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [id, ...picks] = process.argv.slice(2);
if (!id) { console.error('usage: node tests/shot-machine.mjs <id> [presetIndex …]'); process.exit(2); }
const group = ['nes', 'snes', 'genesis', 'tg16', 'gb'].includes(id) ? 'console' : ['opl2', 'opl3', 'awe32', 'live'].includes(id) ? 'blasta' : 'oldschool';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
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
const page = await browser.newPage({ viewport: { width: 1180, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push('page: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text().slice(0, 300)); });
let code = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/apps/${group}/index.html?machine=${id}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.click('#boot');
  await page.waitForTimeout(id === 'snes' ? 4000 : group === 'blasta' ? 9000 : 1500);
  await page.click('#btnDemo');
  await page.waitForTimeout(3500);
  const info = await page.evaluate(() => ({
    voices: [...document.querySelectorAll('#voiceRows .vrow')].map(r => r.querySelector('.vname').textContent + ' | ' + r.querySelector('.vwhat').textContent),
    arranger: [...document.querySelectorAll('#arrRows .arow:not(.head)')].map(r => r.querySelector('.num').textContent + ' ' + r.querySelector('.gm').textContent + ' → ' + r.querySelector('.ai').selectedOptions[0].textContent),
    instruments: document.querySelectorAll('#instList option').length,
    status: document.getElementById('status').textContent,
  }));
  console.log('VOICES', JSON.stringify(info.voices));
  console.log('ARRANGER', JSON.stringify(info.arranger));
  console.log('INSTRUMENTS', info.instruments, '| status:', info.status);
  await page.screenshot({ path: `/tmp/rs/${id}_app.png`, fullPage: true });
  const n = info.instruments;
  const list = picks.length ? picks.map(Number) : [0, Math.floor(n / 2), n - 1].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);
  for (const i of list) {
    await page.selectOption('#instList', String(i));
    await page.waitForTimeout(400);
    const name = await page.textContent('#instName');
    // play a little phrase on the keyboard with this instrument
    for (const k of ['a', 'd', 'g', 'k']) { await page.keyboard.down(k); await page.waitForTimeout(120); await page.keyboard.up(k); }
    const box = await page.$('.instruments');
    await box.screenshot({ path: `/tmp/rs/${id}_inst${i}.png` });
    console.log('INST', i, name, '→', `/tmp/rs/${id}_inst${i}.png`);
  }
} catch (err) { console.log('FAILED', err.message); code = 1; }
if (errors.length) { console.log('ERRORS', JSON.stringify(errors.slice(0, 10))); code = 1; }
await browser.close(); server.close();
process.exit(code);
