// Modem models (invented brands, described by era and protocol), the phone network regions,
// and the fake dialing directory. Pure data: used by the UI, the AT interpreter and the worklet.

// protocol keys, fastest first
export const PROTOS = ['V90', 'P56X', 'P56F', 'V34', 'V32bis', 'V32', 'V22bis', 'V22', 'B212A', 'B103', 'V21'];
export const PROTO_NAME = {
  V90: 'V.90', P56X: '56K pre-standard (Rival-X)', P56F: '56K pre-standard (Rival-F)', V34: 'V.34', V32bis: 'V.32bis', V32: 'V.32',
  V22bis: 'V.22bis', V22: 'V.22', B212A: 'Bell 212A', B103: 'Bell 103', V21: 'V.21',
};
export const PROTO_MAX = { V90: 56000, P56X: 56000, P56F: 56000, V34: 33600, V32bis: 14400, V32: 9600, V22bis: 2400, V22: 1200, B212A: 1200, B103: 300, V21: 300 };

const ALL = (top) => PROTOS.slice(PROTOS.indexOf(top)).filter(p => !(top === 'V90' && (p === 'P56X' || p === 'P56F')));

/** speaker/character presets */
const SPK = {
  coupler: { hp: 350, res: 1050, resQ: 1.4, resGain: 7, lp: 2300, drive: 1.6, acoustic: true },
  tin:     { hp: 520, res: 2600, resQ: 2.2, resGain: 9, lp: 3500, drive: 2.4 },
  small:   { hp: 450, res: 2900, resQ: 1.8, resGain: 7, lp: 3600, drive: 1.8 },
  piezo:   { hp: 700, res: 3200, resQ: 3.0, resGain: 10, lp: 3700, drive: 1.4 },
  cone:    { hp: 300, res: 1800, resQ: 1.1, resGain: 4, lp: 3600, drive: 1.2 },
};

/**
 * caps: protocols supported; ec / comp: error control & compression; bell: factory B1 (Bell) default.
 * ch: audible character — tx level (dBm0), relay type, speaker, timing personality.
 */
