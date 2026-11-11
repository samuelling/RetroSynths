// Modem session: negotiation + handshake timelines (both ends) + the streaming engine (line, speaker, events).
// The handshake is laid out as a script of segments on three tracks (caller modem, answering modem, the
// phone network); the engine then streams them sample by sample at 8 kHz. Nothing is pre-rendered.
import { FS, ms, dB, dBm0, Rng, Biquad, Chain, muQuant, aQuant, Osc, Scrambler, DiffQPSK, V22bisQAM, GridQAM, listThen, cycleBits, hdlcBits } from './dsp.js';
import * as G from './signals.js';
import { REGIONS, PROTO_NAME, modelById } from './models.js';

const sec = (x) => Math.round(x * FS);

// ------------------------------------------------------------------ script
class Seg { constructor(start, n, gen, label, phase, onStart) { this.start = start; this.n = n; this.gen = gen; this.label = label; this.phase = phase; this.onStart = onStart; } }
export class Script {
  constructor() { this.tr = { caller: [], answerer: [], net: [] }; this.ev = []; }
  /** add a segment; trims any earlier segment on the same track that would overlap */
  seg(side, t, dur, gen, label, phase, onStart) {
    t = Math.round(t); dur = dur === Infinity ? Infinity : Math.max(1, Math.round(dur));
    const L = this.tr[side]; const last = L[L.length - 1];
    if (last && last.start + last.n > t) last.n = Math.max(0, t - last.start);
    L.push(new Seg(t, dur, gen, label, phase, onStart)); return t + dur;
  }
  cut(side, t) { for (const s of this.tr[side]) { if (s.start >= t) s.n = 0; else if (s.start + s.n > t) s.n = t - s.start; } }
  end(side) { const L = this.tr[side]; return L.length ? L[L.length - 1].start + L[L.length - 1].n : 0; }
  e(t, kind, data = {}) { this.ev.push({ t: Math.round(t), kind, ...data }); }
}

// ------------------------------------------------------------------ capabilities
function capsOf(cfg) {
  const c = cfg.caps;
  return {
    v8: c.has('V34') || c.has('V90') || c.has('P56X') || c.has('P56F'),
    v32: c.has('V32') || c.has('V32bis'), v32bis: c.has('V32bis'),
    v22: c.has('V22') || c.has('V22bis'), v22bis: c.has('V22bis'),
    b212: c.has('B212A'), b103: c.has('B103'), v21: c.has('V21'),
  };
}
const minRate = (...r) => Math.min(...r.filter(x => x > 0));

/** pick the data rate for a protocol from line quality and both ends' limits */
function pickRate(P, q, C, A) {
  const lim = minRate(C.maxRate || 99999, A.maxRate || 99999);
  const ladder = (steps) => { for (const [qq, r] of steps) if (q >= qq && r <= lim) return r; return steps[steps.length - 1][1]; };
  switch (P) {
    case 'V34': return ladder([[0.85, 33600], [0.72, 31200], [0.6, 28800], [0.48, 26400], [0.38, 24000], [0.28, 21600], [0.2, 19200], [0.12, 16800], [0, 14400]]);
    case 'V90': return ladder([[0.92, 53333], [0.85, 52000], [0.77, 50666], [0.68, 49333], [0.6, 48000], [0.52, 46666], [0.45, 45333], [0, 44000]]);
    case 'P56X': return ladder([[0.92, 53333], [0.85, 52000], [0.75, 50666], [0.65, 49333], [0.55, 48000], [0, 46666]]);
    case 'P56F': return ladder([[0.92, 54000], [0.84, 52000], [0.74, 50000], [0.64, 48000], [0.54, 46000], [0, 44000]]);
    case 'V32bis': return ladder([[0.5, 14400], [0.38, 12000], [0.25, 9600], [0.15, 7200], [0, 4800]]);
    case 'V32': return ladder([[0.2, 9600], [0, 4800]]);
    case 'V22bis': return 2400; case 'V22': case 'B212A': return 1200; default: return 300;
  }
}
/** V.34 symbol rate & carrier (Tables 1/2 of V.34: carrier = baud * d/e, low/high) */
const V34_BAUD = { 2400: [1600, 1800], 2743: [1646, 1829], 2800: [1680, 1867], 3000: [1800, 2000], 3200: [1829, 1920], 3429: [1959, 1959] };
function v34Baud(rate, q) {
  const b = rate >= 33600 ? 3429 : rate >= 28800 ? 3200 : rate >= 26400 ? 3000 : rate >= 21600 ? 2800 : rate >= 19200 ? 2743 : 2400;
  return { baud: b, fc: V34_BAUD[b][q > 0.7 ? 1 : 0] };
}

// ------------------------------------------------------------------ handshake builder
/**
 * H = { S, C, A, q, rng, guard }  C/A = { model, caps:Set, ec:[], comp:[], tx, ch, bell, digital, maxRate, ecPref, compOn }
 * tOff: the answering end goes off hook. Returns { proto, rate, tData, tConnect, ... } or { fail: true, tGiveUp }.
 */
export function handshake(H, tOff) {
  const { S, C, A, rng } = H; const c = capsOf(C), a = capsOf(A);
  const j = (x) => sec(x * rng.range(0.92, 1.08));
  let t = tOff + sec(A.ch.billing ?? 2.0);
  S.seg('answerer', tOff, t - tOff, G.SILENCE, 'Billing delay (answer side silent, V.25: 1.8–2.5 s)', 'Answer');
  let aaFrom = null, bellDone = false;                   // a V.32 caller sends AA after a second of 2100 Hz
  const startAA = (t0) => { if (!c.v32 || aaFrom !== null) return; aaFrom = t0 + j(1.0);
    const p = pumpV32(H, 'caller'); S.seg('caller', aaFrom, Infinity, p, 'V.32 AA (1800 Hz, calling modem offers V.32)', 'V.32 automode', () => p.use(G.SRC.constPt(G.SRC.v32('A')))); };
  const stopAA = (t1) => { if (aaFrom !== null) S.cut('caller', t1); };
  const done = (r) => { r.aaFrom = aaFrom; return r; };

  // -------- stage 1: answer tone
  if (a.v8) {
    if (c.v8) return done(pathV8(H, t));
    if (c.v32 && a.v32) {
      startAA(t); const tStop = aaFrom + j(0.35);
      S.seg('answerer', t, tStop - t, G.ansGen(A.tx, { rev: true, am: true }), 'ANSam: 2100 Hz, 15 Hz AM, 180° reversals every 450 ms (V.8)', 'Answer tone');
      S.e(tStop, 'phase', { name: 'Caller is not V.8: answering modem hears AA, drops to V.32' });
      return done(pathV32(H, tStop + ms(75)));
    }
    S.seg('answerer', t, sec(5.0), G.ansGen(A.tx, { rev: true, am: true }), 'ANSam (V.8) — no CM heard', 'Answer tone');
    startAA(t); t += sec(5.0);
  } else if (a.v32) {
    S.seg('answerer', t, sec(3.3), G.ansGen(A.tx, { rev: true }), 'ANS 2100 Hz with phase reversals every 450 ms (V.25, disables echo cancellers)', 'Answer tone');
    startAA(t);
    if (c.v32) return done(pathV32(H, t + sec(3.3) + ms(75)));
    t += sec(3.3);
  } else if ((a.v22 || a.v21) && !(A.bell && (a.b212 || a.b103))) {
    S.seg('answerer', t, sec(3.3), G.ansGen(A.tx), 'ANS 2100 Hz (V.25 answer tone, no reversals)', 'Answer tone');
    startAA(t); t += sec(3.3);
  } else if (a.b212 || a.b103) {
    const accept = (c.b212 && a.b212 || c.b103 && a.b103) && !(c.v22 && a.v22);
    if (accept) return done(c.b212 && a.b212 ? pathB212(H, t) : pathB103(H, t));
    S.seg('answerer', t, sec(3.3), G.bellAnsGen(A.tx), 'Bell answer tone 2225 Hz', 'Answer tone');
    t += sec(3.3); bellDone = true;
  }
  // -------- automode: the answering modem steps down through older handshakes until something answers back
  if (a.v32) {
    t += ms(75); const p = pumpV32(H, 'answerer');
    S.seg('answerer', t, sec(1.2), p, 'V.32 AC (600 + 3000 Hz) automode probe', 'Automode', () => p.use(G.SRC.alt(G.SRC.v32('A'), G.SRC.v32('C'))));
    t += sec(1.2);
  }
  if (a.v22) {
    t += ms(75);
    if (c.v22 || (c.b212 && a.v22)) { stopAA(t + ms(155)); return done(pathV22(H, t, c.v22bis && a.v22bis && !(C.no2400))); }
    const p = pumpV22(H, 'answerer'); S.seg('answerer', t, sec(2.0), p, 'V.22 USB1: unscrambled ones (2250 Hz)', 'Automode', () => p.use(G.SRC.unscrambled(() => 1, DiffQPSK)));
    t += sec(2.0);
  }
  if ((a.b212 || a.b103) && !bellDone) {
    t += ms(75);
    if (c.b212 && a.b212) { stopAA(t); return done(pathB212(H, t)); }
    if (c.b103 && a.b103) { stopAA(t); return done(pathB103(H, t)); }
    S.seg('answerer', t, sec(2.5), G.bellAnsGen(A.tx), 'Bell answer tone 2225 Hz (automode)', 'Automode'); t += sec(2.5);
  }
  if (a.v21) {
    t += ms(75);
    if (c.v21) { stopAA(t); return done(pathV21(H, t)); }
    S.seg('answerer', t, sec(3.0), G.fskGen('v21H', A.tx, () => 1), 'V.21 channel 2 mark (1650 Hz)', 'Automode'); t += sec(3.0);
  }
  S.e(t, 'phase', { name: 'No common modulation — both ends keep listening' });
  return done({ fail: true, tGiveUp: t });
}

// ------------------------------------------------------------------ pumps (one per side per family, kept for continuity)
function pumpV32(H, side) {
  const k = 'v32' + side; if (H[k]) return H[k];
  return (H[k] = new G.QAMPump({ baud: 2400, fc: 1800, beta: 0.25, db: (side === 'caller' ? H.C : H.A).tx }));
}
function pumpV22(H, side) {
  const k = 'v22' + side; if (H[k]) return H[k];
  const p = new G.QAMPump({ baud: 600, fc: side === 'caller' ? 1200 : 2400, beta: 0.75, db: (side === 'caller' ? H.C : H.A).tx });
  if (side === 'answerer' && H.guard) p.setGuard(H.guard === 2 ? 1800 : 550, H.guard === 2 ? -6 : -3);
  return (H[k] = p);
}

