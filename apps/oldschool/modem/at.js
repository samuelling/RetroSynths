// AT command interpreter (Hayes-style, with common Rockwell/USR/V.250 extensions). Pure logic, no DOM.
// It owns the modem's settings and S-registers, turns a dial command into a "plan" for the engine,
// and formats the engine's outcomes into result codes as E/Q/V/X/W/S95/&A dictate.
import { MODELS, SERVERS, PHONEBOOK, PROTOS, PROTO_NAME, PROTO_MAX, S_DEFAULTS, modelById, REGIONS } from './models.js';
import { hashStr } from './dsp.js';

const NUMERIC = { OK: 0, CONNECT: 1, RING: 2, 'NO CARRIER': 3, ERROR: 4, 'NO DIALTONE': 6, BUSY: 7, 'NO ANSWER': 8 };
const SPEED_CODE = { 300: 1, 600: 9, 1200: 5, 2400: 10, 4800: 11, 7200: 13, 9600: 12, 12000: 14, 14400: 15, 16800: 59, 19200: 16, 21600: 61,
  24000: 62, 26400: 63, 28800: 64, 31200: 65, 33600: 66, 38400: 17, 57600: 18, 115200: 19 };
const speedCode = (r) => SPEED_CODE[r] ?? (r > 33600 ? 100 + Math.round((r - 28000) / (8000 / 6)) : 1);
const MS_CODES = { 0: 'V21', 1: 'V22', 2: 'V22bis', 9: 'V32', 10: 'V32bis', 11: 'V34', 12: 'V90', 56: 'P56F', 64: 'B103', 69: 'B212A' };
const MS_NAMES = { V21: 'V21', V22: 'V22', V22B: 'V22bis', V32: 'V32', V32B: 'V32bis', V34: 'V34', V90: 'V90', B103: 'B103', B212: 'B212A', K56: 'P56F', X2: 'P56X', V92: 'V90' };
const S37_RATE = { 1: 300, 2: 300, 3: 300, 5: 1200, 6: 2400, 7: 4800, 8: 7200, 9: 9600, 10: 12000, 11: 14400, 12: 16800, 13: 19200, 14: 21600, 15: 24000, 16: 26400, 17: 28800, 18: 31200, 19: 33600 };
const AN_RATE = [0, 300, 1200, 2400, 4800, 7200, 9600, 12000, 14400, 16800, 19200, 21600, 24000, 26400, 28800, 31200, 33600];
const RATESET = { V34: [2400, 4800, 7200, 9600, 12000, 14400, 16800, 19200, 21600, 24000, 26400, 28800, 31200, 33600], V32bis: [4800, 7200, 9600, 12000, 14400],
  V32: [4800, 9600], V22bis: [2400], V22: [1200], B212A: [1200], B103: [300], V21: [300] };
const TAG = { V90: 'V90', P56X: 'RX56', P56F: 'RF56', V34: 'V34', V32bis: 'V32B', V32: 'V32', V22bis: 'V22B', V22: 'V22', B212A: 'B212', B103: 'B103', V21: 'V21', FAX: 'FAX' };
const pad3 = (n) => String(n).padStart(3, '0');

export function factory(model, region = 'na') {
  const S = { ...S_DEFAULTS };
  return {
    E: 1, Q: 0, V: 1, X: 4, M: 1, L: 2, B: model.bell && region === 'na' ? 1 : 0, N: 1, W: 0, Y: 0, P: !!model.rotary,
    C: 1, D: 2, K: model.ec && model.ec.length ? 3 : 0, Qa: model.ec && model.ec.length ? 5 : 0, G: REGIONS[region] ? REGIONS[region].guard : 0,
    S_: 0, R: 1, A: 0, Na: 0, BN: model.ec && model.ec.length ? 3 : 0, BV: 0, BQ: 3, PC: model.comp && model.comp.length ? 1 : 0, PE: 1,
    MS: null, ES: null, DS: null, FCLASS: 0, IPR: 0, V90: 1, S, lastS: 0,
  };
}
const clone = (o) => JSON.parse(JSON.stringify(o));