export const MODELS = [
  { id: 'coupler300', name: 'Telecat AC-300', year: 1978, kind: 'Acoustic coupler',
    blurb: '300 bps acoustic coupler · Bell 103 FSK (originate 1070/1270 Hz, answer 2025/2225 Hz). Dialled by hand on a rotary phone.',
    caps: ['B103'], ec: [], comp: [], bell: true, dte: 300, init: 'ATE1V1X0M2', rotary: true,
    plate: { bg: 'linear-gradient(#e9dfc6,#cdbf9c)', fg: '#3a2a14', stripe: '#a0522d', chip: 'FSK 103' },
    ch: { tx: -14, relay: 'handset', spk: SPK.coupler, billing: 1.6, dtDetect: 1.4, pdd: 2.4, hiss: 6 },
    ati: ['300', '028', 'OK', 'TELECAT AC-300 REV B', 'BELL 103 ORIGINATE/ANSWER', '001', 'DISCRETE FSK', 'ACOUSTIC'] },
  { id: 'coupler300e', name: 'Telecat AC-300E', year: 1979, kind: 'Acoustic coupler',
    blurb: '300 bps acoustic coupler · CCITT V.21 FSK (channel 1: 980/1180 Hz, channel 2: 1650/1850 Hz). European sibling.',
    caps: ['V21'], ec: [], comp: [], bell: false, dte: 300, init: 'ATB0E1V1X0M2', rotary: true,
    plate: { bg: 'linear-gradient(#dcd6c8,#bdb4a0)', fg: '#2a2a2a', stripe: '#2f5f8f', chip: 'FSK V.21' },
    ch: { tx: -14, relay: 'handset', spk: SPK.coupler, billing: 2.0, dtDetect: 1.4, pdd: 2.8, hiss: 6 },
    ati: ['300', '031', 'OK', 'TELECAT AC-300E REV A', 'CCITT V.21', '044', 'DISCRETE FSK', 'ACOUSTIC'] },
  { id: 'smart1200', name: 'Hayseed SmartLink 1200', year: 1982, kind: 'External 1200',
    blurb: '1200 bps · Bell 212A DPSK (600 baud, 1200/2400 Hz carriers, answer tone 2225 Hz) with Bell 103 fallback.',
    caps: ['B212A', 'B103'], ec: [], comp: [], bell: true, dte: 1200, init: 'ATZE1V1X1M1',
    plate: { bg: 'linear-gradient(#cfcfcf,#a9a9a9)', fg: '#111', stripe: '#c0392b', chip: 'DPSK 212A' },
    ch: { tx: -10, relay: 'clunk', spk: SPK.tin, billing: 2.0, dtDetect: 2.0, pdd: 2.0 },
    ati: ['122', '094', 'OK', 'SMARTLINK 1200 V1.2', 'BELL 212A/103', '001', 'DISCRETE', 'EXTERNAL'] },
  { id: 'smart1200e', name: 'Hayseed SmartLink 1200E', year: 1984, kind: 'External 1200',
    blurb: '1200 bps · CCITT V.22 DPSK with 2100 Hz answer tone and the 2250 Hz "unscrambled ones" handshake; V.21 fallback.',
    caps: ['V22', 'V21'], ec: [], comp: [], bell: false, dte: 1200, init: 'ATZB0E1V1X1M1',
    plate: { bg: 'linear-gradient(#d6d6d6,#ababab)', fg: '#111', stripe: '#2f5f8f', chip: 'DPSK V.22' },
    ch: { tx: -10, relay: 'clunk', spk: SPK.tin, billing: 2.2, dtDetect: 2.0, pdd: 2.6 },
    ati: ['123', '101', 'OK', 'SMARTLINK 1200E V1.4', 'CCITT V.22/V.21', '044', 'DISCRETE', 'EXTERNAL'] },
  { id: 'q2400', name: 'Quadrant 2400', year: 1987, kind: 'External 2400',
    blurb: '2400 bps · V.22bis 16-QAM at 600 baud, S1 rate signal, Bell/CCITT 1200 and 300 fallback, MNP 5.',
    caps: ALL('V22bis'), ec: ['MNP'], comp: ['MNP5'], bell: true, dte: 2400, init: 'AT&FE1V1X4&C1&D2',
    plate: { bg: 'linear-gradient(#2b2b2b,#141414)', fg: '#ddd', stripe: 'linear-gradient(90deg,#d35400,#f1c40f)', chip: 'QAM V.22b' },
    ch: { tx: -10, relay: 'clunk', spk: SPK.small, billing: 2.0, dtDetect: 1.2, pdd: 2.2 },
    ati: ['247', '163', 'OK', 'QUADRANT 2400 FW 2.11', 'V.22BIS MNP5', '001', 'R2424 PUMP', 'EXTERNAL'] },
  { id: 't9600', name: 'Trellis 9600', year: 1990, kind: 'External 9600',
    blurb: '9600 bps · V.32 echo-cancelling QAM at 2400 baud on 1800 Hz: AA/AC/CA/CC, S, TRN with the x^-18/x^-23 scramblers. V.42/V.42bis.',
    caps: ALL('V32'), ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true, dte: 38400, init: 'AT&FE1V1X4&C1&D2&K3\\N3%C1',
    plate: { bg: 'linear-gradient(#efefea,#cfcfc6)', fg: '#222', stripe: '#16a085', chip: 'V.32 TCM' },
    ch: { tx: -10, relay: 'tick', spk: SPK.small, billing: 2.0, dtDetect: 1.0, pdd: 2.0, trn32: 1536 },
    ati: ['9600', '214', 'OK', 'TRELLIS 9600 V3.02', 'V.32 V.42BIS MNP5', '001', 'DSP 9632', 'EXTERNAL'] },
  { id: 'f144', name: 'FastLane 14.4', year: 1993, kind: 'Fax/Data 14.4',
    blurb: '14,400 bps · V.32bis (128-point TCM in the real thing) with automode fallback, V.42bis, Class 1 fax.',
    caps: ALL('V32bis'), ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true, dte: 57600, fax: true, init: 'AT&F1E1V1X4&C1&D2&K3S0=0W2',
    plate: { bg: 'linear-gradient(#3a3a3a,#1c1c1c)', fg: '#eee', stripe: 'linear-gradient(90deg,#c0392b,#e67e22)', chip: 'V.32bis' },
    ch: { tx: -10, relay: 'tick', spk: SPK.small, billing: 2.0, dtDetect: 0.9, pdd: 2.0, trn32: 1280 },
    ati: ['14400', '255', 'OK', 'FASTLANE 14.4 FAX/DATA REV 1.8', 'V.32BIS V.42BIS FAX CLASS 1', '001', 'RCV144DPi', 'EXTERNAL'] },
  { id: 'r288', name: 'Ridgeline 28.8', year: 1995, kind: 'V.34 28.8',
    blurb: '28,800 bps · V.34: V.8 (ANSam, CM/JM/CJ), INFO0 DPSK, L1/L2 line probe, phase 3/4 training. The iconic dial-up sound.',
    caps: ALL('V34'), ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true, dte: 115200, fax: true, maxRate: 28800,
    init: 'AT&FE1V1X4&C1&D2&K3%C1\\N3+MS=11,1,300,28800',
    plate: { bg: 'linear-gradient(#f2f2f2,#d0d0d0)', fg: '#1b2a4a', stripe: 'linear-gradient(90deg,#1b2a4a,#3e6eb4)', chip: 'V.34 DSP' },
    ch: { tx: -11, relay: 'tick', spk: SPK.piezo, billing: 1.9, dtDetect: 0.8, pdd: 2.0, trn34: 2048 },
    ati: ['28800', '052', 'OK', 'RIDGELINE 28.8 V.34 1.02', 'V.34 V.42BIS V.17 FAX', '001', 'V34 DP 1.0', 'INTERNAL ISA'] },
  { id: 'r336', name: 'Ridgeline 33.6', year: 1996, kind: 'V.34+ 33.6',
    blurb: '33,600 bps · V.34 at up to 3429 baud (carrier 1959 Hz). S95 extended result codes (CARRIER / PROTOCOL / COMPRESSION lines).',
    caps: ALL('V34'), ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true, dte: 115200, fax: true, maxRate: 33600,
    init: 'AT&FE1V1X4&C1&D2&K3S95=44',
    plate: { bg: 'linear-gradient(#f5f5f0,#d6d6cc)', fg: '#1b2a4a', stripe: 'linear-gradient(90deg,#7d3c98,#3e6eb4)', chip: 'V.34+' },
    ch: { tx: -11, relay: 'tick', spk: SPK.piezo, billing: 1.9, dtDetect: 0.8, pdd: 2.0, trn34: 1536 },
    ati: ['33600', '077', 'OK', 'RIDGELINE 33.6 V.34+ 2.10', 'V.34+ V.42BIS V.17 FAX VOICE', '001', 'V34+ DP 2.1', 'INTERNAL ISA'] },
  { id: 'x56', name: 'Kestrel X-56', year: 1997, kind: '56K pre-standard',
    blurb: '56K, pre-standard "Rival-X" camp (late 1997): V.8, then its own digital training. Only talks 56K to a Rival-X server; otherwise V.34.',
    caps: ['P56X', ...ALL('V34')], ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true, dte: 115200, fax: true,
    init: 'AT&FE1V1X4&C1&D2&K3S32=34',
    plate: { bg: 'linear-gradient(#1f1f1f,#050505)', fg: '#f1c40f', stripe: 'linear-gradient(90deg,#f1c40f,#e74c3c)', chip: 'RIVAL-X' },
    ch: { tx: -11, relay: 'tick', spk: SPK.piezo, billing: 1.9, dtDetect: 0.8, pdd: 2.0, trn34: 1536 },
    ati: ['5601', '118', 'OK', 'KESTREL X-56 PRE-STD 1.4', 'RIVAL-X 56K V.34+ V.42BIS', '001', 'XDSP 56', 'EXTERNAL'] },
  { id: 'f56', name: 'Flexion 56', year: 1997, kind: '56K pre-standard',
    blurb: '56K, pre-standard "Rival-F" camp (late 1997): its own PCM training, rates in 2,000 bps steps. Falls back to V.34 elsewhere.',
    caps: ['P56F', ...ALL('V34')], ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true, dte: 115200, fax: true,
    init: 'AT&FE1V1X4&C1&D2&K3+MS=56',
    plate: { bg: 'linear-gradient(#e8eef5,#b9c7d8)', fg: '#0b2545', stripe: 'linear-gradient(90deg,#13315c,#8da9c4)', chip: 'RIVAL-F' },
    ch: { tx: -11, relay: 'tick', spk: SPK.cone, billing: 1.9, dtDetect: 0.8, pdd: 2.0, trn34: 1536 },
    ati: ['5602', '133', 'OK', 'FLEXION 56 PRE-STD 1.1', 'RIVAL-F 56K V.34+ V.42BIS', '001', 'FLEX PUMP', 'PCMCIA'] },
  { id: 'm56', name: 'Mach 56', year: 1998, kind: 'V.90 56K',
    blurb: '56K · V.90: a V.34-style front end, then DIL (digital impairment learning) and PCM training from the ISP\'s digital modem.',
    caps: ALL('V90'), ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true, dte: 115200, fax: true,
    init: 'AT&FE1V1X4&C1&D2&K3+MS=V90',
    plate: { bg: 'linear-gradient(#20242c,#0d0f13)', fg: '#7fdbff', stripe: 'linear-gradient(90deg,#0074d9,#7fdbff)', chip: 'V.90 PCM' },
    ch: { tx: -11, relay: 'tick', spk: SPK.piezo, billing: 1.9, dtDetect: 0.7, pdd: 2.0, trn34: 1536 },
    ati: ['56000', '090', 'OK', 'MACH 56 V.90 3.4.1', 'V.90 V.34+ V.42BIS FAX VOICE', '001', 'V90 SOFT PUMP', 'PCI'] },
];
/** answering-only equipment: ISP digital servers (needed for 56K: one end must be on a digital trunk) */
export const SERVERS = [
  { id: 'srv90', name: 'ISP V.90 digital server', digital: true, caps: ALL('V90'), ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true,
    ch: { tx: -12, relay: 'none', billing: 0.9, trn34: 1024 } },
  { id: 'srvx', name: 'ISP Rival-X digital server', digital: true, caps: ['P56X', ...ALL('V34')], ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true,
    ch: { tx: -12, relay: 'none', billing: 0.9, trn34: 1024 } },
  { id: 'srvf', name: 'ISP Rival-F digital server', digital: true, caps: ['P56F', ...ALL('V34')], ec: ['LAPM', 'MNP'], comp: ['V42BIS', 'MNP5'], bell: true,
    ch: { tx: -12, relay: 'none', billing: 0.9, trn34: 1024 } },
];
export const modelById = (id) => MODELS.find(m => m.id === id) || SERVERS.find(m => m.id === id) || MODELS[0];

