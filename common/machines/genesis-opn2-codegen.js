/*
 * Code generator for the fast path of nuked-opn2.js (RetroSynths Genesis machine). Developer tool, not
 * loaded at run time. It emits OPN2_Clock (Nuked OPN2, ym3438.c) unrolled over the 24 clock positions of
 * one output sample, with per-position constants folded in, into the marked regions of nuked-opn2.js.
 * Being an expression of Nuked OPN2's code, this file is under the same licence:
 *
 * Original C code: Copyright (C) 2017-2022 Alexey Khokholov (Nuke.YKT)
 * This generator: Copyright (C) 2026 Sam Ling
 * This library is free software; you can redistribute it and/or modify it under the terms of the GNU
 * Lesser General Public License as published by the Free Software Foundation; either version 2.1 of the
 * License, or (at your option) any later version. It is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See LICENSES/Nuked-OPN2-LGPL-2.1.txt.
 *
 * Usage:  node common/machines/genesis-opn2-codegen.js common/machines/nuked-opn2.js [fullGroups=6] [leanGroups=6]
 * Groups split the 24 clocks into separate functions; each must stay under V8's optimisation limit of
 * 60 KB of bytecode. After regenerating, re-run the bit-exact comparison against the compiled C core.
 */
// Generates the fast OPN2 renderer: OPN2_Clock unrolled over the 24 clock positions of a sample, with
// constant folding per position, all array state in one Int32Array S, integer-only flag logic.
import fs from 'node:fs';
const fm_algorithm = [
  [[1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,1]],
  [[0,1,0,0,0,1,0,0],[0,0,0,0,0,0,0,0],[1,1,1,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,1,1,1]],
  [[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[0,0,0,0,0,0,0,0],[1,0,0,1,1,1,1,0],[0,0,0,0,0,0,0,0],[0,0,0,0,1,1,1,1]],
  [[0,0,1,0,0,1,0,0],[0,0,0,0,0,0,0,0],[0,0,0,1,0,0,0,0],[1,1,0,1,1,0,0,0],[0,0,1,0,0,0,0,0],[1,1,1,1,1,1,1,1]],
];
const mask = (op, row) => fm_algorithm[op][row].reduce((m, v, i) => m | (v << i), 0);
const op_offset = [0x000, 0x001, 0x002, 0x100, 0x101, 0x102, 0x004, 0x005, 0x006, 0x104, 0x105, 0x106];
const ch_offset = [0x000, 0x001, 0x002, 0x100, 0x101, 0x102];
const bit = (m) => m === 0xff ? 'true' : `((${m} >> con) & 1) !== 0`;
const msk = (m) => m === 0xff ? '-1' : `(0 - ((${m} >> con) & 1))`;

// ---- state layout ----
const LAY = [['pg_inc', 24], ['pg_phase', 24], ['pg_reset', 24], ['eg_state', 24], ['eg_level', 24], ['eg_out', 24], ['eg_kon', 24],
  ['eg_kon_csm', 24], ['eg_kon_latch', 24], ['eg_csm_mode', 24], ['eg_ssg_enable', 24], ['eg_ssg_pgrst_latch', 24], ['eg_ssg_repeat_latch', 24],
  ['eg_ssg_hold_up_latch', 24], ['eg_ssg_dir', 24], ['eg_ssg_inv', 24], ['eg_read', 2], ['eg_sl', 2], ['eg_tl', 2],
  ['fm_op1', 12], ['fm_op2', 6], ['fm_out', 24], ['fm_mod', 24], ['ch_acc', 6], ['ch_out', 8],
  ['mode_test_21', 8], ['mode_test_2c', 8], ['mode_kon_operator', 4], ['mode_kon', 24],
  ['ks', 24], ['ar', 24], ['sr', 24], ['dt', 24], ['multi', 24], ['sl', 24], ['rr', 24], ['dr', 24], ['am', 24], ['tl', 24], ['ssg_eg', 24],
  ['fnum', 6], ['block', 6], ['kcode', 6], ['fnum_3ch', 6], ['block_3ch', 6], ['kcode_3ch', 6],
  ['connect', 6], ['fb', 6], ['pan_l', 6], ['pan_r', 6], ['ams', 6], ['pms', 6]];
const TAB = [['logsinrom', 'T_LOGSIN', 256], ['EXPT', 'T_EXPT', 0x2000], ['DTT', 'T_DTT', 256], ['EG_STEPHI', 'T_STEPHI', 16],
  ['eg_am_shift', 'T_AMSHIFT', 4], ['pg_lfo_sh1', 'T_SH1', 64], ['pg_lfo_sh2', 'T_SH2', 64]];
const OFF = {}; let o = 0;
for (const [n, l] of LAY) { OFF[n] = o; o += l; }
const ARR_END = o;
// replace name[expr] by S[off + expr] (bracket-aware; constant indices folded)
function toS(code) {
  const names = Object.keys(OFF).sort((a, b) => b.length - a.length);
  const re = new RegExp('\\b(' + names.join('|') + ')\\[', 'g');
  let out = '', i = 0;
  for (;;) {
    re.lastIndex = i; const m = re.exec(code); if (!m) { out += code.slice(i); break; }
    out += code.slice(i, m.index);
    let j = m.index + m[0].length, depth = 1; const st = j;
    while (depth) { if (code[j] === '[') depth++; else if (code[j] === ']') depth--; j++; }
    const inner = toS(code.slice(st, j - 1));
    out += /^\d+$/.test(inner) ? `S[${OFF[m[1]] + +inner}]` : `S[${OFF[m[1]]} + (${inner})]`;
    i = j;
  }
  return out;
}

function body(c, lean) {
  const ch = c % 6, s6 = (c + 6) % 24, op6 = (s6 / 6) | 0, s18 = (c + 18) % 24, op18 = (s18 / 6) | 0;
  const s19 = (c + 19) % 24, s20 = (c + 20) % 24, s22 = (c + 22) % 24, s23 = (c + 23) % 24, nch = (ch + 1) % 6, sl12 = c % 12;
  const chn = c < 12 ? ch + 1 : ch;
  let o = `// ---- clock ${c} ----
if (qact !== 0) {
  if (dacState !== 0) { if (since >= 1) { write_data = dacVal; write_d |= 1; dacState = 0; since = 0; } }
  else if (((dacPend >= 0) & (since >= 32) & (qpair === 0)) !== 0) { write_data = 0x2a; write_a |= 1; dacState = 1; dacVal = dacPend; dacPend = -1; since = 0; }
  else while (((qn !== 0) & (since >= qw[qh & QMASK])) !== 0) { const v = qv[qh]; const d = (v >> 8) & 1; write_data = (((v >> 8) << 7) & 0x100) | (v & 0xff); write_d |= d; write_a |= d ^ 1; qpair = d ^ 1; qh = (qh + 1) & QMASK; qn--; since = 0; }
  qact = (qn !== 0) | (dacPend >= 0) | (dacState !== 0);
}
${lean ? (c === 23 ? 'lfo_inc = 1;' : 'lfo_inc = 0;') : 'lfo_inc = t21_1;'} pg_read >>>= 1; eg_read1 >>>= 1; eg_cycle = (eg_cycle + 1) & 0xff;\n`;
  if (c === 1) o += `if (eg_quotient === 2) { eg_shift_lock = eg_cycle_stop !== 0 ? 0 : eg_shift + 1; eg_timer_low_lock = eg_timer & 0x03; }\n`;
  if (c === 0) o += `lfo_pm = lfo_cnt >> 2; lfo_am = ((lfo_cnt & 0x40) !== 0 ? (lfo_cnt & 0x3f) : (lfo_cnt ^ 0x3f)) << 1;\n`;
  if (c === 1) o += `eg_quotient = eg_quotient === 2 ? 0 : eg_quotient + 1; eg_cycle = 0; eg_cycle_stop = 1; eg_shift = 0;
eg_timer_inc |= eg_quotient >> 1; eg_timer = eg_timer + eg_timer_inc; eg_timer_inc = eg_timer >> 12; eg_timer &= 0xfff;\n`;
  if (c === 2) o += `pg_read = pg_phase[21] & 0x3ff; eg_read1 = eg_out[0];\n`;
  if (c === 13) o += `eg_cycle = 0; eg_cycle_stop = 1; eg_shift = 0; eg_timer = eg_timer + eg_timer_inc; eg_timer_inc = eg_timer >> 12; eg_timer &= 0xfff;\n`;
  if (c === 23 && !lean) o += `lfo_inc |= 1;\n`;
  o += lean ? `{ const t = (eg_timer >> eg_cycle) & eg_cycle_stop & 1; eg_shift ^= (eg_shift ^ eg_cycle) & (0 - t); eg_cycle_stop &= t ^ 1; }` : `if (t21_5 !== 0) eg_timer &= ~(1 << eg_cycle) & 0xffff;
if ((((eg_timer >> eg_cycle) | ecust) & eg_cycle_stop) !== 0) { eg_shift = eg_cycle; eg_cycle_stop = 0; }`;
  o += `
${lean ? 'if ((write_a | write_d | write_busy) !== 0) {' : '{'}
write_a_en = (write_a & 0x03) === 0x01 ? 1 : 0; write_d_en = (write_d & 0x03) === 0x01 ? 1 : 0;
write_a = (write_a << 1) & 0xff; write_d = (write_d << 1) & 0xff;
busy = write_busy; write_busy_cnt = (write_busy_cnt + write_busy) & 0xff;
write_busy = (write_busy & ((write_busy_cnt >> 5) ^ 1)) | write_d_en; write_busy_cnt &= 0x1f;
}${lean ? ' else { write_a_en = 0; write_d_en = 0; busy = 0; }' : ''}
if (timersOn !== 0) { this.cycles = ${c}; this.DoTimerA(); this.DoTimerB(); timersOn = this.TimersOn() ? 1 : 0; }
${c === 2 ? 'else konCsm = 0;' : ''}${c === 1 ? 'else tbsub = (tbsub + 1) & 0x0f;' : ''}
eg_kon_latch[${c}] = mode_kon[${c}]; eg_kon_csm[${c}] = 0;
${ch === 2 ? `if (konCsm !== 0) { eg_kon_latch[${c}] = 1; eg_kon_csm[${c}] = 1; }` : ''}
if (konch === ${c}) { mode_kon[${ch}] = mode_kon_operator[0]; mode_kon[${ch + 12}] = mode_kon_operator[1]; mode_kon[${ch + 6}] = mode_kon_operator[2]; mode_kon[${ch + 18}] = mode_kon_operator[3]; }
ch_read = ch_lock;\n`;
  if (lean) {
    if ((c & 3) === 0) o += `ch_lock = ch_out[${chn}]; ch_lock_l = pan_l[${chn}]; ch_lock_r = pan_r[${chn}];\n`;
    if ((c >> 2) === 1) o += `{ let out = dacen !== 0 ? (dacdata & 0xff) - (dacdata & 0x100) : ch_lock;
  if (ym2612) { const nn = (out >> 31) + 1; let sign = (out >> 8) + nn; out += nn;
    ${(c & 3) === 3 ? 'sumL += (ch_lock_l !== 0 ? out : sign) * 3; sumR += (ch_lock_r !== 0 ? out : sign) * 3;' : 'sumL += sign * 3; sumR += sign * 3;'} }
  else { ${(c & 3) !== 0 ? 'sumL += out & (0 - ch_lock_l); sumR += out & (0 - ch_lock_r);' : ''} }
}\n`;
    else if ((c & 3) === 3) o += `{ let out = ch_lock;
  if (ym2612) { const nn = (out >> 31) + 1; let sign = (out >> 8) + nn; out += nn; sumL += 9 * sign + 3 * (ch_lock_l !== 0 ? out : sign); sumR += 9 * sign + 3 * (ch_lock_r !== 0 ? out : sign); }
  else { sumL += (3 * out) & (0 - ch_lock_l); sumR += (3 * out) & (0 - ch_lock_r); }
}\n`;
  } else {
    if ((c & 3) === 0) o += `if (test_dac === 0) ch_lock = ch_out[${chn}]; ch_lock_l = pan_l[${chn}]; ch_lock_r = pan_r[${chn}];\n`;
    o += `{ let out = ${(c >> 2) === 1 ? '(dacen | test_dac) !== 0' : 'test_dac !== 0'} ? (dacdata & 0xff) - (dacdata & 0x100) : ch_lock;
  if (ym2612) { const nn = (out >> 31) + 1; let sign = (out >> 8) + nn; out += nn;
    ${(c & 3) === 3 ? 'mol = (ch_lock_l !== 0 ? out : sign) * 3; mor = (ch_lock_r !== 0 ? out : sign) * 3;'
      : 'if (test_dac !== 0) { mol = (ch_lock_l !== 0 ? out : sign) * 3; mor = (ch_lock_r !== 0 ? out : sign) * 3; } else { mol = sign * 3; mor = mol; }'} }
  else { ${(c & 3) !== 0 ? 'mol = ch_lock_l !== 0 ? out : 0; mor = ch_lock_r !== 0 ? out : 0;'
      : 'if (test_dac !== 0) { mol = ch_lock_l !== 0 ? out : 0; mor = ch_lock_r !== 0 ? out : 0; } else { mol = 0; mor = 0; }'} }
}
sumL += mol; sumR += mor;
if (dbg !== null) { dbg[di++] = mol; dbg[di++] = mor; }
`;
  }
  o += `{ const con = connect[${ch}];
  let acc = ch_acc[${ch}], add = ${lean ? '0' : 'test_dac'};
  ${op18 === 0 ? (lean ? 'acc = 0;' : 'if (test_dac === 0) acc = 0;') : ''}
  ${mask(op18, 5) ? (lean ? `add += (fm_out[${s18}] >> 5) & ${msk(mask(op18, 5))};` : `if (${bit(mask(op18, 5))} && test_dac === 0) add += fm_out[${s18}] >> 5;`) : ''}
  let sum = acc + add; if (sum > 255) sum = 255; else if (sum < -256) sum = -256;
  ${op18 === 0 ? `ch_out[${ch}] = ch_acc[${ch}];` : lean ? '' : `if (test_dac !== 0) ch_out[${ch}] = ch_acc[${ch}];`}
  ch_acc[${ch}] = sum;
  let mod1 = 0, mod2 = 0;
`;
  if (mask(op6, 0)) o += `  mod2 |= fm_op1[${ch * 2}] & ${msk(mask(op6, 0))};\n`;
  if (mask(op6, 1)) o += `  mod1 |= fm_op1[${ch * 2 + 1}] & ${msk(mask(op6, 1))};\n`;
  if (mask(op6, 2)) o += `  mod1 |= fm_op2[${ch}] & ${msk(mask(op6, 2))};\n`;
  if (mask(op6, 3)) o += `  mod2 |= fm_out[${s18}] & ${msk(mask(op6, 3))};\n`;
  if (mask(op6, 4)) o += `  mod1 |= fm_out[${s18}] & ${msk(mask(op6, 4))};\n`;
  o += op6 === 0 ? `  { const f = fb[${ch}]; fm_mod[${s6}] = ((((mod1 + mod2) << 16) >> 16) >> (10 - f)) & (0 - ((f + 7) >> 3)); }\n`
    : `  fm_mod[${s6}] = (((mod1 + mod2) << 16) >> 16) >> 1;\n`;
  if (op18 === 0) o += `  fm_op1[${ch * 2 + 1}] = fm_op1[${ch * 2}]; fm_op1[${ch * 2}] = fm_out[${s18}];\n`;
  if (op18 === 2) o += `  fm_op2[${ch}] = fm_out[${s18}];\n`;
  o += `}
${lean ? `{ const eo = eg_out[${s19}];
  if (eo >= 0x340) fm_out[${s19}] = 0;   /* level >= 0xd00: the exp stage shifts the mantissa out entirely */
  else { const phase = (fm_mod[${s19}] + (pg_phase[${s19}] >>> 10)) & 0x3ff, sg = (phase >> 9) & 1;
    const output = EXPT[logsinrom[(phase ^ ((0 - ((phase >> 8) & 1)) & 0xff)) & 0xff] + (eo << 2)];
    fm_out[${s19}] = (output ^ (0 - sg)) + sg; }
}
` : `{ const phase = (fm_mod[${s19}] + (pg_phase[${s19}] >>> 10)) & 0x3ff;
  let level = logsinrom[(phase & 0x100) !== 0 ? (phase ^ 0xff) & 0xff : phase & 0xff] + (eg_out[${s19}] << 2);
  if (level > 0x1fff) level = 0x1fff;
  let output = EXPT[level];
  if ((phase & 0x200) !== 0) output = ((~output) ^ t21_4) + 1; else output ^= t21_4;
  fm_out[${s19}] = (output & 0x1fff) - (output & 0x2000);
}
`}pg_inc[${s20}] &= pg_reset[${s20}] - 1;
pg_phase[${s19}] = ((pg_phase[${s19}] & ((pg_reset[${s19}]${lean ? '' : ' | t21_3'}) - 1)) + pg_inc[${s19}]) & 0xfffff;
{ let fn = pg_fnum << 1; const p = pms[${ch}];
  if (p !== 0) { const fnum_h = pg_fnum >> 4, lfo_l = (lfo_pm & 0x0f) ^ ((0 - ((lfo_pm >> 3) & 1)) & 0x0f), ng = (lfo_pm >> 4) & 1;
    const fm = (((fnum_h >>> pg_lfo_sh1[(p << 3) | lfo_l]) + (fnum_h >>> pg_lfo_sh2[(p << 3) | lfo_l])) << ((p - 5) & ((5 - p) >> 31))) >>> 2;
    fn = (fn + ((fm ^ (0 - ng)) + ng)) & 0xfff; }
  pg_inc[${c}] = ((((((fn << pg_block) >>> 2) + DTT[(pg_kcode << 3) | dt[${c}]]) & 0x1ffff) * multi[${c}]) >>> 1) & 0xfffff;
}
${lean ? `eg_read0 = eg_read_inc; eg_read_inc = eg_inc > 0 ? 1 : 0;
if ((eg_kon_latch[${s22}] | eg_kon[${s22}] | (eg_level[${s22}] ^ 0x3ff) | (eg_state[${s22}] ^ 3) | eg_ssg_enable[${s22}] | eg_ssg_pgrst_latch[${s22}] | eg_ssg_repeat_latch[${s22}] | eg_kon_csm[${s22}]) === 0) pg_reset[${s22}] = 0;   /* quiescent slot: ADSR is a no-op */
else ` : ''}{ const nkon = eg_kon_latch[${s22}], okon = eg_kon[${s22}], st = eg_state[${s22}];
  let nextstate = st, inc = 0;
  ${lean ? '' : 'eg_read0 = eg_read_inc; eg_read_inc = eg_inc > 0 ? 1 : 0;'}
  const kon_event = (nkon & (okon ^ 1)) | (okon & eg_ssg_repeat_latch[${s22}]);
  pg_reset[${s22}] = (nkon & (okon ^ 1)) | eg_ssg_pgrst_latch[${s22}];
  const ssg_en = eg_ssg_enable[${s22}];
  const km = 0 - (okon & (nkon ^ 1) & eg_ssg_inv[${s22}]);
  let level = ((eg_level[${s22}] ^ km) + (513 & km)) & 0x3ff;
  const ainc = (~level << eg_inc) >> 5, dinc = (1 << (eg_inc - 1)) << (ssg_en << 1);
  const eg_off = ssg_en !== 0 ? level >> 9 : ((level & 0x3f0) === 0x3f0 ? 1 : 0);
  let nextlevel = level;
  if (kon_event !== 0) {
    nextstate = 0;
    if (eg_ratemax !== 0) nextlevel = 0;
    else if (((st === 0) & (level !== 0) & (eg_inc !== 0) & (nkon !== 0)) !== 0) inc = ainc;
  } else {
    const dok = (eg_off === 0) & (eg_inc !== 0);
    if (st === 0) { if (level === 0) nextstate = 1; else if (((eg_inc !== 0) & (eg_ratemax === 0) & (nkon !== 0)) !== 0) inc = ainc; }
    else if (st === 1) { if ((level >> 4) === (eg_sl1 << 1)) nextstate = 2; else inc = dinc & (0 - dok); }
    else inc = dinc & (0 - dok);
    if (nkon === 0) nextstate = 3;
  }
  if (eg_kon_csm[${s22}] !== 0) nextlevel |= eg_tl1 << 3;
  if ((((kon_event | eg_ssg_hold_up_latch[${s22}]) === 0) & (st !== 0) & (eg_off !== 0)) !== 0) { nextstate = 3; nextlevel = 0x3ff; }
  eg_kon[${s22}] = nkon; eg_level[${s22}] = (nextlevel + inc) & 0x3ff; eg_state[${s22}] = nextstate;
}
{ const im = 0 - eg_ssg_inv[${s23}];
  let level = (eg_level[${s23}] ^ im) + (513 & im);
${lean ? '' : '  if (t21_5 !== 0) level = 0;\n'}  level = (level & 0x3ff) + eg_lfo_am${ch === 3 ? ' + (mode_csm !== 0 ? 0 : eg_tl0 << 3)' : ' + (eg_tl0 << 3)'};
  eg_out[${s23}] = level > 0x3ff ? 0x3ff : level;
}
{ const ssg = ssg_eg[${c}];
  if ((ssg & 0x08) !== 0) {
    let direction = eg_ssg_dir[${c}], pgrst = 0, rep = 0, hold = 0;
    { const l9 = (eg_level[${c}] >> 9) & 1;
      pgrst = ((ssg & 0x03) === 0x00) & l9; rep = ((ssg & 0x01) === 0x00) & l9;
      direction = (direction ^ (((ssg & 0x03) === 0x02) & l9)) | (((ssg & 0x03) === 0x03) & l9); }
    hold = (eg_kon_latch[${c}] !== 0) & (((ssg & 0x07) === 0x05) | ((ssg & 0x07) === 0x03));
    direction &= eg_kon[${c}];
    eg_ssg_pgrst_latch[${c}] = pgrst; eg_ssg_repeat_latch[${c}] = rep; eg_ssg_hold_up_latch[${c}] = hold;
    eg_ssg_dir[${c}] = direction; eg_ssg_enable[${c}] = 1;
    eg_ssg_inv[${c}] = (direction ^ ((ssg >> 2) & 1)) & eg_kon[${c}];
  } else ${lean ? `if (eg_ssg_enable[${c}] !== 0) ` : ''}{   /* SSG off: these are already 0 unless the last pass had it on */
    eg_ssg_pgrst_latch[${c}] = 0; eg_ssg_repeat_latch[${c}] = 0; eg_ssg_hold_up_latch[${c}] = 0;
    eg_ssg_dir[${c}] = 0; eg_ssg_enable[${c}] = 0; eg_ssg_inv[${c}] = 0;
  }
}
{ let rate = (eg_rate << 1) + eg_ksv; if (rate > 0x3f) rate = 0x3f;
  let inc = 0;
  if (((eg_rate !== 0) & (eg_quotient === 2)) !== 0) {
    if (rate < 48) { const sum = ((rate >> 2) + eg_shift_lock) & 0x0f; inc = ((sum === 12) | ((sum === 13) & (rate >> 1)) | ((sum === 14) & rate)) & 1; }
    else { inc = EG_STEPHI[((rate & 0x03) << 2) | eg_timer_low_lock] + (rate >> 2) - 11; if (inc > 4) inc = 4; }
  }
  eg_inc = inc; eg_ratemax = (rate >> 1) === 0x1f ? 1 : 0;
  const kn = eg_kon[${c}];
  const rate_sel = ((kn & eg_ssg_repeat_latch[${c}]) | ((kn ^ 1) & eg_kon_latch[${c}])) !== 0 ? 0 : eg_state[${c}];
  const r0 = ar[${c}], r1 = dr[${c}], r2 = sr[${c}], r3 = (rr[${c}] << 1) | 0x01;
  eg_rate = rate_sel === 0 ? r0 : rate_sel === 1 ? r1 : rate_sel === 2 ? r2 : r3;
  eg_ksv = pg_kcode >> (ks[${c}] ^ 0x03);
  eg_lfo_am = (lfo_am >> eg_am_shift[ams[${ch}]]) & (0 - am[${c}]);
  eg_tl1 = eg_tl0; eg_tl0 = tl[${c}]; eg_sl1 = eg_sl0; eg_sl0 = sl[${c}];
}\n`;
  const c3 = { 1: 1, 7: 0, 13: 2 }[c];
  if (c3 !== undefined) o += `if (mode_ch3 !== 0) { pg_fnum = fnum_3ch[${c3}]; pg_block = block_3ch[${c3}]; pg_kcode = kcode_3ch[${c3}]; } else { pg_fnum = fnum[${nch}]; pg_block = block[${nch}]; pg_kcode = kcode[${nch}]; }\n`;
  else o += `pg_fnum = fnum[${nch}]; pg_block = block[${nch}]; pg_kcode = kcode[${nch}];\n`;
  o += `{ const h = (lfo_quotient & lfo_lc) === lfo_lc ? -1 : 0; lfo_cnt = (lfo_cnt + (h & 1)) & 0xff; lfo_quotient = ((lfo_quotient + lfo_inc) & 0xff) & ~h; }
lfo_cnt &= lfo_en;
if (${lean ? '((write_fm_data !== 0) & (wdirty !== 0)) !== 0' : 'write_fm_data !== 0'}) {
  if ((address & 0x107) === ${op_offset[sl12]}) this.SlotReg((address & 0x08) !== 0 ? ${sl12 + 12} : ${sl12}, address, data);
  if ((address & 0x103) === ${ch_offset[ch]}) this.ChanReg(${ch}, address, data);
}
if ((write_a_en | write_d_en) !== 0) {
  ${lean ? 'wdirty = 25;' : ''}
  if (write_a_en !== 0) write_fm_data = 0;
  if ((write_fm_address & write_d_en) !== 0) write_fm_data = 1;
  if (write_a_en !== 0) { if ((write_data & 0xf0) !== 0x00) { address = write_data; write_fm_address = 1; } else write_fm_address = 0; }
  if (write_d_en !== 0 && (write_data & 0x100) === 0) {
    this.ModeWrite(wfma, write_data); this.Reload();
    ${lean ? `if (wfma === 0x21 || wfma === 0x2c) { if (write_a_en !== 0) wfma = write_data & 0x1ff; if (write_fm_data !== 0) data = write_data & 0xff;
      if (stt !== 0) stt--; if (since < 0x3fffffff) since++; ${c % 4 !== 3 && (c >> 2) !== 1 ? `PARTIAL${c}` : ''} STOREALL this.cycles = ${(c + 1) % 24}; this.channel = ${(c + 1) % 6}; return true; }` : ''}
  }
  if (write_a_en !== 0) wfma = write_data & 0x1ff;
}
if (write_fm_data !== 0) data = write_data & 0xff;
if (stt !== 0) stt--;
if (since < 0x3fffffff) since++;
${lean ? 'wdirty = (wdirty - 1) & ~((wdirty - 1) >> 31);' : ''}
`;
  return o;
}
const MODEV = ['t21_1', 't21_2', 't21_3', 't21_4', 't21_5', 'test_dac', 'ecust', 'konch', 'lfo_en', 'lfo_lc', 'mode_ch3', 'mode_csm', 'dacen', 'dacdata', 'timersOn'];
// every scalar of ym3438_t (plus the write queue and fast-path caches) lives in S too; [code name, field name]
const SCAL = ['cycles', 'channel', 'mol', 'mor', 'write_data', 'write_a', 'write_d', 'write_a_en', 'write_d_en', 'write_busy', 'write_busy_cnt',
  'write_fm_address', 'write_fm_data', ['wfma', 'write_fm_mode_a'], 'address', 'data', 'pin_test_in', 'pin_irq', 'busy',
  'lfo_en', 'lfo_freq', 'lfo_pm', 'lfo_am', 'lfo_cnt', 'lfo_inc', 'lfo_quotient', 'pg_fnum', 'pg_block', 'pg_kcode', 'pg_read',
  'eg_cycle', 'eg_cycle_stop', 'eg_shift', 'eg_shift_lock', 'eg_timer_low_lock', 'eg_timer', 'eg_timer_inc', 'eg_quotient',
  'eg_custom_timer', 'eg_rate', 'eg_ksv', 'eg_inc', 'eg_ratemax', 'eg_lfo_am', 'eg_read_inc', 'ch_lock', 'ch_lock_l', 'ch_lock_r', 'ch_read',
  'timer_a_cnt', 'timer_a_reg', 'timer_a_load_lock', 'timer_a_load', 'timer_a_enable', 'timer_a_reset', 'timer_a_load_latch',
  'timer_a_overflow_flag', 'timer_a_overflow', 'timer_b_cnt', ['tbsub', 'timer_b_subcnt'], 'timer_b_reg', 'timer_b_load_lock', 'timer_b_load',
  'timer_b_enable', 'timer_b_reset', 'timer_b_load_latch', 'timer_b_overflow_flag', 'timer_b_overflow',
  'mode_ch3', 'mode_kon_channel', 'mode_csm', ['konCsm', 'mode_kon_csm'], 'dacen', 'dacdata', 'reg_a4', 'reg_ac', 'status', ['stt', 'status_time'],
  'qh', 'qn', 'since', 'dacPend', 'dacState', 'dacVal', 'qpair', ['wdirty', 'k_wdirty'],
  ...MODEV.filter(v => !['lfo_en', 'mode_ch3', 'mode_csm', 'dacen', 'dacdata'].includes(v)).map(v => [v, 'k_' + v]),
  ['__k_lean', 'k_lean'], ['qact', 'k_qact'], ['sumL', 'k_sumL'], ['sumR', 'k_sumR'], ['di', 'k_di']].map(x => Array.isArray(x) ? x : [x, x]);
// code names whose cached k_ copy equals the live field
const ALIAS = { lfo_en: 'lfo_en', mode_ch3: 'mode_ch3', mode_csm: 'mode_csm', dacen: 'dacen', dacdata: 'dacdata' };
const SOFF = {}; let so = ARR_END;
for (const [, f] of SCAL) SOFF[f] = so++;
const STATE_LEN = so;
for (const [n, , l] of TAB) { OFF[n] = so; so += l; }
const S_TOTAL = so;
const CODE2F = Object.fromEntries(SCAL.map(([c, f]) => [c, f]));
// eg_sl0 etc. already live in S
const SLMAP = { eg_sl0: OFF.eg_sl, eg_sl1: OFF.eg_sl + 1, eg_tl0: OFF.eg_tl, eg_tl1: OFF.eg_tl + 1, eg_read0: OFF.eg_read, eg_read1: OFF.eg_read + 1 };
function scalarsToS(code) {
  const names = [...Object.keys(CODE2F), ...Object.keys(SLMAP)].sort((a, b) => b.length - a.length);
  const re = new RegExp('(?<![.\\w])(' + names.join('|') + ')(?![\\w])', 'g');
  return code.replace(re, (m) => `S[${m in SLMAP ? SLMAP[m] : SOFF[CODE2F[m]]}]`);
}
const G = +(process.argv[3] || 3), PER = 24 / G, GL = +(process.argv[4] || 3), PERL = 24 / GL;
// pin-sum of clocks 4k..c of a non-DAC window whose closed form had not been added yet (lean bail-out)
function partial(c) {
  const n = (c & 3) + 1, ym3438n = (c & 3);   // ym2612: n clocks of sign*3; ym3438: clocks 4k+1..c pass out
  return `{ let out = ch_lock; if (ym2612) { const nn = (out >> 31) + 1; let sign = (out >> 8) + nn; out += nn; sumL += ${3 * n} * sign; sumR += ${3 * n} * sign; }
  else { if (ch_lock_l !== 0) sumL += ${ym3438n} * out; if (ch_lock_r !== 0) sumR += ${ym3438n} * out; } }`;
}
const STOREALL = () => '';
let methods = '';
function emit(name, from, to, lean) {
  let code = '';
  for (let c = from; c < to; c++) code += body(c, lean);
  code = code.replace(/PARTIAL(\d+)/g, (_, c) => partial(+c)).replaceAll('STOREALL', '');
  code = scalarsToS(toS(code)).split('\n').map(l => l ? '    ' + l : l).join('\n');
  code = code.replaceAll('this.', 'self.');
  methods += `/** Clocks ${from}..${to - 1} of one output sample${lean ? ', no LSI test bits set (returns true if it bailed out)' : ''} (generated; see OPN2.render()). */
function ${name}(self, dbg, ym2612) {
  const qw = self.qw, qv = self.qv;
${code}
  return false;
}
`;
}
for (let g = 0; g < G; g++) emit(`_g${g}`, g * PER, (g + 1) * PER, false);
for (let g = 0; g < GL; g++) emit(`_l${g}`, g * PERL, (g + 1) * PERL, true);
const render = `  /**
   * Run n output samples (24 internal clocks each). L[off+i]/R[off+i] receive the sum of the 24 MOL/MOR pin
   * values of sample i. If dbg is given, every clock's MOL/MOR pair is also stored there (verification).
   * Fast path: OPN2_Clock unrolled over the 24 clock positions of one sample, each position's slot
   * indices, operator stage, output-enable phase and cycle-specific branches folded into constants,
   * all array state addressed in the single buffer S (generated code in _g*; verified bit-exact against
   * ym3438.c). Requires cycles === 0 at entry, which holds whenever the chip is only advanced by whole
   * samples; otherwise it falls back to clockQ().
   */
  render(L, R, n, dbg, off = 0) {
    if (this.cycles !== 0) { const b = this.buf; let di = 0; for (let i = 0; i < n; i++) { let l = 0, r = 0; for (let k = 0; k < 24; k++) { this.clockQ(b); l += b[0]; r += b[1]; if (dbg) { dbg[di++] = b[0]; dbg[di++] = b[1]; } } L[off + i] = l; R[off + i] = r; } return; }
    this.activate();
    const ym2612 = (this.chip_type & ym3438_mode_ym2612) !== 0;
    if (!dbg) dbg = null;
    this.Reload();
    this.k_qact = (this.qn !== 0 || this.dacPend >= 0 || this.dacState !== 0) ? 1 : 0;
    this.k_di = 0; this.k_wdirty = 25;   // re-apply the open register latch once after any outside activity
    for (let smp = 0; smp < n; smp++) {
      this.k_sumL = 0; this.k_sumR = 0;
      if (this.k_lean !== 0 && dbg === null) {
        if (${Array.from({ length: GL }, (_, g) => `_l${g}(this, null, ym2612)`).join(' || ')}) {
          // a test register was written mid-sample: finish this sample on the reference path
          const b = this.buf; let l = this.k_sumL, r = this.k_sumR;
          while (this.cycles !== 0) { this.clockQ(b); l += b[0]; r += b[1]; }
          this.k_sumL = l; this.k_sumR = r; this.Reload();
          this.k_qact = (this.qn !== 0 || this.dacPend >= 0 || this.dacState !== 0) ? 1 : 0;
        }
      } else {
${Array.from({ length: G }, (_, g) => `        _g${g}(this, dbg, ym2612);`).join('\n')}
      }
      L[off + smp] = this.k_sumL; R[off + smp] = this.k_sumR;
    }
    this.cycles = 0; this.channel = 0;
  }
`;
const layout = `// State layout of the Int32 buffer (generated with the fast path): [name, offset, length], then ROM table copies.
const LAYOUT = ${JSON.stringify(LAY.map(([n, l]) => [n, OFF[n], l]))};
${TAB.map(([n, k]) => `const ${k} = ${OFF[n]};`).join(' ')}
const STATE_LEN = ${STATE_LEN};   // per-slot arrays then scalars of ym3438_t (swapped per instance)
const S_SIZE = ${S_TOTAL};      // ... followed by the ROM tables
/* The live chip state. A module-level constant, so optimised code addresses it at fixed offsets with no
   bounds checks; each OPN2 instance keeps a private copy and swaps it in when it is used (activate()). */
const S = new Int32Array(S_SIZE);
S.set(logsinrom, T_LOGSIN); S.set(EXPT, T_EXPT); S.set(DTT, T_DTT); S.set(EG_STEPHI, T_STEPHI);
S.set(eg_am_shift, T_AMSHIFT); S.set(pg_lfo_sh1, T_SH1); S.set(pg_lfo_sh2, T_SH2);
let ACTIVE = null;
/** Named Int32 views into the state buffer (explicit stores keep the object in fast-property mode). */
function initViews(o, S) {
${LAY.map(([n, l]) => `  o.${n} = S.subarray(${OFF[n]}, ${OFF[n] + l});`).join('\n')}
}`;
const accessors = `  // Scalars of ym3438_t, stored in S (generated accessors; the reference code above uses them by name).
${SCAL.map(([, f]) => `  get ${f}() { return S[${SOFF[f]}]; }\n  set ${f}(v) { S[${SOFF[f]}] = v; }`).join('\n')}
`;
const file = process.argv[2];
let src = fs.readFileSync(file, 'utf8');
src = src.replace(/\/\/ <generated-layout>[\s\S]*?\/\/ <\/generated-layout>/, `// <generated-layout>\n${layout}\n// </generated-layout>`);
src = src.replace(/  \/\/ <generated-render>[\s\S]*?  \/\/ <\/generated-render>/, `  // <generated-render>\n${render}\n${accessors}  // </generated-render>`);
src = src.replace(/\/\/ <generated-groups>[\s\S]*?\/\/ <\/generated-groups>/, `// <generated-groups>\n${methods}// </generated-groups>`);
fs.writeFileSync(file, src);
console.log('G', G, 'GL', GL, 'lines', src.split('\n').length);
