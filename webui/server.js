require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const { db, getSetting, setSetting } = require('./db');
const { refreshEpg, getNowNext } = require('./epg');
const { buildM3U, buildXmltv } = require('./playlist');
const { scrapeUrl, importChannels, refreshSource, refreshAllSources, refreshDueSources } = require('./scraper');
const { parseM3U } = require('./m3u');
const { checkAndStore, checkAllChannels } = require('./statuscheck');
const { getEngineParams, getEngineParamsForDisplay, getEngineBaseUrl, isEnvFileWritable, isMountedAsDirectory } = require('./engineConfig');
const { searchAceStream, CATEGORIES } = require('./search');
const { getTranslator, SUPPORTED_LANGUAGES } = require('./i18n');
const { getProgramsForDay } = require('./epg');
const { getCachedTranslations } = require('./translator');
const { suggestTvgIds, suggestLogosFromSearch } = require('./suggestions');
const { searchTeams, getTeamMatches, getUpcomingTeamMatches, getBroadcastersByCountry, parseTeamUrl } = require('./football');
const { getStats, stopSession, getStatsEngineUrl, setStatsEngineUrl, isUsingDefaultEngine } = require('./statsProxy');
const { proxyTs, proxyHlsManifest, proxyHlsPassthrough } = require('./streamProxy');
const { remuxToFmp4 } = require('./remux');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname + '/public'));

const APP_VERSION = require('./package.json').version;

// Per le rotte che rispondono con testo/JSON grezzo (errori 404/400/500) senza
// passare da render(): senza questo, quei messaggi restavano sempre in
// italiano anche con la lingua impostata su inglese.
function reqT() {
  return getTranslator(getSetting('ui_language', 'en'));
}

// Piccolo helper per renderizzare le viste dentro il layout comune.
// Inietta sempre t()/lang così ogni vista può tradurre senza doverli passare a mano.
// Se locals.titleKey è presente, il <title> del browser viene tradotto di conseguenza.
function render(res, view, locals = {}) {
  const lang = getSetting('ui_language', 'en');
  const t = getTranslator(lang);
  const title = locals.titleKey ? t(locals.titleKey) : locals.title;
  const fullLocals = { ...locals, title, t, lang, appVersion: APP_VERSION };
  app.render(view, fullLocals, (err, body) => {
    if (err) {
      console.error(err);
      return res.status(500).send(reqT()('errors.render_failed'));
    }
    res.render('layout', { ...fullLocals, body });
  });
}

app.get('/lang/:lang', (req, res) => {
  if (SUPPORTED_LANGUAGES.includes(req.params.lang)) {
    setSetting('ui_language', req.params.lang);
  }
  res.redirect(req.get('Referer') || '/');
});

// ---------- Canali ----------

app.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  const channels = q
    ? db
        .prepare('SELECT * FROM channels WHERE name LIKE ? OR category LIKE ? ORDER BY sort_order, name COLLATE NOCASE')
        .all(`%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM channels ORDER BY sort_order, name COLLATE NOCASE').all();

  const epgByChannel = {};
  const tvgIdCounts = {};
  for (const ch of channels) {
    epgByChannel[ch.id] = getNowNext(ch.tvg_id);
    if (ch.tvg_id) tvgIdCounts[ch.tvg_id] = (tvgIdCounts[ch.tvg_id] || 0) + 1;
  }

  // Titoli "in onda ora" / "a seguire" mostrati nella lista canali, se una
  // lingua guida è impostata E la checkbox "Traduci nella webui" è attiva
  // in Sorgenti. Legge SOLO dalla cache (mai una chiamata di rete a
  // LibreTranslate): questa pagina deve restare sempre istantanea, non
  // aspettare mai una traduzione in corso. Le vere chiamate di rete
  // avvengono solo nel job in background (vedi epg.js) — un titolo non
  // ancora tradotto qui resta nella lingua originale fino al prossimo giro.
  const epgLanguage = getSetting('epg_language', '');
  if (epgLanguage && getSetting('epg_translate_ui', '1') === '1') {
    const flatTitles = [];
    const refs = [];
    for (const epg of Object.values(epgByChannel)) {
      if (epg.now) {
        flatTitles.push(epg.now.title);
        refs.push(epg.now);
      }
      if (epg.next) {
        flatTitles.push(epg.next.title);
        refs.push(epg.next);
      }
    }
    if (flatTitles.length) {
      const translated = getCachedTranslations(flatTitles, epgLanguage);
      refs.forEach((ref, i) => {
        ref.title = translated[i];
      });
    }
  }

  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  render(res, 'index', { titleKey: 'channels.title', channels, epgByChannel, tvgIdCounts, q, acexyBaseUrl });
});

app.get('/channels/new', (req, res) => {
  let prefill = null;
  if (req.query.duplicate_from) {
    const source = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.query.duplicate_from);
    if (source) {
      prefill = { name: source.name, category: source.category, tvg_id: source.tvg_id, logo_url: source.logo_url };
    }
  }
  render(res, 'channel_form', { titleKey: 'form.new_title', channel: null, prefill });
});

app.post('/channels/new', (req, res) => {
  const { name, acestream_id, category, logo_url, tvg_id } = req.body;
  db.prepare(
    'INSERT INTO channels (name, acestream_id, category, logo_url, tvg_id) VALUES (?, ?, ?, ?, ?)'
  ).run(name, acestream_id.toLowerCase(), category || '', logo_url || '', tvg_id || '');
  res.redirect('/');
});

app.get('/channels/:id/edit', (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).send(reqT()('errors.channel_not_found'));
  render(res, 'channel_form', { titleKey: 'form.edit_title', channel });
});

app.post('/channels/:id/edit', (req, res) => {
  const { name, acestream_id, category, logo_url, tvg_id } = req.body;
  db.prepare(
    'UPDATE channels SET name = ?, acestream_id = ?, category = ?, logo_url = ?, tvg_id = ? WHERE id = ?'
  ).run(name, acestream_id.toLowerCase(), category || '', logo_url || '', tvg_id || '', req.params.id);
  res.redirect('/');
});

app.post('/channels/:id/delete', (req, res) => {
  db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);
  res.redirect('/');
});

app.post('/channels/:id/check-status', async (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (channel) {
    try {
      await checkAndStore(channel);
    } catch (err) {
      console.error('[status] errore:', err.message);
    }
  }
  res.redirect('/');
});

app.post('/channels/check-all', async (req, res) => {
  try {
    await checkAllChannels();
  } catch (err) {
    console.error('[status] errore verifica di massa:', err.message);
  }
  res.redirect('/');
});

app.post('/channels/bulk-delete', (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.filter(Boolean);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM channels WHERE id IN (${placeholders})`).run(...ids);
  }
  res.redirect('/');
});

