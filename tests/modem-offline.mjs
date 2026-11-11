// Usage: node tests/modem-offline.mjs
// Fast spec checks of the modem engine in Node (no browser): AT sessions rendered at 8 kHz, Goertzel/FFT checks
// that the right tones are in the right segments, plus WAVs in /tmp/rs/modem-*.wav.
import { makeRig, goertzel, rms, slice, writeWav } from './modem-harness.mjs';
import { muEncode, muDecode, aEncode, aDecode, Scrambler } from '../apps/oldschool/modem/dsp.js';

let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const seg = (r, re, side) => r.segs.find(s => re.test(s.label) && (!side || s.side === side));
const g = (r, t, f, d = 0.2) => goertzel(slice(r.line, t, t + d), f);
const sane = (r, name) => { const bad = r.spk.some(v => !Number.isFinite(v)) || r.line.some(v => !Number.isFinite(v)); check(!bad, `${name}: no NaN/Inf`); const v = rms(r.spk); check(v > 0.01 && v < 0.5, `${name}: speaker RMS ${v.toFixed(3)}`); };
const call = (model, cmds, secs, opt = {}) => { const r = makeRig({ model, q: opt.q ?? 0.85, region: opt.region || 'na' }); if (opt.region) { r.at.setRegion(opt.region); } for (const c of cmds) r.cmd(c); r.run(secs); return r; };

// ---------------------------------------------------------------- primitives
{
  let ok = true; for (let c = 0; c < 256; c++) { if (c === 0x7f) continue; if (muEncode(muDecode(c)) !== c) ok = false; } check(ok, 'G.711 μ-law decode→encode is the identity on all codes');
  ok = true; for (let c = 0; c < 256; c++) if (aEncode(aDecode(c)) !== c) ok = false; check(ok, 'G.711 A-law decode→encode is the identity on all codes');
  check(muEncode(0) === 0xff && aEncode(0) === 0xd5, 'G.711 idle codes (μ 0xFF, A 0xD5)');
  for (const [a, b, nm] of [[14, 17, 'V.22 1+x^-14+x^-17'], [18, 23, 'V.32 GPC 1+x^-18+x^-23'], [5, 23, 'V.32 GPA 1+x^-5+x^-23']]) {
    const s = new Scrambler(a, b); let reg = 0, okk = true, ones = 0;
    for (let i = 0; i < 4000; i++) { const x = (i * 7919 >> 3) & 1, y = s.bit(x); const d = (y ^ (reg >>> (a - 1)) ^ (reg >>> (b - 1))) & 1; reg = ((reg << 1) | y) & 0x7fffff; if (d !== x) okk = false; }
    const s2 = new Scrambler(a, b); for (let i = 0; i < 4000; i++) ones += s2.bit(1); check(okk && ones > 1700 && ones < 2300, `${nm}: self-synchronising descrambler recovers data; scrambled ones are ~50 % ones (${ones}/4000)`);
  }
}

