// Usage: node tests/modem-notes.mjs [--trials 50] [--quick-check]
// Secret Notes over a simulated acoustic channel: speaker band-pass, room reverb (RT60 0.3–0.6 s, DRR 2–10 dB,
// early reflections), ±0.5 % clock skew, random gain (−35…0 dB), random leading/trailing silence, a clap
// mid-packet, and band-limited (100 Hz – 8 kHz) white noise at several SNRs. Reports success rates per SNR
// for both speeds, checks crypto outcomes and false alarms, writes WAVs, and round-trips lossy transcodes.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { synthesize, decodeBuffer, frameSeconds, MODES, MODE_KEYS, INTRO_SECONDS } from '../apps/oldschool/modem/notes-core.js';
import { packNote, unpackNote } from '../apps/oldschool/modem/notes-crypto.js';
import { Rand, throughRoom, addNoise, filt } from './modem-notes-channel.mjs';
import { writeWav } from './modem-harness.mjs';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
const TRIALS = opt('--trials', 50), FS = 24000;
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
fs.mkdirSync('/tmp/rs', { recursive: true });
const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- 1. robustness sweep
const SNRS = [20, 12, 6, 3, 0, -3, -6, -9];
const NBYTES = 145;                       // a 100-character secret note: 100 + 45 bytes of crypto overhead
const table = {};
const t0 = Date.now();
for (const mode of MODE_KEYS) {
  const ok = Object.fromEntries(SNRS.map(s => [s, 0])), why = {};
  for (let t = 0; t < TRIALS; t++) {
    const rng = new Rand(9000 + t * 13 + MODES[mode].id * 5);
    const payload = Uint8Array.from({ length: NBYTES }, () => Math.floor(rng.next() * 256));
    const room = throughRoom(payload, 1, mode, FS, rng, { intro: t % 4 === 0 });
    for (const snr of SNRS) {
      const y = addNoise(room.clean, room.sigPower, snr, FS, rng);
      const fr = decodeBuffer(y, FS);
      if (fr.some(f => f.ok && same(f.bytes, payload))) ok[snr]++; else { const k = fr.length ? fr.map(f => f.why).join('+') : 'nothing'; why[snr + ' dB ' + k] = (why[snr + ' dB ' + k] || 0) + 1; }
      if (fr.some(f => f.ok && !same(f.bytes, payload))) { console.log('FAIL undetected error!'); fails++; }
    }
  }
  table[mode] = ok;
  const breakAt = SNRS.find(s => ok[s] / TRIALS < 0.9);
  console.log(`\n${MODES[mode].name}: ${MODES[mode].baud} baud, ${MODES[mode].bps} bit/symbol, ${MODES[mode].tones.length} tones; success over ${TRIALS} trials per SNR`);
  console.log('  ' + SNRS.map(s => `${String(s).padStart(3)} dB: ${String(Math.round(100 * ok[s] / TRIALS)).padStart(3)} %`).join(' |'));
  console.log(`  falls below 90 % at ${breakAt ?? '< ' + SNRS[SNRS.length - 1]} dB SNR   (failures: ${JSON.stringify(why)})`);
  const need = { sturdy: [0, 0.9], quick: [6, 0.9], classic: [12, 0.88] }[mode];
  check(ok[need[0]] / TRIALS >= need[1], `${MODES[mode].name}: ≥ ${need[1] * 100} % success at ${need[0]} dB SNR through the room`);
}
console.log(`(sweep took ${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);

// ---------------------------------------------------------------- 2. specific impairments, 50 trials each at 15 dB
for (const mode of MODE_KEYS) {
  for (const [name, o] of Object.entries({
    'skew +0.5 %': { skew: 0.005 }, 'skew −0.5 %': { skew: -0.005 }, 'skew ±0.8 %': null, 'RT60 0.6 s, DRR 2 dB': { rt60: 0.6, drr: 2 },
    'level −45 dB': { gainDb: -45 }, 'two claps': 'claps',
  })) {
    let ok = 0;
    for (let t = 0; t < TRIALS; t++) {
      const rng = new Rand(500 + t * 31); const payload = Uint8Array.from({ length: 80 }, () => Math.floor(rng.next() * 256));
      const oo = o === null ? { skew: (t & 1 ? 1 : -1) * 0.008 } : o === 'claps' ? {} : o;
      const room = throughRoom(payload, 0, mode, FS, rng, oo);
      let y = addNoise(room.clean, room.sigPower, 15, FS, rng);
      if (o === 'claps') { const [a, b] = room.segment; const at = Math.round(a + (b - a) * rng.range(0.15, 0.3)); for (let i = 0; i < FS * 0.05; i++) y[at + i] += Math.sqrt(room.sigPower) * 10 * rng.gauss() * Math.exp(-i / (FS * 0.012)); }
      if (decodeBuffer(y, FS).some(f => f.ok && same(f.bytes, payload))) ok++;
    }
    console.log(`  ${MODES[mode].name.padEnd(6)} ${name.padEnd(22)} ${ok}/${TRIALS}`);
    check(ok / TRIALS >= (name.includes('0.8') || name.includes('DRR 2') ? 0.8 : 0.88), `${MODES[mode].name}: ${name} at 15 dB SNR`);
  }
}

// ---------------------------------------------------------------- 3. crypto, end to end through the room
{
  const pass = 'correct horse battery staple', text = 'Meet at the MEGAzine table at 9. Bring the 300 baud coupler. — S.';
  for (const mode of MODE_KEYS) {
    const { payload, flags } = await packNote(text, pass, MODES[mode].id);
    const rng = new Rand(77); const room = throughRoom(payload, flags, mode, FS, rng, {}); const y = addNoise(room.clean, room.sigPower, 12, FS, rng);
    const fr = decodeBuffer(y, FS).find(f => f.ok);
    check(!!fr, `${MODES[mode].name}: secret note survives the room at 12 dB (${payload.length} bytes, ${frameSeconds(payload.length, mode).toFixed(1)} s)`);
    if (fr) {
      const a = await unpackNote(fr.bytes, fr.flags, pass, MODES[mode].id), b = await unpackNote(fr.bytes, fr.flags, 'wrong one', MODES[mode].id), c = await unpackNote(fr.bytes, fr.flags, '', MODES[mode].id);
      check(a.status === 'secret' && a.text === text, `${MODES[mode].name}: right passphrase decrypts (GCM tag verified)`);
      check(b.status === 'badpass' && !b.text, `${MODES[mode].name}: wrong passphrase is rejected`);
      check(c.status === 'locked', `${MODES[mode].name}: no passphrase -> locked, not shown`);
    }
  }
  const open = await packNote('an open note', '', 0); const fo = decodeBuffer(synthesize(open.payload, open.flags, 'sturdy', { fs: 48000 }), 48000)[0];
  check(fo && (await unpackNote(fo.bytes, fo.flags, '', 0)).status === 'open', 'open note decodes without a passphrase');
  // tampering: flip a ciphertext bit, fix up CRC by re-framing -> GCM must reject
  const sec = await packNote('tamper test', pass, 0); const bad = sec.payload.slice(); bad[40] ^= 1;
  const ft = decodeBuffer(synthesize(bad, sec.flags, 'quick', { fs: 48000 }), 48000)[0];
  check(ft && ft.ok && (await unpackNote(ft.bytes, ft.flags, pass, 0)).status === 'badpass', 'a modified ciphertext is rejected by the GCM tag');
  // garbled: bury 40 % of the payload under loud noise -> reported as a checksum (CRC-32) failure, not a wrong passphrase
  {
    const rng = new Rand(5), q = MODES.quick; const room = throughRoom(sec.payload, sec.flags, 'quick', FS, rng, { clap: false, drr: 8, gainDb: -6 });
    const y = addNoise(room.clean, room.sigPower, 20, FS, rng); const [a, b] = room.segment;
    const hdrEnd = a + Math.round((0.03 + (q.preSyms + q.sync.length + 26) / q.baud) * FS), L = b - hdrEnd;
    for (let i = hdrEnd + Math.round(0.2 * L); i < hdrEnd + Math.round(0.6 * L); i++) y[i] += 8 * Math.sqrt(room.sigPower) * rng.gauss();  // ~18 dB above the signal (3x is still corrected by the FEC)
    const fr = decodeBuffer(y, FS); check(fr.length === 1 && !fr[0].ok && fr[0].why === 'crc', 'a frame heard but too damaged is reported as a checksum (CRC-32) failure');
  }
  // the header binds speed + flags as GCM AAD: decrypting with the wrong mode id fails
  check((await unpackNote(sec.payload, sec.flags, pass, 1)).status === 'badpass', 'frame header (speed/flags) is authenticated as GCM additional data');
}

// ---------------------------------------------------------------- 4. false alarms: noise, babble, the modem's own handshake sounds
{
  const rng = new Rand(3); let falses = 0; const N = FS * 60;
  const noise = new Float32Array(N); for (let i = 0; i < N; i++) noise[i] = 0.1 * rng.gauss();
  falses += decodeBuffer(noise, FS).length;
  // "babble": random tones and chirps across the band, changing every 20–200 ms
  const bab = new Float32Array(N); let ph = 0, f = 1000, nx = 0; for (let i = 0; i < N; i++) { if (i >= nx) { f = rng.range(300, 3500); nx = i + Math.round(rng.range(0.02, 0.2) * FS); } ph += 2 * Math.PI * f / FS; bab[i] = 0.3 * Math.sin(ph) + 0.05 * rng.gauss(); }
  falses += decodeBuffer(bab, FS).filter(f => f.ok || f.why === 'crc').length;
  // the intro flourish alone
  const p = new Uint8Array(1); const intro = synthesize(p, 0, 'sturdy', { fs: FS, intro: true }).subarray(0, Math.round(INTRO_SECONDS * FS));
  falses += decodeBuffer(intro, FS).length;
  check(falses === 0, `no false notes from 60 s of noise, 60 s of tone babble, or the fake handshake intro (${falses})`);
}

// ---------------------------------------------------------------- 5. WAVs, the fake-mic file, lossy transcodes
{
  const pass = 'correct horse battery staple';
  for (const mode of MODE_KEYS) {
    const n = await packNote('Hello from RetroSynths. This is a secret note.', pass, MODES[mode].id);
    writeWav(`/tmp/rs/note-${mode}.wav`, synthesize(n.payload, n.flags, mode, { fs: 48000, intro: mode === 'classic' }), 48000);
  }
  // a note "recorded in a room" for Chrome's fake microphone: 48 kHz, 15 dB SNR, leading/trailing room noise
  const n = await packNote('Psst. The fake mic heard this through a simulated room.', pass, MODES.sturdy.id);
  const rng = new Rand(11); const room = throughRoom(n.payload, n.flags, 'sturdy', 48000, rng, { lead: 1.0, trail: 1.5, gainDb: -10, skew: 0.004 });
  const y = addNoise(room.clean, room.sigPower, 15, 48000, rng); let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < y.length; i++) y[i] *= 0.5 / pk;
  writeWav('/tmp/rs/note.wav', y, 48000);
  const n2 = await packNote('Quick note via the fake microphone.', pass, MODES.quick.id); const rq = new Rand(12);
  const roomq = throughRoom(n2.payload, n2.flags, 'quick', 48000, rq, { lead: 1.0, trail: 1.5, gainDb: -10, skew: -0.004 });
  const yq = addNoise(roomq.clean, roomq.sigPower, 15, 48000, rq); pk = 0; for (const v of yq) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < yq.length; i++) yq[i] *= 0.5 / pk;
  writeWav('/tmp/rs/note-quick-room.wav', yq, 48000);
  console.log('wrote /tmp/rs/note.wav (Sturdy, through the room), /tmp/rs/note-quick-room.wav, /tmp/rs/note-{sturdy,quick,classic}.wav');
  let ff = true; try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { ff = false; }
  if (ff) {
    const readWav = (p) => { const b = fs.readFileSync(p); let o = 12; let sr = 48000, data = null, ch = 1; while (o < b.length) { const id = b.toString('ascii', o, o + 4), sz = b.readUInt32LE(o + 4); if (id === 'fmt ') { ch = b.readUInt16LE(o + 10); sr = b.readUInt32LE(o + 12); } if (id === 'data') data = b.subarray(o + 8, o + 8 + sz); o += 8 + sz + (sz & 1); } const n = data.length / 2 / ch, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = data.readInt16LE(i * 2 * ch) / 32768; return { x, sr }; };
    for (const [src, label] of [['/tmp/rs/note-sturdy.wav', 'Sturdy'], ['/tmp/rs/note-quick.wav', 'Quick'], ['/tmp/rs/note-classic.wav', 'Classic'], ['/tmp/rs/note.wav', 'Sturdy via room'], ['/tmp/rs/note-quick-room.wav', 'Quick via room']]) {
      for (const [codec, ext, extra] of [['aac', 'm4a', ['-b:a', '64k']], ['libopus', 'ogg', ['-b:a', '24k', '-application', 'voip']], ['libmp3lame', 'mp3', ['-b:a', '64k']]]) {
        const enc = `/tmp/rs/note-tx.${ext}`, dec = '/tmp/rs/note-tx-dec.wav';
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-c:a', codec, ...extra, enc]);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', enc, '-ac', '1', '-c:a', 'pcm_s16le', dec]);
        const { x, sr } = readWav(dec); const fr = decodeBuffer(x, sr).find(f => f.ok);
        const u = fr && await unpackNote(fr.bytes, fr.flags, pass, MODES[fr.mode].id);
        check(u && u.status === 'secret', `${label} note survives ${codec} ${extra[1]} (${ext}) transcode and decrypts`);
      }
    }
  }
}

// ---------------------------------------------------------------- 6. throughput summary
for (const mode of MODE_KEYS) {
  const m = MODES[mode], netBps = m.baud * m.bps / 2;
  const t100 = frameSeconds(145, mode), t100o = frameSeconds(100, mode);
  console.log(`${m.name}: gross ${m.baud * m.bps} bit/s, net ${netBps} bit/s = ${(netBps / 8).toFixed(1)} bytes/s; 100-character note: ${t100.toFixed(1)} s secret (145 B), ${t100o.toFixed(1)} s open (before compression); fixed overhead ${frameSeconds(0, mode).toFixed(2)} s; intro adds ${INTRO_SECONDS} s`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
