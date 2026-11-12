// Schedule, scores and point spreads from ESPN's public NFL scoreboard feed.
// The spread shown is the one ESPN publishes (it names the sportsbook in the feed).

const BASE = process.env.SCOREBOARD_URL ||
  'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

function parseEvent(e, season, week) {
  const c = (e.competitions || [])[0];
  if (!c) return null;
  const home = (c.competitors || []).find((x) => x.homeAway === 'home');
  const away = (c.competitors || []).find((x) => x.homeAway === 'away');
  if (!home || !away) return null;
  const type = (e.status && e.status.type) || {};
  const started = type.state === 'in' || type.state === 'post';
  const num = (v) => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? null : Number(v));

  let fav = null, line = null, overUnder = null, provider = null;
  const o = (c.odds || [])[0];
  if (o) {
    provider = (o.provider && (o.provider.displayName || o.provider.name)) || null;
    overUnder = num(o.overUnder);
    const sp = num(o.spread);
    if (sp !== null) {
      line = Math.abs(sp);
      if (o.homeTeamOdds && o.homeTeamOdds.favorite) fav = home.team.name;
      else if (o.awayTeamOdds && o.awayTeamOdds.favorite) fav = away.team.name;
      else if (sp < 0) fav = home.team.name;
      else if (sp > 0) fav = away.team.name;
      // sp === 0 is a pick'em: fav stays null, line 0
    }
  }

  return {
    id: String(e.id),
    season, week,
    kickoff: Date.parse(e.date),
    home: home.team.name,
    away: away.team.name,
    home_score: started ? num(home.score) : null,
    away_score: started ? num(away.score) : null,
    state: type.state || 'pre',
    completed: type.completed ? 1 : 0,
    status_text: type.shortDetail || type.description || '',
    fav, line, over_under: overUnder, odds_provider: provider,
  };
}

async function fetchWeek(season, week) {
  const url = `${BASE}?seasontype=2&week=${week}&dates=${season}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('Scoreboard feed returned ' + res.status);
    const data = await res.json();
    return (data.events || []).map((e) => parseEvent(e, season, week)).filter((g) => g && !isNaN(g.kickoff));
  } finally {
    clearTimeout(timer);
  }
}

// The Super Bowl (postseason week 5), with each team's running score at the end of every quarter.
function quarterTotals(e) {
  const c = (e.competitions || [])[0];
  if (!c) return null;
  const type = (e.status && e.status.type) || {};
  const period = Number((e.status && e.status.period) || 0);
  const side = (x) => {
    const per = (x.linescores || []).map((l) => Number(l.value) || 0);
    const run = [];
    let sum = 0;
    for (let i = 0; i < 3; i++) { sum += per[i] || 0; run.push(sum); }
    run.push(Number(x.score) || 0); // final score, overtime included
    return { name: x.team.name, location: x.team.location, totals: run };
  };
  const home = c.competitors.find((x) => x.homeAway === 'home');
  const away = c.competitors.find((x) => x.homeAway === 'away');
  if (!home || !away) return null;
  const done = [0, 1, 2].map((q) => !!type.completed || period > q + 1 ||
    (period === q + 1 && ['STATUS_HALFTIME', 'STATUS_END_PERIOD'].includes(type.name)));
  done.push(!!type.completed);
  return { id: String(e.id), kickoff: Date.parse(e.date), home: side(home), away: side(away), done };
}

async function fetchSuperBowl(season) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(`${BASE}?seasontype=3&week=5&dates=${season}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('Scoreboard feed returned ' + res.status);
    const data = await res.json();
    const e = (data.events || [])[0];
    return e ? quarterTotals(e) : null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWeek, parseEvent, fetchSuperBowl, quarterTotals };