/** what answers a number: the directory, else the fictional 555-01xx exchange, else an intercept */
export function lookupNumber(digits, book = PHONEBOOK) {
  const d = digits.replace(/\D/g, ''), last7 = d.slice(-7);
  const e = book.find(b => b.number.replace(/\D/g, '') === last7 && last7.length === 7);
  if (e) return { entry: e, answer: e.answer, rings: e.rings };
  if (/^55501\d\d$/.test(last7)) {
    const h = hashStr(last7), pool = ['modem:q2400', 'modem:t9600', 'modem:f144', 'modem:r288', 'modem:r336', 'modem:smart1200', 'busy', 'noanswer', 'person', 'modem:r336', 'fax'];
    return { entry: null, answer: pool[h % pool.length], rings: 1 + (h >> 8) % 3 };
  }
  return { entry: null, answer: 'intercept', rings: 0 };
}

/** an engine plan entry for a modem model (as the far end, or the local modem with its settings applied) */
export function modemPlan(model, extra = {}) {
  return { kind: 'modem', id: model.id, name: model.name, caps: [...model.caps], ec: model.ec || [], comp: model.comp || [], ch: model.ch || {}, tx: (model.ch && model.ch.tx) ?? -10,
    bell: !!model.bell, digital: !!model.digital, maxRate: model.maxRate || 0, ecPref: 'auto', compOn: true, fclass: 0, ...extra };
}
export function farPlan(answer, rings, seed = 1) {
  if (answer.startsWith('modem:')) return modemPlan(modelById(answer.slice(6)), { rings: rings || 1 });
  return { kind: answer, rings: rings || 1, caps: [], ch: {} };
}

export class ATModem {
  /** io: { send(msg), print(text, cls), state(st), connect(info), data(line), lookup(digits) } */
  constructor(io, modelId = 'r336', region = 'na') {
    this.io = io; this.region = region; this.setModel(modelId, true);
    this.mode = 'command'; this.lastCmd = ''; this.lastDial = ''; this.conn = null; this.callUp = false; this.seed = 1;
    this.offhook = false; this.carrier = false; this.ringing = false;
  }
  setModel(id, quiet) {
    this.model = modelById(id); this.factory = factory(this.model, this.region); this.st = clone(this.factory); this.stored = clone(this.factory);
    if (!quiet) this._state();
  }
  setRegion(r) { this.region = r; this.factory = factory(this.model, r); this.st.G = this.factory.G; this.st.B = this.factory.B; this.stored.G = this.factory.G; this.stored.B = this.factory.B; }
  print(t, cls) { this.io.print(t, cls); }
  _state() { this.io.state && this.io.state({ mode: this.mode, offhook: this.offhook, carrier: this.carrier, aa: (this.st.S[0] | 0) > 0, conn: this.conn, ringing: this.ringing }); }

  // ---------------------------------------------------------------- result codes
  result(code, info = null) {
    const st = this.st; if (st.Q) return;
    let c = code;
    if (st.X < 2 && c === 'NO DIALTONE') c = 'NO CARRIER';
    if (st.X < 3 && (c === 'BUSY')) c = 'NO CARRIER';
    if (st.X === 3 && c === 'NO DIALTONE') c = 'NO CARRIER';
    if (c !== 'CONNECT') { this.print(st.V ? c : String(NUMERIC[c] ?? 4), 'res'); return; }
    const r = info || {}; const dce = r.rate || 300, dte = st.IPR || this.model.dte || dce;
    if (r.fax) { this.print(st.V ? '+FCON' : '+FCON', 'res'); this.print(st.V ? 'CONNECT' : '1', 'res'); return; }
    const s95 = st.S[95] | 0, ec = r.ec && r.ec !== 'none';
    if (st.V && (st.W === 1 || (s95 & 4))) this.print('CARRIER ' + dce, 'res');
    if (st.V && (st.W === 1 || (s95 & 8))) this.print('PROTOCOL: ' + (r.ec === 'LAPM' ? 'LAPM' : r.ec === 'MNP' ? 'ALT' : 'NONE'), 'res');
    if (st.V && (st.W === 1 || (s95 & 32))) this.print('COMPRESSION: ' + (r.comp === 'V.42bis' ? 'V.42BIS' : r.comp === 'MNP 5' ? 'CLASS 5' : 'NONE'), 'res');
    if (st.X === 0) { this.print(st.V ? 'CONNECT' : '1', 'res'); return; }
    const showDce = st.W === 2 || (s95 & 1) || !(dte > (PROTO_MAX[r.proto] || 0));
    const speed = showDce ? dce : dte;
    if (!st.V) { this.print(String(speedCode(speed)), 'res'); return; }
    let s = 'CONNECT ' + speed;
    if (ec && (st.BV || st.A >= 1 || (s95 & 2) || st.W === 2)) s += '/ARQ';
    if (st.A >= 2) s += '/' + (TAG[r.proto] || r.proto);
    if (st.A >= 3 && ec) s += '/' + (r.ec === 'LAPM' ? 'LAPM' : 'MNP') + (r.comp && r.comp !== 'none' ? '/' + (r.comp === 'V.42bis' ? 'V42BIS' : 'MNP5') : '');
    else if (st.BV && r.comp && r.comp !== 'none') s += '/' + (r.comp === 'V.42bis' ? 'V42BIS' : 'MNP5');
    this.print(s, 'res');
  }
  ok() { this.result('OK'); }
  error() { this.result('ERROR'); }

