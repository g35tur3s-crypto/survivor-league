// Survivor league server.
// Rules (taken from the league spreadsheet):
//   - one pick per week, each NFL team can be used once per season
//   - a win adds the margin of victory, a loss subtracts the margin of defeat
//   - nobody is eliminated; standings = fewest losses, then most points
//   - picks lock LOCK_MINUTES (default 5) before that game's kickoff

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const { open } = require('./src/db');
const espn = require('./src/espn');
const TEAMS = require('./src/teams.json');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT || 3000);
const SEASON = Number(process.env.SEASON || 2026);
const WEEKS = 18;
const LOCK_MINUTES = Number(process.env.LOCK_MINUTES || 5);
const LOCK_MS = LOCK_MINUTES * 60 * 1000;
const SESSION_DAYS = 150;
const TEAM_NAMES = new Set(TEAMS.map((t) => t.name));

// FAKE_NOW is only for testing the lock logic; never set it on the real site.
const now = () => (process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : Date.now());

let db;
const q = (sql, params) => db.query(sql, params);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (status, message) => { throw new HttpError(status, message); };
const h = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
  console.error(e);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

const uid = () => crypto.randomBytes(9).toString('base64url');
const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(pw, salt, 32);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
async function checkPassword(pw, stored) {
  if (!stored) return false;
  const [kind, salt, hex] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hex) return false;
  const key = await scrypt(pw, salt, 32);
  const want = Buffer.from(hex, 'hex');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

// The activity log: one timestamped row for everything anyone does.
// kind: login | pick | signup | squares | manager | system. When a row names a team for a
// game that has not locked yet, the team is stored separately and only shown after the lock.
async function audit(actor, action, detail, extra) {
  const x = extra || {};
  try {
    await q('INSERT INTO audit (id, ts, actor, action, detail, kind, week, team) VALUES (?,?,?,?,?,?,?,?)',
      [uid(), Date.now(), String(actor).slice(0, 60), action, detail || '', x.kind || 'manager', x.week || null, x.team || null]);
  } catch (e) {
    console.error('Could not write to the activity log:', e.message);
  }
}

// ---------------------------------------------------------------- games

const lastFetch = new Map();
const inflight = new Map();

const gamesForWeek = (week) =>
  q('SELECT * FROM games WHERE season = ? AND week = ? ORDER BY kickoff, id', [SEASON, week]);

const gameLocked = (g) => now() >= g.kickoff - LOCK_MS || g.state !== 'pre';
const gameFor = (games, team) => games.find((g) => g.home === team || g.away === team);

async function saveGames(week, games) {
  const t = Date.now();
  for (const g of games) {
    const pre = g.state === 'pre';
    await q(
      `INSERT INTO games (id, season, week, kickoff, home, away, home_score, away_score, state, completed,
                          status_text, fav, line, over_under, odds_provider, odds_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (id) DO UPDATE SET
         season = excluded.season, week = excluded.week, kickoff = excluded.kickoff,
         home = excluded.home, away = excluded.away,
         home_score = excluded.home_score, away_score = excluded.away_score,
         state = excluded.state, completed = excluded.completed, status_text = excluded.status_text,
         fav = CASE WHEN excluded.line IS NULL THEN games.fav ELSE excluded.fav END,
         line = COALESCE(excluded.line, games.line),
         over_under = COALESCE(excluded.over_under, games.over_under),
         odds_provider = COALESCE(excluded.odds_provider, games.odds_provider),
         odds_at = COALESCE(excluded.odds_at, games.odds_at),
         updated_at = excluded.updated_at`,
      [g.id, g.season, g.week, g.kickoff, g.home, g.away, g.home_score, g.away_score, g.state, g.completed,
        g.status_text,
        // The spread is frozen once a game starts: only pre-game lines are stored.
        pre ? g.fav : null, pre ? g.line : null, pre ? g.over_under : null,
        pre && g.line !== null ? g.odds_provider : null, pre && g.line !== null ? t : null, t]);
  }
  if (games.length) {
    const keep = new Set(games.map((g) => g.id));
    const existing = await gamesForWeek(week);
    for (const g of existing) if (!keep.has(g.id)) await q('DELETE FROM games WHERE id = ?', [g.id]);
  }
}

async function scoreWeek(week) {
  const games = await gamesForWeek(week);
  const picks = await q('SELECT * FROM picks WHERE week = ? AND manual = 0 AND team IS NOT NULL', [week]);
  let scored = 0;
  for (const p of picks) {
    const g = gameFor(games, p.team);
    let points = null, result = null;
    if (g && g.completed && g.home_score !== null && g.away_score !== null) {
      points = g.home === p.team ? g.home_score - g.away_score : g.away_score - g.home_score;
      result = points > 0 ? 'W' : points < 0 ? 'L' : 'T';
    }
    if (points !== p.points || result !== p.result) {
      await q('UPDATE picks SET points = ?, result = ? WHERE user_id = ? AND week = ?',
        [points, result, p.user_id, week]);
      if (points !== null) scored++;
    }
  }
  return scored;
}

// Pull the week's schedule, scores and spreads if what we have is stale.
async function ensureFresh(week, force) {
  const games = await gamesForWeek(week);
  const t = now();
  let ttl;
  if (!games.length) ttl = 60e3;
  else if (games.every((g) => g.completed)) ttl = 6 * 3600e3;
  else if (games.some((g) => !g.completed && g.kickoff - 15 * 60e3 <= t)) ttl = 60e3; // live or about to start
  else ttl = 10 * 60e3;
  const last = Math.max(lastFetch.get(week) || 0, ...games.map((g) => g.updated_at));
  if (!force && Date.now() - last < ttl) return true;
  if (inflight.has(week)) return inflight.get(week);
  const job = (async () => {
    try {
      const fresh = await espn.fetchWeek(SEASON, week);
      await saveGames(week, fresh);
      await scoreWeek(week);
      lastFetch.set(week, Date.now());
      weekCache.at = 0;
      return true;
    } catch (e) {
      console.error(`Could not refresh week ${week}: ${e.message}`);
      lastFetch.set(week, Date.now() - ttl + 30e3); // try again in 30 seconds
      return false;
    } finally {
      inflight.delete(week);
    }
  })();
  inflight.set(week, job);
  return job;
}

