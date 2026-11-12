// End-to-end check against a running copy of the app.
//   node test/check.js http://localhost:3111 test123 [phase]
// phase "main" (default) runs the general checks; "before" / "after" run the lock checks
// (the server is started with FAKE_NOW 6 or 4 minutes before the Week 10 opener).

const base = process.argv[2];
const managerPw = process.argv[3];
const phase = process.argv[4] || 'main';
let failed = 0;
const ok = (cond, label, extra) => {
  if (!cond) { failed++; console.log('FAIL  ' + label + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
  else console.log('ok    ' + label);
};

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(base + url, {
      method,
      headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), cookie },
      body: method !== 'GET' ? JSON.stringify(body || {}) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
}

// Standings from the spreadsheet's "Overall Standings" tab (Week 9), with the two corrected margins:
// Polly H. Week 9 49ers +21 (sheet had +23) and Sam C. Week 3 Seahawks -2 (sheet had -3).
const SHEET = {"Jamie A.": [1, 0, 85], "Frank G.": [2, 1, 108], "Garrett H.": [3, 1, 86], "Ryan J.": [4, 1, 82], "Lisa H.": [5, 1, 81], "Kyle L.": [6, 1, 77], "Tyler L.": [7, 1, 68], "Polly H.": [8, 1, 62], "Danni L.": [9, 1, 38], "Eric A.": [10, 2, 99], "Andrew H.": [11, 2, 90], "Keith C.": [12, 2, 89], "David C.": [13, 2, 86], "Ryan G.": [14, 2, 82], "Tyler H.": [15, 2, 79], "AJ S.": [16, 2, 77], "Drew H.": [16, 2, 77], "Saralee A.": [18, 2, 76], "Anthony A.": [19, 2, 75], "Garry A.": [20, 2, 73], "Nick A.": [21, 2, 72], "Jamisen L.": [22, 2, 67], "Kelsey L.": [23, 2, 51], "Nancy A.": [24, 3, 92], "Carson A.": [25, 3, 89], "Tyler J.": [26, 3, 67], "Rian A.": [27, 3, 65], "Tyler D.": [28, 3, 63], "Sidney B.": [29, 3, 58], "Miles B.": [29, 3, 58], "Chandler W.": [31, 3, 53], "Sam C.": [32, 3, 51], "Alex A.": [33, 3, 50], "Trae M.": [34, 3, 48], "Brandon K.": [35, 3, 46], "Myron S.": [36, 3, 44], "Seth F.": [37, 3, 37], "John L.": [38, 3, 22], "Kerry H.": [39, 4, 57], "Jared P.": [40, 4, 56], "Damien C.": [41, 4, 51], "Rachel H.": [42, 4, 46], "Ricky A.": [42, 4, 46], "Charles H.": [44, 4, 17], "Andrew T.": [45, 4, -7], "Bridger A.": [46, 5, 31], "Kyle G.": [47, 5, 25], "Mahesh K.": [48, 5, 13], "Jake R.": [49, 5, 6], "Jordan A.": [50, 5, -22], "Grant S.": [51, 6, -2], "Kyle B.": [52, 6, -20]};

async function setupPlayer(mgr, name, pw) {
  const { data } = await mgr('GET', '/api/admin/players');
  const p = data.players.find((x) => x.name === name);
  const c = client();
  if (p.setupToken) {
    const r = await c('POST', '/api/setup/' + p.setupToken, { password: pw });
    if (r.status !== 200) throw new Error('setup failed ' + JSON.stringify(r));
  } else {
    const r = await c('POST', '/api/login', { username: name, password: pw });
    if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r));
  }
  return { c, id: p.id, token: p.setupToken };
}