// Programmazione giornaliera di un canale (usata dal pannello espandibile in AJAX).
app.get('/channels/:id/schedule', async (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: reqT()('errors.channel_not_found') });

  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
    ? req.query.date
    : new Date().toISOString().slice(0, 10);

  if (!channel.tvg_id) {
    return res.json({ date, tvgId: null, programs: [] });
  }

  let programs = getProgramsForDay(channel.tvg_id, date).map((p) => ({
    title: p.title,
    description: p.description,
    start: p.start_ts,
    stop: p.stop_ts,
  }));

  // Titoli del pannello Programmazione, se una lingua guida è impostata E
  // la checkbox "Traduci nella webui" è attiva — stessa checkbox e stessa
  // logica della lista canali. Legge SOLO dalla cache (mai una chiamata
  // di rete a LibreTranslate): questa pagina deve restare sempre
  // istantanea, non aspettare mai una traduzione in corso. Le vere
  // chiamate di rete avvengono solo nel job in background (vedi epg.js) —
  // un titolo non ancora tradotto qui resta nella lingua originale fino
  // al prossimo giro.
  const epgLanguage = getSetting('epg_language', '');
  if (epgLanguage && programs.length && getSetting('epg_translate_ui', '1') === '1') {
    const translatedTitles = getCachedTranslations(programs.map((p) => p.title), epgLanguage);
    programs = programs.map((p, i) => ({ ...p, title: translatedTitles[i] }));
  }

  const [y, m, d] = date.split('-').map(Number);
  const prevDate = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  const nextDate = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);

  res.json({ date, prevDate, nextDate, tvgId: channel.tvg_id, programs });
});

// Suggerimenti tvg-id basati sull'EPG importato (matching sul nome canale),
// più loghi suggeriti dalla ricerca AceStream (non dipende dall'EPG).
app.get('/channels/:id/tvg-suggestions', async (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: reqT()('errors.channel_not_found') });

  let logoSuggestions = [];
  try {
    logoSuggestions = await suggestLogosFromSearch(channel.name);
  } catch (err) {
    console.error('[suggestions] ricerca loghi fallita:', err.message);
  }

  res.json({ suggestions: await suggestTvgIds(channel.name), logoSuggestions });
});

// Ricerca manuale diretta nell'EPG importato: nessuno scoring automatico,
// nessuna dipendenza da traduzione/API esterne — solo un LIKE sul nome.
// Sempre disponibile come alternativa affidabile ai suggerimenti automatici.
app.get('/epg-channels/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const rows = db
    .prepare('SELECT tvg_id, display_name, logo_url FROM epg_channels WHERE display_name LIKE ? LIMIT 15')
    .all(`%${q}%`);
  res.json({
    results: rows.map((r) => ({
      tvgId: r.tvg_id,
      displayName: r.display_name,
      logoUrl: r.logo_url && /^https?:\/\//i.test(r.logo_url) ? r.logo_url : '',
    })),
  });
});