  // ---------------------------------------------------------------- input from the terminal
  input(raw) {
    const line = raw.replace(/\r|\n/g, '');
    if (this.mode === 'busy' || this.mode === 'dialing-ret') {               // any character aborts dialing / handshake
      this.io.send({ type: 'hangup' }); this.offhook = false; this.carrier = false; this.mode = 'command'; this.callUp = false;
      this.result('NO CARRIER'); this._state();
      if (/^at/i.test(line.trim())) this.exec(line.trim());
      return;
    }
    if (this.mode === 'online') {
      if (line.trim() === '+++') {
        this.print('+++', 'echo'); const guard = Math.max(200, (this.st.S[12] | 0) * 20);
        this.mode = 'escaping'; setTimeout(() => { if (this.mode === 'escaping') { this.mode = 'online-cmd'; this.ok(); this._state(); } }, guard);
        return;
      }
      if (/^at/i.test(line.trim())) { this.mode = 'online-cmd'; this.print('(escape +++ assumed)', 'note'); this.exec(line.trim()); return; }
      this.io.data && this.io.data(line); return;
    }
    if (this.mode === 'escaping') return;
    const t = line.trim();
    if (/^a\/$/i.test(t)) { if (this.lastCmd) this.exec(this.lastCmd, true); return; }
    if (/^at/i.test(t)) { this.exec(t); return; }
    if (t && this.st.E) this.print(t, 'echo');   // a real modem ignores text that is not a command
  }
  hangupButton() {
    const active = this.mode === 'busy' || this.mode === 'dialing-ret' || this.mode === 'online' || this.mode === 'online-cmd' || this.mode === 'escaping' || this.offhook || this.callUp;
    this.io.send({ type: 'hangup' });
    if (active) { this.mode = 'command'; this.offhook = false; this.carrier = false; this.callUp = false; this.conn = null; this.result('NO CARRIER'); }
    this._state();
  }