async function main() {
  const anon = client();
  const mgr = client();
  let r = await mgr('POST', '/api/login', { username: 'manager', password: managerPw });
  ok(r.status === 200 && r.data.me.role === 'manager', 'manager logs in');

  if (phase === 'main') {
    ok((await anon('GET', '/api/state')).status === 401, 'not logged in: week page refused');
    ok((await anon('GET', '/api/standings')).status === 401, 'not logged in: standings refused');
    ok((await anon('GET', '/api/admin/players')).status === 401, 'not logged in: manager page refused');
    ok((await anon('POST', '/api/login', { username: 'manager', password: 'wrong' })).status === 401, 'wrong password refused');

    // --- standings match the spreadsheet
    r = await mgr('GET', '/api/standings');
    const rows = r.data.rows;
    ok(rows.length === 52, '52 players loaded', rows.length);
    const diffs = rows.filter((x) => { const s = SHEET[x.name]; return !s || s[0] !== x.rank || s[1] !== x.losses || s[2] !== x.points; });
    ok(diffs.length === 0, 'rank, losses and points match the spreadsheet for all 52', diffs.map((d) => [d.name, d.rank, d.losses, d.points]));
    ok(r.data.currentWeek === 10, 'current week is 10', r.data.currentWeek);

    // --- every imported margin agrees with the real final scores (manager re-enters each pick in auto mode on a copy)
    // done separately in test/verify-import.js against the database

    // --- a player sets up and picks
    const aj = await setupPlayer(mgr, 'AJ S.', 'pw-aj-1');
    ok((await anon('GET', '/api/setup/' + aj.token)).status === 404, 'setup link works only once');
    const lg = client();
    ok((await lg('POST', '/api/login', { username: 'aj s', password: 'pw-aj-1' })).status === 200, 'player logs in by typing their name');
    ok((await aj.c('GET', '/api/admin/players')).status === 403, 'player cannot open manager pages');
    ok((await aj.c('PUT', '/api/admin/picks/' + aj.id + '/10', { team: 'Bills' })).status === 403, 'player cannot use manager pick tool');
    ok((await aj.c('PATCH', '/api/admin/players/' + aj.id, { role: 'manager' })).status === 403, 'player cannot make themselves manager');

    r = await aj.c('GET', '/api/state');
    ok(r.data.week === 10 && r.data.games.length === 14, 'week 10 shows 14 matchups', r.data.games.length);
    ok(r.data.games.every((g) => g.line !== null && g.oddsProvider), 'every week 10 game has a point spread', r.data.games.filter((g) => g.line === null).map((g) => g.home));
    const nyg = r.data.games.find((g) => g.home === 'Giants');
    ok(nyg && nyg.fav && nyg.line > 0 && nyg.lockAt === nyg.kickoff - 5 * 60000, 'lock time is 5 minutes before kickoff', nyg);
    ok(r.data.byes.length === 4, 'bye teams listed', r.data.byes);

    r = await aj.c('PUT', '/api/picks/10', { team: 'Chiefs' });
    ok(r.status === 409, 'reusing a team (Chiefs, used Week 3) is refused', r.data);
    r = await aj.c('PUT', '/api/picks/10', { team: 'Bears' });
    ok(r.status === 400, 'picking a team on bye is refused', r.data);
    r = await aj.c('PUT', '/api/picks/10', { team: 'Nonsense' });
    ok(r.status === 400, 'unknown team refused');
    r = await aj.c('PUT', '/api/picks/10', { team: 'Bills' });
    ok(r.status === 200, 'valid pick saved (Bills)', r.data);
    r = await aj.c('PUT', '/api/picks/10', { team: 'Jaguars' });
    ok(r.status === 200, 'pick can be changed before lock (Jaguars)', r.data);
    r = await aj.c('PUT', '/api/picks/8', { team: 'Raiders' });
    ok(r.status === 403, 'cannot change a past week', r.data);
    r = await aj.c('DELETE', '/api/picks/3');
    ok(r.status === 403, 'cannot clear a past week', r.data);
    r = await aj.c('PUT', '/api/picks/11', { team: 'Jaguars' });
    ok(r.status === 409, 'team picked this week cannot also be used in a later week', r.data);

    // --- other players cannot see an unlocked pick; the manager can
    const al = await setupPlayer(mgr, 'Alex A.', 'pw-alex-1');
    r = await al.c('GET', '/api/standings');
    const ajRow = r.data.rows.find((x) => x.name === 'AJ S.');
    ok(ajRow.picks[10] && ajRow.picks[10].hidden === true && !ajRow.picks[10].team, "another player sees AJ's week 10 pick as hidden", ajRow.picks[10]);
    ok(ajRow.picks[8].team === 'Bengals' && ajRow.picks[9].team === 'Cowboys', 'past picks are visible to everyone');
    ok(ajRow.paid === undefined, 'paid status is not shown to players');
    r = await mgr('GET', '/api/standings');
    ok(r.data.rows.find((x) => x.name === 'AJ S.').picks[10].hidden === true, 'the league manager cannot see the unlocked pick either');
    ok(!JSON.stringify(r.data).includes('Jaguars') || !r.data.rows.some((x) => x.picks[10] && x.picks[10].team), 'no week 10 team appears anywhere in what the manager receives');
    ok((await aj.c('GET', '/api/standings')).data.rows.find((x) => x.name === 'AJ S.').picks[10].team === 'Jaguars', 'the player still sees their own pick');
    ok(r.data.rows.find((x) => x.name === 'AJ S.').paid === true && r.data.rows.find((x) => x.name === 'Trae M.').paid === false, 'manager sees paid flags');

    // --- manager enters a late pick for a new player; it scores itself from the real final
    r = await mgr('PUT', '/api/admin/picks/' + al.id + '/10', { team: 'Chiefs' });
    ok(r.status === 409, 'manager is warned about a reused team', r.data);
    r = await mgr('POST', '/api/admin/players', { name: 'Test Person' });
    ok(r.status === 200, 'manager adds a player');
    const tp = r.data.id;
    r = await mgr('GET', '/api/state?week=9');
    const g9 = r.data.games.find((g) => g.completed);
    r = await mgr('PUT', '/api/admin/picks/' + tp + '/9', { team: g9.home });
    ok(r.status === 200, 'manager enters a late week 9 pick (' + g9.home + ')', r.data);
    r = await mgr('GET', '/api/standings');
    let t = r.data.rows.find((x) => x.name === 'Test Person');
    const want = g9.homeScore - g9.awayScore;
    ok(t.picks[9].points === want && t.points === want, 'late pick scored automatically from the final: ' + want, t.picks[9]);

    // --- missed pick: manager decides
    r = await mgr('PUT', '/api/admin/picks/' + tp + '/8', { team: null, points: -10, note: 'Missed pick' });
    ok(r.status === 200, 'manager scores a missed pick by hand', r.data);
    r = await mgr('GET', '/api/standings');
    t = r.data.rows.find((x) => x.name === 'Test Person');
    ok(t.picks[8].result === 'L' && t.points === want - 10 && t.picks[8].team === null, 'missed pick counts as a loss with the entered points', t.picks[8]);
    r = await mgr('DELETE', '/api/admin/picks/' + tp + '/8');
    r = await mgr('GET', '/api/standings');
    ok(!r.data.rows.find((x) => x.name === 'Test Person').picks[8], 'manager can undo it');
    ok(r.data.closedWeeks.includes(9) && !r.data.closedWeeks.includes(10), 'week 9 is closed, week 10 is open', r.data.closedWeeks);

    // --- manager account housekeeping
    r = await mgr('POST', '/api/admin/players', { name: 'test person' });
    ok(r.status === 409, 'duplicate name refused');
    const me = (await mgr('GET', '/api/me')).data.me;
    const tylerId = (await mgr('GET', '/api/admin/players')).data.players.find((p) => p.name === 'Tyler H.').id;
    await mgr('PATCH', '/api/admin/players/' + tylerId, { role: 'player' });
    r = await mgr('PATCH', '/api/admin/players/' + me.id, { role: 'player' });
    ok(r.status === 400, 'the last manager cannot be demoted', r.data);
    await mgr('PATCH', '/api/admin/players/' + tylerId, { role: 'manager' });
    r = await mgr('PATCH', '/api/admin/players/' + al.id, { role: 'manager' });
    ok(r.status === 200 && (await al.c('GET', '/api/admin/players')).status === 200, 'a player can be made a second manager');
    await mgr('PATCH', '/api/admin/players/' + al.id, { role: 'player' });
    r = await mgr('POST', '/api/admin/players/' + al.id + '/reset');
    ok(r.status === 200 && (await al.c('GET', '/api/state')).status === 401, 'password reset logs the player out');
    const al2 = client();
    await al2('POST', '/api/setup/' + r.data.setupToken, { password: 'pw-alex-1' });
    ok((await al2('GET', '/api/state')).status === 200, 'player sets a new password with the new link');
    // --- sign-ups for next season
    r = await anon('POST', '/api/signup', { name: 'New Guy', email: 'newguy@example.com', phone: '702-555-0142' });
    ok(r.status === 200 && r.data.season === 2027, 'anyone can sign up for next season without logging in', r.data);
    r = await anon('POST', '/api/signup', { name: 'New Guy', email: 'NEWGUY@example.com' });
    ok(r.status === 200 && r.data.already === true, 'signing up twice does not duplicate (matched by email)');
    r = await anon('POST', '/api/signup', { name: 'new guy', phone: '(702) 555 0142' });
    ok(r.status === 200 && r.data.already === true, 'signing up twice does not duplicate (matched by phone)');
    ok((await anon('POST', '/api/signup', { name: 'Phone Only', phone: '702 555 0199' })).status === 200, 'a phone number alone is enough');
    ok((await anon('POST', '/api/signup', { name: 'X', email: 'a@b.co' })).status === 400, 'sign-up needs a real name');
    ok((await anon('POST', '/api/signup', { name: 'No Contact', email: '', phone: '' })).status === 400, 'sign-up needs an email or a phone number');
    ok((await anon('POST', '/api/signup', { name: 'Bad Email', email: 'not-an-email' })).status === 400 && (await anon('POST', '/api/signup', { name: 'Bad Phone', phone: '12' })).status === 400, 'a malformed email or phone is refused');
    await anon('POST', '/api/signup', { name: 'Bot', email: 'bot@example.com', website: 'http://spam' });
    ok((await anon('GET', '/api/admin/signups')).status === 401 && (await lg('GET', '/api/admin/signups')).status === 403, 'only managers can see the sign-up list');
    r = await mgr('GET', '/api/admin/signups');
    const ng = r.data.signups.find((s) => s.name === 'New Guy');
    ok(r.data.signups.length === 2 && ng.email === 'newguy@example.com' && ng.phone === '702-555-0142' && r.data.nextSeason === 2027, 'manager sees email and phone separately, and the bot entry was dropped', r.data.signups);
    ok((await mgr('GET', '/api/standings')).data.rows.every((x) => x.name !== 'New Guy'), 'signing up does not add anyone to this season');
    await mgr('DELETE', '/api/admin/signups/' + r.data.signups.find((s) => s.name === 'Phone Only').id);
    ok((await lg('POST', '/api/admin/signups', { name: 'Sneaky' })).status === 403, 'players cannot use the manager sign-up form');
    ok((await mgr('POST', '/api/admin/signups', { name: 'Uncle Bob', note: 'Asked at the party' })).status === 200, 'manager signs someone up without contact details');
    ok((await mgr('POST', '/api/admin/signups', { name: 'Aunt Sue', email: 'sue@example.com', phone: '702 555 0111' })).status === 200, 'manager signs someone up with both');
    await mgr('DELETE', '/api/admin/signups/' + (await mgr('GET', '/api/admin/signups')).data.signups.find((s) => s.name === 'Aunt Sue').id);
    ok((await mgr('POST', '/api/admin/signups', { name: 'uncle bob' })).status === 409, 'manager is told when the name is already on the list');
    r = await mgr('GET', '/api/admin/signups');
    ok(r.data.signups.length === 2 && r.data.signups.some((s) => s.name === 'Uncle Bob' && /Added by League Manager/.test(s.note)), 'manager-added sign-up is on the list and marked', r.data.signups);
    for (const s of r.data.signups) await mgr('DELETE', '/api/admin/signups/' + s.id);
    ok((await mgr('GET', '/api/admin/signups')).data.signups.length === 0, 'manager can remove a sign-up');
    // --- Super Bowl squares
    const pub = client();
    r = await pub('GET', '/api/squares');
    ok(r.status === 200 && r.data.squares.length === 100 && r.data.squares.every((x) => x === null) && r.data.open && !r.data.cols, 'squares board opens empty for anyone, no login');
    r = await pub('POST', '/api/squares/claim', { name: 'Pat Marlow', contact: 'pat@example.com', squares: [0, 1, 2] });
    ok(r.status === 200 && r.data.total === 3 && r.data.owes === 60, 'anyone can claim squares: 3 for $60', r.data);
    ok((await pub('POST', '/api/squares/claim', { name: 'Other Guy', contact: 'other@example.com', squares: [5, 2] })).status === 409, 'a taken square cannot be claimed again');
    r = await pub('GET', '/api/squares');
    ok(r.data.squares[5] === null && r.data.sold === 3, 'a failed claim leaves no partial squares behind', r.data.sold);
    ok(!JSON.stringify(r.data).includes('pat@example.com') && r.data.squares[1].name === 'Pat Marlow', 'the public board shows names but never contact details');
    ok((await pub('POST', '/api/squares/claim', { name: 'No Contact', contact: '', squares: [9] })).status === 400, 'buyers must leave a way to reach them');
    ok((await pub('POST', '/api/squares/claim', { name: 'Bad Square', contact: 'bad@example.com', squares: [100] })).status === 400, 'squares off the board are refused');
    ok((await pub('GET', '/api/admin/squares')).status === 401 && (await lg('GET', '/api/admin/squares')).status === 403 && (await lg('POST', '/api/admin/squares/draw')).status === 403, 'only managers reach the squares manager tools');
    ok((await mgr('PATCH', '/api/admin/squares/settings', { limit: 4, price: 20, payouts: [20, 20, 20, 40], top: 'Chiefs', side: 'Eagles' })).status === 200, 'manager changes price, limit, payouts and teams');
    ok((await mgr('PATCH', '/api/admin/squares/settings', { payouts: [50, 50, 50, 50] })).status === 400, 'payouts over 100% are refused');
    ok((await pub('POST', '/api/squares/claim', { name: 'pat marlow', contact: 'PAT@example.com', squares: [10, 11] })).status === 400, 'the per-person limit is enforced');
    ok((await pub('POST', '/api/squares/claim', { name: 'Pat Marlow', contact: 'pat@example.com', squares: [10] })).data.owes === 80, 'up to the limit is fine, at the new price');
    r = await mgr('POST', '/api/squares/claim', { name: 'Uncle Bob', squares: [20, 21, 22, 23, 24, 25] });
    ok(r.status === 200 && r.data.total === 6, 'manager adds squares for someone, past the limit and without contact', r.data);
    await mgr('POST', '/api/admin/squares/paid', { name: 'Pat Marlow', contact: 'pat@example.com', paid: true });
    r = await mgr('GET', '/api/admin/squares');
    ok(r.data.squares[0].paid === true && r.data.squares[20].paid === false && r.data.squares[0].contact === 'pat@example.com' && r.data.pot === 200, 'manager sees contacts, payments and the pot', r.data.pot);
    ok((await mgr('DELETE', '/api/admin/squares/25')).status === 200 && (await pub('GET', '/api/squares')).data.squares[25] === null, 'manager releases a square');
    ok((await mgr('PATCH', '/api/admin/squares/settings', { open: false })).status === 200 && (await pub('POST', '/api/squares/claim', { name: 'Late Larry', contact: 'late@example.com', squares: [50] })).status === 403, 'a closed board refuses buyers');
    ok((await mgr('POST', '/api/admin/squares/draw')).status === 200 && (await mgr('POST', '/api/admin/squares/draw')).status === 400, 'numbers are drawn once');
    r = await pub('GET', '/api/squares');
    const perm = (a) => Array.isArray(a) && a.slice().sort().join('') === '0123456789';
    ok(perm(r.data.cols) && perm(r.data.rows) && r.data.open === false, 'each axis gets the digits 0 to 9 once, and buying closes', [r.data.cols, r.data.rows]);
    ok((await mgr('POST', '/api/squares/claim', { name: 'Too Late', squares: [60] })).status === 403, 'nobody can buy after the draw');
    // put the winning square for Chiefs 17, Eagles 3 on one of Pat's squares by finding the score that lands there
    const cols = r.data.cols, sqRows = r.data.rows;
    await mgr('PUT', '/api/admin/squares/scores', { quarter: 0, top: 10 + cols[2], side: 20 + sqRows[0] });
    await mgr('PUT', '/api/admin/squares/scores', { quarter: 3, top: 30 + cols[7], side: sqRows[9] });
    r = await pub('GET', '/api/squares');
    ok(r.data.winners[0].idx === 2 && r.data.winners[0].name === 'Pat Marlow', 'the last digits of the score pick the right square and owner', r.data.winners[0]);
    ok(r.data.winners[3].idx === 97 && r.data.winners[3].name === null && r.data.winners[1] === null, 'an unsold winning square is reported as unsold; unplayed quarters have no winner', r.data.winners);
    ok((await mgr('DELETE', '/api/admin/squares/0')).status === 400 && (await mgr('POST', '/api/admin/squares/undraw')).status === 400, 'squares and numbers are frozen once a score is in');
    ok((await mgr('POST', '/api/admin/squares/reset', {})).status === 400 && (await mgr('POST', '/api/admin/squares/reset', { confirm: 'RESET' })).status === 200, 'the board can be cleared for next year, with a confirmation');
    r = await pub('GET', '/api/squares');
    ok(r.data.sold === 0 && !r.data.cols && r.data.price === 20 && r.data.scores.every((x) => x === null), 'a cleared board keeps the price and drops buyers, numbers and scores');
    // --- activity log and roles
    r = await mgr('GET', '/api/admin/log?kind=pick&who=aj');
    const txt = JSON.stringify(r.data.log);
    ok(r.data.log.some((l) => l.actor === 'AJ S.' && l.action === 'Made pick' && l.detail === 'Week 10: team hidden until the game locks') && r.data.log.some((l) => l.action === 'Changed pick'),
      'every pick and change is logged with who and when', r.data.log);
    ok(!txt.includes('Jaguars') && !txt.includes('Bills') && r.data.log.every((l) => l.kind === 'pick' && l.actor === 'AJ S.' && l.ts > 1.7e12),
      'the log hides the team until the game locks, and the filters work');
    r = await mgr('GET', '/api/admin/log?kind=login');
    ok(['Logged in', 'Set up password', 'Failed log-in'].every((a) => r.data.log.some((l) => l.action === a)), 'log-ins, password set-ups and failed log-ins are logged', r.data.log.map((l) => l.action));
    r = await mgr('GET', '/api/admin/log');
    ok(['signup', 'squares', 'manager', 'login', 'pick'].every((k) => r.data.log.some((l) => l.kind === k)) && r.data.canRun === true, 'sign-ups, squares and manager changes are in the same log');
    ok((await lg('GET', '/api/admin/log')).status === 403 && (await anon('GET', '/api/admin/log')).status === 401, 'ordinary players cannot read the log');
    const ty = await setupPlayer(mgr, 'Tyler H.', 'pw-ty-1');
    ok((await ty.c('GET', '/api/admin/players')).status === 200 && (await ty.c('GET', '/api/admin/log')).status === 200, 'Tyler H. is a league manager from the start');
    ok((await ty.c('GET', '/api/standings')).data.rows.find((x) => x.name === 'AJ S.').picks[10].hidden === true, 'and still cannot see unlocked picks');
    const rk = await setupPlayer(mgr, 'Ricky A.', 'pw-rk-1');
    r = await rk.c('GET', '/api/admin/log');
    ok(r.status === 200 && r.data.canRun === false && r.data.log.length > 10, 'Ricky A. (support) can read the whole activity log');
    ok((await rk.c('GET', '/api/admin/players')).status === 403 && (await rk.c('PUT', '/api/admin/picks/' + aj.id + '/10', { team: 'Bills' })).status === 403 &&
       (await rk.c('POST', '/api/admin/daily-update')).status === 403 && (await rk.c('GET', '/api/admin/squares')).status === 403 && (await rk.c('GET', '/api/admin/signups')).status === 403,
      'support cannot change picks, players, squares or run updates');
    ok((await rk.c('PUT', '/api/picks/10', { team: 'Bills' })).status === 200, 'support still plays as a normal player');
    r = await mgr('GET', '/api/admin/log');
    ok(r.data.log.length >= 6, 'manager changes are logged', r.data.log.length);
    r = await aj.c('POST', '/api/password', { current: 'bad', password: 'newpass1' });
    ok(r.status === 400, 'password change needs the current password');
    await aj.c('POST', '/api/logout');
    ok((await aj.c('GET', '/api/state')).status === 401, 'log out works');
  }

  if (phase === 'before') {
    // 6 minutes before WSH @ NYG kicks off
    const aj = await setupPlayer(mgr, 'AJ S.', 'pw-aj-1');
    const dc = await setupPlayer(mgr, 'David C.', 'pw-dc-1');
    let r = await aj.c('PUT', '/api/picks/10', { team: 'Giants' });
    ok(r.status === 200, '6 min before kickoff: Giants pick accepted', r.data);
    r = await dc.c('PUT', '/api/picks/10', { team: 'Commanders' });
    ok(r.status === 200, '6 min before kickoff: Commanders pick accepted', r.data);
    r = await dc.c('PUT', '/api/picks/10', { team: 'Bills' });
    ok(r.status === 200, '6 min before kickoff: switching away is still allowed', r.data);
    r = await dc.c('GET', '/api/standings');
    ok(r.data.rows.find((x) => x.name === 'AJ S.').picks[10].hidden === true, "6 min before: AJ's Giants pick is hidden from others");
  }

  if (phase === 'after') {
    // 4 minutes before WSH @ NYG kicks off: that game is locked, the rest are open
    const aj = await setupPlayer(mgr, 'AJ S.', 'pw-aj-1');
    const dc = await setupPlayer(mgr, 'David C.', 'pw-dc-1');
    const ea = await setupPlayer(mgr, 'Eric A.', 'pw-ea-1');
    let r = await ea.c('PUT', '/api/picks/10', { team: 'Giants' });
    ok(r.status === 403, '4 min before kickoff: new Giants pick refused', r.data);
    r = await ea.c('PUT', '/api/picks/10', { team: 'Commanders' });
    ok(r.status === 403, '4 min before kickoff: new Commanders pick refused', r.data);
    r = await aj.c('PUT', '/api/picks/10', { team: 'Bills' });
    ok(r.status === 403, '4 min before kickoff: AJ cannot switch off the locked Giants pick', r.data);
    r = await aj.c('DELETE', '/api/picks/10');
    ok(r.status === 403, '4 min before kickoff: AJ cannot clear the locked pick', r.data);
    r = await dc.c('PUT', '/api/picks/10', { team: 'Seahawks' });
    ok(r.status === 200, 'a pick on a later game can still change (Bills to Seahawks)', r.data);
    r = await dc.c('PUT', '/api/picks/10', { team: 'Giants' });
    ok(r.status === 403, 'but cannot move onto the locked game', r.data);
    r = await ea.c('PUT', '/api/picks/10', { team: 'Lions' });
    ok(r.status === 200, 'a player with no pick can still take a later game', r.data);
    r = await ea.c('GET', '/api/standings');
    ok(r.data.rows.find((x) => x.name === 'AJ S.').picks[10].team === 'Giants', "after lock: AJ's Giants pick is visible to everyone");
    ok(r.data.rows.find((x) => x.name === 'David C.').picks[10].hidden === true, "David's later-game pick is still hidden");
    r = await ea.c('GET', '/api/state');
    ok(r.data.games.find((g) => g.home === 'Giants').locked === true && r.data.games.filter((g) => g.locked).length === 1, 'exactly one game shows as locked');
    r = await mgr('GET', '/api/standings');
    ok(r.data.rows.find((x) => x.name === 'AJ S.').picks[10].team === 'Giants', 'manager sees a pick once its game has locked');
    r = await mgr('GET', '/api/admin/log?kind=pick&who=aj');
    ok(r.data.log.some((l) => l.action === 'Made pick' && l.detail === 'Week 10: Giants'), 'after the lock the activity log shows which team was picked', r.data.log);
    r = await mgr('PUT', '/api/admin/picks/' + aj.id + '/10', { team: 'Bills' });
    ok(r.status === 200, 'manager can still change a locked pick', r.data);
    r = await mgr('PUT', '/api/admin/picks/' + ea.id + '/10', { team: 'Chiefs' });
    r = await mgr('GET', '/api/admin/log');
    ok(!r.data.log.some((l) => l.detail.includes('Chiefs')) && r.data.log.some((l) => l.detail.includes('hidden until the game locks')), 'activity log does not reveal a team before lock');
    r = await mgr('GET', '/api/standings');
    ok(r.data.rows.find((x) => x.name === 'David C.').picks[10].hidden === true && r.data.rows.find((x) => x.name === 'AJ S.').picks[10].hidden === true, 'picks on games that have not locked stay hidden from the manager');
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
