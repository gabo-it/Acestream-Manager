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

CREATE TABLE IF NOT EXISTS favorite_channels (
  channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watch_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  watched_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_watch_history_channel_time ON watch_history (channel_id, watched_at DESC);

-- Una riga per ogni verifica stato (programmata o manuale) di ogni canale:
-- da qui nasce la percentuale di uptime per canale nella pagina Health.
CREATE TABLE IF NOT EXISTS channel_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  checked_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_status_history_channel_time ON channel_status_history (channel_id, checked_at DESC);

-- Cronologia dei job in background (refresh EPG, controllo canali,
-- auto-refresh sorgenti, indice calcio): una riga per esecuzione, con
-- esito, dettaglio e durata — la tabella "Job history" della pagina Health.
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  detail TEXT DEFAULT '',
  started_at TEXT DEFAULT (datetime('now')),
  duration_ms INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_job_runs_time ON job_runs (started_at DESC);
`);

// v3.8.0 introduceva la tabella search_sites (pagina "Search sites",
// rimossa in v3.9.0 perché troppo complicata): chi l'aveva provata trova
// qui la pulizia automatica, le installazioni che non l'hanno mai avuta
// non notano nulla.
db.exec('DROP TABLE IF EXISTS search_sites');

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

// ---------- Preferiti e cronologia ----------

// I preferiti sono un elenco piccolo e minacciato solo dal delete del
// canale (ON DELETE CASCADE lo gestisce); nessun limite di dimensione.
function isFavoriteChannel(channelId) {
  return !!db.prepare('SELECT 1 FROM favorite_channels WHERE channel_id = ?').get(channelId);
}

// Toggle: true se ORA è tra i preferiti, false se è stato rimosso.
function toggleFavoriteChannel(channelId) {
  if (isFavoriteChannel(channelId)) {
    db.prepare('DELETE FROM favorite_channels WHERE channel_id = ?').run(channelId);
    return false;
  }
  db.prepare('INSERT OR IGNORE INTO favorite_channels (channel_id) VALUES (?)').run(channelId);
  return true;
}

function getFavoriteChannelIds() {
  return new Set(db.prepare('SELECT channel_id FROM favorite_channels').all().map((r) => r.channel_id));
}

// Una riga per ogni apertura della pagina watch; teniamo solo l'ultima
// 100 — è una cronologia "continua a guardare", non un archivio.
function recordWatch(channelId) {
  db.prepare('INSERT INTO watch_history (channel_id) VALUES (?)').run(channelId);
  db.prepare(
    `DELETE FROM watch_history WHERE id NOT IN (
       SELECT id FROM watch_history ORDER BY id DESC LIMIT 100
     )`
  ).run();
}

// Ultimi canali guardati, uno riga per canale (l'apertura più recente),
// il più recente prima — base del widget "Continua a guardare". Il tempo
// torna in epoch ms (sqlite conserva "YYYY-MM-DD HH:MM:SS" UTC: lo
// convertiamo qui, la vista formatta solo numeri).
function getRecentlyWatched(limit = 6) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.logo_url,
              CAST(strftime('%s', MAX(h.watched_at)) AS INTEGER) * 1000 AS last_watched_ms
       FROM watch_history h
       JOIN channels c ON c.id = h.channel_id
       GROUP BY h.channel_id
       ORDER BY last_watched_ms DESC
       LIMIT ?`
    )
    .all(limit);
}

// ---------- Storico stato canali e job ----------

// Quante verifiche tenere per canale: con il check giornaliero sono due
// mesi di storia, con check orari almeno un paio di giorni densi. Pruning
// per canale a ogni inserimento: la tabella non cresce oltre il tetto.
const STATUS_HISTORY_PER_CHANNEL = 60;

function addStatusHistory(channelId, status) {
  db.prepare('INSERT INTO channel_status_history (channel_id, status) VALUES (?, ?)').run(channelId, status);
  db.prepare(
    `DELETE FROM channel_status_history WHERE channel_id = ? AND id NOT IN (
       SELECT id FROM channel_status_history WHERE channel_id = ? ORDER BY id DESC LIMIT ?
     )`
  ).run(channelId, channelId, STATUS_HISTORY_PER_CHANNEL);
}

// Affidabilità per canale sulla finestra conservata: conteggio verifiche,
// quante online, ultima verifica. Uptime in percentuale arrotondata;
// i tempi tornano in epoch ms (stessa conversione di getRecentlyWatched).
function getStatusStats() {
  const rows = db
    .prepare(
      `SELECT channel_id,
              COUNT(*) AS checks,
              SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online_count,
              CAST(strftime('%s', MAX(checked_at)) AS INTEGER) * 1000 AS last_check_ms
       FROM channel_status_history
       GROUP BY channel_id`
    )
    .all();
  const map = new Map();
  for (const r of rows) {
    map.set(r.channel_id, {
      checks: r.checks,
      onlineCount: r.online_count || 0,
      uptimePct: r.checks ? Math.round((100 * (r.online_count || 0)) / r.checks) : null,
      lastCheckMs: r.last_check_ms || null,
    });
  }
  return map;
}

// Registro di basso livello: una riga per esecuzione di un job.
function recordJobRun(job, status, detail = '', durationMs = 0) {
  try {
    db.prepare('INSERT INTO job_runs (job, status, detail, duration_ms) VALUES (?, ?, ?, ?)').run(
      job,
      status,
      String(detail || '').slice(0, 500),
      Math.max(0, Math.round(durationMs))
    );
    // Conservazione: una settimana di storia, come concordato — più un tetto
    // di sicurezza a 1000 righe che protegge da burst di job (il limite di
    // solo righe, prima, rendeva la ritenzione effettiva imprevedibile).
    db.prepare(`DELETE FROM job_runs WHERE started_at < datetime('now', '-7 days')`).run();
    db.prepare(
      `DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT 1000)`
    ).run();
  } catch (err) {
    // La registrazione di un job non deve mai far fallire il job stesso.
    console.error('[jobs] record failed:', err.message);
  }
}

// Esegue fn() registrando esito, dettaglio e durata. fn può restituire
// una stringa (o {detail, warnings}) come dettaglio dell'esito positivo;
// un'eccezione diventa una riga 'error' e viene ri-lanciata: chi chiama
// decide cosa farne (le rotte HTTP di solito la loggano e vanno avanti).
async function runJob(job, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const detail = typeof result === 'object' && result !== null && 'detail' in result ? result.detail : result;
    const warnings = typeof result === 'object' && result !== null && result.warnings ? result.warnings : 0;
    recordJobRun(job, warnings ? 'partial' : 'ok', detail, Date.now() - startedAt);
    return result;
  } catch (err) {
    recordJobRun(job, 'error', err.message, Date.now() - startedAt);
    throw err;
  }
}

function getJobRuns(limit = 60) {
  return db
    .prepare(
      `SELECT job, status, detail, duration_ms,
              CAST(strftime('%s', started_at) AS INTEGER) * 1000 AS started_ms
       FROM job_runs ORDER BY id DESC LIMIT ?`
    )
    .all(limit);
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

module.exports = {
  db,
  getSetting,
  setSetting,
  isFavoriteChannel,
  toggleFavoriteChannel,
  getFavoriteChannelIds,
  recordWatch,
  getRecentlyWatched,
  addStatusHistory,
  getStatusStats,
  recordJobRun,
  runJob,
  getJobRuns,
};