// ------------------------------------------------------------------ data mode (shared by every path)
function dataMode(H, side, t, gen, P, rate) {
  const { S } = H; const name = PROTO_NAME[P];
  const ec = H.ec, tec = ec === 'none' ? 0 : sec(ec === 'LAPM' ? 0.45 : 0.35);
  if (tec) S.seg(side, t, tec, gen, ec === 'LAPM' ? 'V.42: ODP/ADP detection, LAPM XID / SABME / UA' : 'MNP link request (LR / LA)', 'Error control');
  S.seg(side, t + tec, Infinity, gen, `Data: ${name} ${rate} bps${ec !== 'none' ? ' · ' + (ec === 'LAPM' ? 'V.42 LAPM' : 'MNP') : ''}${H.comp !== 'none' ? ' · ' + H.comp : ''}`, 'Data');
  return t + tec;
}
function finish(H, P, rate, tDc, tDa, extra = {}) {
  const t = Math.max(tDc, tDa); const tCon = t + (H.ec === 'none' ? 0 : sec(H.ec === 'LAPM' ? 0.45 : 0.35)) + ms(30);
  return { proto: P, rate, tData: { caller: tDc, answerer: tDa }, tCarrier: t, tConnect: tCon, ...extra };
}
const dataPumpBits = (H, side) => () => H.pumps[side].bit();

// ------------------------------------------------------------------ Bell 103 / V.21 (300 bps FSK)
function pathB103(H, t) {
  const { S, C, A } = H; S.e(t, 'phase', { name: 'Bell 103 300 bps FSK' });
  const fa = G.fskGen('b103a', A.tx, dataPumpBits(H, 'answerer')), fc = G.fskGen('b103o', C.tx, dataPumpBits(H, 'caller'));
  S.seg('answerer', t, sec(0.6), fa, 'Bell 103 answer mark 2225 Hz (answer tone)', 'Answer tone');
  const tc = t + sec(0.45);
  S.seg('caller', tc, sec(0.6), fc, 'Bell 103 originate mark 1270 Hz', 'Bell 103');
  const td = tc + sec(0.6);                                                 // S9: 0.6 s carrier detect
  S.seg('answerer', t + sec(0.6), td - t - sec(0.6), fa, 'Bell 103 answer mark 2225 Hz (carrier detect)', 'Bell 103');
  dataMode(H, 'answerer', td, fa, 'B103', 300); dataMode(H, 'caller', td, fc, 'B103', 300);
  return finish(H, 'B103', 300, td, td);
}
function pathV21(H, t) {
  const { S, C, A } = H; S.e(t, 'phase', { name: 'V.21 300 bps FSK' });
  const fa = G.fskGen('v21H', A.tx, dataPumpBits(H, 'answerer')), fc = G.fskGen('v21L', C.tx, dataPumpBits(H, 'caller'));
  const tc = t + sec(0.3), td = tc + sec(0.6);
  S.seg('answerer', t, td - t, fa, 'V.21 channel 2 mark 1650 Hz', 'V.21');
  S.seg('caller', tc, td - tc, fc, 'V.21 channel 1 mark 980 Hz', 'V.21');
  dataMode(H, 'answerer', td, fa, 'V21', 300); dataMode(H, 'caller', td, fc, 'V21', 300);
  return finish(H, 'V21', 300, td, td);
}

// ------------------------------------------------------------------ Bell 212A / V.22 / V.22bis (600 baud DPSK/QAM)
function pathB212(H, t) {
  const { S, A } = H; S.e(t, 'phase', { name: 'Bell 212A 1200 bps DPSK' });
  const pa = pumpV22(H, 'answerer'), pc = pumpV22(H, 'caller');
  const sa = new Scrambler(14, 17, true), sc = new Scrambler(14, 17, true);
  const tS = t + sec(0.611);
  const tA = tS + sec(0.27);
  S.seg('answerer', t, tA - t, G.bellAnsGen(A.tx), 'Bell answer tone 2225 Hz', 'Answer tone');
  S.seg('caller', tS, Infinity, pc, 'Bell 212A scrambled ones, 1200 Hz carrier (x^-14 + x^-17 scrambler)', 'Bell 212A', () => pc.use(G.SRC.scrambled(sc, () => 1, DiffQPSK)));
  S.seg('answerer', tA, sec(0.765), pa, 'Bell 212A scrambled ones, 2400 Hz carrier', 'Bell 212A', () => pa.use(G.SRC.scrambled(sa, () => 1, DiffQPSK)));
  const tDa = tA + sec(0.765), tDc = tA + sec(0.27 + 0.765);
  dataMode(H, 'answerer', tDa, pa, 'B212A', 1200); S.e(tDa, 'src', { fn: () => pa.use(G.SRC.scrambled(sa, dataPumpBits(H, 'answerer'), DiffQPSK)) });
  dataMode(H, 'caller', tDc, pc, 'B212A', 1200); S.e(tDc, 'src', { fn: () => pc.use(G.SRC.scrambled(sc, dataPumpBits(H, 'caller'), DiffQPSK)) });
  return finish(H, 'B212A', 1200, tDc, tDa);
}
function pathV22(H, t, bis) {
  const { S } = H; const P = bis ? 'V22bis' : 'V22';
  S.e(t, 'phase', { name: bis ? 'V.22bis 2400 bps 16-QAM' : 'V.22 1200 bps DPSK' });
  const pa = pumpV22(H, 'answerer'), pc = pumpV22(H, 'caller');
  const sa = new Scrambler(14, 17, true), sc = new Scrambler(14, 17, true);
  const g = H.guard ? ` + ${H.guard === 2 ? '1800' : '550'} Hz guard tone` : '';
  const usb1 = () => pa.use(G.SRC.unscrambled(() => 1, DiffQPSK));
  const sb1 = (p, s) => () => p.use(G.SRC.scrambled(s, () => 1, DiffQPSK));
  const s1 = (p) => () => p.use(G.SRC.unscrambled(cycleBits([0, 0, 1, 1]), DiffQPSK));
  const tS = t + sec(0.155 + 0.456);
  let tDa, tDc;
  if (bis) {
    const tAS1 = tS + sec(0.1);
    S.seg('answerer', t, tAS1 - t, pa, 'USB1: unscrambled binary ones at 1200 bit/s, 2400 Hz carrier → 2250 Hz' + g, 'V.22bis', usb1);
    S.seg('caller', tS, sec(0.1), pc, 'S1: unscrambled double dibits 00/11, 1200 Hz carrier (offers 2400 bit/s)', 'V.22bis', s1(pc));
    S.seg('caller', tS + sec(0.1), sec(0.6), pc, 'SB1 scrambled ones at 1200 bit/s (x^-14 + x^-17)', 'V.22bis', sb1(pc, sc));
    S.seg('answerer', tAS1, sec(0.1), pa, 'S1 (answering modem agrees to 2400 bit/s)', 'V.22bis', s1(pa));
    S.seg('answerer', tAS1 + sec(0.1), sec(0.5), pa, 'SB1 scrambled ones at 1200 bit/s', 'V.22bis', sb1(pa, sa));
    const tA24 = tAS1 + sec(0.6), tC24 = tS + sec(0.7);
    S.seg('answerer', tA24, sec(0.2), pa, 'SB1 scrambled ones at 2400 bit/s (16-point)', 'V.22bis', () => pa.use(G.SRC.scrambled(sa, () => 1, V22bisQAM)));
    S.seg('caller', tC24, sec(0.2), pc, 'SB1 scrambled ones at 2400 bit/s (16-point)', 'V.22bis', () => pc.use(G.SRC.scrambled(sc, () => 1, V22bisQAM)));
    tDa = tA24 + sec(0.2); tDc = tC24 + sec(0.2);
    dataMode(H, 'answerer', tDa, pa, P, 2400); S.e(tDa, 'src', { fn: () => pa.use(G.SRC.scrambled(sa, dataPumpBits(H, 'answerer'), V22bisQAM)) });
    dataMode(H, 'caller', tDc, pc, P, 2400); S.e(tDc, 'src', { fn: () => pc.use(G.SRC.scrambled(sc, dataPumpBits(H, 'caller'), V22bisQAM)) });
  } else {
    const tA = tS + sec(0.27);
    S.seg('answerer', t, tA - t, pa, 'USB1: unscrambled binary ones, 2400 Hz carrier → 2250 Hz' + g, 'V.22', usb1);
    S.seg('caller', tS, Infinity, pc, 'SB1 scrambled ones, 1200 Hz carrier', 'V.22', sb1(pc, sc));
    S.seg('answerer', tA, sec(0.765), pa, 'SB1 scrambled ones, 2400 Hz carrier (765 ms)', 'V.22', sb1(pa, sa));
    tDa = tA + sec(0.765); tDc = tA + sec(0.27 + 0.765);
    dataMode(H, 'answerer', tDa, pa, P, 1200); S.e(tDa, 'src', { fn: () => pa.use(G.SRC.scrambled(sa, dataPumpBits(H, 'answerer'), DiffQPSK)) });
    dataMode(H, 'caller', tDc, pc, P, 1200); S.e(tDc, 'src', { fn: () => pc.use(G.SRC.scrambled(sc, dataPumpBits(H, 'caller'), DiffQPSK)) });
  }
  return finish(H, P, bis ? 2400 : 1200, tDc, tDa);
}