  // ---------------------------------------------------------------- command line
  exec(line, repeat) {
    const st = this.st;
    if (st.E && !repeat) this.print(line, 'echo'); else if (st.E && repeat) this.print('A/', 'echo');
    this.lastCmd = line;
    let b = line.slice(2); let i = 0; const U = b.toUpperCase();
    const num = () => { let s = ''; while (i < U.length && U[i] >= '0' && U[i] <= '9') s += U[i++]; return s === '' ? 0 : +s; };
    const want = (v, max, min = 0) => v >= min && v <= max;
    let printed = false;
    try {
      while (i < U.length) {
        const c = U[i++];
        if (c === ' ') continue;
        switch (c) {
          case 'A': return this.cmdAnswer();
          case 'D': return this.cmdDial(b.slice(i));
          case 'E': { const v = num(); if (!want(v, 1)) return this.error(); st.E = v; break; }
          case 'Q': { const v = num(); if (!want(v, 1)) return this.error(); st.Q = v; break; }
          case 'V': { const v = num(); if (!want(v, 1)) return this.error(); st.V = v; break; }
          case 'X': { const v = num(); if (!want(v, 4)) return this.error(); st.X = v; break; }
          case 'M': { const v = num(); if (!want(v, 3)) return this.error(); st.M = v; break; }
          case 'L': { const v = num(); if (!want(v, 3)) return this.error(); st.L = v; break; }
          case 'B': { const v = num(); if (!want(v, 1)) return this.error(); st.B = v; break; }
          case 'N': { const v = num(); if (!want(v, 1)) return this.error(); st.N = v; break; }
          case 'W': { const v = num(); if (!want(v, 2)) return this.error(); st.W = v; break; }
          case 'Y': { const v = num(); if (!want(v, 1)) return this.error(); st.Y = v; break; }
          case 'T': st.P = false; break;
          case 'P': st.P = true; break;
          case 'H': { const v = num(); if (!want(v, 1)) return this.error(); this.cmdHook(v); break; }
          case 'O': { num(); return this.cmdOnline(); }
          case 'Z': { num(); this.cmdReset(); return this.ok(); }
          case 'I': { const v = num(); if (!want(v, 7)) return this.error(); this.print(String(this.model.ati[v]), 'info'); if (v === 2) { /* ROM test prints OK */ } break; }
          case 'S': {
            let n = st.lastS; if (U[i] >= '0' && U[i] <= '9') n = num(); st.lastS = n;
            if (n > 255) return this.error();
            if (U[i] === '?') { i++; this.print(pad3(st.S[n] | 0), 'info'); }
            else if (U[i] === '=') { i++; const v = num(); if (v > 255) return this.error(); st.S[n] = v; }
            break;
          }
          case '&': {
            const k = U[i++]; const v = num();
            const R = { C: 1, D: 3, K: 6, Q: 6, G: 2, S: 1, R: 1, A: 3, N: 16, Y: 1, T: 8, J: 1, M: 0, X: 2, B: 1, H: 7, I: 5, E: 2, P: 1, L: 1, Z: 255 };
            if (k === 'F') { if (!want(v, 1)) return this.error(); this.st = clone(this.factory); Object.assign(st, this.st); this.st = st; break; }
            if (k === 'W') { if (!want(v, 1)) return this.error(); this.stored = clone(st); break; }
            if (k === 'V') { this.cmdShow(); printed = true; break; }
            if (!(k in R) || !want(v, R[k])) return this.error();
            if (k === 'C') st.C = v; else if (k === 'D') st.D = v; else if (k === 'K') st.K = v; else if (k === 'Q') st.Qa = v; else if (k === 'G') st.G = v;
            else if (k === 'S') st.S_ = v; else if (k === 'R') st.R = v; else if (k === 'A') st.A = v; else if (k === 'N') st.Na = v;
            break;
          }
          case '\\': {
            const k = U[i++]; const v = num(); const R = { N: 5, V: 1, Q: 3, K: 5, J: 1, G: 1, T: 90, A: 3, C: 2 };
            if (!(k in R) || !want(v, R[k])) return this.error();
            if (k === 'N') st.BN = v; else if (k === 'V') st.BV = v; else if (k === 'Q') st.BQ = v;
            break;
          }
          case '%': {
            const k = U[i++]; const v = num();
            if (k === 'C') { if (!want(v, 3)) return this.error(); st.PC = v; }
            else if (k === 'E') { if (!want(v, 2)) return this.error(); st.PE = v; }
            else if (k === 'L') { this.print(pad3(Math.round(12 + (1 - this.io.quality()) * 26)), 'info'); }
            else if (k === 'Q') { this.print(pad3(Math.round(Math.pow(1 - this.io.quality(), 2) * 120 + 2)), 'info'); }
            else return this.error();
            break;
          }
          case '+': case '-': {
            let name = ''; while (i < U.length && /[A-Z0-9]/.test(U[i])) name += U[i++];
            let op = '', arg = '';
            if (U.startsWith('=?', i)) { op = 'test'; i += 2; } else if (U[i] === '?') { op = 'read'; i++; } else if (U[i] === '=') { op = 'set'; i++; let s = ''; while (i < U.length && U[i] !== ';') s += U[i++]; arg = s; }
            if (U[i] === ';') i++;
            if (!this.extended(c + name, op, arg)) return this.error();
            break;
          }
          case ';': break;
          default: return this.error();
        }
      }
    } catch (e) { return this.error(); }
    this.ok(); this._state();
  }

