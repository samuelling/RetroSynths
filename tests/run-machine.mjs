// Usage: node tests/run-machine.mjs <machineId> [--sweep] [--seconds 30] [--start 8]
// Serves the repo on a private port, renders the Blasta demo through one machine in headless Chrome,
// prints levels / speed / errors, and writes /tmp/rs/<id>_demo.wav (and _sweep.wav with --sweep).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args[0];
if (!id) { console.error('usage: node tests/run-machine.mjs <id> [--sweep] [--seconds N] [--start S]'); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const seconds = opt('--seconds', 30), start = opt('--start', 8);

// per-machine worklet entry, so one machine's bug can't break another's test
fs.mkdirSync(path.join(root, 'tests/tmp'), { recursive: true });
fs.writeFileSync(path.join(root, `tests/tmp/worklet-${id}.js`),
  `import M from '../../common/machines/${id}.js';\nimport { defineHost } from '../../common/host-core.js';\ndefineHost({ '${id}': M }, 'host-${id}');\n`);

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.sf2': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;


// pull a big ArrayBuffer out of the page in base64 chunks (Array.from on 60 MB WAVs runs Chrome out of memory)
async function pullWav(page, name) {
  const len = await page.evaluate((n) => window[n].byteLength, name);
  const parts = [];
  for (let off = 0; off < len; off += 4 << 20) {
    const b64 = await page.evaluate(([n, o, e]) => {
      const u = new Uint8Array(window[n], o, e - o); let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
      return btoa(s);
    }, [name, off, Math.min(len, off + (4 << 20))]);
    parts.push(Buffer.from(b64, 'base64'));
  }
  return Buffer.concat(parts);
}

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) pageErrors.push(m.text()); });
let code = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/tests/machine-test.html`);
  fs.mkdirSync('/tmp/rs', { recursive: true });
  const demo = await page.evaluate(([i, s, st]) => window.runDemo(i, s, st), [id, seconds, start]);
  fs.writeFileSync(`/tmp/rs/${id}_demo.wav`, await pullWav(page, '_demoWav'));
  console.log('DEMO', JSON.stringify(demo));
  if (args.includes('--sweep')) {
    const sw = await page.evaluate((i) => window.runSweep(i), id);
    fs.writeFileSync(`/tmp/rs/${id}_sweep.wav`, await pullWav(page, '_sweepWav'));
    const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
    const mm = med(sw.melodic), dm = med(sw.drums);
    console.log('SWEEP', JSON.stringify({ melodicMedianDb: mm, drumMedianDb: dm, nan: sw.nan, errors: sw.errors,
      silentPrograms: sw.melodic.map((v, i) => [i, v]).filter(([, v]) => v < -60).map(([i]) => i),
      quietPrograms: sw.melodic.map((v, i) => [i, v]).filter(([, v]) => v < mm - 14 && v >= -60),
      loudPrograms: sw.melodic.map((v, i) => [i, v]).filter(([, v]) => v > mm + 9),
      silentDrums: sw.drums.map((v, i) => [35 + i, v]).filter(([, v]) => v < -60).map(([n]) => n) }));
  }
  if (demo.errors.length || demo.nan) code = 1;
} catch (err) { console.log('FAILED', err.message); code = 1; }
if (pageErrors.length) { console.log('PAGE ERRORS', JSON.stringify(pageErrors)); code = 1; }
await browser.close(); server.close();
process.exit(code);
