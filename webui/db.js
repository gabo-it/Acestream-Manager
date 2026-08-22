const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'acestream.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 1,
  last_scraped_at TEXT,
  last_result TEXT DEFAULT '',
  channel_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  acestream_id TEXT NOT NULL UNIQUE,
  category TEXT DEFAULT '',
  logo_url TEXT DEFAULT '',
  tvg_id TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'unknown',
  last_checked_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tvg_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  start_ts INTEGER NOT NULL,
  stop_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_programs_tvgid_time ON programs (tvg_id, start_ts, stop_ts);

CREATE TABLE IF NOT EXISTS epg_channels (
  tvg_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  logo_url TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// --- Migrazione automatica per database creati con schemi precedenti ---
// (CREATE TABLE IF NOT EXISTS non aggiunge colonne a tabelle già esistenti)
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('channels', 'source_id', 'INTEGER REFERENCES sources(id)');
ensureColumn('channels', 'status', "TEXT DEFAULT 'unknown'");
ensureColumn('channels', 'last_checked_at', 'TEXT');
ensureColumn('epg_channels', 'logo_url', "TEXT DEFAULT ''");
ensureColumn('channels', 'imported', 'INTEGER DEFAULT 0');
ensureColumn('sources', 'auto_refresh_hours', 'INTEGER DEFAULT NULL');

// Se acestream_id non ha ancora un vincolo UNIQUE (schema molto vecchio),
// rimuove eventuali duplicati (tiene la riga più recente) e crea l'indice:
// serve perché importChannels() usa ON CONFLICT(acestream_id).
db.exec(`
  DELETE FROM channels
  WHERE id NOT IN (
    SELECT MAX(id) FROM channels GROUP BY acestream_id
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_acestream_id ON channels(acestream_id);
`);

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

module.exports = { db, getSetting, setSetting };