app.post('/channels/:id/tvg-id', (req, res) => {
  const tvgId = (req.body.tvg_id || '').trim();
  const logoUrl = (req.body.logo_url || '').trim();
  console.log(`[tvg-id] richiesta per canale ${req.params.id}: tvg_id="${tvgId}" logo_url="${logoUrl}" body-ricevuto=`, req.body);
  let result;
  if (logoUrl) {
    result = db.prepare('UPDATE channels SET tvg_id = ?, logo_url = ? WHERE id = ?').run(tvgId, logoUrl, req.params.id);
  } else {
    result = db.prepare('UPDATE channels SET tvg_id = ? WHERE id = ?').run(tvgId, req.params.id);
  }
  console.log(`[tvg-id] righe modificate: ${result.changes}`);
  if (result.changes === 0) {
    console.warn(`[tvg-id] ATTENZIONE: nessuna riga aggiornata — canale ${req.params.id} non trovato?`);
  }
  const after = db.prepare('SELECT id, name, tvg_id, logo_url FROM channels WHERE id = ?').get(req.params.id);
  console.log('[tvg-id] canale dopo l\'update:', after);
  res.json({ ok: true, tvgId, logoUrl, changes: result.changes, channel: after });
});

// Applica solo il logo (suggerimento da ricerca, senza tvg-id associato):
// a differenza della rotta sopra, non tocca il tvg-id già impostato.
app.post('/channels/:id/logo', (req, res) => {
  const logoUrl = (req.body.logo_url || '').trim();
  console.log(`[logo] richiesta per canale ${req.params.id}: logo_url="${logoUrl}" body-ricevuto=`, req.body);
  let changes = 0;
  if (logoUrl) {
    const result = db.prepare('UPDATE channels SET logo_url = ? WHERE id = ?').run(logoUrl, req.params.id);
    changes = result.changes;
  } else {
    console.warn('[logo] logo_url vuoto nella richiesta, nessun aggiornamento');
  }
  console.log(`[logo] righe modificate: ${changes}`);
  res.json({ ok: true, logoUrl, changes });
});

// Player web integrato (mpegts.js via MSE): evita che il browser scarichi
// il flusso invece di riprodurlo, attraverso un proxy same-origin (vedi
// streamProxy.js) perché acexy non manda header CORS e le richieste
// fetch() di mpegts.js verrebbero altrimenti bloccate dal browser (a
// differenza della navigazione diretta a un link, che funziona sempre
// perché non passa da CORS).
// NB: usiamo solo MPEG-TS via acexy, non HLS via engine nativo — l'HLS
// nativo richiede riscrivere il manifest e instradare ogni segmento, mai
// verificato contro un manifest reale (nessun accesso di rete in questo
// ambiente di sviluppo) e risultato inaffidabile nell'uso reale (404).
// acexy è invece infrastruttura collaudata (usata anche dalle playlist).
function buildStreamUrls(req, acestreamId) {
  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  const tsUrl = `${acexyBaseUrl}/ace/getstream?id=${acestreamId}`;
  const proxyBase = `${req.protocol}://${req.get('host')}`;
  const tsProxyUrl = `${proxyBase}/stream-proxy/ts/${acestreamId}`;
  return { tsUrl, tsProxyUrl };
}

app.get('/watch/:id', (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).send(reqT()('errors.channel_not_found'));
  const { tsUrl, tsProxyUrl } = buildStreamUrls(req, channel.acestream_id);
  render(res, 'watch', { title: channel.name, channel, streamUrl: tsUrl, tsProxyUrl });
});

// Come /watch/:id ma per contenuti non ancora salvati come canale (es. un
// risultato del tab Cerca su cui l'utente vuole solo provare la riproduzione).
app.get('/watch-direct', (req, res) => {
  const acestreamId = (req.query.id || '').trim();
  const name = (req.query.name || 'Stream').trim();
  if (!/^[a-fA-F0-9]{40}$/.test(acestreamId)) return res.status(400).send(reqT()('errors.invalid_acestream_id'));
  const { tsUrl, tsProxyUrl } = buildStreamUrls(req, acestreamId);
  render(res, 'watch', { title: name, channel: { id: null, name, acestream_id: acestreamId }, streamUrl: tsUrl, tsProxyUrl });
});

// Il pulsante "VLC" NON usa più lo schema vlc:// (VLC non lo registra come
// gestore di default su nessun sistema operativo — serve un tool di terze
// parti installato apposta, quindi cliccarlo di solito non faceva nulla).
// Genera invece un piccolo file .m3u con quel solo canale, scaricabile: la
// maggior parte delle installazioni di VLC si registra come gestore
// predefinito per i file .m3u/.m3u8, quindi aprirlo (o farlo aprire in
// automatico dal browser) avvia VLC in modo molto più affidabile.
function sendSingleChannelM3U(res, name, acestreamId, streamUrl) {
  const body = `#EXTM3U\n#EXTINF:-1,${name}\n${streamUrl}\n`;
  const safeName = name.replace(/[^a-z0-9\- ]/gi, '').trim() || 'canale';
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.m3u"`);
  res.send(body);
}

