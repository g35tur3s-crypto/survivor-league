// Checks the automatic Super Bowl scores against a finished Super Bowl.
// Start the server with SEASON=2025 (Super Bowl LX: Seahawks 29, Patriots 13), then:
//   node test/superbowl.js http://localhost:PORT managerPassword
const base = process.argv[2];
let cookie = '';
async function call(method, url, body) {
  const r = await fetch(base + url, { method, headers: { ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}), cookie }, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const ok = (c, label, extra) => console.log((c ? 'ok    ' : 'FAIL  ') + label + (c || !extra ? '' : '  -> ' + JSON.stringify(extra)));
(async () => {
  await call('POST', '/api/login', { username: 'manager', password: process.argv[3] });
  let r = await call('POST', '/api/admin/squares/sync');
  ok(r.status === 200 && r.data.matched, 'finds the Super Bowl on the schedule', r);
  r = await call('GET', '/api/squares');
  ok(r.data.top === 'Seahawks' && r.data.side === 'Patriots', 'fills in the two teams', [r.data.top, r.data.side]);
  const s = r.data.scores.map((x) => x && [x.top, x.side]);
  ok(JSON.stringify(s) === JSON.stringify([[3, 0], [9, 0], [12, 0], [29, 13]]), 'running score at the end of each quarter is right', s);
  await call('PUT', '/api/admin/squares/scores', { quarter: 0, top: 7, side: 7 });
  await call('POST', '/api/admin/squares/sync');
  r = await call('GET', '/api/squares');
  ok(r.data.scores[0].top === 7 && r.data.scores[0].manual === true, 'a score entered by hand is not overwritten by the schedule');
  await call('PATCH', '/api/admin/squares/settings', { top: 'Patriots', side: 'Seahawks' });
  await call('PUT', '/api/admin/squares/scores', { quarter: 0, clear: true });
  await call('POST', '/api/admin/squares/sync');
  r = await call('GET', '/api/squares');
  ok(r.data.scores[3].top === 13 && r.data.scores[3].side === 29 && r.data.scores[0].top === 0 && r.data.scores[0].side === 3, 'swapping which team is on top swaps the scores', r.data.scores);
})();
