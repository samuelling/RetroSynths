// "Blasta Theme" — an original General MIDI demo tune written for this project.
// Returns the same shape as parseSMF(): { title, events: [[sec, status, d1, d2]], duration }.

export function demoSong() {
  const BPM = 116, beat = 60 / BPM, bar = beat * 4, e8 = beat / 2, s16 = beat / 4;
  const ev = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const on = (t, ch, n, v, d) => {
    const tt = Math.max(0.002, t + (ch === 9 ? 0 : (rnd() - 0.5) * 0.006));   // never before the t=0 program changes
    ev.push([tt, 0x90 | ch, n, Math.max(1, Math.min(127, Math.round(v + (rnd() - 0.5) * 10)))]);
    ev.push([tt + d, 0x80 | ch, n, 0]);
  };
  const cc = (t, ch, c, v) => ev.push([t, 0xB0 | ch, c, v]);
  const pc = (t, ch, p) => ev.push([t, 0xC0 | ch, p, 0]);

  // channel setup
  const setup = [
    // ch, program, vol, pan, reverb, chorus
    [0, 81, 84, 60, 50, 10],   // saw lead
    [1, 33, 104, 64, 20, 0],   // finger bass
    [2, 4, 74, 44, 50, 30],    // electric piano
    [3, 48, 70, 84, 70, 20],   // strings
    [4, 46, 78, 92, 60, 0],    // harp
    [5, 73, 86, 52, 60, 0],    // flute
    [6, 11, 72, 76, 60, 0],    // vibes
    [9, 0, 100, 64, 40, 0],    // drums
  ];
  for (const [ch, p, v, pan, rv, co] of setup) {
    cc(0, ch, 121, 0); pc(0, ch, p); cc(0, ch, 7, v); cc(0, ch, 10, pan); cc(0, ch, 91, rv); cc(0, ch, 93, co);
  }

  const CH = {
    Am: [57, 60, 64], F: [53, 57, 60], C: [55, 60, 64], G: [55, 59, 62], Dm: [57, 62, 65], E: [56, 59, 64], Em: [55, 59, 64],
  };
  const ROOT = { Am: 45, F: 41, C: 48, G: 43, Dm: 38, E: 40, Em: 40 };
  const progA = ['Am', 'F', 'C', 'G', 'Am', 'F', 'Dm', 'E'];
  const progB = ['F', 'G', 'Em', 'Am', 'Dm', 'G', 'C', 'E'];
  const melA = [
    [[76, 2], [69, 1], [72, 1], [76, 2], [74, 1], [72, 1]],
    [[72, 3], [69, 1], [65, 2], [69, 2]],
    [[67, 2], [72, 1], [76, 1], [79, 2], [76, 1], [74, 1]],
    [[74, 6], [71, 1], [74, 1]],
    [[76, 2], [69, 1], [72, 1], [76, 2], [79, 1], [81, 1]],
    [[77, 3], [76, 1], [72, 2], [69, 2]],
    [[74, 2], [77, 1], [76, 1], [74, 2], [72, 1], [71, 1]],
    [[71, 4], [68, 2], [71, 2]],
  ];
  const melB = [
    [[72, 1], [69, 1], [72, 1], [77, 3], [76, 1], [74, 1]],
    [[74, 1], [71, 1], [74, 1], [79, 3], [77, 1], [76, 1]],
    [[76, 2], [71, 2], [67, 2], [71, 2]],
    [[72, 6], [0, 2]],
    [[74, 1], [69, 1], [74, 1], [77, 3], [76, 1], [74, 1]],
    [[79, 2], [77, 1], [76, 1], [74, 2], [71, 2]],
    [[72, 2], [76, 2], [79, 2], [84, 2]],
    [[83, 6], [80, 2]],
  ];

  const melody = (t0, m, ch, vel, oct = 0, legato = 0.92) => {
    let t = t0;
    for (const [n, d] of m) { if (n) on(t, ch, n + oct, vel, d * e8 * legato); t += d * e8; }
  };
  const strings = (t, c, len = bar) => { for (const n of CH[c]) on(t, 3, n, 62, len * 0.98); };
  const harp = (t, c, vel = 70) => {
    const tones = CH[c], seq = [0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 2, 3, 4, 5];
    for (let i = 0; i < 16; i++) { const k = seq[i]; on(t + i * s16, 4, tones[k % 3] + 12 * Math.floor(k / 3) + 12, vel - (i % 4 ? 12 : 0), s16 * 1.8); }
  };
  const bass = (t, c) => {
    const r = ROOT[c], pat = [0, 12, 0, 12, 0, 12, 7, 12];
    for (let i = 0; i < 8; i++) on(t + i * e8, 1, r + pat[i], i % 2 ? 84 : 104, e8 * 0.8);
  };
  const ep = (t, c) => { for (const k of [1, 3, 5, 7]) for (const n of CH[c]) on(t + k * e8, 2, n + 12, 70, e8 * 0.7); };
  const drums = (t, i, fill, crash) => {
    if (crash) on(t, 9, 49, 100, 1);
    for (let s = 0; s < 16; s++) {
      const ts = t + s * s16;
      if (s === 0 || s === 8 || s === 10) on(ts, 9, 36, s === 0 ? 112 : 96, 0.1);
      if (!fill || s < 12) { if (s === 4 || s === 12) on(ts, 9, 38, 106, 0.1); }
      if (s % 2 === 0 && !(fill && s >= 12)) on(ts, 9, (i % 4 === 3 && s === 14) ? 46 : 42, s % 4 ? 70 : 92, 0.05);
    }
    if (fill) {
      const toms = [50, 48, 47, 45];
      for (let s = 12; s < 16; s++) on(t + s * s16, 9, toms[s - 12], 100, 0.1);
      on(t + 12 * s16, 9, 38, 96, 0.1); on(t + 14 * s16, 9, 38, 90, 0.1);
    }
  };

  let t = 0;
  // Intro: 4 bars, strings + harp, drum fill into A
  ['Am', 'F', 'C', 'G'].forEach((c, i) => {
    strings(t, c); harp(t, c);
    on(t, 1, ROOT[c], 90, bar * 0.95);
    if (i === 3) drums(t + bar / 2, 3, true, false);
    t += bar;
  });
  const sectionA = (lead) => {
    progA.forEach((c, i) => {
      strings(t, c); bass(t, c); ep(t, c);
      drums(t, i, i === 7, i === 0);
      melody(t, melA[i], 0, 100);
      if (lead === 2) melody(t, melA[i], 5, 72, 12, 0.85);
      t += bar;
    });
  };
  const sectionB = () => {
    progB.forEach((c, i) => {
      strings(t, c); bass(t, c); harp(t, c, 64);
      drums(t, i, i === 7, i === 0);
      melody(t, melB[i], 5, 96);
      melody(t, melB[i], 6, 78, 0, 0.6);
      t += bar;
    });
  };
  sectionA(1);
  sectionB();
  sectionA(2);
  // Outro
  on(t, 9, 49, 110, 2); on(t, 9, 36, 110, 0.2);
  for (const n of CH.Am) { on(t, 3, n, 70, bar * 2); on(t, 2, n + 12, 76, bar * 2); }
  on(t, 1, 33, 100, bar * 2); on(t, 0, 81, 96, bar * 2); on(t, 5, 69, 80, bar * 2);
  harp(t, 'Am', 60);
  t += bar * 2;

  ev.sort((a, b) => a[0] - b[0]);
  return { title: 'Blasta Theme (demo)', events: ev, duration: t + 2 };
}