// ------------------------------------------------------------------ V.32 / V.32bis
const rateWord = (rate, bis) => { // V.32-style 16-bit rate sequence: 0001 1xxx 1xxx 1xxx (approximate field layout)
  let w = 0x1888; if (rate >= 4800) w |= 0x0400; if (rate >= 9600) w |= 0x0200; if (rate >= 7200 && bis) w |= 0x0100;
  if (rate >= 12000) w |= 0x0040; if (rate >= 14400) w |= 0x0020; w |= 0x0001; return w;
};
function pathV32(H, tAC) {
  const { S, C, A, q, rng } = H; const bis = C.caps.has('V32bis') && A.caps.has('V32bis');
  const P = bis ? 'V32bis' : 'V32', rate = pickRate(P, q, C, A), T = 1 / 2400;
  S.e(tAC, 'phase', { name: `${PROTO_NAME[P]} training (2400 baud, 1800 Hz carrier)` });
  const pa = pumpV32(H, 'answerer'), pc = pumpV32(H, 'caller');
  const sa = new Scrambler(5, 23), sc = new Scrambler(18, 23);     // GPA 1+x^-5+x^-23, GPC 1+x^-18+x^-23
  const st = G.SRC, V = st.v32, sy = (n) => sec(n * T);
  // caller already sends AA (from automode); make sure it does
  if (!S.tr.caller.some(s => s.n === Infinity && s.label.startsWith('V.32 AA'))) S.seg('caller', tAC - sec(0.4), Infinity, pc, 'V.32 AA (1800 Hz)', 'V.32', () => pc.use(st.constPt(V('A'))));
  // round-trip delay exchange
  const tR1 = tAC + sy(128);
  S.seg('answerer', tAC, sy(128), pa, 'AC: alternating A/C states → 600 + 3000 Hz', 'V.32 ranging', () => pa.use(st.alt(V('A'), V('C'))));
  const tCC = tR1 + ms(5) + sy(64);
  S.cut('caller', tCC);
  S.seg('caller', tCC, Infinity, pc, 'CC: AA phase-reversed, 64 symbols after the AC→CA reversal (round-trip timing)', 'V.32 ranging', () => pc.use(st.constPt(V('C'))));
  const tR2 = tCC + ms(5) + ms(8);
  S.seg('answerer', tR1, tR2 - tR1, pa, 'CA: phase reversal of AC (starts round-trip delay timer)', 'V.32 ranging', () => pa.use(st.alt(V('C'), V('A'))));
  S.seg('answerer', tR2, sy(64), pa, 'AC again (round-trip delay measured)', 'V.32 ranging', () => pa.use(st.alt(V('A'), V('C'))));
  S.cut('caller', tR2 + ms(5) + sy(32));
  // answering modem trains first: S, S̄, TRN, R1
  let ta = tR2 + sy(64) + sy(16);
  const trnA = A.ch.trn32 || 1280, trnC = C.ch.trn32 || 1280;
  ta = S.seg('answerer', ta, sy(256), pa, 'S: ABAB alternation (256 symbols) — echo canceller & AGC start', 'V.32 training', () => pa.use(st.alt(V('A'), V('B'))));
  ta = S.seg('answerer', ta, sy(16), pa, 'S̄: CDCD (16 symbols)', 'V.32 training', () => pa.use(st.alt(V('C'), V('D'))));
  ta = S.seg('answerer', ta, sy(trnA), pa, `TRN: scrambled ones, 4-point (${trnA} symbols, scrambler 1+x^-5+x^-23)`, 'V.32 training', () => pa.use(st.v32trn4(sa)));
  const wA = rateWord(rate, bis), tR1s = ta;
  // calling modem hears R1, then trains: S, S̄, TRN, R2
  let tc = tR1s + sy(32) + ms(5) + sy(16);
  S.seg('answerer', ta, tc + sy(64) - ta, pa, `R1 rate signal (answerer offers up to ${bis ? 14400 : 9600})`, 'V.32 rates', () => pa.use(st.word16(sa, wA)));
  tc = S.seg('caller', tc, sy(256), pc, 'S: ABAB (calling modem)', 'V.32 training', () => pc.use(st.alt(V('A'), V('B'))));
  tc = S.seg('caller', tc, sy(16), pc, 'S̄: CDCD', 'V.32 training', () => pc.use(st.alt(V('C'), V('D'))));
  tc = S.seg('caller', tc, sy(trnC), pc, `TRN: scrambled ones, 4-point (${trnC} symbols, scrambler 1+x^-18+x^-23)`, 'V.32 training', () => pc.use(st.v32trn4(sc)));
  const tR2s = tc;
  // answering modem hears R2: S, S̄, TRN, R3
  ta = tR2s + sy(32) + ms(5);
  ta = S.seg('answerer', ta, sy(256), pa, 'S (second training)', 'V.32 training', () => pa.use(st.alt(V('A'), V('B'))));
  ta = S.seg('answerer', ta, sy(16), pa, 'S̄', 'V.32 training', () => pa.use(st.alt(V('C'), V('D'))));
  ta = S.seg('answerer', ta, sy(1280), pa, 'TRN (1280 symbols)', 'V.32 training', () => pa.use(st.v32trn4(sa)));
  const tR3s = ta, w3 = rateWord(rate, bis);
  const tEc = tR3s + sy(32) + ms(5);
  S.seg('caller', tR2s, tEc - tR2s, pc, `R2 rate signal (caller: up to ${bis ? 14400 : 9600})`, 'V.32 rates', () => pc.use(st.word16(sc, rateWord(C.maxRate || 14400, bis))));
  const b = Math.round(rate / 2400);
  const dataSrc = (scr, side) => () => (side === 'caller' ? pc : pa).use(st.scrambled(scr, dataPumpBits(H, side), GridQAM, b));
  tc = S.seg('caller', tEc, sy(8), pc, 'E: end of rate sequence', 'V.32 rates', () => pc.use(st.word16(sc, (w3 & 0x0fff) | 0xf000)));
  tc = S.seg('caller', tc, sy(128), pc, `B1: scrambled ones at ${rate} bps`, 'V.32', () => pc.use(st.scrambled(sc, () => 1, GridQAM, b)));
  const tEa = tEc + sy(8) + ms(5);
  S.seg('answerer', tR3s, tEa - tR3s, pa, `R3 rate signal (final: ${rate} bps)`, 'V.32 rates', () => pa.use(st.word16(sa, w3)));
  ta = S.seg('answerer', tEa, sy(8), pa, 'E', 'V.32 rates', () => pa.use(st.word16(sa, (w3 & 0x0fff) | 0xf000)));
  ta = S.seg('answerer', ta, sy(128), pa, `B1: scrambled ones at ${rate} bps`, 'V.32', () => pa.use(st.scrambled(sa, () => 1, GridQAM, b)));
  dataMode(H, 'caller', tc, pc, P, rate); S.e(tc, 'src', { fn: dataSrc(sc, 'caller') });
  dataMode(H, 'answerer', ta, pa, P, rate); S.e(ta, 'src', { fn: dataSrc(sa, 'answerer') });
  return finish(H, P, rate, tc, ta);
}

// ------------------------------------------------------------------ V.8 → V.34 / V.90 / pre-standard 56K
function pathV8(H, t) {
  const { S, C, A, q, rng } = H;
  const both = (p) => C.caps.has(p) && A.caps.has(p);
  let P = 'V34';
  if (A.digital && q >= 0.32) { if (both('V90')) P = 'V90'; else if (both('P56X')) P = 'P56X'; else if (both('P56F')) P = 'P56F'; }
  const pcm = P !== 'V34';
  // ---- phase 1: V.8
  S.e(t, 'phase', { name: 'V.8 negotiation (ANSam, CM/JM over V.21)' });
  const lapm = H.ec === 'LAPM';
  const cm = G.V8.message(C.caps, { lapm, pcm: C.caps.has('V90') || C.caps.has('P56X') || C.caps.has('P56F'), digital: false, nsf: C.caps.has('P56X') ? 0x58 : C.caps.has('P56F') ? 0x46 : 0 });
  const joint = new Set([...C.caps].filter(p => A.caps.has(p)));
  const jm = G.V8.message(joint, { lapm, pcm, digital: A.digital, nsf: P === 'P56X' ? 0x58 : P === 'P56F' ? 0x46 : 0 });
  const tCM = t + sec(1.0 + rng.range(0.15, 0.3)), cmLen = cm.length / 300, jmLen = jm.length / 300;
  const tAnsStop = tCM + sec(2 * cmLen + 0.02);
  S.seg('answerer', t, tAnsStop - t, G.ansGen(A.tx, { rev: true, am: true }), 'ANSam: 2100 Hz, 15 Hz AM ±20 %, phase reversals every 450 ms', 'V.8');
  const tJM = tAnsStop + ms(75);
  const tJMok = tJM + sec(2 * jmLen + 0.02);
  const nb = Math.ceil((tJMok - tCM) / FS * 300 / 10) * 10;          // finish the current CM octet
  const cmSeq = []; while (cmSeq.length < nb) cmSeq.push(...cm); cmSeq.length = nb;
  const fc = G.fskGen('v21L', C.tx, listThen([...cmSeq, ...G.V8.cj()], () => 1));
  const tCJ = tCM + sec(nb / 300), tCJend = tCJ + sec(30 / 300);
  S.seg('caller', tCM, tCJ - tCM, fc, `V.8 CM (call menu: ${[...C.caps].filter(p => ['V90', 'P56X', 'P56F', 'V34', 'V32bis', 'V22bis', 'V21'].includes(p)).map(p => PROTO_NAME[p].replace(/ \(.*/, '')).join(', ')}) · V.21 ch1 FSK 980/1180 Hz`, 'V.8');
  S.seg('caller', tCJ, tCJend - tCJ, fc, 'V.8 CJ (three zero octets: CM terminator)', 'V.8');
  S.seg('answerer', tJM, tCJend + ms(10) - tJM, G.fskGen('v21H', A.tx, cycleBits(jm)), `V.8 JM (joint menu: ${PROTO_NAME[P]}) · V.21 ch2 FSK 1650/1850 Hz`, 'V.8');
  // ---- phase 2: line probing & ranging (600 bps DPSK; caller 1200 Hz, answerer 2400 Hz)
  const tP2c = tCJend + ms(75), tP2a = tCJend + ms(85);
  S.e(tP2a, 'phase', { name: 'V.34 phase 2: INFO0, tones A/B, line probing L1/L2, INFO1' });
  const pc = new G.Phase2Pump(1200, C.tx), pa = new G.Phase2Pump(2400, A.tx - 1);
  const i0 = 49 / 600;
  let tc = S.seg('caller', tP2c, sec(i0), pc, 'INFO0c: 49-bit capabilities frame, DPSK 600 bit/s, 1200 Hz', 'V.34 phase 2', () => { pc.mod.re.fill(0); pc.mod.im.fill(0); pc.info(G.infoBits(G.INFO_LEN.INFO0, rng)); });
  let ta = S.seg('answerer', tP2a, sec(i0), pa, 'INFO0a: 49-bit capabilities frame, DPSK 600 bit/s, 2400 Hz', 'V.34 phase 2', () => { pa.mod.re.fill(0); pa.mod.im.fill(0); pa.info(G.infoBits(G.INFO_LEN.INFO0, rng)); });
  const tRevA = Math.max(ta + ms(50), tc + ms(30)), tRevB = tRevA + ms(25);
  S.seg('caller', tc, tRevB - tc, pc, 'Tone B 1200 Hz', 'V.34 phase 2', () => pc.tone());
  S.seg('answerer', ta, tRevA - ta, pa, 'Tone A 2400 Hz', 'V.34 phase 2', () => pa.tone());
  S.seg('caller', tRevB, ms(40), pc, 'B̄: Tone B phase reversal (answers Ā, round-trip delay)', 'V.34 phase 2', () => pc.reverse());
  tc = S.seg('caller', tRevB + ms(40), ms(10), pc, 'B (reversed back)', 'V.34 phase 2', () => pc.reverse());
  const tL1a = tRevB + ms(45);
  S.seg('answerer', tRevA, tL1a - tRevA, pa, 'Ā: Tone A phase reversal (starts round-trip delay timer)', 'V.34 phase 2', () => pa.reverse());
  ta = S.seg('answerer', tL1a, ms(160), G.probeGen(A.tx, 6), 'Line probing L1: 21 tones 150–3750 Hz (no 900/1200/1800/2400), +6 dB, 160 ms', 'V.34 line probe');
  ta = S.seg('answerer', ta, ms(550), G.probeGen(A.tx), 'Line probing L2: same comb at nominal power, 550 ms', 'V.34 line probe');
  ta = S.seg('answerer', ta, ms(50), pa, 'Tone A', 'V.34 phase 2', () => { pa.mod.re.fill(0); pa.mod.im.fill(0); pa.tone(); });
  ta = S.seg('answerer', ta, ms(10), pa, 'Ā', 'V.34 phase 2', () => pa.reverse());
  tc = ta + ms(40);
  tc = S.seg('caller', tc, ms(50), pc, 'Tone B', 'V.34 phase 2', () => { pc.mod.re.fill(0); pc.mod.im.fill(0); pc.tone(); });
  tc = S.seg('caller', tc, ms(160), G.probeGen(C.tx, 6), 'Line probing L1 (calling modem), +6 dB', 'V.34 line probe');
  tc = S.seg('caller', tc, ms(550), G.probeGen(C.tx), 'Line probing L2 (calling modem)', 'V.34 line probe');
  tc = S.seg('caller', tc, sec(109 / 600), pc, 'INFO1c: probing results & symbol-rate choices (109 bits)', 'V.34 phase 2', () => { pc.mod.re.fill(0); pc.mod.im.fill(0); pc.info(G.infoBits(G.INFO_LEN.INFO1c, rng)); });
  ta = tc + ms(30);
  ta = S.seg('answerer', ta, sec(70 / 600), pa, 'INFO1a: final symbol rates, carrier, pre-emphasis (70 bits)', 'V.34 phase 2', () => { pa.mod.re.fill(0); pa.mod.im.fill(0); pa.info(G.infoBits(G.INFO_LEN.INFO1a, rng)); });
  // ---- phase 3 & 4
  const tP3 = ta + ms(40);
  const rate = pickRate(P, q, C, A);
  return pcm ? phase34pcm(H, P, rate, tP3, tc) : phase34(H, rate, tP3);
}

