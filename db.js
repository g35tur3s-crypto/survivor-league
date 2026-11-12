// Small database layer. Uses Postgres when DATABASE_URL is set (for hosting),
// otherwise a local SQLite file (for trying the app on your own computer).
// All SQL in the app is written with "?" placeholders and works on both.

const path = require('path');
const fs = require('fs');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     username TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     role TEXT NOT NULL DEFAULT 'player',
     is_player INTEGER NOT NULL DEFAULT 1,
     paid INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     pass_hash TEXT,
     setup_token TEXT,
     created_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS games (
     id TEXT PRIMARY KEY,
     season INTEGER NOT NULL,
     week INTEGER NOT NULL,
     kickoff BIGINT NOT NULL,
     home TEXT NOT NULL,
     away TEXT NOT NULL,
     home_score INTEGER,
     away_score INTEGER,
     state TEXT NOT NULL DEFAULT 'pre',
     completed INTEGER NOT NULL DEFAULT 0,
     status_text TEXT,
     fav TEXT,
     line REAL,
     over_under REAL,
     odds_provider TEXT,
     odds_at BIGINT,
     updated_at BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS games_week ON games (season, week)`,
  `CREATE TABLE IF NOT EXISTS picks (
     user_id TEXT NOT NULL,
     week INTEGER NOT NULL,
     team TEXT,
     points INTEGER,
     result TEXT,
     manual INTEGER NOT NULL DEFAULT 0,
     note TEXT,
     updated_at BIGINT NOT NULL,
     updated_by TEXT,
     PRIMARY KEY (user_id, week)
   )`,
  `CREATE TABLE IF NOT EXISTS audit (
     id TEXT PRIMARY KEY,
     ts BIGINT NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     detail TEXT,
     kind TEXT,
     week INTEGER,
     team TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS audit_ts ON audit (ts)`,
  `CREATE TABLE IF NOT EXISTS signups (
     id TEXT PRIMARY KEY,
     season INTEGER NOT NULL,
     name TEXT NOT NULL,
     email TEXT,
     phone TEXT,
     note TEXT,
     created_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS squares (
     idx INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     contact TEXT,
     paid INTEGER NOT NULL DEFAULT 0,
     claimed_at BIGINT NOT NULL,
     added_by TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT
   )`,
];

function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => '$' + ++n);
}

async function open() {
  const url = process.env.DATABASE_URL;
  let db;
  if (url) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT -> number
    const pool = new Pool({ connectionString: url, max: 5 });
    pool.on('error', (e) => console.error('Database connection error:', e.message));
    db = {
      kind: 'postgres',
      async query(sql, params = []) {
        const r = await pool.query(toPg(sql), params);
        return r.rows;
      },
      async close() { await pool.end(); },
    };
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const file = process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'league.db');
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const s = new DatabaseSync(file);
    s.exec('PRAGMA journal_mode = WAL');
    db = {
      kind: 'sqlite',
      async query(sql, params = []) {
        const st = s.prepare(sql);
        if (/^\s*(select|with)\b/i.test(sql) || /\breturning\b/i.test(sql)) return st.all(...params);
        st.run(...params);
        return [];
      },
      async close() { s.close(); },
    };
  }
  for (const stmt of SCHEMA) await db.query(stmt);
  return db;
}

module.exports = { open };
