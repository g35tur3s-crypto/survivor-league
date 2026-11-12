// Compares every pick imported from the spreadsheet with the real final score.
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2]);
const picks = db.prepare("SELECT p.*, u.name FROM picks p JOIN users u ON u.id=p.user_id WHERE p.note='From the spreadsheet'").all();
let bad = 0, nogame = 0;
for (const p of picks) {
  const g = db.prepare('SELECT * FROM games WHERE week=? AND (home=? OR away=?)').get(p.week, p.team, p.team);
  if (!g || !g.completed) { nogame++; console.log('no final:', p.name, p.week, p.team); continue; }
  const m = g.home === p.team ? g.home_score - g.away_score : g.away_score - g.home_score;
  if (m !== p.points) { bad++; console.log('MISMATCH', p.name, 'wk', p.week, p.team, 'sheet', p.points, 'actual', m); }
}
console.log(`${picks.length} imported picks checked, ${bad} mismatches, ${nogame} without a final`);
console.log('games stored:', db.prepare('SELECT COUNT(*) c FROM games').get().c, 'weeks:', db.prepare('SELECT COUNT(DISTINCT week) c FROM games').get().c);