// ---------------------------------------------------------------- call progress + DTMF
{
  const r = call('r336', ['ATS11=95X1DT123A456B789C*0#D'], 6.5);
  const tbl = { '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633], '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633], '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633], '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633] };
  const all = [697, 770, 852, 941, 1209, 1336, 1477, 1633]; let ok = 0, n = 0; const dts = r.segs.filter(s => /^DTMF/.test(s.label));
  for (const s of dts) { const d = s.label.match(/"(.)"/)[1]; n++; const e = all.map(f => g(r, s.t + 0.01, f, 0.075)); const want = tbl[d]; const top2 = all.map((f, i) => [f, e[i]]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]).sort((a, b) => a - b); if (top2[0] === want[0] && top2[1] === want[1]) ok++; }
  check(n === 16 && ok === 16, `DTMF: all 16 digits carry their exact row/column pair (${ok}/${n})`);
  const d1 = dts[0], d2 = dts[1]; check(Math.abs((d2.t - d1.t) - 0.19) < 0.003, `DTMF timing from S11=95: ${((d2.t - d1.t) * 1000).toFixed(0)} ms digit period (95 on + 95 off)`);
  const dt = seg(r, /^Dial tone/); check(g(r, dt.t + 0.2, 350, 0.4) > 0.03 && g(r, dt.t + 0.2, 440, 0.4) > 0.03, 'NA dial tone 350 + 440 Hz');
  writeWav('/tmp/rs/modem-dtmf.wav', r.spk);
}
{
  const r = call('r336', ['ATX4DT555-0175'], 18);
  const rb = seg(r, /^Ringback/); const on = (t) => g(r, t, 440, 0.3) + g(r, t, 480, 0.3);
  // find the first full ring burst: scan for onset
  let t1 = rb.t; while (on(t1) < 0.01 && t1 < rb.t + 6) t1 += 0.05;
  check(on(t1 + 0.6) > 0.01 && on(t1 + 2.6) < on(t1 + 0.6) / 10 && on(t1 + 6.6) > 0.01, `ringback 440+480 Hz, 2 s on / 4 s off`);
}
{
  const r = call('r336', ['ATX4DT555-0167'], 9); const b = seg(r, /^Busy/);
  const e = (t) => g(r, t, 480, 0.2) + g(r, t, 620, 0.2);
  check(e(b.t + 0.15) > 0.006 && e(b.t + 0.65) < e(b.t + 0.15) / 10 && e(b.t + 1.15) > 0.006 && /BUSY/.test(r.term.map(t => t.text).join()), 'busy 480+620 Hz 0.5/0.5 s, X4 reports BUSY');
  sane(r, 'busy'); writeWav('/tmp/rs/modem-busy.wav', r.spk);
}
{
  const r = call('smart1200e', ['ATDT5550123'], 1.5, { region: 'uk' }); const dt = seg(r, /^Dial tone/);
  check(g(r, dt.t + 0.3, 350, 0.4) > 0.03 && g(r, dt.t + 0.3, 450, 0.4) > 0.03 && g(r, dt.t + 0.3, 440, 0.4) < g(r, dt.t + 0.3, 450, 0.4) / 3, 'UK dial tone 350 + 450 Hz');
  const r2 = call('r336', ['ATDP5'], 4); const brk = r2.events.filter(e => e.kind === 'mech' && /pulse/.test(e.what));
  check(brk.length === 10 && Math.abs(brk[2].t - brk[0].t - 0.1) < 0.002 && Math.abs(brk[1].t - brk[0].t - 0.06) < 0.002, `pulse dialling "5": 5 breaks at 10 pps, 60/40 ms break/make (${brk.length} relay events)`);
}