function phase34(H, rate, tP3) {
  const { S, C, A, q } = H; const { baud, fc } = v34Baud(rate, q);
  S.e(tP3, 'phase', { name: `V.34 phase 3: equalizer & echo canceller training (${baud} baud, ${fc} Hz)` });
  const qa = new G.QAMPump({ baud, fc, beta: 0.12, db: A.tx }), qc = new G.QAMPump({ baud, fc, beta: 0.12, db: C.tx });
  const sa = new Scrambler(5, 23), sc = new Scrambler(18, 23), st = G.SRC, sy = (n) => sec(n / baud);
  const P0 = [Math.SQRT1_2, Math.SQRT1_2], P1 = [-Math.SQRT1_2, Math.SQRT1_2], N0 = [-P0[0], -P0[1]], N1 = [-P1[0], -P1[1]];
  const trnA = A.ch.trn34 || 1024, trnC = C.ch.trn34 || 1024;
  // answering modem first
  let ta = tP3;
  ta = S.seg('answerer', ta, sy(128), qa, 'S: alternating points 90° apart (128 symbols)', 'V.34 phase 3', () => qa.use(st.alt(P0, P1)));
  ta = S.seg('answerer', ta, sy(16), qa, 'S̄ (16 symbols)', 'V.34 phase 3', () => qa.use(st.alt(N0, N1)));
  ta = S.seg('answerer', ta, sy(288), qa, 'PP: 6 × 48-symbol periodic CAZAC sequence (equalizer)', 'V.34 phase 3', () => qa.use(st.pp()));
  ta = S.seg('answerer', ta, sy(trnA), qa, `TRN: scrambled ones, 4-point (${trnA} symbols, 1+x^-5+x^-23)`, 'V.34 phase 3', () => qa.use(st.qpsk4(sa)));
  const tJa = ta;
  let tc = tJa + sy(16) + ms(20);
  tc = S.seg('caller', tc, sy(128), qc, 'S (calling modem)', 'V.34 phase 3', () => qc.use(st.alt(P0, P1)));
  tc = S.seg('caller', tc, sy(16), qc, 'S̄', 'V.34 phase 3', () => qc.use(st.alt(N0, N1)));
  tc = S.seg('caller', tc, sy(288), qc, 'PP (calling modem)', 'V.34 phase 3', () => qc.use(st.pp()));
  tc = S.seg('caller', tc, sy(trnC), qc, `TRN: scrambled ones (${trnC} symbols, 1+x^-18+x^-23)`, 'V.34 phase 3', () => qc.use(st.qpsk4(sc)));
  S.seg('answerer', tJa, (tJa + sy(16) + ms(20) + sy(64)) - tJa, qa, 'J: 16-bit pattern 0x8990 (4-point), repeated', 'V.34 phase 3', () => qa.use(st.word16(null, 0x8990)));
  const tJc = tc;
  // phase 4: answering modem goes when it has heard the caller's J
  ta = tJc + sy(16) + ms(20);
  S.e(ta, 'phase', { name: 'V.34 phase 4: final training, MP exchange, rate ' + rate });
  ta = S.seg('answerer', ta, sy(128), qa, 'S (phase 4)', 'V.34 phase 4', () => qa.use(st.alt(P0, P1)));
  ta = S.seg('answerer', ta, sy(16), qa, 'S̄', 'V.34 phase 4', () => qa.use(st.alt(N0, N1)));
  const tJcStop = ta + ms(20);
  S.seg('caller', tJc, tJcStop - tJc, qc, 'J: 0x8990 repeated (calling modem waits for S̄)', 'V.34 phase 3', () => qc.use(st.word16(null, 0x8990)));
  ta = S.seg('answerer', ta, sy(512), qa, 'TRN (512 symbols)', 'V.34 phase 4', () => qa.use(st.qpsk4(sa)));
  ta = S.seg('answerer', ta, sy(188), qa, 'MP: modulation parameters (2 × 188-bit frames, scrambled)', 'V.34 phase 4', () => qa.use(st.qpsk4(sa, () => 0)));
  ta = S.seg('answerer', ta, sy(94), qa, "MP' (acknowledge)", 'V.34 phase 4', () => qa.use(st.qpsk4(sa, () => 0)));
  ta = S.seg('answerer', ta, sy(10), qa, 'E: end of MP', 'V.34 phase 4', () => qa.use(st.qpsk4(sa)));
  tc = tJcStop;
  tc = S.seg('caller', tc, sy(8), qc, "J': 16-bit pattern (once)", 'V.34 phase 4', () => qc.use(st.word16(null, 0x899f, true)));
  tc = S.seg('caller', tc, sy(512), qc, 'TRN (512 symbols)', 'V.34 phase 4', () => qc.use(st.qpsk4(sc)));
  tc = S.seg('caller', tc, sy(188), qc, 'MP: modulation parameters', 'V.34 phase 4', () => qc.use(st.qpsk4(sc, () => 0)));
  tc = S.seg('caller', tc, sy(94), qc, "MP'", 'V.34 phase 4', () => qc.use(st.qpsk4(sc, () => 0)));
  tc = S.seg('caller', tc, sy(10), qc, 'E', 'V.34 phase 4', () => qc.use(st.qpsk4(sc)));
  const b = Math.max(4, Math.round(rate / baud)), nB1 = Math.round(0.035 * baud);
  ta = S.seg('answerer', ta, sy(nB1), qa, `B1: one data frame of scrambled ones (${rate} bps, shaped QAM)`, 'V.34 phase 4', () => qa.use(st.scrambled(sa, () => 1, GridQAM, b, true)));
  tc = S.seg('caller', tc, sy(nB1), qc, `B1 (${rate} bps)`, 'V.34 phase 4', () => qc.use(st.scrambled(sc, () => 1, GridQAM, b, true)));
  dataMode(H, 'answerer', ta, qa, 'V34', rate); S.e(ta, 'src', { fn: () => qa.use(st.scrambled(sa, dataPumpBits(H, 'answerer'), GridQAM, b, true)) });
  dataMode(H, 'caller', tc, qc, 'V34', rate); S.e(tc, 'src', { fn: () => qc.use(st.scrambled(sc, dataPumpBits(H, 'caller'), GridQAM, b, true)) });
  return finish(H, 'V34', rate, tc, ta, { baud, fc });
}