const weekCache = { at: 0, value: 1 };
async function currentWeek() {
  if (Date.now() - weekCache.at < 60e3) return weekCache.value;
  const rows = await q('SELECT week, MAX(kickoff) AS last FROM games WHERE season = ? GROUP BY week ORDER BY week', [SEASON]);
  let value = rows.length ? WEEKS : 1;
  for (const r of rows) {
    if (Number(r.last) + 5 * 3600e3 > now()) { value = r.week; break; }
  }
  weekCache.at = Date.now();
  weekCache.value = value;
  return value;
}

// Scores post when someone opens the site: refresh this week and last week (Monday night finals).
async function refreshRecent() {
  const cur = await currentWeek();
  if (cur > 1) await ensureFresh(cur - 1);
  await ensureFresh(cur);
  return currentWeek();
}

// ---------------------------------------------------------------- daily update
// Every day at DAILY_HOUR (5 AM) Eastern the program looks up the schedule for the whole
// season, finds the final scores, and adds each player's win or loss margin to their total.

const DAILY_HOUR = Number(process.env.DAILY_HOUR || 5);
const DAILY_TZ = process.env.DAILY_TZ || 'America/New_York';

async function getMeta(key) {
  const rows = await q('SELECT value FROM meta WHERE key = ?', [key]);
  return rows.length ? rows[0].value : null;
}
async function setMeta(key, value) {
  await q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, String(value)]);
}

function easternClock() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now()));
  const get = (t) => parts.find((x) => x.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

let dailyRunning = null;
let dailyDate = null; // Eastern date of the last completed daily update

async function dailyUpdate(trigger) {
  if (dailyRunning) return dailyRunning;
  dailyRunning = (async () => {
    try {
      let scored = 0, failedWeeks = 0;
      for (let w = 1; w <= WEEKS; w++) {
        if (!(await ensureFresh(w, true))) failedWeeks++;
        scored += await scoreWeek(w);
      }
      const finals = (await q('SELECT id FROM games WHERE season = ? AND completed = 1', [SEASON])).length;
      const summary = `${scored} pick${scored === 1 ? '' : 's'} scored, ${finals} final scores on file` +
        (failedWeeks ? `, ${failedWeeks} week${failedWeeks === 1 ? '' : 's'} could not be reached` : '');
      if (!failedWeeks) {
        dailyDate = easternClock().date;
        await setMeta('daily_date', dailyDate);
      }
      try { await syncSuperBowl(true); } catch (e) { /* the squares board is optional */ }
      await setMeta('daily_at', Date.now());
      await setMeta('daily_summary', summary);
      await audit('Daily update', trigger, summary, { kind: 'system' });
      return { ok: !failedWeeks, scored, finals, summary };
    } finally {
      dailyRunning = null;
    }
  })();
  return dailyRunning;
}

// Checked once a minute. Runs the update the first time the clock is past 5 AM Eastern on a
// day that has not been done yet, so a site that was asleep at 5 AM catches up when it wakes.
async function dailyTick() {
  const clock = easternClock();
  if (clock.hour < DAILY_HOUR || dailyDate === clock.date || dailyRunning) return;
  try { await dailyUpdate('5 AM Eastern schedule'); } catch (e) { console.error('Daily update failed:', e.message); }
}

// ---------------------------------------------------------------- picks

function pickLocked(pick, games) {
  if (!pick) return false;
  if (pick.manual || pick.points !== null || !pick.team) return true;
  const g = gameFor(games, pick.team);
  return g ? gameLocked(g) : false;
}

function pickVisibleToOthers(pick, games) {
  if (pick.manual || pick.points !== null || !pick.team) return true;
  const g = gameFor(games, pick.team);
  return g ? gameLocked(g) : false;
}

const parseWeek = (v) => {
  const w = Number(v);
  if (!Number.isInteger(w) || w < 1 || w > WEEKS) bad(400, 'That week does not exist.');
  return w;
};

async function usedElsewhere(userId, team, week) {
  const rows = await q('SELECT week FROM picks WHERE user_id = ? AND team = ? AND week <> ?', [userId, team, week]);
  return rows.length ? rows[0].week : null;
}

async function upsertPick(userId, week, f) {
  await q(
    `INSERT INTO picks (user_id, week, team, points, result, manual, note, updated_at, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT (user_id, week) DO UPDATE SET
       team = excluded.team, points = excluded.points, result = excluded.result, manual = excluded.manual,
       note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [userId, week, f.team, f.points, f.result, f.manual, f.note || null, Date.now(), f.by]);
}

// ---------------------------------------------------------------- app

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'",
  });
  next();
});

let ready = false;
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!ready) return res.status(503).json({ error: 'The league site is starting up. Try again in a few seconds.' });
  if (req.method !== 'GET' && !req.is('application/json') && req.method !== 'DELETE') {
    return res.status(415).json({ error: 'Unsupported request.' });
  }
  next();
});

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(req, res, token) {
  const secure = req.secure ? '; Secure' : '';
  const age = token ? SESSION_DAYS * 86400 : 0;
  res.set('Set-Cookie', `sid=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`);
}
async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)',
    [sha(token), userId, Date.now() + SESSION_DAYS * 86400e3]);
  setSessionCookie(req, res, token);
}

async function currentUser(req) {
  const token = readCookie(req, 'sid');
  if (!token) return null;
  const rows = await q(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`, [sha(token), Date.now()]);
  return rows[0] || null;
}
const auth = (fn) => h(async (req, res) => {
  const user = await currentUser(req);
  if (!user) bad(401, 'Log in to continue.');
  req.user = user;
  return fn(req, res);
});
const manager = (fn) => auth(async (req, res) => {
  if (req.user.role !== 'manager') bad(403, 'Only the league manager can do that.');
  return fn(req, res);
});
// League managers plus "support" (the person who looks after the site): read-only activity log.
const staff = (fn) => auth(async (req, res) => {
  if (!['manager', 'support'].includes(req.user.role)) bad(403, 'Only the league manager can see that.');
  return fn(req, res);
});

const publicUser = (u) => ({
  id: u.id, name: u.name, username: u.username, role: u.role, isPlayer: !!u.is_player,
});

// ---- logging in

const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 10 * 60e3) { failures.delete(ip); return false; }
  return f.count >= 12;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 10 * 60e3) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