app.get('/channels/:id/vlc.m3u', (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).send(reqT()('errors.channel_not_found'));
  const { tsUrl } = buildStreamUrls(req, channel.acestream_id);
  sendSingleChannelM3U(res, channel.name, channel.acestream_id, tsUrl);
});

app.get('/vlc-direct.m3u', (req, res) => {
  const acestreamId = (req.query.id || '').trim();
  const name = (req.query.name || 'Stream').trim();
  if (!/^[a-fA-F0-9]{40}$/.test(acestreamId)) return res.status(400).send(reqT()('errors.invalid_acestream_id'));
  const { tsUrl } = buildStreamUrls(req, acestreamId);
  sendSingleChannelM3U(res, name, acestreamId, tsUrl);
});

// ---------- Proxy same-origin per il player web (bypass CORS) ----------

app.get('/stream-proxy/ts/:id', proxyTs);
app.get('/stream-proxy/hls/:id/manifest.m3u8', proxyHlsManifest);
app.get('/stream-proxy/hls/:id/*', proxyHlsPassthrough);

// Fallback finale del player web: remux server-side a MP4 frammentato via
// ffmpeg (vedi remux.js), usato solo quando mpegts.js/MSE ha già fallito
// tutti i suoi tentativi normali. Il processo ffmpeg va terminato quando
// il client si disconnette, altrimenti resta a girare a vuoto.
app.get('/stream-proxy/fmp4/:id', (req, res) => {
  if (!/^[a-fA-F0-9]{40}$/.test(req.params.id)) return res.status(400).end();
  const ffmpeg = remuxToFmp4(req.params.id, res);
  req.on('close', () => {
    if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
  });
});

// ---------- Sorgenti (scraping ricorrente) ----------

app.get('/sources', (req, res) => {
  const sources = db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all();
  render(res, 'sources', {
    titleKey: 'sources.title',
    sources,
    epgUrls: getSetting('epg_urls', ''),
    epgRefreshHours: getSetting('epg_refresh_hours', '6'),
    epgLastResult: getSetting('epg_last_result', ''),
    epgLanguage: getSetting('epg_language', ''),
    libretranslateUrl: getSetting('libretranslate_url', ''),
    // Default "1" (attivo) per entrambe: chi imposta una lingua guida per
    // la prima volta si aspetta che faccia qualcosa, senza dover scoprire
    // due checkbox nascoste. Chi ha un EPG molto grande e vuole evitare il
    // costo CPU può disattivare quella dell'export in un secondo momento,
    // con l'avviso ben visibile accanto al campo.
    epgTranslateUi: getSetting('epg_translate_ui', '1') === '1',
    epgTranslateXml: getSetting('epg_translate_xml', '1') === '1',
    epgTranslateDays: getSetting('epg_translate_days', '2'),
  });
});

app.post('/sources/epg', (req, res) => {
  setSetting('epg_urls', req.body.epg_urls || '');
  const hours = Math.max(1, Math.min(24, parseInt(req.body.epg_refresh_hours, 10) || 6));
  setSetting('epg_refresh_hours', String(hours));
  const allowedLangs = new Set(['', 'it', 'en', 'fr', 'es']);
  setSetting('epg_language', allowedLangs.has(req.body.epg_language) ? req.body.epg_language : '');
  // Validazione minimale: solo per evitare di salvare valori palesemente
  // non validi (es. testo libero), non una verifica di raggiungibilità
  // reale — quella la scopriamo comunque al primo tentativo di traduzione.
  // Campo facoltativo: vuoto = traduzione EPG disattivata.
  const url = (req.body.libretranslate_url || '').trim();
  const validUrl = /^https?:\/\/.+/.test(url);
  setSetting('libretranslate_url', validUrl ? url : '');
  // Tra 1 e 14 giorni: un limite superiore di sicurezza, non un valore
  // consigliato — la nota nell'interfaccia avverte di scegliere con
  // attenzione in base a hardware disponibile e velocità di LibreTranslate.
  const days = Math.max(1, Math.min(14, parseInt(req.body.epg_translate_days, 10) || 2));
  setSetting('epg_translate_days', String(days));
  // Checkbox HTML: presenti nel body solo se spuntate, quindi la loro
  // assenza in req.body significa "disattivata", non "campo mancante".
  setSetting('epg_translate_ui', req.body.epg_translate_ui ? '1' : '0');
  setSetting('epg_translate_xml', req.body.epg_translate_xml ? '1' : '0');
  scheduleEpgRefresh();
  res.redirect('/sources');
});