function phase34pcm(H, P, rate, tP3) {
  const { S, C, A, q, rng } = H;
  const up = q > 0.75 ? 31200 : q > 0.55 ? 28800 : 26400, { baud, fc } = v34Baud(up, q);
  const name = PROTO_NAME[P];
  S.e(tP3, 'phase', { name: `${name} phase 3: digital modem PCM training; analogue upstream V.34 ${baud} baud` });
  const sa = new Scrambler(5, 23), sc = new Scrambler(18, 23), st = G.SRC, sy = (n) => sec(n / baud), u = (n) => n; // PCM: 8000 symbols/s = samples
  const qc = new G.QAMPump({ baud, fc, beta: 0.12, db: C.tx });
  const P0 = [Math.SQRT1_2, Math.SQRT1_2], P1 = [-Math.SQRT1_2, Math.SQRT1_2], N0 = [-P0[0], -P0[1]], N1 = [-P1[0], -P1[1]];
  const U = A.tx < -11 ? 72 : 76;
  let ta = tP3;
  ta = S.seg('answerer', ta, u(384), G.pcmSdGen(U, false), `Sd: 6-symbol PCM sign pattern at Ucode ${U} (μ-law codes, 8000/s)`, name + ' phase 3');
  ta = S.seg('answerer', ta, u(48), G.pcmSdGen(U, true), 'S̄d', name + ' phase 3');
  ta = S.seg('answerer', ta, u(4096), G.pcmTrnGen(sa, U), 'TRN1d: scrambled ones as PCM signs — the hiss of PCM training', name + ' phase 3');
  const jd = cycleBits([1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1]);
  const tJd = ta;
  let tc = tJd + ms(30);
  tc = S.seg('caller', tc, sy(128), qc, 'S (analogue modem, upstream V.34)', name + ' phase 3', () => qc.use(st.alt(P0, P1)));
  tc = S.seg('caller', tc, sy(16), qc, 'S̄', name + ' phase 3', () => qc.use(st.alt(N0, N1)));
  tc = S.seg('caller', tc, sy(288), qc, 'PP', name + ' phase 3', () => qc.use(st.pp()));
  tc = S.seg('caller', tc, sy(C.ch.trn34 || 1024), qc, 'TRN (upstream, 1+x^-18+x^-23)', name + ' phase 3', () => qc.use(st.qpsk4(sc)));
  S.seg('answerer', tJd, tc + ms(20) - tJd, G.pcmTrnGen({ bit: () => jd() }, U - 8), 'Jd: digital modem\'s capabilities, repeated (PCM signs)', name + ' phase 3');
  const tJa = tc;
  const nSeg = P === 'V90' ? 64 : 48, segSyms = P === 'P56F' ? 240 : 192;
  const tDIL = tJa + sy(64) + ms(20);
  tc = S.seg('caller', tJa, tDIL - tJa, qc, 'Ja: DIL descriptor (which levels to test), repeated', name + ' phase 3', () => qc.use(st.word16(null, 0x8990)));
  S.e(tDIL, 'phase', { name: P === 'V90' ? 'V.90 DIL: digital impairment learning' : `${name}: proprietary digital level training` });
  ta = S.seg('answerer', tDIL, nSeg * segSyms, G.dilGen(P, nSeg, segSyms, rng), P === 'V90' ? `DIL: ${nSeg} segments of sign/training patterns stepping through μ-law Ucodes (robbed-bit & pad detection)` : `${name} level training (${nSeg} segments)`, name + ' DIL');
  // phase 4
  S.e(ta, 'phase', { name: `${name} phase 4: Ri, TRN2d, CP exchange — downstream ${rate}` });
  const tc4 = ta + ms(25);
  ta = S.seg('answerer', ta, u(800), G.pcmSdGen(U - 4, false), 'Ri / Sd: phase 4 start', name + ' phase 4');
  ta = S.seg('answerer', ta, u(2400), G.pcmDataGen(() => 1, sa, U + 20), 'TRN2d: scrambled multi-level PCM', name + ' phase 4');
  ta = S.seg('answerer', ta, u(900), G.pcmDataGen(() => 0, sa, U + 20), 'CPd: data-mode constellation parameters', name + ' phase 4');
  ta = S.seg('answerer', ta, u(280), G.pcmDataGen(() => 1, sa, U + 26), 'Ed / B1d', name + ' phase 4');
  tc = S.seg('caller', tc4, sy(512), qc, 'TRN (analogue modem, phase 4)', name + ' phase 4', () => qc.use(st.qpsk4(sc)));
  tc = S.seg('caller', tc, sy(188), qc, 'CPu / MP: upstream parameters', name + ' phase 4', () => qc.use(st.qpsk4(sc, () => 0)));
  tc = Math.max(tc, ta - sy(40));
  tc = S.seg('caller', tc, sy(40), qc, 'E / B1u', name + ' phase 4', () => qc.use(st.qpsk4(sc)));
  const b = Math.max(4, Math.round(up / baud));
  const pcmData = G.pcmDataGen(dataPumpBits(H, 'answerer'), sa, U + 30);
  dataMode(H, 'answerer', ta, pcmData, P, rate);
  dataMode(H, 'caller', tc, qc, P, rate); S.e(tc, 'src', { fn: () => qc.use(st.scrambled(sc, dataPumpBits(H, 'caller'), GridQAM, b, true)) });
  return finish(H, P, rate, tc, ta, { baud, fc, up });
}

// ------------------------------------------------------------------ fax answering (T.30): CED then V.21 HDLC DIS, repeated
function faxAnswer(H, tOff, local = false) {
  const { S, A } = H; const t = tOff + sec(2.0);
  S.seg('answerer', tOff, t - tOff, G.SILENCE, 'Fax machine picked up', 'Fax');
  let ta = S.seg('answerer', t, sec(3.0), G.ansGen(-11), 'CED: 2100 Hz called-terminal identification (T.30)', 'Fax');
  const dis = [0xff, 0x13, 0x80, 0x00, 0xce, 0xf4, 0x80, 0x80, 0x81, 0x80, 0x80, 0x80, 0x18];
  for (let k = 0; k < 3; k++) {
    ta += ms(75);
    const bits = []; for (let i = 0; i < 38; i++) bits.push(...[0, 1, 1, 1, 1, 1, 1, 0]);
    const fr = hdlcFrame(dis); bits.push(...fr, 0, 1, 1, 1, 1, 1, 1, 0);
    ta = S.seg('answerer', ta, sec(bits.length / 300), G.fskGen('v21H', -11, listThen(bits, () => 1)), 'V.21 ch2 300 bps HDLC: 1 s of flags, then DIS (fax capabilities)', 'Fax');
    ta += sec(2.4);
  }
  return ta;
}
const hdlcFrame = (bytes) => hdlcBits(bytes);

// ------------------------------------------------------------------ the engine
/** speaker mode gate: M0 never, M1 until carrier, M2 always, M3 after dialing until carrier */
const SPK_LEVEL = [0.18, 0.18, 0.42, 1.0];