/** call-progress tones and line conventions */
export const REGIONS = {
  na: { name: 'North America', codec: 'mu', hum: 60,
    dial: { f: [350, 440], db: -13 }, ring: { f: [440, 480], db: -19, pat: [2, 4] },
    busy: { f: [480, 620], db: -24, pat: [0.5, 0.5] }, reorder: { f: [480, 620], db: -24, pat: [0.25, 0.25] },
    pulse: { brk: 60, mk: 40 }, ringIn: [2, 4], guard: 0 },
  uk: { name: 'United Kingdom', codec: 'a', hum: 50,
    dial: { f: [350, 450], db: -13 }, ring: { f: [400, 450], db: -19, pat: [0.4, 0.2, 0.4, 2.0] },
    busy: { f: [400], db: -20, pat: [0.375, 0.375] }, reorder: { f: [400], db: -20, pat: [10, 0] },
    pulse: { brk: 67, mk: 33 }, ringIn: [0.4, 0.2, 0.4, 2.0], guard: 2 },
  eu: { name: 'Europe (CEPT)', codec: 'a', hum: 50,
    dial: { f: [425], db: -13 }, ring: { f: [425], db: -19, pat: [1, 4] },
    busy: { f: [425], db: -20, pat: [0.5, 0.5] }, reorder: { f: [425], db: -20, pat: [0.25, 0.25] },
    pulse: { brk: 60, mk: 40 }, ringIn: [1, 4], guard: 0 },
};