// ---------------------------------------------------------------- 300 / 1200 / 2400
{
  const r = call('coupler300', ['ATM2DT555-0101'], 22);
  const o = seg(r, /originate mark 1270/), a = seg(r, /answer mark 2225 Hz \(answer/);
  check(g(r, a.t + 0.05, 2225, 0.3) > 0.01, 'Bell 103 answer mark 2225 Hz');
  check(g(r, o.t + 0.05, 1270, 0.2) > 0.05 && g(r, o.t + 0.05, 1070, 0.2) < g(r, o.t + 0.05, 1270, 0.2) / 5, 'Bell 103 originate mark 1270 Hz (not space 1070)');
  check(/CONNECT 300/.test(r.term.map(t => t.text).join()), 'Bell 103 connects at 300');
  sane(r, 'b103'); writeWav('/tmp/rs/modem-300.wav', r.spk);
}
{
  const r = call('smart1200e', ['ATM2DT555-0118'], 18, { region: 'uk' });
  const u = seg(r, /USB1/), ans = seg(r, /^ANS 2100/);
  check(ans && g(r, ans.t + 0.5, 2100, 0.5) > 0.01, 'V.22 (UK, CCITT) answer tone 2100 Hz');
  check(u && g(r, u.t + 0.05, 2250, 0.2) > 0.005 && g(r, u.t + 0.05, 1800, 0.2) > 0.002, 'V.22 USB1 = 2250 Hz, with the 1800 Hz guard tone (UK)');
  check(/CONNECT/.test(r.term.map(t => t.text).join()), 'V.22 1200 connects');
}
{
  const r = call('q2400', ['ATM2DT555-0118'], 17);
  const s1 = seg(r, /^S1:/, 'local'); const e = (f) => g(r, s1.t + 0.01, f, 0.08);
  check(e(900) > 0.02 && e(1500) > 0.02 && e(1200) > 0.02, `V.22bis S1: lines at 1200 ± 300 Hz (${[900, 1200, 1500].map(e).map(x => x.toFixed(3))})`);
  check(/CONNECT 2400/.test(r.term.map(t => t.text).join()), 'V.22bis connects at 2400');
  sane(r, 'v22bis'); writeWav('/tmp/rs/modem-2400.wav', r.spk);
}

// ---------------------------------------------------------------- V.32bis
{
  const r = call('f144', ['ATM2W2DT555-0133'], 22);
  const ans = seg(r, /^ANS 2100 Hz with phase reversals/), aa = seg(r, /^V\.32 AA/), ac = seg(r, /^AC:/);
  check(g(r, ans.t + 0.2, 2100, 0.2) > 0.02, 'V.32bis: 2100 Hz answer tone');
  // phase reversal: correlate the 2100 Hz tone 1 cycle-aligned across a reversal boundary
  const tr = Math.round((ans.t + 0.45) * 8000), x = r.line; let c = 0; const P = 80; // 80 samples = 21 cycles of 2100 Hz
  for (let i = 0; i < 160; i++) c += x[tr - 240 + i] * x[tr + 80 + i];
  check(c < 0, 'V.25 answer tone reverses phase at 450 ms');
  check(g(r, aa.t + 0.3, 1800, 0.3) > 0.03, 'V.32 AA: 1800 Hz from the caller');
  const acE = (f) => goertzel(slice(r.line, ac.t + 0.004, ac.t + 0.05), f);
  check(acE(600) > 0.01 && acE(3000) > 0.005, `V.32 AC: 600 + 3000 Hz (${acE(600).toFixed(3)}, ${acE(3000).toFixed(3)})`);
  check(/CONNECT 14400/.test(r.term.map(t => t.text).join()), 'V.32bis connects at 14400 (W2 shows line speed)');
  sane(r, 'v32bis'); writeWav('/tmp/rs/modem-v32bis.wav', r.spk);
}

// ---------------------------------------------------------------- V.34
{
  const r = call('r336', ['ATM2W2DT555-0142'], 18);
  const am = seg(r, /^ANSam/);
  // 15 Hz AM: envelope of the 2100 Hz band over 0.6 s
  const env = []; for (let k = 0; k < 60; k++) env.push(g(r, am.t + 0.1 + k * 0.01, 2100, 0.01));
  const mean = env.reduce((a, b) => a + b) / env.length; let s15 = 0, c15 = 0; env.forEach((v, k) => { s15 += (v - mean) * Math.sin(2 * Math.PI * 15 * k * 0.01); c15 += (v - mean) * Math.cos(2 * Math.PI * 15 * k * 0.01); });
  const depth = 2 * Math.hypot(s15, c15) / env.length / mean;
  check(depth > 0.12 && depth < 0.3, `ANSam 15 Hz amplitude modulation depth ≈ 20 % (${(depth * 100).toFixed(0)} %)`);
  const cm = seg(r, /^V\.8 CM/), jm = seg(r, /^V\.8 JM/);
  check(g(r, cm.t + 0.02, 980, 0.25) + g(r, cm.t + 0.02, 1180, 0.25) > 5 * g(r, cm.t + 0.02, 1750, 0.25), 'V.8 CM on V.21 channel 1 (980/1180 Hz)');
  check(g(r, jm.t + 0.02, 1650, 0.25) + g(r, jm.t + 0.02, 1850, 0.25) > 5 * g(r, jm.t + 0.02, 2400, 0.25), 'V.8 JM on V.21 channel 2 (1650/1850 Hz), while CM continues on channel 1');
  const ta = seg(r, /^Tone A 2400/), tb = seg(r, /^Tone B 1200/);
  check(g(r, ta.t + 0.005, 2400, 0.04) > 0.01 && g(r, tb.t + 0.005, 1200, 0.04) > 0.03, 'V.34 phase 2: Tone A 2400 Hz (answerer), Tone B 1200 Hz (caller)');
  const l2 = seg(r, /^Line probing L2 \(calling/); const p = (f) => g(r, l2.t + 0.1, f, 0.4);
  const present = [300, 450, 600, 750, 1050, 1350, 1500, 1650, 1950, 2100, 2250, 2550, 2700, 2850, 3000, 3150, 3300].every(f => p(f) > 0.008);
  const absent = [900, 1200, 1800, 2400].every(f => p(f) < 0.002);
  check(present && absent, `L2 line probe: comb at 150 Hz spacing present, 900/1200/1800/2400 Hz omitted`);
  const l1 = seg(r, /^Line probing L1 \(calling/); check(Math.abs(20 * Math.log10(rms(slice(r.line, l1.t + 0.02, l1.t + 0.14)) / rms(slice(r.line, l2.t + 0.1, l2.t + 0.4))) - 6) < 1.2, 'L1 is ~6 dB above L2');
  check(/CONNECT 33600/.test(r.term.map(t => t.text).join()), 'V.34 connects at 33600 on a good line');
  sane(r, 'v34'); writeWav('/tmp/rs/modem-v34.wav', r.spk);
  const rq = call('r336', ['ATW2DT555-0142'], 18, { q: 0.45 }); check(/CONNECT (24000|26400|21600)/.test(rq.term.map(t => t.text).join()), 'V.34 rate drops on a noisy line: ' + rq.term.map(t => t.text).filter(x => /CONNECT/.test(x)));
}

// ---------------------------------------------------------------- V.90, fax, voice, answer mode
{
  const r = call('m56', ['ATM2W2DT555-0156'], 17);
  check(!!seg(r, /^DIL:/) && !!seg(r, /^TRN1d/), 'V.90: TRN1d and DIL from the digital modem');
  const trn = seg(r, /^TRN1d/); const v = slice(r.line, trn.t + 0.05, trn.t + 0.25);
  const bands = [500, 1500, 2500, 3200].map(f => { let a = 0; for (let k = -4; k <= 4; k++) a += goertzel(v, f + k * 20) ** 2; return Math.sqrt(a / 9); });
  check(Math.min(...bands) > Math.max(...bands) / 6, 'V.90 PCM training is broadband hiss (' + bands.map(x => x.toFixed(4)).join(' ') + ')');
  check(/CONNECT (4\d{4}|5\d{4})/.test(r.term.map(t => t.text).join()), 'V.90 connects at a 56K rate: ' + r.term.map(t => t.text).filter(x => /CONNECT/.test(x)));
  sane(r, 'v90'); writeWav('/tmp/rs/modem-v90.wav', r.spk);
  const r2 = call('r336', ['ATW2DT555-0156'], 18); check(/CONNECT 33600|CONNECT 31200/.test(r2.term.map(t => t.text).join()), 'a V.34 modem calling the V.90 server gets V.34');
  const r3 = call('m56', ['ATW2DT555-0142'], 18); check(/CONNECT 3\d{4}/.test(r3.term.map(t => t.text).join()) && !seg(r3, /DIL/), 'a V.90 modem calling an analogue BBS gets V.34 (56K needs a digital end)');
}
{
  const r = call('f144', ['ATM2+FCLASS=1;DT555-0181'], 30);
  const cng = seg(r, /^CNG/), ced = seg(r, /^CED/);
  check(cng && g(r, cng.t + 0.1, 1100, 0.3) > 0.02, 'fax CNG 1100 Hz');
  check(ced && g(r, ced.t + 0.5, 2100, 0.5) > 0.01, 'fax CED 2100 Hz');
  check(/\+FHNG/.test(r.term.map(t => t.text).join()), 'fax to fax: T.30 exchange completes');
  sane(r, 'fax'); writeWav('/tmp/rs/modem-fax.wav', r.spk);
}
{
  const r = call('r336', ['ATM2S7=30DT555-0190'], 34); const h = seg(r, /hello/);
  check(h && rms(slice(r.line, h.t, h.t + 0.6)) > 0.02, 'a person answers: "hello?" formant blip');
  check(/NO CARRIER/.test(r.term.map(t => t.text).join()), 'voice answer -> NO CARRIER after S7');
  writeWav('/tmp/rs/modem-person.wav', r.spk);
}
{
  const r = makeRig({ model: 't9600' }); r.cmd('ATS0=2M2');
  r.eng.msg({ type: 'incoming', plan: { incoming: true, caller: { kind: 'modem', id: 'r336', caps: ['V34', 'V32bis', 'V32', 'V22bis', 'V22', 'B212A', 'B103', 'V21'], ec: ['LAPM'], comp: ['V42BIS'], ch: { tx: -11 }, bell: true } } });
  r.run(26); const tt = r.term.map(t => t.text);
  check(tt.filter(x => x === 'RING').length === 2 && tt.some(x => /CONNECT/.test(x)), 'answer mode: two RINGs, S0=2 auto-answers, V.32 from the answering end');
  check(!!seg(r, /^ANSam|^ANS 2100/, 'local'), 'answer mode: our modem sends the answer tone');
  writeWav('/tmp/rs/modem-answer.wav', r.spk);
}
{ // ATH latency inside the engine: speaker quiet within 50 ms
  const r = call('r336', ['ATM2DT555-0142'], 12); const n0 = r.spk.length; r.cmd('ATH'); r.run(0.2);
  let last = 0; for (let i = n0; i < r.spk.length; i++) if (Math.abs(r.spk[i]) > 0.003) last = i - n0;
  check(last / 8 < 50, `ATH: speaker silent ${(last / 8).toFixed(1)} ms after the command (engine)`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