  extended(name, op, arg) {
    const st = this.st, m = this.model, a = arg.split(',').map(s => s.trim());
    switch (name) {
      case '+MS': {
        if (op === 'test') { const codes = Object.entries(MS_CODES).filter(([, p]) => m.caps.includes(p)).map(([k]) => k); this.print(`+MS: (${codes.join(',')}),(0,1),(300-${this._max()}),(300-${this._max()})`, 'info'); return true; }
        if (op === 'read') { const ms = st.MS || { carrier: this._top(), auto: 1, min: 300, max: this._max() }; const code = Object.entries(MS_CODES).find(([, p]) => p === ms.carrier); this.print(`+MS: ${code ? code[0] : ms.carrier},${ms.auto},${ms.min},${ms.max}`, 'info'); return true; }
        const car = /^\d+$/.test(a[0]) ? MS_CODES[a[0]] : MS_NAMES[a[0]];
        if (!car || !m.caps.includes(car)) return false;
        st.MS = { carrier: car, auto: a[1] === undefined || a[1] === '' ? 1 : +a[1], min: +a[2] || 300, max: +a[3] || 0 };
        return true;
      }
      case '+ES': if (op === 'read') { this.print('+ES: ' + (st.ES || [3, 0, 2]).join(','), 'info'); return true; } if (op === 'test') { this.print('+ES: (0-7),(0-4),(0-4,6)', 'info'); return true; }
        st.ES = a.map(x => +x || 0); return true;
      case '+DS': if (op === 'read') { this.print('+DS: ' + (st.DS || [3, 0, 2048, 32]).join(','), 'info'); return true; } if (op === 'test') { this.print('+DS: (0-3),(0,1),(512-2048),(6-250)', 'info'); return true; }
        st.DS = a.map(x => +x || 0); return true;
      case '+FCLASS': if (op === 'test') { this.print(m.fax ? '0,1' : '0', 'info'); return true; } if (op === 'read') { this.print(String(st.FCLASS), 'info'); return true; }
        if (!(a[0] === '0' || (a[0] === '1' && m.fax))) return false; st.FCLASS = +a[0]; return true;
      case '+IPR': if (op === 'read') { this.print('+IPR: ' + (st.IPR || m.dte), 'info'); return true; } if (op === 'test') { this.print('+IPR: (0,300,1200,2400,9600,19200,38400,57600,115200)', 'info'); return true; }
        st.IPR = +a[0] || 0; return true;
      case '+GMI': this.print(this.model.ati[3].split(' ')[0] + ' COMMUNICATIONS', 'info'); return true;
      case '+GMM': this.print(this.model.name.toUpperCase(), 'info'); return true;
      case '+GMR': this.print(this.model.ati[3], 'info'); return true;
      case '+GCAP': this.print('+GCAP: +MS,+ES,+DS' + (m.fax ? ',+FCLASS' : ''), 'info'); return true;
      case '-V90': if (op === 'set') { st.V90 = +a[0] ? 1 : 0; return true; } if (op === 'read') { this.print(String(st.V90), 'info'); return true; } return true;
      default: return false;
    }
  }
  _top() { return this.model.caps[0]; }
  _max() { return this.model.maxRate || PROTO_MAX[this._top()] || 300; }

