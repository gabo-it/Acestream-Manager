const { XMLParser } = require('fast-xml-parser');
const { db, getSetting, setSetting } = require('./db');

// I limiti di espansione entità di default (introdotti da fast-xml-parser
// come protezione contro attacchi XML entity-bomb) sono pensati per input
// arbitrario/non fidato. Le nostre fonti EPG sono URL scelti esplicitamente
// dall'utente in Impostazioni, non input di sconosciuti — e il default
// (maxTotalExpansions: 1000) è troppo basso per alcuni feed XMLTV legittimi
// che usano molte entità personalizzate per la codifica caratteri (es. la
// guida tedesca di open-epg.com, che ne usa oltre 1000 e altrimenti fallisce
// con "Entity expansion limit exceeded"). Alziamo il limite invece di
// disabilitarlo del tutto, per mantenere comunque una protezione di base.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: {
    enabled: true,
    maxEntitySize: 50000, // default 10000
    maxTotalExpansions: 20000, // default 1000 — quello che scattava sul feed tedesco
    maxExpandedLength: 1000000, // default 100000
    maxEntityCount: 5000, // default 100
  },
});

// Formato data XMLTV tipico: 20240115120000 +0100
function parseXmltvTime(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  iso += tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// Alcuni tag XMLTV (title, desc) possono comparire più volte per lingue
// diverse: normalizziamo sempre al primo valore testuale disponibile.
function textOf(field) {
  if (field == null) return '';
  const first = Array.isArray(field) ? field[0] : field;
  if (typeof first === 'object') return first['#text'] ?? '';
  return String(first);
}

async function fetchXmltv(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AceStreamManager/1.0)',
      Accept: 'application/xml,text/xml,*/*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  if (!xml.includes('<tv')) throw new Error('la risposta non sembra un XMLTV valido');
  return parser.parse(xml);
}

async function refreshEpg() {
  const urlsRaw = getSetting('epg_urls', '');
  const urls = urlsRaw.split(',').map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    setSetting('epg_last_result', 'Nessuna sorgente EPG configurata.');
    return { imported: 0, sources: 0, errors: [] };
  }

  const allPrograms = [];
  const allEpgChannels = new Map(); // tvg_id -> { displayName, logoUrl } (dedup tra sorgenti)
  const errors = [];
  for (const url of urls) {
    try {
      const data = await fetchXmltv(url);

      const rawChannels = data?.tv?.channel;
      const channelList = Array.isArray(rawChannels) ? rawChannels : rawChannels ? [rawChannels] : [];
      for (const c of channelList) {
        const tvgId = c['@_id'];
        const displayName = textOf(c['display-name']);
        const icon = Array.isArray(c.icon) ? c.icon[0] : c.icon;
        const logoUrl = icon?.['@_src'] || '';
        if (tvgId && displayName && !allEpgChannels.has(tvgId)) {
          allEpgChannels.set(tvgId, { displayName, logoUrl });
        }
      }

      const rawProgrammes = data?.tv?.programme;
      const list = Array.isArray(rawProgrammes) ? rawProgrammes : rawProgrammes ? [rawProgrammes] : [];
      let countForSource = 0;
      for (const p of list) {
        const start = parseXmltvTime(p['@_start']);
        const stop = parseXmltvTime(p['@_stop']);
        const tvgId = p['@_channel'];
        const title = textOf(p.title);
        const desc = textOf(p.desc);
        if (start && stop && tvgId && title) {
          allPrograms.push({ tvgId, title, desc, start, stop });
          countForSource += 1;
        }
      }
      if (countForSource === 0) {
        errors.push(`${url}: nessun <programme> valido trovato (controlla il formato)`);
      }
    } catch (err) {
      console.error(`[epg] Errore importando ${url}:`, err.message);
      errors.push(`${url}: ${err.message}`);
    }
  }

  // Se questo giro non ha prodotto nulla (es. limite di download giornaliero
  // raggiunto sulla sorgente, servizio irraggiungibile, ecc.), NON
  // sovrascriviamo l'EPG già scaricato in precedenza: meglio una guida
  // leggermente vecchia che nessuna guida. Le tabelle vengono aggiornate
  // solo se questo fetch ha davvero prodotto qualcosa.
  if (allPrograms.length === 0 && allEpgChannels.size === 0) {
    const summary =
      `Aggiornamento fallito, mantenuta l'EPG precedente — problemi: ${errors.join(' | ') || 'nessun dato ricevuto'}` +
      ` (${new Date().toLocaleString('it-IT')})`;
    setSetting('epg_last_result', summary);
    console.warn(`[epg] ${summary}`);
    return { imported: 0, sources: urls.length, errors, keptPrevious: true };
  }

  const insertChannel = db.prepare(
    `INSERT INTO epg_channels (tvg_id, display_name, logo_url) VALUES (?, ?, ?)
     ON CONFLICT(tvg_id) DO UPDATE SET display_name = excluded.display_name, logo_url = excluded.logo_url`
  );
  const replaceChannels = db.transaction((channels) => {
    db.prepare('DELETE FROM epg_channels').run();
    for (const [tvgId, { displayName, logoUrl }] of channels) {
      insertChannel.run(tvgId, displayName, logoUrl || '');
    }
  });
  replaceChannels(allEpgChannels);

  const insert = db.prepare(
    'INSERT INTO programs (tvg_id, title, description, start_ts, stop_ts) VALUES (?, ?, ?, ?, ?)'
  );
  const replaceAll = db.transaction((programs) => {
    db.prepare('DELETE FROM programs').run();
    for (const pr of programs) {
      insert.run(pr.tvgId, pr.title, pr.desc, pr.start, pr.stop);
    }
  });
  replaceAll(allPrograms);

  const summary =
    `${allPrograms.length} programmi importati da ${urls.length} sorgenti` +
    (errors.length ? ` — problemi: ${errors.join(' | ')}` : '') +
    ` (${new Date().toLocaleString('it-IT')})`;
  setSetting('epg_last_result', summary);

  console.log(`[epg] ${summary}`);
  return { imported: allPrograms.length, sources: urls.length, errors };
}

function getNowNext(tvgId) {
  if (!tvgId) return { now: null, next: null };
  const now = Date.now();
  const current = db
    .prepare('SELECT * FROM programs WHERE tvg_id = ? AND start_ts <= ? AND stop_ts > ? ORDER BY start_ts LIMIT 1')
    .get(tvgId, now, now);
  const next = db
    .prepare('SELECT * FROM programs WHERE tvg_id = ? AND start_ts > ? ORDER BY start_ts LIMIT 1')
    .get(tvgId, now);
  return { now: current || null, next: next || null };
}

// Programmi di un canale per un singolo giorno (dateStr = 'YYYY-MM-DD').
// I confini del giorno sono calcolati in UTC: dato che gli orari XMLTV sono
// già stati normalizzati in timestamp assoluti durante l'import, è
// un'approssimazione semplice e deterministica (può differire di qualche
// ora dall'ora locale dell'utente a seconda del fuso della sorgente EPG).
function getProgramsForDay(tvgId, dateStr) {
  if (!tvgId) return [];
  const dayStart = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(dayStart)) return [];
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  return db
    .prepare(
      'SELECT * FROM programs WHERE tvg_id = ? AND start_ts < ? AND stop_ts > ? ORDER BY start_ts'
    )
    .all(tvgId, dayEnd, dayStart);
}

module.exports = { refreshEpg, getNowNext, getProgramsForDay };