export class ModemEngine {
  constructor({ outRate = FS, mech8k = false } = {}) {
    this.n = 0; this.out = []; this.evq = []; this.S = null;
    this.cfg = { M: 1, L: 2, vol: 1, q: 0.8, region: 'na', dead: false, model: 'r336' };
    this.state = { offhook: false, carrier: false, dialing: false, loop: 1, ringing: false, remoteOff: false };
    this.trk = { caller: new TrackRun(), answerer: new TrackRun(), net: new TrackRun() };
    this.localRole = 'caller'; this.pumps = { caller: new G.DataPump(), answerer: new G.DataPump() };
    this.rng = new Rng(77); this.mech8k = mech8k; this.mech = []; this.ringer = null; this.tapOn = false;
    this.lineLp = new Chain([new Biquad().hp(300, 0.7), new Biquad().hp(260, 0.6), new Biquad().lp(3400, 0.9), new Biquad().lp(3300, 0.6)]);
    this.daa = new Biquad().hp(150, 0.7);
    this.hissF = new Chain([new Biquad().hp(200), new Biquad().lp(3500)]);
    this.echo = new Float32Array(1024); this.ei = 0;
    this.trans = 0; this.transF = new Biquad().bp(500, 0.8); this.crk = 0; this.crkF = new Biquad().bp(1800, 1.2);
    this.drop = 1; this.dropT = 0; this.loopEnv = 1; this.gate = 0; this.remoteEnv = 0;
    this.hum = [new Osc(60, 1), new Osc(180, 0.35), new Osc(300, 0.18)];
    this.setModel('r336'); this.setRegion('na');
    this.spkOut = 0; this.lineOut = 0;
  }
  setModel(id) {
    const m = modelById(id); this.cfg.model = id; this.model = m; const s = m.ch.spk || {};
    this.spk = new Chain([new Biquad().hp(s.hp || 450, 0.8), new Biquad().peak(s.res || 2800, s.resQ || 1.8, s.resGain || 7), new Biquad().lp(s.lp || 3600, 0.8)]);
    this.drive = s.drive || 1.6; this.acoustic = !!s.acoustic; this.comb = new Float32Array(64); this.ci = 0;
  }
  setRegion(r) { this.cfg.region = REGIONS[r] ? r : 'na'; this.R = REGIONS[this.cfg.region]; this.hum[0].setF(this.R.hum); this.hum[1].setF(this.R.hum * 3); this.hum[2].setF(this.R.hum * 5); }
  emit(kind, data = {}) { this.out.push({ t: this.n / FS, kind, ...data }); }
  // ---------------------------------------------------------------- messages
  msg(m) {
    switch (m.type) {
      case 'config':
        if (m.model && m.model !== this.cfg.model) this.setModel(m.model);
        if (m.region) this.setRegion(m.region);
        for (const k of ['M', 'L', 'vol', 'q', 'dead']) if (m[k] !== undefined) this.cfg[k] = m[k];
        break;
      case 'dial': this.dial(m.plan); break;
      case 'answer': this.answer(m.plan); break;
      case 'incoming': this.incoming(m.plan); break;
      case 'hangup': this.hangup(m.quiet); break;
      case 'offhook': this.offhookIdle(); break;
      case 'originate': this.originateNow(); break;
      case 'send': this.pumps[this.localRole].push(enc(m.text)); break;
      case 'remoteSend': this.pumps[this.remoteRole].push(enc(m.text)); break;
      case 'remoteHangup': this.remoteHangupWhenIdle = true; break;
      case 'tap': this.tapOn = !!m.on; break;
    }
  }
  get remoteRole() { return this.localRole === 'caller' ? 'answerer' : 'caller'; }
  _reset() {
    this.S = new Script(); this.evq = []; for (const k in this.trk) this.trk[k] = new TrackRun();
    this.state.carrier = false; this.state.dialing = false; this.state.remoteOff = false; this.state.loop = 1;
    this.remoteHangupWhenIdle = false; this.call = null;
  }
  _install() {
    const S = this.S; for (const k of ['caller', 'answerer', 'net']) { S.tr[k].sort((a, b) => a.start - b.start); this.trk[k].set(S.tr[k]); }
    this.evq = S.ev.sort((a, b) => a.t - b.t);
  }
  _H(plan) {
    const mk = (p) => ({ ...p, caps: new Set(p.caps), ch: p.ch || {}, tx: p.tx ?? (p.ch && p.ch.tx) ?? -10 });
    const C = mk(plan.caller), A = mk(plan.answerer);
    if (this.cfg.region !== 'na') { if (this.localRole === 'caller') A.bell = false; else C.bell = false; } // Bell tones are a North American thing
    const ecBoth = (x) => (C.ec || []).includes(x) && (A.ec || []).includes(x);
    let ec = 'none';
    if (C.ecPref !== 'none' && A.ecPref !== 'none') { if (ecBoth('LAPM') && C.ecPref !== 'mnp') ec = 'LAPM'; else if (ecBoth('MNP')) ec = 'MNP'; }
    let comp = 'none';
    if (C.compOn !== false && A.compOn !== false) { if (ec === 'LAPM' && (C.comp || []).includes('V42BIS') && (A.comp || []).includes('V42BIS')) comp = 'V.42bis'; else if (ec === 'MNP' && (C.comp || []).includes('MNP5') && (A.comp || []).includes('MNP5')) comp = 'MNP 5'; }
    this.pumps = { caller: new G.DataPump(ec === 'none' ? 'async' : 'hdlc', null), answerer: new G.DataPump(ec === 'none' ? 'async' : 'hdlc', null) };
    const remote = this.remoteRole; this.pumps[remote].onByte = (b) => this.rxByte(b); this.pumps[this.localRole].onByte = () => this.txByte();
    return { S: this.S, C, A, q: this.cfg.q, rng: new Rng(plan.seed || 1), ec, comp, guard: plan.guard || 0, pumps: this.pumps, needEc: C.ecPref === 'required' };
  }
  rxByte(b) { this._rx = (this._rx || '') + String.fromCharCode(b); }
  txByte() { this._tx = (this._tx || 0) + 1; }
  // ---------------------------------------------------------------- originate
  dial(plan) {
    this._reset(); const S = this.S, R = this.R, t0 = this.n + 1; this.plan = plan; this.localRole = 'caller';
    const rng = new Rng(plan.seed || 1); const ch = plan.caller.ch || {};
    S.e(t0, 'hook', { off: true }); S.e(t0, 'mech', { what: 'relay-on' }); S.e(t0, 'trans', { amp: 0.5 });
    S.e(t0, 'phase', { name: 'Off hook: waiting for dial tone' });
    const dead = this.cfg.dead;
    let t = t0 + ms(rng.range(120, 260));
    if (!dead) S.seg('net', t, Infinity, G.cadenceGen({ f: R.dial.f, db: R.dial.db, pat: [3600, 0] }), `Dial tone ${R.dial.f.join(' + ')} Hz`, 'Dialing');
    const X = plan.x ?? 4, detect = X === 2 || X === 4;
    if (detect && dead) { S.e(t0 + sec(5), 'result', { code: 'NO DIALTONE' }); S.e(t0 + sec(5), 'hangup'); this._install(); return; }
    t = detect ? t + sec(ch.dtDetect || 1.0) : t0 + sec(plan.s6 ?? 2);
    // -------- dial string
    let mode = plan.pulse ? 'P' : 'T', first = true, quiet = false;
    const S11 = Math.max(50, Math.min(255, plan.s11 ?? 95)), brk = R.pulse.brk, mk = R.pulse.mk;
    S.e(t, 'dialing', { on: true });
    for (const it of plan.dial) {
      if (it.k === 'T' || it.k === 'P') { mode = it.k; continue; }
      if (it.k === 'digit') {
        if (mode === 'T') {
          if (first) S.cut('net', t + ms(40));
          t = S.seg('caller', t, ms(S11), G.dtmfGen(it.d, ms(S11)), `DTMF "${it.d}" ${(DTMFP[it.d] || []).join(' + ')} Hz`, 'Dialing');
          t += ms(S11);
        } else {
          const np = it.d === '0' ? 10 : +it.d || 10;
          if (first) S.cut('net', t + ms(5));
          S.e(t, 'phase', { name: `Pulse dialing "${it.d}" (${np} pulses, 10 pps, ${brk}/${mk} break/make)` });
          if (plan.rotary) S.e(t - ms(380), 'mech', { what: 'rotary' });
          for (let p = 0; p < np; p++) { S.e(t, 'loop', { v: 0 }); t += ms(brk); S.e(t, 'loop', { v: 1 }); t += ms(mk); }
          t += ms(700);
        }
        first = false;
      } else if (it.k === ',') { t += sec(plan.s8 ?? 2); }
      else if (it.k === 'W') {
        const td = t + ms(rng.range(400, 900));
        if (!dead) S.seg('net', td, Infinity, G.cadenceGen({ f: R.dial.f, db: R.dial.db - 2, pat: [3600, 0] }), 'Second dial tone (W: wait for dial tone)', 'Dialing');
        t = td + sec(0.8); first = true;
      } else if (it.k === '!') {
        S.e(t, 'loop', { v: 0 }); S.e(t, 'mech', { what: 'relay-off' }); t += ms(500); S.e(t, 'loop', { v: 1 }); S.e(t, 'mech', { what: 'relay-on' });
        if (!dead) S.seg('net', t + ms(150), Infinity, G.cadenceGen({ f: R.dial.f, db: R.dial.db, pat: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 3600, 0] }), 'Hook flash: recall (stutter) dial tone', 'Dialing');
        t += ms(1100); first = true;
      } else if (it.k === '@') { quiet = true; }
    }
    S.e(t, 'dialing', { on: false });
    const tDial = t; this.call = { tDial, plan };
    const s7 = sec(plan.s7 ?? 50), limit = tDial + s7;
    // -------- the network and the far end
    const far = plan.answerer; // { kind, ...model }
    if (dead) { this._failAt(limit, 'NO CARRIER'); this._install(); return; }
    let tp = tDial + sec(ch.pdd || rng.range(1.6, 3.0));
    S.seg('net', tDial, tp - tDial, G.SILENCE, 'Post-dial delay (the exchange is switching)', 'Call progress');
    if (plan.ret) S.e(tDial + ms(30), 'result', { code: 'OK' });
    const busyDetect = X >= 3;
    if (far.kind === 'busy') {
      S.seg('net', tp, Infinity, G.cadenceGen(R.busy), `Busy ${R.busy.f.join(' + ')} Hz, ${R.busy.pat[0]} s on / ${R.busy.pat[1]} s off`, 'Call progress');
      if (!plan.ret) { if (busyDetect) { S.e(tp + sec(2.3), 'result', { code: 'BUSY' }); S.e(tp + sec(2.3), 'hangup'); } else this._failAt(limit, 'NO CARRIER'); }
      this._install(); return;
    }
    if (far.kind === 'intercept') {
      let ti = tp; for (let k = 0; k < 2; k++) { ti = S.seg('net', ti, ms(928), G.sitGen(), 'Special Information Tones 913.8 / 1370.6 / 1776.7 Hz', 'Intercept'); ti = S.seg('net', ti, sec(3.4), G.babbleGen(3.3, 5 + k), 'Recorded announcement ("the number you have reached…")', 'Intercept'); ti += ms(300); }
      S.seg('net', ti, Infinity, G.cadenceGen(R.reorder), 'Reorder (fast busy)', 'Intercept');
      if (!plan.ret) { if (busyDetect) { S.e(ti + sec(1.5), 'result', { code: 'BUSY' }); S.e(ti + sec(1.5), 'hangup'); } else this._failAt(limit, 'NO CARRIER'); }
      this._install(); return;
    }
    const ringOff = rng.range(0, 1.6);
    const rings = far.kind === 'noanswer' ? 1e9 : Math.max(1, far.rings || 1);
    const per = R.ring.pat.reduce((a, b) => a + b, 0);
    const k0 = ringOff < R.ring.pat[0] ? 0 : 1;                       // a partly-heard first burst still counts
    const ringEnd = (k0 + rings - 1) * per - ringOff + R.ring.pat.slice(0, R.ring.pat.length > 2 ? 3 : 1).reduce((x, y) => x + y, 0);
    const tAns = far.kind === 'noanswer' ? Infinity : tp + sec(Math.max(0.5, ringEnd + rng.range(0.25, 0.9)));
    S.seg('net', tp, tAns === Infinity ? Infinity : tAns - tp, G.cadenceGen(R.ring, ringOff), `Ringback ${R.ring.f.join(' + ')} Hz (${R.ring.pat.join('/')} s)`, 'Ringing');
    S.e(tp, 'phase', { name: 'Ringing' });
    if (tAns === Infinity) { if (!plan.ret) this._failAt(limit, quiet && X >= 3 ? 'NO ANSWER' : 'NO CARRIER'); this._install(); return; }
    S.e(tAns, 'remote', { off: true }); S.e(tAns, 'trans', { amp: 0.12 }); S.e(tAns, 'phase', { name: 'Answered' });
    this.call.tAns = tAns;
    if (plan.ret) { this._farAnswerOnly(tAns, far); this._install(); return; }
    this._farConnect(tAns, far, plan, limit);
    this._install();
  }
  _failAt(t, code) { this.S.e(t, 'result', { code }); this.S.e(t, 'hangup'); }
  /** the far end answers while our modem is silent (after ATD...;) */
  _farAnswerOnly(tAns, far) {
    const S = this.S;
    if (far.kind === 'person') return this._person(tAns, 'answerer');
    if (far.kind === 'fax') return faxAnswer({ S, A: far }, tAns);
    S.seg('answerer', tAns + sec(1.9), sec(3.3), G.ansGen(far.ch?.tx ?? -10, { rev: far.caps.includes('V32') || far.caps.includes('V32bis') || far.caps.includes('V34'), am: far.caps.includes('V34') }), 'Answer tone (your modem is in command mode, staying quiet)', 'Answer tone');
  }
  _person(t, side) {
    const S = this.S;
    S.seg(side, t + ms(600), ms(620), G.helloGen({ seed: 4 }), 'A person: "hello?"', 'Voice');
    S.seg(side, t + ms(2700), ms(700), G.helloGen({ seed: 8, f0: 210, rise: 1.45, dur: 0.7, amp: dBm0(-11) }), 'A person, louder: "HELLO?"', 'Voice');
    S.e(t + ms(5200), 'remote', { off: false }); S.e(t + ms(5200), 'trans', { amp: 0.1 });
    S.e(t + ms(5200), 'phase', { name: 'They hung up' });
  }
  _farConnect(tAns, far, plan, limit) {
    const S = this.S;
    if (far.kind === 'person') { this._person(tAns, 'answerer'); this._callerWaits(tAns, plan); this._failAt(limit, 'NO CARRIER'); return; }
    const H = this._H(plan);
    if (far.kind === 'fax') {
      if (plan.caller.fclass === 1) return this._faxCall(H, tAns, limit);
      const tEnd = faxAnswer(H, tAns);
      // a data modem hears CED as an answer tone: a V.32 caller offers AA
      const c = capsOf(H.C); if (c.v32) { const p = pumpV32(H, 'caller'); S.seg('caller', tAns + sec(3.0), Infinity, p, 'V.32 AA (1800 Hz) — mistaking CED for a modem', 'V.32 automode', () => p.use(G.SRC.constPt(G.SRC.v32('A')))); }
      S.e(tEnd, 'remote', { off: false }); this._failAt(limit, 'NO CARRIER'); return;
    }
    if (plan.reverse) { // both ends behave as answering modems: nobody originates
      const tb = tAns + sec(2);
      S.seg('caller', tAns, Infinity, G.ansGen(H.C.tx, { rev: true }), 'Your modem (R: answer mode) sends its answer tone too', 'Answer tone');
      S.seg('answerer', tb, sec(4), G.ansGen(H.A.tx, { rev: true }), 'Far end answer tone', 'Answer tone');
      this._failAt(limit, 'NO CARRIER'); return;
    }
    if (plan.caller.fclass === 1) { this._cng(this.call.tDial + ms(200)); H.C.caps = new Set(); }
    const r = handshake(H, tAns);
    this._result(H, r, limit);
  }
  _cng(t) { this.S.seg('caller', Math.max(t, 0), Infinity, G.cngGen(), 'CNG: 1100 Hz calling tone (fax)', 'Fax'); }
  _callerWaits() {}
  _result(H, r, limit) {
    const S = this.S;
    if (r.fail || r.tConnect > limit || (H.needEc && H.ec === 'none')) {
      const t = r.fail ? limit : Math.min(limit, r.tConnect);
      for (const k of ['caller', 'answerer']) S.cut(k, t);
      S.ev = S.ev.filter(e => e.t <= t);
      this._failAt(t, 'NO CARRIER'); return;
    }
    S.e(r.tCarrier, 'carrier', { on: true });
    S.e(r.tConnect, 'result', { code: 'CONNECT', proto: r.proto, rate: r.rate, ec: H.ec, comp: H.comp, baud: r.baud, up: r.up });
    S.e(r.tConnect, 'phase', { name: `Connected: ${PROTO_NAME[r.proto]} ${r.rate} bps` });
  }
  // ---------------------------------------------------------------- fax to fax (T.30 Phase B/C/D, abbreviated)
  _faxCall(H, tAns, limit) {
    const S = this.S; this._cng(this.call.tDial + ms(200));
    let ta = tAns + sec(2.0);
    ta = S.seg('answerer', ta, sec(3.0), G.ansGen(-11), 'CED 2100 Hz', 'Fax');
    S.cut('caller', ta);
    ta += ms(75);
    const flags = (n) => { const b = []; for (let i = 0; i < n; i++) b.push(0, 1, 1, 1, 1, 1, 1, 0); return b; };
    const v21 = (side, t, bytes, label) => { const bits = [...flags(38), ...hdlcFrame(bytes), ...flags(1)]; return S.seg(side, t, sec(bits.length / 300), G.fskGen(side === 'caller' ? 'v21H' : 'v21H', -11, listThen(bits, () => 1)), label, 'Fax T.30'); };
    ta = v21('answerer', ta, [0xff, 0x13, 0x80, 0x00, 0xce, 0xf4, 0x80], 'DIS: digital identification signal (V.21 HDLC)');
    let tc = v21('caller', ta + ms(75), [0xff, 0x13, 0x83, 0x00, 0xc6, 0x74], 'DCS: digital command signal — 9600 bps V.29');
    tc += ms(75);
    const v29 = new G.QAMPump({ baud: 2400, fc: 1700, beta: 0.5, db: -11 }), s29 = new Scrambler(18, 23);
    tc = S.seg('caller', tc, sec(0.2), v29, 'V.29 training: alternations, equalizer conditioning, scrambled ones', 'Fax V.29', () => v29.use(G.SRC.alt([1, 0], [-0.6, 0.6])));
    tc = S.seg('caller', tc, sec(1.5), v29, 'TCF: 1.5 s of zeros at 9600 bps (training check)', 'Fax V.29', () => v29.use(G.SRC.scrambled(s29, () => 0, G.V29Mapper)));
    ta = v21('answerer', tc + ms(75), [0xff, 0x13, 0x84], 'CFR: confirmation to receive');
    tc = ta + ms(75);
    tc = S.seg('caller', tc, sec(0.25), v29, 'V.29 training', 'Fax V.29', () => v29.use(G.SRC.alt([1, 0], [-0.6, 0.6])));
    tc = S.seg('caller', tc, sec(6.0), v29, 'Page data: T.4 MH-coded scan lines at 9600 bps (V.29)', 'Fax V.29', () => v29.use(G.SRC.scrambled(s29, () => (this.rng.next() < 0.8 ? 0 : 1), G.V29Mapper)));
    tc = v21('caller', tc + ms(75), [0xff, 0x13, 0x2e], 'EOP: end of procedure');
    ta = v21('answerer', tc + ms(75), [0xff, 0x13, 0x8c], 'MCF: message confirmation');
    tc = v21('caller', ta + ms(75), [0xff, 0x13, 0xfa], 'DCN: disconnect');
    S.e(tAns + sec(5.4), 'result', { code: 'CONNECT', proto: 'FAX', rate: 9600, ec: 'none', comp: 'none', fax: true });
    S.e(tc + ms(200), 'result', { code: 'FAXDONE' }); S.e(tc + ms(300), 'remote', { off: false }); S.e(tc + ms(400), 'hangup');
  }
  // ---------------------------------------------------------------- answer mode
  incoming(plan) {
    this._reset(); this.localRole = 'answerer'; this.plan = plan; const S = this.S, R = this.R;
    const t0 = this.n + sec(0.5); const per = R.ringIn.reduce((a, b) => a + b, 0);
    for (let k = 0; k < 8; k++) S.e(t0 + sec(k * per), 'ring', { k: k + 1 });
    S.e(t0 + sec(8 * per), 'ringstop');
    this.state.ringing = true; this.ringer = G.ringerGen(R.ringIn); this.ringStart = t0; this.ringStop = t0 + sec(8 * per - per + R.ringIn[0]);
    this._install();
  }
  answer(plan) {
    const ringing = this.state.ringing && this.plan && this.plan.incoming; const inc = ringing ? this.plan : null;
    this._reset(); this.localRole = 'answerer'; this.state.ringing = false; this.ringer = null;
    const S = this.S, t0 = this.n + 1;
    S.e(t0, 'hook', { off: true }); S.e(t0, 'mech', { what: 'relay-on' }); S.e(t0, 'trans', { amp: 0.5 });
    const p = { ...plan, caller: inc ? inc.caller : { kind: 'nobody', caps: [], ch: {} } };
    this.plan = p; const limit = t0 + sec(plan.s7 ?? 50);
    const ansCfg = { ...p.answerer, ch: { ...(p.answerer.ch || {}), billing: 2.0 } };
    if (!inc || inc.caller.kind === 'nobody') { // ATA with nobody there: dial tone and our answer tone
      S.seg('net', t0 + ms(150), Infinity, G.cadenceGen({ f: this.R.dial.f, db: this.R.dial.db, pat: [3600, 0] }), 'Dial tone (nobody is calling)', 'Answer');
      S.seg('answerer', t0 + sec(2), sec(3.3), G.ansGen(ansCfg.tx ?? -10, { rev: true }), 'ANS 2100 Hz into an empty line', 'Answer tone');
      this._failAt(limit, 'NO CARRIER'); this._install(); return;
    }
    const caller = inc.caller;
    S.e(t0, 'remote', { off: true });
    if (caller.kind === 'person') {
      S.seg('answerer', t0 + sec(2), sec(5), G.ansGen(ansCfg.tx ?? -10, { rev: true, am: true }), 'Answer tone into a voice call', 'Answer tone');
      this._person(t0, 'caller'); this._failAt(limit, 'NO CARRIER'); this._install(); return;
    }
    if (caller.kind === 'fax') {
      S.seg('caller', t0, Infinity, G.cngGen(), 'CNG 1100 Hz (a fax machine is calling)', 'Fax');
      const H = this._H({ ...p, caller: { ...caller, caps: [] }, answerer: ansCfg }); const r = handshake(H, t0); this._result(H, r, limit); this._install(); return;
    }
    const H = this._H({ ...p, caller, answerer: ansCfg });
    const r = handshake(H, t0); this._result(H, r, limit); this._install();
  }
  /** ATH1: off hook, nobody dialing: dial tone, then the receiver-off-hook howler */
  offhookIdle() {
    this._reset(); this.localRole = 'caller'; const S = this.S, t0 = this.n + 1;
    S.e(t0, 'hook', { off: true }); S.e(t0, 'mech', { what: 'relay-on' }); S.e(t0, 'trans', { amp: 0.5 });
    if (!this.cfg.dead) {
      const t1 = S.seg('net', t0 + ms(200), sec(20), G.cadenceGen({ f: this.R.dial.f, db: this.R.dial.db, pat: [3600, 0] }), 'Dial tone', 'Off hook');
      S.seg('net', t1 + sec(1), Infinity, G.howlerGen(), 'Receiver-off-hook howler 1400+2060+2450+2600 Hz', 'Off hook');
    }
    this._install();
  }
  /** ATD with no number after ATD...; — start the originate handshake now */
  originateNow() {
    if (!this.call || !this.plan) return;
    const plan = this.plan, far = plan.answerer, t = this.n + 1;
    for (const k of ['caller', 'answerer']) this.S.cut(k, t);
    this.evq = this.evq.filter(e => e.t < t || e.kind === 'ring');
    const S = this.S; const limit = t + sec(plan.s7 ?? 50);
    if (far.kind !== 'modem' || !this.call.tAns || this.call.tAns > t) { this.S.ev = []; this._failAt(limit, 'NO CARRIER'); this._reinstallFrom(t); return; }
    const H = this._H(plan); const r = handshake({ ...H, C: H.C, A: { ...H.A, ch: { ...H.A.ch, billing: 0.2 } } }, t);
    this.S.ev = this.S.ev.filter(e => e.t >= t); this._result(H, r, limit); this._reinstallFrom(t);
  }
  _reinstallFrom(t) { const S = this.S; for (const k of ['caller', 'answerer', 'net']) { S.tr[k] = S.tr[k].filter(s => s.start + s.n > t || s.n === Infinity); } this._install(); }
  hangup(quiet) {
    const was = this.state.offhook;
    for (const k in this.trk) this.trk[k].clear();
    this.evq = []; this.S = null; this.state.carrier = false; this.state.dialing = false; this.state.ringing = false; this.ringer = null; this.state.remoteOff = false;
    if (was) { this.state.offhook = false; if (!quiet) { this.mechAdd('relay-off'); this.trans += 0.35; } this.emit('hook', { off: false }); }
    this.call = null;
  }
  mechAdd(what) { this.mech.push(what); this.emit('mech', { what }); }
  _fire(e) {
    switch (e.kind) {
      case 'hook': this.state.offhook = e.off; this.emit('hook', { off: e.off }); return;
      case 'mech': this.mechAdd(e.what); return;
      case 'trans': this.trans += e.amp; return;
      case 'loop': this.state.loop = e.v; this.trans += e.v ? 0.55 : -0.55; this.mechAdd(e.v ? 'pulse-make' : 'pulse-break'); return;
      case 'dialing': this.state.dialing = e.on; this.emit('dialing', { on: e.on }); return;
      case 'carrier': this.state.carrier = e.on; this.emit('carrier', { on: e.on }); return;
      case 'remote': this.state.remoteOff = e.off; return;
      case 'src': e.fn(); return;
      case 'hangup': this.hangup(); return;
      case 'ring': if (this.state.offhook) return; this.emit('ring', { k: e.k }); return;
      case 'ringstop': this.state.ringing = false; this.ringer = null; this.emit('ringstop'); return;
      default: { const { t, ...rest } = e; this.emit(e.kind, rest); }
    }
  }
  // ---------------------------------------------------------------- one 8 kHz sample
  tick() {
    const n = this.n, st = this.state, cfg = this.cfg;
    while (this.evq.length && this.evq[0].t <= n) this._fire(this.evq.shift());
    const c = this.trk.caller.step(n, this, 'caller'), a = this.trk.answerer.step(n, this, 'answerer'), net = this.trk.net.step(n, this, 'net');
    const local = this.localRole === 'caller' ? c : a, remote = this.localRole === 'caller' ? a : c;
    const q = cfg.q, nq = 1 - q;
    let line = 0;
    if (st.offhook) {
      // far modem + exchange tones: one codec stage, line band, loss, drop-outs
      this.loopEnv += (st.loop - this.loopEnv) * 0.25;
      let r = remote * dB(-4 - 6 * nq) + net;
      r = this.R.codec === 'mu' ? muQuant(r) : aQuant(r);
      r = this.lineLp.run(r) * dB(-3 - 10 * nq);
      if (this.dropT > 0) { this.dropT--; this.drop += (0.03 - this.drop) * 0.05; } else { this.drop += (1 - this.drop) * 0.05; if (nq > 0.35 && this.rng.next() < Math.pow(nq, 3) * 0.6 / FS) this.dropT = this.rng.int(ms(20), ms(160)); }
      r *= this.drop;
      // noise: hiss, hum, crackle
      const hiss = this.hissF.run(this.rng.gauss()) * dB(-66 + 34 * nq);
      const hum = (this.hum[0].next() + this.hum[1].next() + this.hum[2].next()) * dB(-58 + 18 * nq);
      if (nq > 0.2 && this.rng.next() < nq * nq * 4 / FS) this.crk += (this.rng.next() - 0.5) * nq * 0.6;
      const crk = this.crkF.run(this.crk); this.crk *= 0.6;
      r = (r + hiss + hum + crk) * this.loopEnv;
      // our own transmitter (through the DAA) and the far-end hybrid's echo of it
      const lt = this.daa.run(local);
      const eo = this.echo[(this.ei + 1024 - 240) & 1023]; this.echo[this.ei] = lt; this.ei = (this.ei + 1) & 1023;
      line = lt * 0.85 + r + eo * dB(-30 + 8 * nq) * (st.remoteOff ? 1 : 0.3);
    }
    // line transients (hook switch, dial pulses)
    if (this.trans !== 0) { line += this.transF.run(this.trans); this.trans *= 0.82; if (Math.abs(this.trans) < 1e-4) this.trans = 0; } else this.transF.run(0);
    // speaker: mode gate, ATL volume, small-speaker colour and overdrive
    const M = cfg.M, gOn = st.offhook && (M === 2 || (M === 1 && !st.carrier) || (M === 3 && !st.dialing && !st.carrier));
    this.gate += ((gOn ? 1 : 0) - this.gate) * 0.02;
    let s = this.spk.run(line) * SPK_LEVEL[cfg.L & 3] * cfg.vol * this.gate * 2.2;
    s = Math.tanh(s * this.drive) / this.drive;
    if (this.acoustic) { const d = this.comb[(this.ci + 64 - 37) & 63]; s = s + d * 0.35; this.comb[this.ci] = s; this.ci = (this.ci + 1) & 63; }
    let room = 0;
    if (this.ringer && st.ringing && !st.offhook && n >= this.ringStart && n < this.ringStop) room = this.ringer.next() * 0.25 * cfg.vol;
    this.lineOut = line; this.spkOut = s + room;
    this.n++;
    // data-mode bookkeeping
    if (this._rx && (n & 127) === 0) { this.emit('rx', { text: this._rx }); this._rx = ''; }
    if (this._tx && (n & 255) === 0) { this.emit('tx', { n: this._tx }); this._tx = 0; }
    if (this.remoteHangupWhenIdle && st.carrier && this.pumps[this.remoteRole].idle && (n & 255) === 0) {
      this.remoteHangupWhenIdle = false; const t = n + 1, S = this.S; if (S) { S.cut(this.remoteRole, t);
        this.trk[this.remoteRole].clipAt(t); this.evq.push({ t: t + sec(0.15), kind: 'trans', amp: 0.1 }, { t: t + ms(100 * ((this.plan && this.plan.s10) || 14)), kind: 'carrier', on: false }, { t: t + ms(100 * ((this.plan && this.plan.s10) || 14)), kind: 'result', code: 'NO CARRIER' }, { t: t + ms(100 * ((this.plan && this.plan.s10) || 14)) + 1, kind: 'hangup' }); this.evq.sort((x, y) => x.t - y.t); }
    }
    return this.spkOut;
  }
  /** drain queued events (for the worklet / tests) */
  take() { const o = this.out; this.out = []; return o; }
}
const enc = (s) => { const b = []; for (const ch of String(s)) { const c = ch.charCodeAt(0); b.push(c < 256 ? c : 63); } return b; };
const DTMFP = { '1': [697, 1209], '2': [697, 1336], '3': [697, 1477], 'A': [697, 1633], '4': [770, 1209], '5': [770, 1336], '6': [770, 1477], 'B': [770, 1633],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477], 'C': [852, 1633], '*': [941, 1209], '0': [941, 1336], '#': [941, 1477], 'D': [941, 1633] };