  cmdShow() {
    const st = this.st, f = (o) => `B${o.B} E${o.E} L${o.L} M${o.M} N${o.N} Q${o.Q} ${o.P ? 'P' : 'T'} V${o.V} W${o.W} X${o.X} Y${o.Y} &C${o.C} &D${o.D} &G${o.G} &K${o.K} &Q${o.Qa} &R${o.R} &S${o.S_} \\N${o.BN} %C${o.PC} %E${o.PE}`;
    const regs = (o) => { const ks = Object.keys(o.S).map(Number).sort((x, y) => x - y); const out = []; let row = [];
      for (const k of ks) { row.push(`S${String(k).padStart(2, '0')}:${pad3(o.S[k] | 0)}`); if (row.length === 8) { out.push(row.join(' ')); row = []; } } if (row.length) out.push(row.join(' ')); return out; };
    this.print('ACTIVE PROFILE:', 'info'); this.print(f(st), 'info'); for (const l of regs(st)) this.print(l, 'info');
    if (st.MS) this.print(`+MS=${st.MS.carrier},${st.MS.auto},${st.MS.min},${st.MS.max}`, 'info');
    this.print('', 'info'); this.print('STORED PROFILE 0:', 'info'); this.print(f(this.stored), 'info'); for (const l of regs(this.stored)) this.print(l, 'info');
    this.print('', 'info'); this.print('TELEPHONE NUMBERS:', 'info'); this.print('0=' + (this.lastDial || '').padEnd(30) + ' 1=', 'info');
  }
  cmdReset() { this.io.send({ type: 'hangup', quiet: !this.offhook }); this.mode = 'command'; this.offhook = this.carrier = this.callUp = false; this.conn = null; this.st = clone(this.stored); this._state(); }
  cmdHook(v) {
    if (v === 0) { if (this.offhook || this.callUp || this.conn) { this.io.send({ type: 'hangup' }); } this.offhook = false; this.callUp = false; this.conn = null; this.carrier = false; this.mode = 'command'; }
    else { this.io.send({ type: 'config', ...this._cfg() }); this.io.send({ type: 'offhook' }); this.offhook = true; }
  }
  cmdOnline() {
    if (this.mode === 'online-cmd' && this.conn) { this.mode = 'online'; this.result('CONNECT', this.conn); this._state(); return; }
    this.result('NO CARRIER');
  }
  cmdAnswer() {
    this.io.send({ type: 'config', ...this._cfg() });
    this.io.send({ type: 'answer', plan: { answerer: this.localPlan(), s7: this.st.S[7], s10: this.st.S[10], guard: this.st.G, seed: this.seed++ } });
    this.mode = 'busy'; this.ringing = false; this.offhook = true; this._state();
  }
  /** settings that matter to the engine's speaker & line */
  _cfg() { return { M: this.st.M, L: this.st.L, model: this.model.id }; }

  /** the local modem's capabilities after B, +MS, S37, N, &N, \N, %C, +ES, +DS, -V90 */
  localPlan() {
    const st = this.st, m = this.model; let caps = [...m.caps];
    const has = (p) => caps.includes(p);
    if (st.B === 0 && (has('V22') || has('V22bis') || has('V21'))) caps = caps.filter(p => p !== 'B212A' && p !== 'B103');
    if (st.B === 1 && (has('B212A') || has('B103'))) caps = caps.filter(p => !(p === 'V21' && has('B103')) && !(p === 'V22' && has('B212A')));
    if (!st.V90) caps = caps.filter(p => p !== 'V90' && p !== 'P56F' && p !== 'P56X');
    let maxRate = m.maxRate || 0, minRate = 0;
    if (st.MS) {
      const k = PROTOS.indexOf(st.MS.carrier);
      caps = caps.filter(p => st.MS.auto ? PROTOS.indexOf(p) >= k : p === st.MS.carrier);
      if (st.MS.max) maxRate = maxRate ? Math.min(maxRate, st.MS.max) : st.MS.max; minRate = st.MS.min || 0;
    }
    const fixed = st.Na ? AN_RATE[st.Na] : (st.S[37] ? S37_RATE[st.S[37]] : 0);
    if (fixed) {
      if (st.Na || st.N === 0) { caps = caps.filter(p => (RATESET[p] || []).includes(fixed)); minRate = fixed; }  // N0 / &Nn: this speed or nothing
      else caps = caps.filter(p => Math.min(...(RATESET[p] || [1e9])) <= fixed);                                   // N1: this speed at most
      maxRate = maxRate ? Math.min(maxRate, fixed) : fixed;
    }
    let ecPref = 'auto';
    if (!m.ec || !m.ec.length) ecPref = 'none';
    else if (st.BN === 0 || st.BN === 1 || st.Qa === 0 || st.Qa === 6 || (st.ES && st.ES[0] <= 1)) ecPref = 'none';
    else if (st.BN === 2 || (st.ES && st.ES[0] === 4)) ecPref = 'required';
    else if (st.BN === 5 || (st.ES && st.ES[0] === 6)) ecPref = 'mnp';
    const compOn = !!st.PC && !(st.DS && st.DS[0] === 0);
    return modemPlan(m, { caps, maxRate, minRate, ecPref, compOn, fclass: st.FCLASS, bell: st.B === 1 });
  }