app.post('/api/login', h(async (req, res) => {
  const ip = req.ip;
  if (tooManyFailures(ip)) bad(429, 'Too many tries. Wait 10 minutes, or ask the league manager to reset your password.');
  const name = normalize(req.body.username);
  const password = String(req.body.password || '');
  const users = name ? await q('SELECT * FROM users WHERE active = 1') : [];
  const user = users.find((u) => u.username === name || normalize(u.name) === name);
  if (!user || !(await checkPassword(password, user.pass_hash))) {
    noteFailure(ip);
    if (user) await audit(user.name, 'Failed log-in', user.pass_hash ? 'Wrong password' : 'No password set up yet', { kind: 'login' });
    if (user && !user.pass_hash) bad(401, 'This account has no password yet. Open the setup link the league manager sent you.');
    bad(401, 'That name and password do not match.');
  }
  await startSession(req, res, user.id);
  await audit(user.name, 'Logged in', '', { kind: 'login' });
  res.json({ me: publicUser(user) });
}));

app.post('/api/logout', h(async (req, res) => {
  const token = readCookie(req, 'sid');
  const leaving = await currentUser(req);
  if (leaving) await audit(leaving.name, 'Logged out', '', { kind: 'login' });
  if (token) await q('DELETE FROM sessions WHERE token_hash = ?', [sha(token)]);
  setSessionCookie(req, res, null);
  res.json({ ok: true });
}));

app.get('/api/me', h(async (req, res) => {
  const user = await currentUser(req);
  res.json({ me: user ? publicUser(user) : null, league: await leagueName(), nextSeason: SEASON + 1 });
}));

async function leagueName() {
  const rows = await q("SELECT value FROM meta WHERE key = 'league'");
  return process.env.LEAGUE_NAME || (rows[0] && rows[0].value) || 'Survivor League';
}

async function userBySetupToken(token) {
  if (!token || String(token).length < 10) return null;
  const rows = await q('SELECT * FROM users WHERE setup_token = ? AND active = 1', [String(token)]);
  return rows[0] || null;
}

app.get('/api/setup/:token', h(async (req, res) => {
  const user = await userBySetupToken(req.params.token);
  if (!user) bad(404, 'This setup link has already been used or was replaced. Ask the league manager for a new one.');
  res.json({ name: user.name, username: user.username, league: await leagueName() });
}));

const checkNewPassword = (pw) => {
  pw = String(pw || '');
  if (pw.length < 6) bad(400, 'Use at least 6 characters for the password.');
  if (pw.length > 200) bad(400, 'That password is too long.');
  return pw;
};

app.post('/api/setup/:token', h(async (req, res) => {
  const user = await userBySetupToken(req.params.token);
  if (!user) bad(404, 'This setup link has already been used or was replaced. Ask the league manager for a new one.');
  const pw = checkNewPassword(req.body.password);
  await q('UPDATE users SET pass_hash = ?, setup_token = NULL WHERE id = ?', [await hashPassword(pw), user.id]);
  await q('DELETE FROM sessions WHERE user_id = ?', [user.id]);
  await startSession(req, res, user.id);
  await audit(user.name, 'Set up password', 'Used their setup link and logged in', { kind: 'login' });
  res.json({ me: publicUser(user) });
}));

app.post('/api/password', auth(async (req, res) => {
  if (!(await checkPassword(String(req.body.current || ''), req.user.pass_hash))) bad(400, 'The current password is not right.');
  const pw = checkNewPassword(req.body.password);
  await q('UPDATE users SET pass_hash = ? WHERE id = ?', [await hashPassword(pw), req.user.id]);
  await audit(req.user.name, 'Changed password', '', { kind: 'login' });
  res.json({ ok: true });
}));

// ---- sign-up list for next season (open to anyone with the link; no login)

