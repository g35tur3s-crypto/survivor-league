// Checks the daily update: an unscored pick gets its points, and the 5 AM Eastern clock rule holds.
//   node test/daily.js <sqlite file> <base url> <expect: ran|notrun|trigger>
const { DatabaseSync } = require('node:sqlite');
const [file, base, mode] = process.argv.slice(2);
const db = new DatabaseSync(file);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const meta = (k) => (db.prepare('SELECT value FROM meta WHERE key=?').get(k) || {}).value;
  const jamie = db.prepare("SELECT id FROM users WHERE name='Jamie A.'").get().id;
  const pick = () => db.prepare('SELECT * FROM picks WHERE user_id=? AND week=9').get(jamie);
  if (mode === 'notrun') {
    console.log(meta('daily_date') === undefined ? 'ok    4:59 AM Eastern: daily update has not run' : 'FAIL  ran too early ' + meta('daily_date'));
    // turn Jamie's imported Week 9 pick into an unscored one for the later phases
    db.prepare('UPDATE picks SET manual=0, points=NULL, result=NULL WHERE user_id=? AND week=9').run(jamie);
  }
  if (mode === 'ran') {
    const g = db.prepare('SELECT * FROM games WHERE week=9 AND (home=? OR away=?)').get(pick().team, pick().team);
    const want = g.home === pick().team ? g.home_score - g.away_score : g.away_score - g.home_score;
    console.log(meta('daily_date') === '2026-11-12' ? 'ok    5:01 AM Eastern: daily update ran on its own (' + meta('daily_summary') + ')' : 'FAIL  did not run: ' + meta('daily_date'));
    console.log(pick().points === want ? 'ok    unscored pick got its margin: ' + want + ' (' + pick().result + ')' : 'FAIL  pick not scored ' + JSON.stringify(pick()));
    const log = db.prepare("SELECT * FROM audit WHERE actor='Daily update'").all();
    console.log(log.length === 1 ? 'ok    recorded once in the activity log' : 'FAIL  log rows ' + log.length);
  }
  if (mode === 'trigger') {
    db.prepare('UPDATE picks SET points=NULL, result=NULL WHERE user_id=? AND week=9').run(jamie);
    db.prepare("UPDATE meta SET value='0' WHERE key='daily_at'").run();
    const r = await (await fetch(base + '/api/daily-update')).json();
    console.log(r.started ? 'ok    wake-up address answers immediately' : 'FAIL  ' + JSON.stringify(r));
    await sleep(9000);
    console.log(pick().points !== null ? 'ok    wake-up address scored the pick: ' + pick().points : 'FAIL  not scored by trigger');
    const r2 = await (await fetch(base + '/api/daily-update')).json();
    console.log(r2.skipped ? 'ok    a second call within 10 minutes is skipped' : 'FAIL  ' + JSON.stringify(r2));
  }
})();