  /** ATD: parse the dial string into steps, look up what answers, hand the engine a plan */
  cmdDial(rest) {
    const st = this.st; let s = rest;
    if (/^\s*L\s*$/i.test(s)) { if (!this.lastDial) return this.error(); s = this.lastDial; this.print(s, 'note'); }
    const dial = []; let digits = '', ret = false, reverse = false, any = false, pulse = st.P;
    for (const ch0 of s) {
      const ch = ch0.toUpperCase();
      if ('0123456789*#'.includes(ch) || ('ABCD'.includes(ch))) { dial.push({ k: 'digit', d: ch }); if (/\d/.test(ch)) digits += ch; any = true; }
      else if (ch === 'T' || ch === 'P') { dial.push({ k: ch }); if (!any) pulse = ch === 'P'; }
      else if (ch === ',' || ch === 'W' || ch === '!' || ch === '@') dial.push({ k: ch });
      else if (ch === ';') { ret = true; break; }
      else if (ch === 'R') reverse = true;
      else if (' -()./'.includes(ch)) continue;
      else if (ch === 'S' || ch === '=' || ch === 'L') continue;
      else return this.error();
    }
    if (st.E) {/* already echoed */}
    this.io.send({ type: 'config', ...this._cfg() });
    if (!any && this.callUp) { this.io.send({ type: 'originate' }); this.mode = 'busy'; this.callUp = false; this._state(); return; }
    this.lastDial = s;
    let far;
    if (!any) far = { kind: 'dialtone', caps: [], ch: {} };
    else { const L = this.io.lookup ? this.io.lookup(digits) : lookupNumber(digits); far = farPlan(L.answer, L.rings); far.number = digits; far.entry = L.entry && L.entry.name; }
    const plan = {
      dial, x: st.X, s6: st.S[6], s7: st.S[7], s8: st.S[8], s10: st.S[10], s11: st.S[11], pulse, ret, reverse, rotary: !!this.model.rotary,
      caller: this.localPlan(), answerer: far, guard: st.G, seed: hashStr(digits + ':' + this.seed++),
    };
    this.plan = plan;
    this.io.send({ type: 'dial', plan });
    this.mode = ret ? 'dialing-ret' : 'busy'; this.offhook = true; this._state();
  }

  // ---------------------------------------------------------------- engine events
  onEngine(e) {
    switch (e.kind) {
      case 'result': this.onResult(e); break;
      case 'ring':
        if (this.mode === 'online' || this.mode === 'busy' || this.offhook) return;
        this.ringing = true; this.mode = 'command'; this.result('RING'); this.st.S[1] = (this.st.S[1] | 0) + 1;
        if ((this.st.S[0] | 0) > 0 && this.st.S[1] >= this.st.S[0]) this.cmdAnswer();
        this._state(); break;
      case 'ringstop': this.ringing = false; this.st.S[1] = 0; this._state(); break;
      case 'hook': this.offhook = e.off; if (!e.off) { this.carrier = false; } this._state(); break;
      case 'carrier': this.carrier = e.on; this._state(); break;
    }
  }
  onResult(e) {
    const code = e.code;
    if (code === 'OK') { this.mode = 'command'; this.callUp = true; this.ok(); this._state(); return; }
    if (code === 'CONNECT') {
      this.conn = { proto: e.proto, rate: e.rate, ec: e.ec, comp: e.comp, fax: e.fax, baud: e.baud, up: e.up };
      this.mode = e.fax ? 'busy' : 'online'; this.carrier = true; this.st.S[1] = 0; this.result('CONNECT', this.conn); this._state();
      if (!e.fax && this.io.connect) this.io.connect(this.conn);
      return;
    }
    if (code === 'FAXDONE') { this.print('+FHNG: 0', 'res'); this.mode = 'command'; this.conn = null; this.ok(); this._state(); return; }
    // failures and disconnects
    const wasOnline = this.mode === 'online' || this.mode === 'online-cmd';
    this.mode = 'command'; this.callUp = false; this.conn = null; this.carrier = false;
    this.result(code); this._state();
    if (wasOnline && this.io.disconnect) this.io.disconnect();
  }
}
export { MODELS, SERVERS, PHONEBOOK };