// Email and phone are separate blanks. People signing themselves up must fill in at least one.
function signupContact(b, needOne) {
  const email = String(b.email || '').trim().slice(0, 80);
  const phone = String(b.phone || '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad(400, 'That email address does not look right.');
  if (phone && phone.replace(/\D/g, '').length < 7) bad(400, 'That phone number looks too short.');
  if (needOne && !email && !phone) bad(400, 'Enter an email address or a phone number so the league manager can reach you.');
  return { email, phone };
}

const signupTries = new Map();
app.post('/api/signup', h(async (req, res) => {
  const b = req.body;
  if (b.website) return res.json({ ok: true }); // hidden field only bots fill in
  const t = signupTries.get(req.ip);
  if (t && Date.now() - t.first < 3600e3 && t.count >= 5) bad(429, 'Too many sign-ups from this connection. Try again in an hour.');
  const name = cleanName(b.name);
  const { email, phone } = signupContact(b, true);
  const season = SEASON + 1;
  const existing = await q('SELECT name, email, phone FROM signups WHERE season = ?', [season]);
  if (existing.length >= 500) bad(400, 'The sign-up list is full. Contact the league manager directly.');
  const digits = (v) => String(v || '').replace(/\D/g, '');
  if (existing.some((s) => normalize(s.name) === normalize(name) &&
      ((email && normalize(s.email) === normalize(email)) || (phone && digits(s.phone) === digits(phone))))) {
    return res.json({ ok: true, season, already: true });
  }
  await q('INSERT INTO signups (id, season, name, email, phone, note, created_at) VALUES (?,?,?,?,?,?,?)',
    [uid(), season, name, email, phone, null, Date.now()]);
  await audit(name, 'Signed up for next season', `${season} season`, { kind: 'signup' });
  if (!t || Date.now() - t.first >= 3600e3) signupTries.set(req.ip, { first: Date.now(), count: 1 }); else t.count++;
  res.json({ ok: true, season });
}));

// ---- the week: matchups, spreads, my picks

const gameOut = (g) => ({
  id: g.id, kickoff: g.kickoff, home: g.home, away: g.away,
  homeScore: g.home_score, awayScore: g.away_score,
  state: g.state, completed: !!g.completed, statusText: g.status_text,
  fav: g.fav, line: g.line, overUnder: g.over_under, oddsProvider: g.odds_provider,
  lockAt: g.kickoff - LOCK_MS, locked: gameLocked(g),
});

app.get('/api/state', auth(async (req, res) => {
  const cur = await refreshRecent();
  const week = req.query.week ? parseWeek(req.query.week) : cur;
  const fresh = await ensureFresh(week);
  const games = await gamesForWeek(week);
  const mine = await q('SELECT * FROM picks WHERE user_id = ? ORDER BY week', [req.user.id]);
  const mineThisWeek = mine.find((p) => p.week === week);
  const playing = new Set(games.flatMap((g) => [g.home, g.away]));
  res.json({
    league: await leagueName(), season: SEASON, weeks: WEEKS, lockMinutes: LOCK_MINUTES,
    now: now(), currentWeek: await currentWeek(), week, feedOk: fresh,
    me: publicUser(req.user), teams: TEAMS,
    games: games.map(gameOut),
    byes: games.length ? TEAMS.filter((t) => !playing.has(t.name)).map((t) => t.name) : [],
    myPicks: mine.map((p) => ({ week: p.week, team: p.team, points: p.points, result: p.result, note: p.note })),
    myPickLocked: pickLocked(mineThisWeek, games),
  });
}));

app.put('/api/picks/:week', auth(async (req, res) => {
  if (!req.user.is_player) bad(403, 'This account is for managing the league and does not make picks.');
  const week = parseWeek(req.params.week);
  const team = String(req.body.team || '');
  if (!TEAM_NAMES.has(team)) bad(400, 'Pick one of the teams playing this week.');
  await ensureFresh(week);
  const games = await gamesForWeek(week);
  const g = gameFor(games, team);
  if (!g) bad(400, `The ${team} are not playing in Week ${week}.`);
  if (gameLocked(g)) bad(403, `That game is locked. Picks close ${LOCK_MINUTES} minutes before kickoff.`);
  const existing = (await q('SELECT * FROM picks WHERE user_id = ? AND week = ?', [req.user.id, week]))[0];
  if (pickLocked(existing, games)) bad(403, `Your Week ${week} pick is locked and can no longer be changed.`);
  const used = await usedElsewhere(req.user.id, team, week);
  if (used) bad(409, `You already used the ${team} in Week ${used}. Each team can be picked once a season.`);
  await upsertPick(req.user.id, week, { team, points: null, result: null, manual: 0, by: req.user.name });
  await audit(req.user.name, existing ? 'Changed pick' : 'Made pick', `Week ${week}: `, { kind: 'pick', week, team });
  res.json({ ok: true, week, team });
}));

app.delete('/api/picks/:week', auth(async (req, res) => {
  const week = parseWeek(req.params.week);
  await ensureFresh(week);
  const games = await gamesForWeek(week);
  const existing = (await q('SELECT * FROM picks WHERE user_id = ? AND week = ?', [req.user.id, week]))[0];
  if (!existing) return res.json({ ok: true });
  if (pickLocked(existing, games)) bad(403, `Your Week ${week} pick is locked and can no longer be changed.`);
  await q('DELETE FROM picks WHERE user_id = ? AND week = ?', [req.user.id, week]);
  await audit(req.user.name, 'Removed pick', `Week ${week}: `, { kind: 'pick', week, team: existing.team });
  res.json({ ok: true });
}));

// ---- standings and everyone's picks

app.get('/api/standings', auth(async (req, res) => {
  const cur = await refreshRecent();
  const isManager = req.user.role === 'manager';
  const players = await q('SELECT * FROM users WHERE active = 1 AND is_player = 1');
  const picks = await q('SELECT * FROM picks');
  const allGames = await q('SELECT * FROM games WHERE season = ?', [SEASON]);
  const byWeek = new Map();
  for (const g of allGames) {
    if (!byWeek.has(g.week)) byWeek.set(g.week, []);
    byWeek.get(g.week).push(g);
  }
  const rows = new Map(players.map((u) => [u.id, {
    id: u.id, name: u.name, wins: 0, losses: 0, ties: 0, points: 0, picks: {},
    ...(isManager ? { paid: !!u.paid } : {}),
  }]));
  for (const p of picks) {
    const row = rows.get(p.user_id);
    if (!row) continue;
    if (p.result === 'W') row.wins++;
    if (p.result === 'L') row.losses++;
    if (p.result === 'T') row.ties++;
    row.points += p.points || 0;
    const games = byWeek.get(p.week) || [];
    // Nobody, league managers included, sees another player's pick before its game locks.
    const show = p.user_id === req.user.id || pickVisibleToOthers(p, games);
    row.picks[p.week] = show
      ? { team: p.team, points: p.points, result: p.result, manual: !!p.manual, note: p.note || undefined }
      : { hidden: true };
  }
  const list = [...rows.values()];
  for (const r of list) {
    r.rank = 1 + list.filter((o) => o.losses < r.losses || (o.losses === r.losses && o.points > r.points)).length;
  }
  list.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  // A week is "closed" once every game in it has locked: anyone without a pick then needs the manager.
  const closedWeeks = [];
  for (let w = 1; w <= WEEKS; w++) {
    const games = byWeek.get(w) || [];
    if (games.length && games.every(gameLocked)) closedWeeks.push(w);
  }
  res.json({ currentWeek: cur, weeks: WEEKS, rows: list, closedWeeks, me: publicUser(req.user) });
}));

// ---- league manager

app.get('/api/admin/players', manager(async (req, res) => {
  const users = await q('SELECT * FROM users ORDER BY active DESC, name');
  res.json({
    players: users.map((u) => ({
      ...publicUser(u), paid: !!u.paid, active: !!u.active, hasPassword: !!u.pass_hash, setupToken: u.setup_token,
    })),
  });
}));

async function uniqueUsername(name) {
  const base = normalize(name) || 'player';
  const taken = new Set((await q('SELECT username FROM users')).map((r) => r.username));
  let candidate = base, n = 2;
  while (taken.has(candidate)) candidate = base + n++;
  return candidate;
}

const cleanName = (v) => {
  const name = String(v || '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 40) bad(400, 'Enter a name between 2 and 40 characters.');
  return name;
};

app.post('/api/admin/players', manager(async (req, res) => {
  const name = cleanName(req.body.name);
  const all = await q('SELECT name FROM users WHERE active = 1');
  if (all.some((u) => normalize(u.name) === normalize(name))) bad(409, 'There is already a player with that name.');
  const id = uid();
  await q(`INSERT INTO users (id, username, name, role, is_player, paid, active, setup_token, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, await uniqueUsername(name), name, 'player', 1, req.body.paid ? 1 : 0, 1, uid() + uid(), Date.now()]);
  await audit(req.user.name, 'Added player', name);
  res.json({ ok: true, id });
}));

async function managerCount() {
  return (await q("SELECT id FROM users WHERE role = 'manager' AND active = 1")).length;
}

app.patch('/api/admin/players/:id', manager(async (req, res) => {
  const u = (await q('SELECT * FROM users WHERE id = ?', [req.params.id]))[0];
  if (!u) bad(404, 'That player no longer exists.');
  const b = req.body;
  const changes = [];
  if (b.name !== undefined) {
    const name = cleanName(b.name);
    if (name !== u.name) { await q('UPDATE users SET name = ? WHERE id = ?', [name, u.id]); changes.push(`renamed to ${name}`); }
  }
  if (b.paid !== undefined && !!b.paid !== !!u.paid) {
    await q('UPDATE users SET paid = ? WHERE id = ?', [b.paid ? 1 : 0, u.id]);
    changes.push(b.paid ? 'marked paid' : 'marked unpaid');
  }
  if (b.role !== undefined && b.role !== u.role) {
    if (!['manager', 'support', 'player'].includes(b.role)) bad(400, 'Unknown role.');
    if (u.role === 'manager' && (await managerCount()) <= 1) bad(400, 'The league needs at least one manager.');
    await q('UPDATE users SET role = ? WHERE id = ?', [b.role, u.id]);
    changes.push(b.role === 'manager' ? 'made a league manager' : b.role === 'support' ? 'given the activity log (support)' : 'changed to player only');
  }
  if (b.active !== undefined && !!b.active !== !!u.active) {
    if (!b.active && u.role === 'manager' && (await managerCount()) <= 1) bad(400, 'The league needs at least one manager.');
    await q('UPDATE users SET active = ? WHERE id = ?', [b.active ? 1 : 0, u.id]);
    if (!b.active) await q('DELETE FROM sessions WHERE user_id = ?', [u.id]);
    changes.push(b.active ? 'restored' : 'removed from the league');
  }
  if (changes.length) await audit(req.user.name, 'Changed player', `${u.name}: ${changes.join(', ')}`);
  res.json({ ok: true });
}));

app.post('/api/admin/players/:id/reset', manager(async (req, res) => {
  const u = (await q('SELECT * FROM users WHERE id = ?', [req.params.id]))[0];
  if (!u) bad(404, 'That player no longer exists.');
  if (u.id === req.user.id) bad(400, 'Change your own password from the Account page instead.');
  const token = uid() + uid();
  await q('UPDATE users SET pass_hash = NULL, setup_token = ? WHERE id = ?', [token, u.id]);
  await q('DELETE FROM sessions WHERE user_id = ?', [u.id]);
  await audit(req.user.name, 'Reset password', u.name);
  res.json({ ok: true, setupToken: token });
}));

// Manager sets, changes or scores anyone's pick, with no lock.
//   { team }                         -> normal pick, scored automatically from the final score
//   { team?, points, result }        -> manual score (team may be empty for a missed-pick penalty)
app.put('/api/admin/picks/:userId/:week', manager(async (req, res) => {
  const week = parseWeek(req.params.week);
  const u = (await q('SELECT * FROM users WHERE id = ? AND is_player = 1', [req.params.userId]))[0];
  if (!u) bad(404, 'That player no longer exists.');
  const b = req.body;
  const team = b.team ? String(b.team) : null;
  if (team && !TEAM_NAMES.has(team)) bad(400, 'Unknown team.');
  if (team) {
    const used = await usedElsewhere(u.id, team, week);
    if (used && !b.allowReuse) bad(409, `${u.name} already used the ${team} in Week ${used}.`);
  }
  const manualScore = b.points !== undefined && b.points !== null && b.points !== '';
  if (manualScore) {
    const points = Number(b.points);
    if (!Number.isInteger(points) || Math.abs(points) > 200) bad(400, 'Points must be a whole number.');
    const result = ['W', 'L', 'T'].includes(b.result) ? b.result : points > 0 ? 'W' : points < 0 ? 'L' : 'T';
    const note = String(b.note || '').slice(0, 120) || (team ? 'Scored by manager' : 'Missed pick');
    await upsertPick(u.id, week, { team, points, result, manual: 1, note, by: req.user.name });
    await audit(req.user.name, 'Scored pick by hand',
      `${u.name}, Week ${week}: ${team || 'no pick'}, ${result} ${points > 0 ? '+' : ''}${points}`);
  } else {
    if (!team) bad(400, 'Choose a team, or enter points for a missed pick.');
    await ensureFresh(week);
    const games = await gamesForWeek(week);
    if (games.length && !gameFor(games, team)) bad(400, `The ${team} are not playing in Week ${week}.`);
    await upsertPick(u.id, week, { team, points: null, result: null, manual: 0, by: req.user.name });
    await scoreWeek(week);
    await audit(req.user.name, 'Set pick', `${u.name}, Week ${week}: `, { week, team });
  }
  res.json({ ok: true });
}));

app.delete('/api/admin/picks/:userId/:week', manager(async (req, res) => {
  const week = parseWeek(req.params.week);
  const u = (await q('SELECT * FROM users WHERE id = ?', [req.params.userId]))[0];
  if (!u) bad(404, 'That player no longer exists.');
  await q('DELETE FROM picks WHERE user_id = ? AND week = ?', [u.id, week]);
  await audit(req.user.name, 'Cleared pick', `${u.name}, Week ${week}`);
  res.json({ ok: true });
}));

app.get('/api/admin/signups', manager(async (req, res) => {
  res.json({ nextSeason: SEASON + 1,
    signups: await q('SELECT id, season, name, email, phone, note, created_at FROM signups ORDER BY created_at DESC') });
}));

// A league manager adds someone to next season's list for them (contact is optional here).
app.post('/api/admin/signups', manager(async (req, res) => {
  const name = cleanName(req.body.name);
  const { email, phone } = signupContact(req.body, false);
  const said = String(req.body.note || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const note = (said ? said + '. ' : '') + 'Added by ' + req.user.name;
  const season = SEASON + 1;
  const existing = await q('SELECT name FROM signups WHERE season = ?', [season]);
  if (existing.some((s) => normalize(s.name) === normalize(name))) bad(409, name + ' is already on the sign-up list.');
  await q('INSERT INTO signups (id, season, name, email, phone, note, created_at) VALUES (?,?,?,?,?,?,?)',
    [uid(), season, name, email, phone, note, Date.now()]);
  await audit(req.user.name, 'Added sign-up', name, { kind: 'signup' });
  res.json({ ok: true });
}));

app.delete('/api/admin/signups/:id', manager(async (req, res) => {
  const s = (await q('SELECT name FROM signups WHERE id = ?', [req.params.id]))[0];
  if (!s) return res.json({ ok: true });
  await q('DELETE FROM signups WHERE id = ?', [req.params.id]);
  await audit(req.user.name, 'Removed sign-up', s.name);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Super Bowl squares
// A 10 x 10 board. Anyone with the link claims squares (name + contact, no login). When the
// manager draws the numbers, the digits 0-9 are shuffled for the columns (top team) and the
// rows (side team). Each quarter's winner is the square where the last digits of the two
// scores meet. The site records who owes what; it does not take payments.

const SQ_DEFAULT = { price: 20, limit: 0, payouts: [25, 25, 25, 25], open: true,
  top: 'AFC champion', side: 'NFC champion', teamsSet: false, cols: null, rows: null,
  scores: [null, null, null, null] };
const QUARTERS = ['End of 1st quarter', 'Halftime', 'End of 3rd quarter', 'Final score'];

async function sqCfg() {
  const raw = await getMeta('squares_cfg');
  return raw ? { ...SQ_DEFAULT, ...JSON.parse(raw) } : { ...SQ_DEFAULT };
}
const sqSave = (cfg) => setMeta('squares_cfg', JSON.stringify(cfg));
const samePerson = (a, name, contact) => normalize(a.name) === normalize(name) && normalize(a.contact) === normalize(contact);

function shuffledDigits() {
  const d = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

let sqSyncAt = 0;
async function syncSuperBowl(force) {
  if (!force && Date.now() - sqSyncAt < 60e3) return null;
  sqSyncAt = Date.now();
  let game;
  try { game = await espn.fetchSuperBowl(SEASON); } catch (e) { console.error('Super Bowl lookup failed:', e.message); return { error: true }; }
  if (!game) return { found: false };
  const cfg = await sqCfg();
  let changed = false;
  if (!cfg.teamsSet) { cfg.top = game.away.name; cfg.side = game.home.name; cfg.teamsSet = true; changed = true; }
  const match = (label, t) => normalize(label) === normalize(t.name) || normalize(label) === normalize(t.location + t.name);
  const top = match(cfg.top, game.home) ? game.home : match(cfg.top, game.away) ? game.away : null;
  const side = match(cfg.side, game.home) ? game.home : match(cfg.side, game.away) ? game.away : null;
  if (top && side && top !== side) {
    for (let i = 0; i < 4; i++) {
      const cur = cfg.scores[i];
      if (!game.done[i] || (cur && cur.manual)) continue;
      if (!cur || cur.top !== top.totals[i] || cur.side !== side.totals[i]) {
        cfg.scores[i] = { top: top.totals[i], side: side.totals[i] };
        changed = true;
      }
    }
  }
  if (changed) await sqSave(cfg);
  return { found: true, matched: !!(top && side && top !== side), kickoff: game.kickoff };
}

async function squaresBoard(withContacts) {
  const cfg = await sqCfg();
  const rows = await q('SELECT * FROM squares ORDER BY idx');
  const cells = Array(100).fill(null);
  for (const r of rows) {
    cells[r.idx] = withContacts ? { name: r.name, contact: r.contact || '', paid: !!r.paid } : { name: r.name };
  }
  const sold = rows.length;
  const pot = sold * cfg.price;
  const winners = cfg.scores.map((s, i) => {
    if (!s || !cfg.cols || !cfg.rows) return null;
    const c = cfg.cols.indexOf(((s.top % 10) + 10) % 10);
    const r = cfg.rows.indexOf(((s.side % 10) + 10) % 10);
    const idx = r * 10 + c;
    return { quarter: i, idx, name: cells[idx] ? cells[idx].name : null };
  });
  return {
    league: await leagueName(), season: SEASON, price: cfg.price, limit: cfg.limit, payouts: cfg.payouts,
    open: !!cfg.open && !cfg.cols, top: cfg.top, side: cfg.side, cols: cfg.cols, rows: cfg.rows,
    scores: cfg.scores.map((s) => (s ? { top: s.top, side: s.side, manual: !!s.manual } : null)),
    quarters: QUARTERS, winners, squares: cells, sold, pot,
  };
}

app.get('/api/squares', h(async (req, res) => {
  const cfg = await sqCfg();
  if (cfg.cols && cfg.scores.some((s) => !s)) await syncSuperBowl(false);
  const user = await currentUser(req);
  res.json({ ...(await squaresBoard(false)), me: user ? publicUser(user) : null });
}));

const sqTries = new Map();
app.post('/api/squares/claim', h(async (req, res) => {
  const user = await currentUser(req);
  const isManager = !!user && user.role === 'manager';
  const cfg = await sqCfg();
  if (cfg.cols) bad(403, 'The numbers have been drawn, so the board is closed.');
  if (!cfg.open && !isManager) bad(403, 'The board is not open for buying right now.');
  const name = cleanName(req.body.name);
  const contact = String(req.body.contact || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!isManager && contact.length < 5) bad(400, 'Enter an email address or phone number so the league manager can reach you.');
  const wanted = [...new Set((Array.isArray(req.body.squares) ? req.body.squares : []).map(Number))];
  if (!wanted.length) bad(400, 'Tap the squares you want first.');
  if (wanted.some((i) => !Number.isInteger(i) || i < 0 || i > 99)) bad(400, 'One of those squares does not exist.');
  const all = await q('SELECT * FROM squares');
  if (!isManager) {
    const t = sqTries.get(req.ip);
    if (t && Date.now() - t.first < 3600e3 && t.count + wanted.length > 40) bad(429, 'That is a lot of squares from one connection. Ask the league manager to add more for you.');
    const mine = all.filter((s) => samePerson(s, name, contact)).length;
    if (cfg.limit > 0 && mine + wanted.length > cfg.limit) {
      bad(400, `The limit is ${cfg.limit} squares per person` + (mine ? ` and you already have ${mine}.` : '.'));
    }
  }
  const got = [];
  for (const idx of wanted) {
    const r = await q(`INSERT INTO squares (idx, name, contact, paid, claimed_at, added_by) VALUES (?,?,?,?,?,?)
                       ON CONFLICT (idx) DO NOTHING RETURNING idx`,
      [idx, name, contact, 0, Date.now(), isManager ? user.name : null]);
    if (!r.length) {
      for (const g of got) await q('DELETE FROM squares WHERE idx = ?', [g]);
      bad(409, 'Someone just took one of those squares. The board has been refreshed; pick again.');
    }
    got.push(idx);
  }
  if (!isManager) {
    const t = sqTries.get(req.ip);
    if (!t || Date.now() - t.first >= 3600e3) sqTries.set(req.ip, { first: Date.now(), count: got.length }); else t.count += got.length;
  } else {
    await audit(user.name, 'Added squares', `${name}: ${got.length} square${got.length === 1 ? '' : 's'} (${got.map((i) => '#' + (i + 1)).join(', ')})`, { kind: 'squares' });
  }
  if (!isManager) await audit(name, 'Claimed squares', `${got.length} square${got.length === 1 ? '' : 's'} (${got.map((i) => '#' + (i + 1)).join(', ')})`, { kind: 'squares' });
  const total = all.filter((s) => samePerson(s, name, contact)).length + got.length;
  res.json({ ok: true, claimed: got.length, total, owes: total * cfg.price });
}));

app.get('/api/admin/squares', manager(async (req, res) => {
  res.json(await squaresBoard(true));
}));

app.patch('/api/admin/squares/settings', manager(async (req, res) => {
  const cfg = await sqCfg();
  const b = req.body;
  if (b.price !== undefined) {
    const p = Number(b.price);
    if (!(p >= 0 && p <= 100000)) bad(400, 'Enter a price per square.');
    cfg.price = Math.round(p * 100) / 100;
  }
  if (b.limit !== undefined) {
    const l = Number(b.limit);
    if (!Number.isInteger(l) || l < 0 || l > 100) bad(400, 'The limit per person is a whole number from 0 to 100 (0 means no limit).');
    cfg.limit = l;
  }
  if (b.payouts !== undefined) {
    const p = (Array.isArray(b.payouts) ? b.payouts : []).map(Number);
    if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 100))) bad(400, 'Enter four payout percentages.');
    if (p.reduce((a, x) => a + x, 0) > 100.001) bad(400, 'The four payouts add up to more than 100%.');
    cfg.payouts = p;
  }
  for (const key of ['top', 'side']) {
    if (b[key] !== undefined) {
      const v = String(b[key]).replace(/\s+/g, ' ').trim().slice(0, 30);
      if (!v) bad(400, 'Enter both team names.');
      if (v !== cfg[key]) { cfg[key] = v; cfg.teamsSet = true; }
    }
  }
  if (b.open !== undefined) cfg.open = !!b.open;
  await sqSave(cfg);
  await audit(req.user.name, 'Changed squares settings', `$${cfg.price} a square, ${cfg.open ? 'open' : 'closed'}`);
  res.json({ ok: true });
}));

app.post('/api/admin/squares/draw', manager(async (req, res) => {
  const cfg = await sqCfg();
  if (cfg.cols) bad(400, 'The numbers are already drawn.');
  cfg.cols = shuffledDigits();
  cfg.rows = shuffledDigits();
  await sqSave(cfg);
  await audit(req.user.name, 'Drew the squares numbers', `Top ${cfg.cols.join('')}, side ${cfg.rows.join('')}`);
  res.json({ ok: true });
}));

app.post('/api/admin/squares/undraw', manager(async (req, res) => {
  const cfg = await sqCfg();
  if (cfg.scores.some((s) => s)) bad(400, 'A score is already entered, so the numbers can no longer be cleared.');
  cfg.cols = null; cfg.rows = null;
  await sqSave(cfg);
  await audit(req.user.name, 'Cleared the squares numbers', '');
  res.json({ ok: true });
}));

app.put('/api/admin/squares/scores', manager(async (req, res) => {
  const cfg = await sqCfg();
  const i = Number(req.body.quarter);
  if (![0, 1, 2, 3].includes(i)) bad(400, 'Unknown quarter.');
  if (req.body.clear) {
    cfg.scores[i] = null;
  } else {
    const top = Number(req.body.top), side = Number(req.body.side);
    if (![top, side].every((n) => Number.isInteger(n) && n >= 0 && n <= 200)) bad(400, 'Enter both scores as whole numbers.');
    cfg.scores[i] = { top, side, manual: true };
  }
  await sqSave(cfg);
  await audit(req.user.name, 'Set squares score', `${QUARTERS[i]}: ` + (cfg.scores[i] ? `${cfg.top} ${cfg.scores[i].top}, ${cfg.side} ${cfg.scores[i].side}` : 'cleared'));
  res.json({ ok: true });
}));

app.post('/api/admin/squares/sync', manager(async (req, res) => {
  const r = await syncSuperBowl(true);
  if (!r || r.error) bad(502, 'The score feed did not answer. Try again in a minute.');
  if (!r.found) bad(404, 'The Super Bowl is not on the schedule yet. Enter the team names by hand for now.');
  res.json({ ok: true, matched: r.matched });
}));

app.post('/api/admin/squares/paid', manager(async (req, res) => {
  const rows = await q('SELECT * FROM squares');
  const mine = rows.filter((s) => samePerson(s, req.body.name, req.body.contact));
  for (const s of mine) await q('UPDATE squares SET paid = ? WHERE idx = ?', [req.body.paid ? 1 : 0, s.idx]);
  if (mine.length) await audit(req.user.name, 'Squares payment', `${mine[0].name}: ${req.body.paid ? 'paid' : 'not paid'} (${mine.length})`);
  res.json({ ok: true });
}));

app.delete('/api/admin/squares/:idx', manager(async (req, res) => {
  const idx = Number(req.params.idx);
  const s = (await q('SELECT * FROM squares WHERE idx = ?', [idx]))[0];
  if (!s) return res.json({ ok: true });
  if ((await sqCfg()).scores.some((x) => x)) bad(400, 'A score is already entered, so squares can no longer be released.');
  await q('DELETE FROM squares WHERE idx = ?', [idx]);
  await audit(req.user.name, 'Released a square', `${s.name}, square ${idx + 1}`);
  res.json({ ok: true });
}));

app.post('/api/admin/squares/reset', manager(async (req, res) => {
  if (req.body.confirm !== 'RESET') bad(400, 'Confirm the reset.');
  const cfg = await sqCfg();
  await q('DELETE FROM squares WHERE idx >= 0');
  await sqSave({ ...SQ_DEFAULT, price: cfg.price, limit: cfg.limit, payouts: cfg.payouts });
  await audit(req.user.name, 'Cleared the whole squares board', '');
  res.json({ ok: true });
}));

app.post('/api/admin/refresh', manager(async (req, res) => {
  const week = parseWeek(req.body.week);
  const ok = await ensureFresh(week, true);
  if (!ok) bad(502, 'The score feed did not answer. Try again in a minute.');
  res.json({ ok: true });
}));

// A scheduler (see the README) opens this address at 5 AM Eastern to wake the site and run the
// daily update. It only reads public scores, and it runs at most once every 10 minutes.
app.get('/api/daily-update', h(async (req, res) => {
  const last = Number(await getMeta('daily_at')) || 0;
  if (Date.now() - last < 10 * 60e3) return res.json({ ok: true, skipped: 'Already ran in the last 10 minutes.', summary: await getMeta('daily_summary') });
  // Answer right away (schedulers give up after a few seconds); the update finishes in the background.
  dailyUpdate('Scheduled wake-up').catch((e) => console.error('Daily update failed:', e.message));
  res.json({ ok: true, started: true });
}));

app.post('/api/admin/daily-update', manager(async (req, res) => {
  const r = await dailyUpdate('Run by ' + req.user.name);
  if (!r.ok) bad(502, 'The score feed did not answer for every week. Try again in a minute.');
  res.json(r);
}));

app.get('/api/admin/log', staff(async (req, res) => {
  const kinds = ['login', 'pick', 'signup', 'squares', 'manager', 'system'];
  const where = ['ts < ?'], args = [Number(req.query.before) || Date.now() + 1];
  if (kinds.includes(req.query.kind)) { where.push('kind = ?'); args.push(req.query.kind); }
  const who = String(req.query.who || '').trim().toLowerCase().slice(0, 40);
  if (who) { where.push('LOWER(actor) LIKE ?'); args.push('%' + who.replace(/[%_]/g, '') + '%'); }
  const rows = await q(`SELECT ts, actor, action, detail, kind, week, team FROM audit WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT 201`, args);
  const more = rows.length > 200;
  const games = await q('SELECT * FROM games WHERE season = ?', [SEASON]);
  // A team is only shown once its game has locked, exactly as on the standings.
  const log = rows.slice(0, 200).map((r) => {
    let detail = r.detail || '';
    if (r.team) {
      const g = games.find((x) => x.week === r.week && (x.home === r.team || x.away === r.team));
      detail += g && !gameLocked(g) ? 'team hidden until the game locks' : r.team;
    }
    return { ts: r.ts, actor: r.actor, action: r.action, detail, kind: r.kind || 'manager' };
  });
  res.json({ dailyAt: Number(await getMeta('daily_at')) || null, dailySummary: await getMeta('daily_summary'), dailyHour: DAILY_HOUR,
    canRun: req.user.role === 'manager', more, log });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------------------------------------------------------------- startup

async function seedFromSpreadsheet() {
  const done = await q("SELECT value FROM meta WHERE key = 'seeded'");
  if (done.length) return;
  const file = path.join(__dirname, 'seed', 'league.json');
  if (!fs.existsSync(file)) return;
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = [];
  for (const p of seed.players) {
    const id = uid();
    await q(`INSERT INTO users (id, username, name, role, is_player, paid, active, setup_token, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, await uniqueUsername(p.name), p.name, ['manager', 'support'].includes(p.role) ? p.role : 'player', 1, p.paid ? 1 : 0, 1, uid() + uid(), Date.now()]);
    for (const k of p.picks) {
      rows.push([id, k.week, k.team, k.points, k.points > 0 ? 'W' : k.points < 0 ? 'L' : 'T', 1,
        'From the spreadsheet', Date.now(), 'Import']);
    }
  }
  for (let i = 0; i < rows.length; i += 40) {
    const chunk = rows.slice(i, i + 40);
    await q(`INSERT INTO picks (user_id, week, team, points, result, manual, note, updated_at, updated_by)
             VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`, chunk.flat());
  }
  await q("INSERT INTO meta (key, value) VALUES ('league', ?)", [seed.league || 'Survivor League']);
  await q("INSERT INTO meta (key, value) VALUES ('seeded', ?)", [String(Date.now())]);
  console.log(`Loaded ${seed.players.length} players and ${rows.length} picks from the spreadsheet.`);
}

async function ensureManagerAccount() {
  // The "manager" login is the set-up account: it exists so someone can log in on day one and
  // hand out the players' setup links. It is created once; a league manager can remove it later.
  const setupAccount = (await q("SELECT id FROM users WHERE username = 'manager'"))[0];
  if (setupAccount && (await managerCount())) return;
  let pw = process.env.MANAGER_PASSWORD;
  const generated = !pw;
  if (generated) pw = crypto.randomBytes(6).toString('base64url');
  const existing = (await q("SELECT * FROM users WHERE username = 'manager'"))[0];
  if (existing) {
    await q("UPDATE users SET role = 'manager', active = 1, pass_hash = ? WHERE id = ?", [await hashPassword(pw), existing.id]);
  } else {
    await q(`INSERT INTO users (id, username, name, role, is_player, paid, active, pass_hash, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
      [uid(), 'manager', 'League Manager', 'manager', 0, 0, 1, await hashPassword(pw), Date.now()]);
  }
  console.log('Created the league manager login. Username: manager');
  if (generated) console.log(`Temporary manager password: ${pw}   (set MANAGER_PASSWORD to choose your own)`);
}

async function loadSeason() {
  for (let w = 1; w <= WEEKS; w++) await ensureFresh(w);
  for (let w = 1; w <= WEEKS; w++) await scoreWeek(w);
}

async function main() {
  db = await open();
  app.listen(PORT, () => console.log(`Survivor league running on port ${PORT} (${db.kind})`));
  await seedFromSpreadsheet();
  await ensureManagerAccount();
  await q('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  ready = true;
  dailyDate = await getMeta('daily_date');
  loadSeason().catch((e) => console.error('Season load failed:', e.message)).then(dailyTick);
  setInterval(dailyTick, 60e3).unref(); // a clock check only; it touches the database once a day
}

main().catch((e) => { console.error(e); process.exit(1); });