app.post('/sources/epg/refresh', async (req, res) => {
  try {
    await refreshEpg();
  } catch (err) {
    console.error(err);
  }
  res.redirect('/sources');
});

app.post('/sources/new', (req, res) => {
  const url = (req.body.url || '').trim();
  if (url) {
    try {
      db.prepare('INSERT OR IGNORE INTO sources (url) VALUES (?)').run(url);
    } catch (err) {
      console.error('[sources] errore inserimento:', err.message);
    }
  }
  res.redirect('/sources');
});

app.post('/sources/:id/toggle', (req, res) => {
  db.prepare('UPDATE sources SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  res.redirect('/sources');
});

app.post('/sources/:id/schedule', (req, res) => {
  const raw = (req.body.auto_refresh_hours || '').trim();
  const hours = raw === '' ? null : Math.max(1, Math.min(168, parseInt(raw, 10) || 0)) || null;
  db.prepare('UPDATE sources SET auto_refresh_hours = ? WHERE id = ?').run(hours, req.params.id);
  res.redirect('/sources');
});

app.post('/sources/:id/delete', (req, res) => {
  db.prepare('DELETE FROM sources WHERE id = ?').run(req.params.id);
  res.redirect('/sources');
});

app.post('/sources/:id/refresh', async (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (source) {
    try {
      await refreshSource(source);
    } catch (err) {
      console.error('[sources] refresh fallito:', err.message);
    }
  }
  res.redirect('/sources');
});

// Come /sources/:id/refresh ma SENZA importare nulla: restituisce solo
// l'elenco trovato, così l'utente può scegliere quali canali importare
// dal popup di selezione invece di importarli tutti automaticamente.
app.get('/sources/:id/preview', async (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: reqT()('errors.source_not_found') });
  try {
    const rows = await scrapeUrl(source.url);
    res.json({ channels: rows });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Importa solo i canali selezionati nel popup di preview.
app.post('/sources/:id/import-selected', (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: reqT()('errors.source_not_found') });

  const selected = Array.isArray(req.body.channels) ? req.body.channels : [];
  const rows = selected
    .filter((c) => c && /^[a-fA-F0-9]{40}$/.test(c.acestream_id))
    .map((c) => ({
      name: String(c.name || `Canale ${c.acestream_id.slice(0, 8)}`).slice(0, 200),
      acestream_id: c.acestream_id.toLowerCase(),
      category: c.category || '',
      logo_url: c.logo_url || '',
      tvg_id: c.tvg_id || '',
    }));

  if (rows.length) importChannels(rows, source.id);
  db.prepare(
    "UPDATE sources SET last_scraped_at = datetime('now'), channel_count = ?, last_result = ? WHERE id = ?"
  ).run(rows.length, `${rows.length} canali importati (selezione manuale)`, source.id);

  res.json({ imported: rows.length });
});

app.post('/sources/refresh-all', async (req, res) => {
  try {
    await refreshAllSources();
  } catch (err) {
    console.error('[sources] refresh-all fallito:', err.message);
  }
  res.redirect('/sources');
});

// ---------- Importazione (unificata nella pagina Sorgenti) ----------

app.get('/import', (req, res) => res.redirect('/sources'));

app.post('/import/url', async (req, res) => {
  const url = (req.body.url || '').trim();
  if (url) {
    try {
      const rows = await scrapeUrl(url);
      importChannels(rows, null);
    } catch (err) {
      console.error('[import] errore da URL:', err.message);
    }
  }
  res.redirect('/');
});

app.post('/import/m3u-text', (req, res) => {
  const text = req.body.m3u_text || '';
  const rows = parseM3U(text);
  if (rows.length) importChannels(rows, null);
  res.redirect('/');
});

app.post('/import/m3u-file', upload.single('file'), (req, res) => {
  if (req.file) {
    const text = req.file.buffer.toString('utf8');
    const rows = parseM3U(text);
    if (rows.length) importChannels(rows, null);
  }
  res.redirect('/');
});

// ---------- Ricerca (API AceStream) ----------

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  let results = [];
  let error = null;
  if (q || category) {
    try {
      const data = await searchAceStream(q, { category });
      results = data.results;
    } catch (err) {
      error = err.message;
    }
  }
  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  render(res, 'search', { titleKey: 'search.title', q, category, results, error, categories: CATEGORIES, acexyBaseUrl });
});

app.post('/search/import', (req, res) => {
  const { name, infohash, category, logo_url } = req.body;
  if (infohash) {
    importChannels(
      [{ name: name || `Canale ${infohash.slice(0, 8)}`, acestream_id: infohash.toLowerCase(), category, logo_url }],
      null
    );
  }
  res.redirect('/');
});