/** plays one track's segments in order, with short fades into and out of silence */
class TrackRun {
  constructor() { this.segs = []; this.i = 0; this.cur = null; this.tail = null; this.tk = 0; this.fin = 0; }
  set(list) { this.segs = list.filter(s => s.n > 0); this.i = 0; this.cur = null; this.tail = null; this.fin = 0; }
  clear() { this.segs = []; this.i = 0; if (this.cur) { this.tail = this.cur.gen; this.tk = 0; } this.cur = null; }
  clipAt(t) { if (this.cur && this.cur.start + this.cur.n > t) this.cur.n = t - this.cur.start; this.segs = this.segs.filter(s => s.start < t); }
  step(n, eng, side) {
    let ended = null;
    if (this.cur && n >= this.cur.start + this.cur.n) { ended = this.cur; this.cur = null; }
    while (this.i < this.segs.length && this.segs[this.i].start <= n) {
      const s = this.segs[this.i++]; if (s.start + s.n <= n) continue;
      if (ended && ended.gen === s.gen) ended = null;                         // same generator: seamless
      else if (ended) { this.tail = ended.gen; this.tk = 0; ended = null; this.fin = 0; } // crossfade
      else if (this.cur && this.cur.gen !== s.gen) { this.tail = this.cur.gen; this.tk = 0; this.fin = 0; }
      else if (!this.cur && !this.tail) this.fin = 0;                         // from silence: fade in
      this.cur = s; if (s.onStart) s.onStart();
      const role = side === 'net' ? 'net' : (side === eng.localRole ? 'local' : 'remote');
      eng.emit('seg', { side: role, role: side, label: s.label, phase: s.phase, dur: s.n === Infinity ? -1 : s.n / FS });
    }
    if (ended) { this.tail = ended.gen; this.tk = 0; }
    let y = 0;
    if (this.cur) { if (this.fin < 1) this.fin = Math.min(1, this.fin + 1 / 24); y = this.cur.gen.next() * this.fin; if (this.tail) { y += this.tail.next() * (1 - this.tk / 24); if (++this.tk >= 24) this.tail = null; } }
    else if (this.tail) { y = this.tail.next() * (1 - this.tk / 24); if (++this.tk >= 24) { this.tail = null; this.fin = 0; } }
    return y;
  }
}