/** what can be on the other end */
export const ANSWER_KINDS = [
  ...MODELS.map(m => ({ value: 'modem:' + m.id, label: `${m.name} (${m.kind})` })),
  ...SERVERS.map(m => ({ value: 'modem:' + m.id, label: m.name })),
  { value: 'busy', label: 'Busy signal' },
  { value: 'noanswer', label: 'No answer (rings forever)' },
  { value: 'person', label: 'A person ("hello?")' },
  { value: 'fax', label: 'Fax machine (CED, V.21 DIS)' },
  { value: 'intercept', label: 'Not in service (SIT intercept)' },
];

/** the dialing directory: fictional 555-01xx numbers */
export const PHONEBOOK = [
  { name: 'The Rusty Coupler', number: '555-0101', answer: 'modem:coupler300', rings: 2, note: '300 baud, est. 1979' },
  { name: 'Euro Teletext Gateway', number: '555-0107', answer: 'modem:coupler300e', rings: 1, note: 'V.21' },
  { name: 'Bitstream Exchange', number: '555-0112', answer: 'modem:smart1200', rings: 2, note: '1200, Bell' },
  { name: 'Echo Hub 18', number: '555-0118', answer: 'modem:q2400', rings: 1, note: '2400, MNP' },
  { name: 'Trellis Gardens', number: '555-0123', answer: 'modem:t9600', rings: 1, note: '9600 V.32' },
  { name: 'Night Owl\'s Roost', number: '555-0133', answer: 'modem:f144', rings: 2, note: '14.4 V.32bis' },
  { name: 'MEGAzine BBS', number: '555-0142', answer: 'modem:r336', rings: 1, note: '33.6 V.34' },
  { name: 'Cyberia Online', number: '555-0150', answer: 'modem:r288', rings: 1, note: '28.8 V.34' },
  { name: 'LoopNet Internet 56K', number: '555-0156', answer: 'modem:srv90', rings: 1, note: 'ISP, V.90 digital' },
  { name: 'Busy Signal Bistro', number: '555-0167', answer: 'busy', rings: 0, note: 'always busy' },
  { name: 'The Endless Ring', number: '555-0175', answer: 'noanswer', rings: 0, note: 'nobody home' },
  { name: 'Copy Shop Fax', number: '555-0181', answer: 'fax', rings: 1, note: 'Group 3 fax' },
  { name: 'Wrong Number', number: '555-0190', answer: 'person', rings: 3, note: 'voice line' },
];

/** S-register defaults (factory) */
export const S_DEFAULTS = { 0: 0, 1: 0, 2: 43, 3: 13, 4: 10, 5: 8, 6: 2, 7: 50, 8: 2, 9: 6, 10: 14, 11: 95, 12: 50, 18: 0, 25: 5, 26: 1, 36: 7, 37: 0, 38: 20, 95: 0 };