app.post('/search/import-selected', (req, res) => {
  const selected = Array.isArray(req.body.results) ? req.body.results : [];
  const rows = selected
    .filter((r) => r && /^[a-fA-F0-9]{40}$/.test(r.infohash))
    .map((r) => ({
      name: String(r.name || `Canale ${r.infohash.slice(0, 8)}`).slice(0, 200),
      acestream_id: r.infohash.toLowerCase(),
      category: r.category || '',
      logo_url: r.logo_url || '',
    }));
  if (rows.length) importChannels(rows, null);
  res.json({ imported: rows.length });
});

// ---------- Statistiche stream ----------

app.get('/stats', (req, res) => {
  const channels = db.prepare('SELECT id, name FROM channels ORDER BY name').all();
  const selectedId = req.query.channel || '';
  const selectedChannel = selectedId
    ? db.prepare('SELECT * FROM channels WHERE id = ?').get(selectedId)
    : null;
  render(res, 'stats', {
    titleKey: 'stats.title',
    channels,
    selectedId,
    selectedChannel,
    statsEngineUrl: getStatsEngineUrl(),
    isDefaultEngine: isUsingDefaultEngine(),
  });
});

app.post('/stats/engine', (req, res) => {
  setStatsEngineUrl(req.body.engine_url || '');
  res.redirect('/stats' + (req.body.channel ? `?channel=${req.body.channel}` : ''));
});

