// What's on the other end once the carrier is up: a tiny scripted BBS (or ISP login, or a caller),
// whose text is sent through the remote modem's data pump, so it really is modulated onto the line.
const CRLF = '\r\n';
const BANNERS = {
  'MEGAzine BBS': [
    '',
    '  __  __ ___ ___   _          _',
    ' |  \\/  | __/ __| /_\\  ___ (_)_ _  ___',
    " | |\\/| | _| (_ |/ _ \\|_ / | | ' \\/ -_)",
    ' |_|  |_|___\\___/_/ \\_\\/__||_|_||_\\___|  B B S',
    '',
    '      a paper zine with a phone number. node 1 of 1.',
  ],
};
const MENUS = {
  M: ['', 'MESSAGE BASES', '  1) General chatter        (412 msgs)', '  2) Weird works & zines    (87 msgs)', '  3) Synths & noise         (203 msgs)', 'No new mail. The sysop is probably asleep.'],
  F: ['', 'FILE AREAS', '  1) ANSI art     2) Trackers & MODs     3) Text files', 'Ratio 1:4. Upload something weird first.'],
  D: ['', 'DOOR GAMES', '  1) Legend of the Red Modem   2) Trade Lanes 2001   3) Usurper of Baud', 'All doors are closed for maintenance. Again.'],
  W: ['', "WHO'S ONLINE", '  Node 1  you          Calling from: a 555 number'],
};

export function farSession({ kind, name, conn, local = 'caller' }, send, hangup) {
  let stage = 0, handle = '';
  const speed = conn ? conn.rate : 0;
  const out = (lines) => send((Array.isArray(lines) ? lines.join(CRLF) : lines) + CRLF);
  if (local === 'answerer') {               // someone dialled into us
    setTimeout(() => out(['', 'Hello? Is this the BBS? I saw the number in a zine.']), 600);
    return { input(line) { out(line.length ? `> ${line}` : '>'); if (/bye|ath|quit/i.test(line)) { out('ok bye!'); hangup(); } else setTimeout(() => out('...cool. how do I download stuff?'), 900); }, stop() {} };
  }
  if (/56K|ISP|digital/i.test(name || '') || kind === 'server') {
    out(['', 'LoopNet Internet Services - terminal server ts3', '', 'login: ']);
    return { input(line) {
      if (stage === 0) { stage = 1; send(line + CRLF + 'Password: '); }
      else if (stage === 1) { stage = 2; out(['', 'Starting PPP... (your dialer would take over now)', '~\x7d#\xc0!\x7d!\x7d!\x7d \x7d4\x7d"\x7d&\x7d \x7d*\x7d \x7d \x7d%\x7d&~']); setTimeout(() => { out('Idle timeout.'); hangup(); }, 6000); }
    }, stop() {} };
  }
  const title = name || 'a BBS';
  out([...(BANNERS[name] || ['', `  *** ${title.toUpperCase()} ***`, '  running since the 300 baud days']), '', `CONNECT ${speed} - welcome, caller.`, '', 'Enter your handle (or NEW): ']);
  return {
    input(line) {
      const l = line.trim();
      if (stage === 0) { handle = l || 'GUEST'; stage = 1; send(line + CRLF + 'Password: '); return; }
      if (stage === 1) { stage = 2; send('*'.repeat(line.length) + CRLF); out(['', `Welcome back, ${handle}. Last call: a while ago.`, '', '[M]essages  [F]iles  [D]oors  [W]ho  [G]oodbye', 'Command: ']); return; }
      const k = l.toUpperCase()[0] || '';
      if (k === 'G') { out([l, '', `Thanks for calling ${title}, ${handle}. Keep it weird.`, '']); hangup(); return; }
      out([l, ...(MENUS[k] || ['', 'Huh? Try M, F, D, W or G.']), '', '[M]essages  [F]iles  [D]oors  [W]ho  [G]oodbye', 'Command: ']);
    },
    stop() {},
  };
}
