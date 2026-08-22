const { db } = require('./db');
const { parseM3U } = require('./m3u');

const ACE_LINK_RE = /acestream:\/\/([a-fA-F0-9]{40})/g;
const GETSTREAM_ID_RE = /[?&]id=([a-fA-F0-9]{40})/g;

// Euristica semplice: cerca un'etichetta testuale vicina al link trovato
// (dentro un tag <a>...</a>/<span>...</span> o un campo "name": "..." in JSON).
// Usata solo come fallback per pagine HTML/JSON NON strutturate come M3U.
function guessNameNear(text, index) {
  const before = text.slice(Math.max(0, index - 300), index);
  const after = text.slice(index, index + 300);

  let m = before.match(/>([^<>{}]{2,80})<[^<]*$/);
  if (m) return m[1].trim();

  m = before.match(/"(?:name|title|channel)"\s*:\s*"([^"]{2,80})"[^"]*$/i);
  if (m) return m[1].trim();

  m = after.match(/^[^<>]*>([^<>{}]{2,80})</);
  if (m) return m[1].trim();

  return null;
}

async function scrapeUrl(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AceStreamManager/1.0)' },
    // Timeout generoso: copre anche gateway locali (es. ZeroNet, tipicamente
    // su http://127.0.0.1:43110/<sito>/...) che possono risolvere/sincronizzare
    // più lentamente di un sito web normale.
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();

  // Se il contenuto è già una playlist M3U (caso più comune: liste che
  // contengono #EXTM3U/#EXTINF con tvg-logo, group-title, ecc.), usiamo il
  // parser dedicato che preserva nome, logo, categoria e tvg-id — l'euristica
  // generica sotto è pensata per pagine HTML qualsiasi e li perderebbe.
  if (/#EXTM3U/i.test(text) || /#EXTINF/i.test(text)) {
    return parseM3U(text);
  }

  const found = new Map(); // acestream_id -> nome

  for (const re of [ACE_LINK_RE, GETSTREAM_ID_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const id = m[1].toLowerCase();
      if (!found.has(id)) {
        found.set(id, guessNameNear(text, m.index) || `Canale ${id.slice(0, 8)}`);
      }
    }
  }

  return Array.from(found.entries()).map(([acestream_id, name]) => ({ acestream_id, name }));
}

// Inserisce/aggiorna una lista di canali (upsert su acestream_id).
// sourceId può essere null per import "una tantum" non legati a una sorgente salvata.
function importChannels(rows, sourceId = null) {
  const stmt = db.prepare(`
    INSERT INTO channels (name, acestream_id, category, logo_url, tvg_id, source_id, imported)
    VALUES (@name, @acestream_id, @category, @logo_url, @tvg_id, @sourceId, 1)
    ON CONFLICT(acestream_id) DO UPDATE SET
      name = excluded.name,
      category = CASE WHEN excluded.category != '' THEN excluded.category ELSE channels.category END,
      logo_url = CASE WHEN excluded.logo_url != '' THEN excluded.logo_url ELSE channels.logo_url END,
      tvg_id = CASE WHEN excluded.tvg_id != '' THEN excluded.tvg_id ELSE channels.tvg_id END,
      source_id = COALESCE(excluded.source_id, channels.source_id),
      imported = 1
  `);
  const insertMany = db.transaction((items) => {
    for (const r of items) {
      stmt.run({
        name: r.name,
        acestream_id: r.acestream_id,
        category: r.category || '',
        logo_url: r.logo_url || '',
        tvg_id: r.tvg_id || '',
        sourceId,
      });
    }
  });
  insertMany(rows);
  return rows.length;
}

async function refreshSource(source) {
  try {
    const rows = await scrapeUrl(source.url);
    importChannels(rows, source.id);
    db.prepare(
      "UPDATE sources SET last_scraped_at = datetime('now'), channel_count = ?, last_result = ? WHERE id = ?"
    ).run(rows.length, `${rows.length} canali trovati`, source.id);
    return rows.length;
  } catch (err) {
    db.prepare("UPDATE sources SET last_scraped_at = datetime('now'), last_result = ? WHERE id = ?").run(
      `Errore: ${err.message}`,
      source.id
    );
    throw err;
  }
}

// Sorgenti con "auto_refresh_hours" impostato (non NULL) vengono aggiornate
// automaticamente da sole quando è passato abbastanza tempo dall'ultimo
// aggiornamento — ognuna col proprio intervallo. Le altre (manuali) vengono
// toccate solo dal popup di selezione o da "Aggiorna tutte le sorgenti attive".
async function refreshDueSources() {
  const sources = db
    .prepare('SELECT * FROM sources WHERE enabled = 1 AND auto_refresh_hours IS NOT NULL')
    .all();
  let total = 0;
  const now = Date.now();
  for (const s of sources) {
    const lastMs = s.last_scraped_at ? Date.parse(`${s.last_scraped_at.replace(' ', 'T')}Z`) : 0;
    const dueMs = (Number.isNaN(lastMs) ? 0 : lastMs) + s.auto_refresh_hours * 60 * 60 * 1000;
    if (now >= dueMs) {
      try {
        total += await refreshSource(s);
      } catch (err) {
        console.error(`[scraper] auto-refresh fallito per ${s.url}:`, err.message);
      }
    }
  }
  return total;
}

async function refreshAllSources() {
  const sources = db.prepare('SELECT * FROM sources WHERE enabled = 1').all();
  let total = 0;
  for (const s of sources) {
    try {
      total += await refreshSource(s);
    } catch (err) {
      console.error(`[scraper] errore su ${s.url}:`, err.message);
    }
  }
  return total;
}

module.exports = { scrapeUrl, importChannels, refreshSource, refreshAllSources, refreshDueSources };