app.get('/channels/:id/stats', async (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: reqT()('errors.channel_not_found') });
  try {
    const stats = await getStats(channel);
    res.json(stats);
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post('/channels/:id/stats/stop', async (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (channel) {
    try {
      await stopSession(channel);
    } catch (err) {
      console.error('[stats] errore stop:', err.message);
    }
  }
  res.json({ ok: true });
});

// ---------- Calendario calcio / trasmittenti ----------

app.get('/football', async (req, res) => {
  const team = (req.query.team || '').trim();
  let candidates = [];
  let error = null;
  if (team) {
    try {
      candidates = await searchTeams(team);
    } catch (err) {
      error = err.message;
    }
  }

  // Squadra preferita: salvata come JSON {country, slug, name} in settings.
  // Se impostata, carichiamo qui anche le sue prossime partite (max 5) per
  // la scheda mostrata sotto la ricerca.
  let favoriteTeam = null;
  let favoriteMatches = [];
  let favoriteError = null;
  const favoriteRaw = getSetting('football_favorite_team', '');
  if (favoriteRaw) {
    try {
      favoriteTeam = JSON.parse(favoriteRaw);
      favoriteMatches = await getUpcomingTeamMatches(favoriteTeam.country, favoriteTeam.slug, favoriteTeam.name, 5);
    } catch (err) {
      favoriteError = err.message;
    }
  }

  render(res, 'football', { titleKey: 'football.title', team, candidates, error, favoriteTeam, favoriteMatches, favoriteError });
});

app.post('/football/favorite', (req, res) => {
  const country = (req.body.country || '').trim();
  const slug = (req.body.slug || '').trim();
  const name = (req.body.name || '').trim();
  if (country && slug && name) {
    setSetting('football_favorite_team', JSON.stringify({ country, slug, name }));
  }
  res.redirect('/football');
});

app.post('/football/favorite/clear', (req, res) => {
  setSetting('football_favorite_team', '');
  res.redirect('/football');
});

// Fallback: per squadre non presenti nell'indice locale (fuori dai
// campionati indicizzati), permette di incollare direttamente l'URL della
// pagina squadra su livesoccertv.com.
app.post('/football/team-url', (req, res) => {
  const parsed = parseTeamUrl(req.body.team_url || '');
  if (!parsed) {
    return render(res, 'football', {
      titleKey: 'football.title',
      team: '',
      candidates: [],
      error: reqT()('errors.team_url_not_recognized'),
    });
  }
  res.redirect(`/football/team?country=${encodeURIComponent(parsed.country)}&slug=${encodeURIComponent(parsed.slug)}`);
});

app.get('/football/team', async (req, res) => {
  const country = (req.query.country || '').trim();
  const slug = (req.query.slug || '').trim();
  let name = (req.query.name || '').trim();
  let matches = [];
  let error = null;
  if (!country || !slug) {
    error = 'Parametri mancanti';
  } else {
    try {
      matches = await getTeamMatches(country, slug, name);
      if (!name && matches.resolvedName) name = matches.resolvedName;
    } catch (err) {
      error = err.message;
    }
  }
  render(res, 'football_team', { titleKey: 'football.title', country, slug, name, matches, error });
});

app.get('/football/match', async (req, res) => {
  const matchUrl = (req.query.url || '').trim();
  let coverage = [];
  let error = null;
  if (!matchUrl) {
    error = 'URL mancante';
  } else {
    try {
      coverage = await getBroadcastersByCountry(matchUrl);
    } catch (err) {
      error = err.message;
    }
  }
  render(res, 'football_match', { titleKey: 'football.broadcasters_title', matchUrl, coverage, error });
});

// ---------- Motore (parametri engine) ----------

// Flag esatti elencati nella documentazione ufficiale
// (https://docs.acestream.net/developers/engine-command-line-options/):
// usati per marcare in rosso, nel tab Motore, i parametri che il progetto
// usa ma che NON compaiono in quella pagina (probabilmente supportati solo
// da questa build Python "legacy" dell'engine).
const OFFICIAL_ENGINE_FLAGS = new Set([
  '--port',
  '--http-port',
  '--bind-all',
  '--api-port',
  '--state-dir',
  '--cache-dir',
  '--cache-limit',
  '--cache-max-bytes',
  '--cache-auto',
  '--login',
  '--password',
  '--access-token',
  '--make-default-access-token',
  '--use-internal-buffering',
  '--log-stdout',
  '--log-stderr',
  '--log-file',
  '--log-debug',
]);

app.get('/engine', async (req, res) => {
  const params = await getEngineParamsForDisplay();
  const effectiveCommand = [
    'start-engine',
    `--http-port ${params.httpPort}`,
    `--port ${params.p2pPort}`,
    params.accessToken ? `--access-token ${params.accessToken}` : '',
    params.engineFlags || '',
  ]
    .filter(Boolean)
    .join(' ');

  // Estrae flag+valore da ENGINE_FLAGS (es. "--live-cache-type memory"
  // -> flag "--live-cache-type", value "memory"; "--bind-all" da solo,
  // senza valore che segue -> considerato un flag booleano "(attivo)").
  // Il bug precedente mostrava sempre "—" al posto del valore reale.
  function parseEngineFlags(flagsStr) {
    const tokens = flagsStr.split(/\s+/).filter(Boolean);
    const result = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok.startsWith('--')) continue;
      const next = tokens[i + 1];
      if (next && !next.startsWith('--')) {
        result.push({ flag: tok, value: next });
        i++;
      } else {
        result.push({ flag: tok, value: '(attivo)' });
      }
    }
    return result;
  }

  // Elenco dei parametri attualmente in uso, con verifica rispetto alla
  // documentazione ufficiale: mostrato in sola lettura nel tab Motore.
  const flagsFromEngineFlags = parseEngineFlags(params.engineFlags);
  const paramsAudit = [
    { label: 'Porta HTTP', flag: '--http-port', value: params.httpPort },
    { label: 'Porta P2P', flag: '--port', value: params.p2pPort },
    { label: 'Access token', flag: '--access-token', value: params.accessToken ? '••••••' : '(non impostato)' },
    ...flagsFromEngineFlags.map((f) => ({ label: 'Flag (ENGINE_FLAGS)', flag: f.flag, value: f.value })),
  ].map((p) => ({ ...p, isOfficial: OFFICIAL_ENGINE_FLAGS.has(p.flag) }));

  let engineStatus = { ok: false, error: reqT()('errors.not_verified') };
  try {
    const r = await fetch(`${getEngineBaseUrl()}/webui/api/service?method=get_version`, {
      signal: AbortSignal.timeout(4000),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    engineStatus = { ok: true, version: data.result?.version || '?' };
  } catch (err) {
    engineStatus = { ok: false, error: err.message };
  }

  render(res, 'engine', {
    titleKey: 'engine.title',
    params,
    paramsAudit,
    effectiveCommand,
    engineStatus,
    writable: isEnvFileWritable(),
    envIsDirectory: isMountedAsDirectory(),
  });
});

// ---------- Impostazioni ----------

app.get('/settings', (req, res) => {
  render(res, 'settings', {
    titleKey: 'settings.title',
    acexyBaseUrl: getSetting('acexy_base_url', 'http://acexy:8080'),
    enginePublicUrl: getSetting('engine_public_url', ''),
  });
});

// Corregge i refusi più comuni negli URL inseriti a mano (es. "http//host"
// invece di "http://host", o nessuno schema) prima di salvarli: un URL
// malformato qui si propaga a tutti i pulsanti di riproduzione (VLC, HTTP,
// AcePlayer) generati da esso.
function normalizeBaseUrl(raw, fallback) {
  let url = (raw || '').trim().replace(/\/$/, '');
  if (!url) return fallback;
  url = url.replace(/^(https?):\/*/i, '$1://'); // "http//" o "http:/" -> "http://"
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

app.post('/settings', (req, res) => {
  setSetting('acexy_base_url', normalizeBaseUrl(req.body.acexy_base_url, 'http://acexy:8080'));
  setSetting('engine_public_url', normalizeBaseUrl(req.body.engine_public_url, ''));
  res.redirect('/settings');
});

// ---------- Export/import configurazione ----------

app.get('/settings/export', (req, res) => {
  const channels = db.prepare('SELECT * FROM channels').all();
  const sources = db.prepare('SELECT * FROM sources').all();
  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  const settingsObj = {};
  for (const row of settingsRows) settingsObj[row.key] = row.value;

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    channels,
    sources,
    settings: settingsObj,
  };

  res.setHeader('Content-Disposition', 'attachment; filename="acestream-manager-config.json"');
  res.type('application/json').send(JSON.stringify(payload, null, 2));
});

app.post('/settings/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.redirect('/settings');

  let payload;
  try {
    payload = JSON.parse(req.file.buffer.toString('utf8'));
  } catch (err) {
    return res.status(400).send(reqT()('errors.invalid_json_file'));
  }

  const importTx = db.transaction(() => {
    db.prepare('DELETE FROM channels').run();
    db.prepare('DELETE FROM sources').run();

    const insertSource = db.prepare(
      `INSERT INTO sources (id, url, enabled, last_scraped_at, last_result, channel_count, created_at, auto_refresh_hours)
       VALUES (@id, @url, @enabled, @last_scraped_at, @last_result, @channel_count, @created_at, @auto_refresh_hours)`
    );
    // ?? null/0 per compatibilità con backup esportati prima che queste
    // colonne esistessero (altrimenti l'insert fallirebbe per parametro
    // mancante).
    for (const s of payload.sources || []) {
      insertSource.run({ auto_refresh_hours: null, ...s });
    }

    const insertChannel = db.prepare(
      `INSERT INTO channels (id, name, acestream_id, category, logo_url, tvg_id, sort_order, source_id, status, last_checked_at, created_at, imported)
       VALUES (@id, @name, @acestream_id, @category, @logo_url, @tvg_id, @sort_order, @source_id, @status, @last_checked_at, @created_at, @imported)`
    );
    for (const c of payload.channels || []) {
      insertChannel.run({ imported: 0, ...c });
    }

    for (const [key, value] of Object.entries(payload.settings || {})) {
      setSetting(key, value);
    }
  });

  try {
    importTx();
    scheduleEpgRefresh();
  } catch (err) {
    console.error('[import] errore:', err.message);
    return res.status(400).send(`Import fallito: ${err.message}`);
  }

  res.redirect('/');
});

// ---------- Playlist / EPG pubblici ----------

app.get('/playlist', (req, res) => {
  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  const enginePublicUrl = getSetting('engine_public_url', '').replace(/\/$/, '');
  const host = req.get('host');
  const tsUrl = `http://${host}/playlist.m3u8`;
  const hlsUrl = `http://${host}/playlist.m3u8?format=hls`;
  render(res, 'playlist', {
    titleKey: 'nav.playlist',
    tsUrl,
    hlsUrl,
    acexyBaseUrl,
    enginePublicUrl,
    hlsConfigured: Boolean(enginePublicUrl),
  });
});

app.get('/playlist.m3u8', (req, res) => {
  const format = req.query.format === 'hls' ? 'hls' : 'ts';
  res.type('application/vnd.apple.mpegurl').send(buildM3U(req.query.search || '', format));
});

app.get('/epg.xml', async (req, res) => {
  res.type('application/xml').send(await buildXmltv());
});

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- Job pianificati ----------

// Intervallo di refresh EPG configurabile dal tab Impostazioni (default 6h).
let epgCronTask = null;

function scheduleEpgRefresh() {
  const hours = Math.max(1, Math.min(24, parseInt(getSetting('epg_refresh_hours', '6'), 10) || 6));
  if (epgCronTask) epgCronTask.stop();
  epgCronTask = cron.schedule(`0 */${hours} * * *`, () => {
    refreshEpg().catch((err) => console.error('[epg] refresh fallito:', err));
  });
  console.log(`[epg] refresh pianificato ogni ${hours}h`);
}

scheduleEpgRefresh();
refreshEpg().catch((err) => console.error('[epg] refresh iniziale fallito:', err));

// Controlla ogni ora quali sorgenti con auto-refresh impostato sono "dovute"
// secondo il proprio intervallo individuale (ognuna il suo, non un unico
// intervallo globale). Le sorgenti manuali non vengono mai toccate qui.
cron.schedule('7 * * * *', () => {
  refreshDueSources().catch((err) => console.error('[sources] auto-refresh fallito:', err));
});

app.listen(PORT, () => {
  console.log(`AceStream Manager in ascolto su http://0.0.0.0:${PORT}`);
});

// Rete di sicurezza: un'eccezione non gestita in un punto imprevisto (es.
// durante lo streaming proxy sotto retry ravvicinati lato client) non deve
// far cadere l'intero processo — solo la richiesta coinvolta va persa. Senza
// questi handler Node termina il processo su un'eccezione/rifiuto non
// gestiti, e Docker lo riavvia (restart: unless-stopped), causando una
// finestra di "connection refused" per tutte le richieste nel frattempo.
process.on('uncaughtException', (err) => {
  console.error('[server] Eccezione non gestita (processo NON terminato):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] Promise rejection non gestita (processo NON terminato):', reason);
});
