require('dotenv').config();
require('./errorLog').install();
const express = require('express');
const multer = require('multer');
const cron = require('node-cron');
const { db, getSetting, setSetting, toggleFavoriteChannel, getFavoriteChannelIds, recordWatch, getRecentlyWatched, getStatusStats, runJob, recordJobRun, getJobRuns } = require('./db');
const { refreshEpg, getNowNext, getSourceStats } = require('./epg');
const { buildM3U, buildXmltv } = require('./playlist');
const { scrapeUrl, importChannels, refreshSource, refreshAllSources, refreshDueSources } = require('./scraper');
const { parseM3U } = require('./m3u');
const { checkAndStore, checkAllChannels } = require('./statuscheck');
const { getEngineParams, getEngineBaseUrl } = require('./engineConfig');
const { searchAceStream, resolveContentId, CATEGORIES } = require('./search');
const { getTranslator } = require('./i18n');
const { getProgramsForDay } = require('./epg');
const { getCachedTranslations } = require('./translator');
const { suggestTvgIds, suggestLogosFromSearch } = require('./suggestions');
const { searchTeams, getTeamMatches, getUpcomingTeamMatches, getBroadcastersByCountry, parseTeamUrl, getMatchTitle, refreshTeamIndex, getFootballDiagnostics } = require('./football');

// Formatta un kickoff epoch nel fuso del server (self-hosted = fuso dell'utente).
function formatKickoff(epoch) {
  if (!epoch) return null;
  try {
    const d = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(epoch));
    const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(epoch));
    return { date: d, time: h };
  } catch {
    return { date: new Date(epoch).toISOString().slice(0, 10), time: null };
  }
}

// Ordina le partite di una squadra: prossime prima (cronologiche), poi
// quelle passate (dalla più recente). Le partite senza orario noto finiscono
// in fondo, nell'ordine di pagina.
function sortMatchesForDisplay(matches) {
  const now = Date.now();
  const withKo = matches.filter((m) => m.koEpoch);
  const withoutKo = matches.filter((m) => !m.koEpoch);
  const upcoming = withKo.filter((m) => m.koEpoch + 3 * 3600 * 1000 >= now).sort((a, b) => a.koEpoch - b.koEpoch);
  const past = withKo.filter((m) => m.koEpoch + 3 * 3600 * 1000 < now).sort((a, b) => b.koEpoch - a.koEpoch);
  return [...upcoming, ...past, ...withoutKo].map((m) => ({ ...m, ko: formatKickoff(m.koEpoch) }));
}
const {
  listDevices: listVlcDevices,
  getDevice: getVlcDevice,
  addDevice: addVlcDevice,
  deleteDevice: deleteVlcDevice,
  getStatus: getVlcStatus,
  playOnDevice: playOnVlcDevice,
} = require('./vlcRemote');
const { checkWarpStatus } = require('./warpStatus');
const { scanForPort, verifyJellyfin } = require('./lanScanner');
const { getRecent: getRecentIssues } = require('./errorLog');
const QRCode = require('qrcode');
const { getStats, stopSession, getStatsEngineUrl, setStatsEngineUrl, isUsingDefaultEngine } = require('./statsProxy');
const { proxyTs, proxyHlsManifest, proxyHlsPassthrough } = require('./streamProxy');
const { remuxToFmp4 } = require('./remux');
const { probeStreams } = require('./streamProbe');

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
  return getTranslator();
}

// Confronta versioni semver "a puntini" (3.6.0 > 3.5.10): restituisce true
// se a è più recente di b. Non serve una libreria: i numeri di versione di
// questo progetto sono sempre in forma X.Y.Z.
function semverNewer(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// ---------- Controllo nuove versioni (badge nell'interfaccia) ----------

// Controlla l'ultima release pubblicata su GitHub e memorizza il risultato
// nelle impostazioni: la UI legge SOLO dalla cache (mai una chiamata di rete
// durante il render di una pagina — una pagina deve restare istantanea).
// Le chiamate di rete vera avvengono all'avvio (rimandate di qualche secondo
// per non rallentare il boot) e poi ogni 6 ore dal job pianificato. Un
// fallimento (offline, rate limit dell'API GitHub) è normale e silenzioso:
// semplicemente il badge non appare finché un controllo successivo non
// riesce.
const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/gabo-it/Acestream-Manager/releases/latest';

async function checkForUpdate() {
  if (getSetting('update_check_enabled', '1') !== '1') return;
  try {
    const r = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers: { 'User-Agent': 'AceStream-Manager', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const latest = String(data.tag_name || '').replace(/^v/i, '').trim();
    if (!/^\d+(\.\d+)*$/.test(latest)) throw new Error(`unexpected tag: ${data.tag_name}`);
    setSetting('update_latest_version', latest);
    setSetting('update_last_check_at', String(Date.now()));
    setSetting('update_check_ok', '1');
  } catch (err) {
    // Non tocca update_latest_version: mantiene l'ultimo buono conosciuto.
    setSetting('update_last_check_at', String(Date.now()));
    setSetting('update_check_ok', '0');
    console.warn('[update-check] failed:', err.message);
  }
}

// Cosa mostrare nel badge della sidebar (sincrono, solo cache).
function getUpdateBadge() {
  if (getSetting('update_check_enabled', '1') !== '1') return null;
  const latest = getSetting('update_latest_version', '');
  if (!latest || !semverNewer(latest, APP_VERSION)) return null;
  if (getSetting('update_dismissed_version', '') === latest) return null;
  return { latest, current: APP_VERSION, url: 'https://github.com/gabo-it/Acestream-Manager/releases' };
}

// Piccolo helper per renderizzare le viste dentro il layout comune.
// Inietta sempre t() così ogni vista può tradurre senza doverlo passare a mano.
// Se locals.titleKey è presente, il <title> del browser viene tradotto di conseguenza.
function render(res, view, locals = {}) {
  const t = getTranslator();
  const title = locals.titleKey ? t(locals.titleKey) : locals.title;
  const fullLocals = { ...locals, title, t, lang: 'en', appVersion: APP_VERSION, embed: locals.embed || false, updateBadge: getUpdateBadge() };
  app.render(view, fullLocals, (err, body) => {
    if (err) {
      console.error(err);
      return res.status(500).send(reqT()('errors.render_failed'));
    }
    res.render('layout', { ...fullLocals, body });
  });
}

// ---------- Canali ----------

// Condivisa tra / (gestione canali) e /tv (vista compatta orientata alla
// riproduzione) — entrambe mostrano la stessa lista con anteprima
// now/next, evitando di duplicare la logica di traduzione.
// filter === 'without_epg': solo canali senza un tvg_id valorizzato, o
// con un tvg_id che non corrisponde a nessun programma importato —
// stessa definizione di "senza EPG" usata dal widget Inventory.
//
// La ricerca testuale (searchQuery) confronta nome/categoria E i titoli
// now/next — per questo calcoliamo prima now/next per l'intera base
// (senza filtro testo) e filtriamo DOPO in JS, invece di scrivere una
// sottoquery SQL con condizioni temporali per "now"/"next": più semplice
// da leggere, e riusa la stessa funzione getNowNext già usata altrove.
function getChannelsWithNowNext(searchQuery, filter, guide) {
  let channels;
  if (filter === 'without_epg') {
    channels = db
      .prepare(
        `SELECT * FROM channels c
         WHERE (c.tvg_id = '' OR NOT EXISTS (SELECT 1 FROM programs p WHERE p.tvg_id = c.tvg_id))
         ORDER BY sort_order, name COLLATE NOCASE`
      )
      .all();
  } else if (filter === 'favorites') {
    channels = db
      .prepare(
        `SELECT c.* FROM channels c
         JOIN favorite_channels f ON f.channel_id = c.id
         ORDER BY sort_order, name COLLATE NOCASE`
      )
      .all();
  } else {
    channels = db.prepare('SELECT * FROM channels ORDER BY sort_order, name COLLATE NOCASE').all();
  }

  const epgByChannel = {};
  const tvgIdCounts = {};
  for (const ch of channels) {
    epgByChannel[ch.id] = getNowNext(ch.tvg_id);
    if (ch.tvg_id) tvgIdCounts[ch.tvg_id] = (tvgIdCounts[ch.tvg_id] || 0) + 1;
  }

  // Titoli "in onda ora" / "a seguire", se una lingua guida è impostata E
  // la checkbox "Traduci nella webui" è attiva in Sorgenti. Legge SOLO
  // dalla cache (mai una chiamata di rete a LibreTranslate): queste
  // pagine devono restare sempre istantanee, non aspettare mai una
  // traduzione in corso. Le vere chiamate di rete avvengono solo nel job
  // in background (vedi epg.js) — un titolo non ancora tradotto qui
  // resta nella lingua originale fino al prossimo giro. Fatto PRIMA del
  // filtro testo, così la ricerca confronta lo stesso titolo che l'utente
  // vede davvero (tradotto, se la traduzione è attiva).
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

  const guideMatches = {};
  if (searchQuery) {
    const needle = searchQuery.toLowerCase();

    // Ricerca nel palinsesto dell'intera giornata (opzionale): cerca la
    // parola nel titolo (originale e tradotto) e nella descrizione di
    // OGNI programma della giornata, non solo di now/next. La giornata è
    // quella indicata dal browser (mezzanotte locale dell'utente): solo il
    // browser conosce il vero fuso orario, il container gira in UTC.
    const matchesByTvgId = {};
    if (guide && Number.isFinite(guide.dayStart)) {
      const dayEnd = guide.dayStart + 24 * 60 * 60 * 1000;
      const wanted = new Set(channels.map((c) => c.tvg_id).filter(Boolean));
      if (wanted.size) {
        const rows = db
          .prepare(
            'SELECT tvg_id, title, description, start_ts, stop_ts FROM programs WHERE start_ts < ? AND stop_ts > ? ORDER BY start_ts'
          )
          .all(dayEnd, guide.dayStart)
          .filter((r) => wanted.has(r.tvg_id));

        // Stessa regola di traduzione di now/next: solo dalla cache, mai
        // chiamate di rete — la ricerca confronta anche il titolo che
        // l'utente vede davvero (tradotto, se la traduzione è attiva).
        const translatedByTitle = new Map();
        if (epgLanguage && getSetting('epg_translate_ui', '1') === '1') {
          const titles = [...new Set(rows.map((r) => r.title))];
          const translated = getCachedTranslations(titles, epgLanguage);
          titles.forEach((t, i) => translatedByTitle.set(t, translated[i]));
        }

        for (const r of rows) {
          const shownTitle = translatedByTitle.get(r.title) || r.title;
          const haystack = `${r.title}\n${shownTitle}\n${r.description || ''}`.toLowerCase();
          if (haystack.includes(needle)) {
            (matchesByTvgId[r.tvg_id] = matchesByTvgId[r.tvg_id] || []).push({
              title: shownTitle,
              start_ts: r.start_ts,
              stop_ts: r.stop_ts,
            });
          }
        }
      }
    }

    channels = channels.filter((ch) => {
      const epg = epgByChannel[ch.id];
      return (
        ch.name.toLowerCase().includes(needle) ||
        (ch.category || '').toLowerCase().includes(needle) ||
        (epg.now && epg.now.title.toLowerCase().includes(needle)) ||
        (epg.next && epg.next.title.toLowerCase().includes(needle)) ||
        Boolean(ch.tvg_id && matchesByTvgId[ch.tvg_id])
      );
    });
    for (const ch of channels) {
      if (ch.tvg_id && matchesByTvgId[ch.tvg_id]) guideMatches[ch.id] = matchesByTvgId[ch.tvg_id];
    }
  }

  return { channels, epgByChannel, tvgIdCounts, guideMatches };
}

// Inizio giornata da usare per la ricerca nel palinsesto: il browser invia
// la propria mezzanotte locale (parametro "ds", epoch ms). Se manca o è
// palesemente fuori range, ripieghiamo sulla mezzanotte del fuso del
// container (impostabile con TZ).
function resolveGuideDayStart(rawDs) {
  const ds = parseInt(rawDs, 10);
  if (Number.isFinite(ds) && Math.abs(ds - Date.now()) < 3 * 24 * 60 * 60 * 1000) return ds;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

app.get('/channels', async (req, res) => {
  const q = (req.query.q || '').trim();
  const filter = req.query.filter === 'without_epg' ? 'without_epg' : req.query.filter === 'favorites' ? 'favorites' : '';
  const guideOn = req.query.guide === '1' && q !== '';
  const { channels, epgByChannel, tvgIdCounts, guideMatches } = getChannelsWithNowNext(
    q,
    filter,
    guideOn ? { dayStart: resolveGuideDayStart(req.query.ds) } : null
  );
  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  render(res, 'index', {
    titleKey: 'channels.title',
    channels,
    epgByChannel,
    tvgIdCounts,
    q,
    filter,
    guideOn,
    guideMatches,
    acexyBaseUrl,
    checkMode: getSetting('channels_check_mode', 'off'),
    checkIntervalHours: getSetting('channels_check_interval_hours', '6'),
    checkTime: getSetting('channels_check_time', '04:00'),
    lastCheckAllAt: getSetting('channels_last_check_all_at', ''),
  });
});

app.post('/channels/schedule-check', (req, res) => {
  const mode = ['off', 'interval', 'time'].includes(req.body.mode) ? req.body.mode : 'off';
  const allowedHours = new Set(['1', '3', '6', '12', '24']);
  const intervalHours = allowedHours.has(req.body.interval_hours) ? req.body.interval_hours : '6';
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(req.body.time || '') ? req.body.time : '04:00';
  setSetting('channels_check_mode', mode);
  setSetting('channels_check_interval_hours', intervalHours);
  setSetting('channels_check_time', time);
  res.redirect('/channels');
});

// Dashboard: colpo d'occhio su cosa sta succedendo (canali configurati,
// stato EPG, cosa è in onda ora) più collegamenti rapidi alle altre
// sezioni — è la nuova pagina di apertura.
app.get('/', (req, res) => {
  const channelCount = db.prepare('SELECT COUNT(*) as c FROM channels').get().c;
  const epgSourceCount = getSetting('epg_urls', '').split(/[\n,]+/).map((u) => u.trim()).filter(Boolean).length;
  const vlcDeviceCount = listVlcDevices().length;
  const epgLastResult = getSetting('epg_last_result', '');
  const libretranslateConfigured = !!getSetting('libretranslate_url', '');

  // "Coming up next": programs starting within the next 24 hours — vista
  // scorrevole, niente più tetto artificiale a 6 elementi dato che ora è
  // possibile scorrere orizzontalmente.
  const { channels, epgByChannel } = getChannelsWithNowNext('');
  const oneDayMs = 24 * 60 * 60 * 1000;
  const comingUpNext = channels
    .filter((ch) => epgByChannel[ch.id] && epgByChannel[ch.id].next && epgByChannel[ch.id].next.start_ts - Date.now() < oneDayMs)
    .map((ch) => ({ id: ch.id, name: ch.name, logoUrl: ch.logo_url, next: epgByChannel[ch.id].next }))
    .sort((a, b) => a.next.start_ts - b.next.start_ts);

  // "On Air": tutti i canali con un programma in corso in questo
  // momento, ordinati dal più recente iniziato al più datato — non un
  // sottoinsieme arbitrario dei primi canali della lista, ma l'elenco
  // completo di cosa è realmente in onda ora.
  const onAir = channels
    .filter((ch) => epgByChannel[ch.id] && epgByChannel[ch.id].now)
    .map((ch) => ({ id: ch.id, name: ch.name, logoUrl: ch.logo_url, now: epgByChannel[ch.id].now }))
    .sort((a, b) => b.now.start_ts - a.now.start_ts);

  // Recently added channels — the library view, distinct from the
  // schedule-based widgets above.
  const recentChannels = db.prepare('SELECT id, name, logo_url FROM channels ORDER BY created_at DESC LIMIT 5').all();

  // Widget "Inventory": colpo d'occhio su cosa è caricato adesso, tre
  // gruppi — Streams (righe canale, ognuna un vero acestream_id),
  // TV channels (identità distinte via tvg_id, dato che più stream
  // possono essere collegati alla stessa identità come stream
  // alternativi), Sources and guide (fonti di importazione + EPG).
  const streamStats = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
         SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) as offline,
         SUM(CASE WHEN status = 'unknown' OR status IS NULL THEN 1 ELSE 0 END) as notChecked
       FROM channels`
    )
    .get();

  const tvChannelTotal = db.prepare("SELECT COUNT(DISTINCT tvg_id) as c FROM channels WHERE tvg_id != ''").get().c;
  const tvChannelWithEpg = db
    .prepare(
      `SELECT COUNT(DISTINCT c.tvg_id) as c FROM channels c
       WHERE c.tvg_id != '' AND EXISTS (SELECT 1 FROM programs p WHERE p.tvg_id = c.tvg_id)`
    )
    .get().c;
  // Stessa definizione usata dal filtro ?filter=without_epg in /channels
  // (righe canale, non tvg_id distinti) — così il numero qui e quello che
  // si vede cliccando corrispondono sempre.
  const channelsWithoutEpg = db
    .prepare(
      `SELECT COUNT(*) as c FROM channels c
       WHERE c.tvg_id = '' OR NOT EXISTS (SELECT 1 FROM programs p WHERE p.tvg_id = c.tvg_id)`
    )
    .get().c;
  const tvChannelLinked = db
    .prepare(
      `SELECT COUNT(*) as c FROM (
         SELECT tvg_id FROM channels WHERE tvg_id != '' GROUP BY tvg_id HAVING COUNT(*) > 1
       )`
    )
    .get().c;

  const sourceRows = db.prepare('SELECT enabled, last_result FROM sources').all();
  // Stessa regex già usata in Sources per capire se un risultato indica un
  // fallimento — riusata qui per coerenza, non una nuova definizione.
  const sourceFailing = sourceRows.filter((s) => s.enabled && /fallit|errore|error|failed/i.test(s.last_result || '')).length;
  const sourceEnabled = sourceRows.filter((s) => s.enabled).length;

  const guideChannelsCount = db.prepare('SELECT COUNT(*) as c FROM epg_channels').get().c;
  const programmesCount = db.prepare('SELECT COUNT(*) as c FROM programs').get().c;

  const inventory = {
    streamsTotal: streamStats.total,
    streamsOnline: streamStats.online,
    streamsOffline: streamStats.offline,
    streamsNotChecked: streamStats.notChecked,
    tvTotal: tvChannelTotal,
    tvWithEpg: tvChannelWithEpg,
    tvWithoutEpg: channelsWithoutEpg,
    tvLinked: tvChannelLinked,
    sourceUrlsTotal: sourceRows.length,
    sourceUrlsEnabled: sourceEnabled,
    sourceUrlsFailing: sourceFailing,
    epgSourceCount,
    guideChannels: guideChannelsCount,
    programmes: programmesCount,
    lastCheckAllAt: getSetting('channels_last_check_all_at', ''),
    checkMode: getSetting('channels_check_mode', 'off'),
  };

  // "Continua a guardare": ultimi canali aperti nel player (il più recente
  // prima) — ogni apertura di /watch/:id registra una visione.
  const continueWatching = getRecentlyWatched(6);

  // Prossime partite della squadra preferita: lette SOLO dalla cache
  // (scritta dalla pagina Football e dal job orario) — la Dashboard non
  // deve mai aspettare una richiesta a livesoccertv.com per aprirsi.
  const favoriteMatch = readFavoriteMatchesCache();

  render(res, 'dashboard', {
    titleKey: 'dashboard.title',
    channelCount,
    epgSourceCount,
    vlcDeviceCount,
    epgLastResult,
    libretranslateConfigured,
    comingUpNext,
    onAir,
    recentChannels,
    inventory,
    continueWatching,
    favoriteMatch,
    recentIssues: getRecentIssues(15),
  });
});

// Vista compatta orientata alla riproduzione: lista cliccabile con
// anteprima now/next, click per espandere player web + programmazione
// completa + invio a dispositivi VLC configurati in Add-Ons.
// ?filter=favorites: solo i canali segnati con la stella.
app.get('/tv', (req, res) => {
  const q = (req.query.q || '').trim();
  const filter = req.query.filter === 'favorites' ? 'favorites' : '';
  const guideOn = req.query.guide === '1' && q !== '';
  const { channels, epgByChannel, guideMatches } = getChannelsWithNowNext(
    q,
    filter,
    guideOn ? { dayStart: resolveGuideDayStart(req.query.ds) } : null
  );
  render(res, 'tv', {
    titleKey: 'tv.title',
    channels,
    epgByChannel,
    q,
    filter,
    guideOn,
    guideMatches,
    favoriteIds: [...getFavoriteChannelIds()],
    vlcDevices: listVlcDevices(),
  });
});

// Toggle preferito per un canale (stella sulla lista TV) — JSON per il JS
// della pagina, che aggiorna la stella senza ricaricare.
app.post('/channels/:id/favorite', (req, res) => {
  const channel = db.prepare('SELECT id FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ ok: false, error: reqT()('errors.channel_not_found') });
  const favorite = toggleFavoriteChannel(channel.id);
  res.json({ ok: true, favorite });
});

// Invia lo stream di un canale (via M3U/TS, stesso URL usato da VLC/AcePlayer
// esterni) a un dispositivo VLC remoto configurato in Add-Ons.
app.post('/tv/:id/send/:deviceId', async (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.json({ ok: false, error: 'channel_not_found' });
  try {
    const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
    const streamUrl = `${acexyBaseUrl}/ace/getstream?id=${encodeURIComponent(channel.acestream_id)}`;
    await playOnVlcDevice(req.params.deviceId, streamUrl);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
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
  res.redirect('/channels');
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
  res.redirect('/channels');
});

app.post('/channels/:id/delete', (req, res) => {
  db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);
  res.redirect('/channels');
});

app.post('/channels/:id/check-status', async (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (channel) {
    try {
      await checkAndStore(channel);
    } catch (err) {
      console.error('[status] error:', err.message);
    }
  }
  res.redirect('/channels');
});

app.post('/channels/check-all', async (req, res) => {
  try {
    // Il job logga anche la pagina Health (esito + "X/Y online"); le
    // singole verifiche finiscono comunque nello storico affidabilità.
    await runJob('channels_check', async () => {
      const out = await checkAllChannels();
      return { detail: `${out.online}/${out.total} online` };
    });
    setSetting('channels_last_check_all_at', String(Date.now()));
  } catch (err) {
    console.error('[status] bulk check error:', err.message);
  }
  res.redirect('/channels');
});

app.post('/channels/bulk-delete', (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.filter(Boolean);
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM channels WHERE id IN (${placeholders})`).run(...ids);
  }
  res.redirect('/channels');
});

// Programmazione giornaliera di un canale (usata dal pannello espandibile in AJAX).
app.get('/channels/:id/schedule', async (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: reqT()('errors.channel_not_found') });

  // "ts" è l'epoch ms di mezzanotte LOCALE del giorno richiesto, calcolato
  // dal browser (che conosce il proprio fuso orario tramite il costruttore
  // Date locale — noi qui non possiamo saperlo). Prima usavamo una
  // stringa "YYYY-MM-DD" interpretata come mezzanotte UTC: per un fuso
  // avanti rispetto a UTC (es. Italia), nelle prime ore del mattino
  // locale questo faceva ancora riferimento al giorno UTC precedente,
  // mostrando programmi già conclusi come se fossero ancora da venire.
  // "date" resta supportato come fallback per URL/bookmark vecchi.
  let dayStart = parseInt(req.query.ts, 10);
  if (!Number.isFinite(dayStart)) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : new Date().toISOString().slice(0, 10);
    dayStart = Date.parse(`${date}T00:00:00Z`);
  }

  if (!channel.tvg_id) {
    return res.json({ ts: dayStart, tvgId: null, programs: [] });
  }

  let programs = getProgramsForDay(channel.tvg_id, dayStart).map((p) => ({
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

  const dayMs = 24 * 60 * 60 * 1000;
  res.json({ ts: dayStart, prevTs: dayStart - dayMs, nextTs: dayStart + dayMs, tvgId: channel.tvg_id, programs });
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
    console.error('[suggestions] logo search failed:', err.message);
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
  console.log(`[tvg-id] request for channel ${req.params.id}: tvg_id="${tvgId}" logo_url="${logoUrl}" body-received=`, req.body);
  let result;
  if (logoUrl) {
    result = db.prepare('UPDATE channels SET tvg_id = ?, logo_url = ? WHERE id = ?').run(tvgId, logoUrl, req.params.id);
  } else {
    result = db.prepare('UPDATE channels SET tvg_id = ? WHERE id = ?').run(tvgId, req.params.id);
  }
  console.log(`[tvg-id] righe modificate: ${result.changes}`);
  if (result.changes === 0) {
    console.warn(`[tvg-id] WARNING: no row updated — channel ${req.params.id} not found?`);
  }
  const after = db.prepare('SELECT id, name, tvg_id, logo_url FROM channels WHERE id = ?').get(req.params.id);
  console.log('[tvg-id] channel after update:', after);
  res.json({ ok: true, tvgId, logoUrl, changes: result.changes, channel: after });
});

// Applica solo il logo (suggerimento da ricerca, senza tvg-id associato):
// a differenza della rotta sopra, non tocca il tvg-id già impostato.
app.post('/channels/:id/logo', (req, res) => {
  const logoUrl = (req.body.logo_url || '').trim();
  console.log(`[logo] request for channel ${req.params.id}: logo_url="${logoUrl}" body-received=`, req.body);
  let changes = 0;
  if (logoUrl) {
    const result = db.prepare('UPDATE channels SET logo_url = ? WHERE id = ?').run(logoUrl, req.params.id);
    changes = result.changes;
  } else {
    console.warn('[logo] empty logo_url in request, no update');
  }
  console.log(`[logo] righe modificate: ${changes}`);
  res.json({ ok: true, logoUrl, changes });
});

// ---------- Matching in blocco canali ↔ EPG ----------

// Calcola i candidati tvg-id (dall'EPG importato) per i canali indicati,
// SENZA toccare il DB: il client chiama qui a piccoli batch (una pagina
// con molti canali altrimenti terrebbe la richiesta aperta per minuti),
// mostra la preview e solo dopo la conferma dell'utente chiama /apply.
// Body: { ids: [..] } — una sotto-lista (canali selezionati) o un batch
// di tutti quelli visibili; la lista dei canali da processare la decide
// il client, qui si risponde solo per gli id che esistono davvero.
app.post('/channels/epg-match', async (req, res) => {
  const rawIds = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const ids = [...new Set(rawIds.map((x) => parseInt(x, 10)).filter(Number.isFinite))];
  if (ids.length === 0) return res.json({ results: [] });

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, name, tvg_id FROM channels WHERE id IN (${placeholders}) ORDER BY name`)
    .all(...ids);

  const results = [];
  for (const ch of rows) {
    let suggestions = [];
    try {
      suggestions = await suggestTvgIds(ch.name, 5);
    } catch (err) {
      console.error(`[epg-match] suggestions failed for "${ch.name}":`, err.message);
    }
    results.push({
      id: ch.id,
      name: ch.name,
      currentTvgId: ch.tvg_id || '',
      suggestions,
    });
  }
  res.json({ results });
});

// Applica le associazioni confermate nella preview. Body:
// { assignments: [{ id, tvgId, logoUrl }] } — tvgId vuoto = scollega il
// canale dall'EPG; logoUrl vuoto o non http(s) = lascia il logo attuale
// (stessa regola di POST /channels/:id/tvg-id).
app.post('/channels/epg-match/apply', (req, res) => {
  const assignments = Array.isArray(req.body && req.body.assignments) ? req.body.assignments : [];
  let applied = 0;

  const applyAll = db.transaction((items) => {
    for (const a of items) {
      const id = parseInt(a && a.id, 10);
      if (!Number.isFinite(id)) continue;
      const tvgId = String(a.tvgId || '').trim().slice(0, 200);
      let logoUrl = String(a.logoUrl || '').trim();
      if (logoUrl && !/^https?:\/\//i.test(logoUrl)) logoUrl = '';
      // Conta solo gli update che hanno davvero toccato una riga: un id
      // arrivato dalla preview ma intanto cancellato non è "applicato".
      let result;
      if (logoUrl) {
        result = db.prepare('UPDATE channels SET tvg_id = ?, logo_url = ? WHERE id = ?').run(tvgId, logoUrl, id);
      } else {
        result = db.prepare('UPDATE channels SET tvg_id = ? WHERE id = ?').run(tvgId, id);
      }
      if (result.changes > 0) applied += 1;
    }
  });
  applyAll(assignments);

  console.log(`[epg-match] applicate ${applied} associazioni su ${assignments.length} proposte`);
  res.json({ applied });
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
  // Cronologia "continua a guardare": ogni apertura della pagina di
  // riproduzione conta come una visione (anche dall'iframe del tab TV —
  // è comunque qualcuno che sta guardando).
  try { recordWatch(channel.id); } catch (err) { console.error('[history] record failed:', err.message); }
  // Stream alternativi: altri canali collegati alla stessa identità TV
  // (stesso tvg_id) — proposti dalla pagina solo se la riproduzione
  // fallisce, come via di fuga manuale o automatica. Ordinati con gli
  // online prima, poi per affidabilità misurata (uptime storico), così
  // il failover automatico prova prima il più probabile.
  let alternates = [];
  if (channel.tvg_id) {
    const rows = db
      .prepare(
        `SELECT id, name, logo_url, status FROM channels
         WHERE tvg_id = ? AND id != ?`
      )
      .all(channel.tvg_id, channel.id);
    const stats = getStatusStats();
    const rank = { online: 0, unknown: 1, offline: 2 };
    alternates = rows.sort(
      (a, b) =>
        (rank[a.status] ?? 1) - (rank[b.status] ?? 1) ||
        (stats.get(b.id)?.uptimePct ?? -1) - (stats.get(a.id)?.uptimePct ?? -1) ||
        a.name.localeCompare(b.name)
    );
  }
  const { tsUrl, tsProxyUrl } = buildStreamUrls(req, channel.acestream_id);
  render(res, 'watch', { title: channel.name, channel, streamUrl: tsUrl, tsProxyUrl, alternates, embed: req.query.embed === '1' });
});

// Come /watch/:id ma per contenuti non ancora salvati come canale (es. un
// risultato del tab Cerca su cui l'utente vuole solo provare la riproduzione).
app.get('/watch-direct', async (req, res) => {
  const name = (req.query.name || 'Stream').trim();
  let acestreamId = (req.query.id || '').trim();
  // I risultati del catalogo arrivano come INFOHASH (param ?infohash=):
  // il motore riproduce solo via content id, quindi si risolve prima di
  // montare la pagina. Un infohash che il motore non riconosce = stream
  // morto: messaggio esplicito invece del player che gira a vuoto.
  const infohash = (req.query.infohash || '').trim();
  if (infohash) {
    if (!/^[a-fA-F0-9]{40}$/.test(infohash)) return res.status(400).send(reqT()('errors.invalid_acestream_id'));
    try {
      acestreamId = await resolveContentId(infohash);
    } catch (err) {
      return res.status(502).send(`${reqT()('errors.resolve_failed')} (${err.message})`);
    }
  }
  if (!/^[a-fA-F0-9]{40}$/.test(acestreamId)) return res.status(400).send(reqT()('errors.invalid_acestream_id'));
  const { tsUrl, tsProxyUrl } = buildStreamUrls(req, acestreamId);
  // alternates: [] serve — il template watch.ejs fa riferimento alla
  // variabile e con EJS un local mai passato è un ReferenceError, non
  // semplicemente undefined (era la causa del 500 "Rendering error" su
  // ogni apertura da Cerca / canali per partita).
  render(res, 'watch', { title: name, channel: { id: null, name, acestream_id: acestreamId }, streamUrl: tsUrl, tsProxyUrl, alternates: [] });
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

app.get('/vlc-direct.m3u', async (req, res) => {
  const name = (req.query.name || 'Stream').trim();
  let acestreamId = (req.query.id || '').trim();
  // Come per /watch-direct: dal catalogo arriva un infohash, si risolve
  // al content id prima di generare il file (nel .m3u deve finire un URL
  // che il motore sappia davvero riprodurre).
  const infohash = (req.query.infohash || '').trim();
  if (infohash) {
    if (!/^[a-fA-F0-9]{40}$/.test(infohash)) return res.status(400).send(reqT()('errors.invalid_acestream_id'));
    try {
      acestreamId = await resolveContentId(infohash);
    } catch (err) {
      return res.status(502).send(`${reqT()('errors.resolve_failed')} (${err.message})`);
    }
  }
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
  // "a" / "v": traccia audio / video scelta dall'utente (indice per tipo)
  // dopo aver ispezionato il flusso — assenti = scelta automatica.
  const audio = req.query.a !== undefined ? parseInt(req.query.a, 10) : undefined;
  const video = req.query.v !== undefined ? parseInt(req.query.v, 10) : undefined;
  const ffmpeg = remuxToFmp4(req.params.id, res, { audio, video });
  req.on('close', () => {
    if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
  });
});

// Elenco delle tracce video/audio/sottotitoli presenti nel flusso, per la
// scelta nella finestra di riproduzione. Un errore qui (es. il canale non
// risponde in questo momento) viene restituito alla pagina, non loggato
// come errore del server: non è un problema della webui.
app.get('/stream-proxy/tracks/:id', async (req, res) => {
  if (!/^[a-fA-F0-9]{40}$/.test(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid id' });
  try {
    const tracks = await probeStreams(req.params.id);
    res.json({ ok: true, ...tracks });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ---------- Sorgenti (scraping ricorrente) ----------

app.get('/sources', (req, res) => {
  const sources = db.prepare('SELECT * FROM sources ORDER BY created_at DESC').all();
  render(res, 'sources', { titleKey: 'sources.title', sources });
});

app.post('/playlist/epg/add-url', (req, res) => {
  const newUrl = (req.body.url || '').trim();
  if (newUrl) {
    const current = getSetting('epg_urls', '')
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (!current.includes(newUrl)) {
      current.push(newUrl);
      setSetting('epg_urls', current.join('\n'));
    }
  }
  res.redirect('/playlist');
});

app.post('/playlist/epg/remove-url', (req, res) => {
  const toRemove = (req.body.url || '').trim();
  const current = getSetting('epg_urls', '')
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter((u) => u && u !== toRemove);
  setSetting('epg_urls', current.join('\n'));
  res.redirect('/playlist');
});

app.post('/sources/epg', (req, res) => {
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
  res.redirect('/playlist');
});

app.post('/sources/epg/refresh', async (req, res) => {
  try {
    await runJob('epg_refresh', async () => {
      const r = await refreshEpg();
      return { detail: `${r.imported} programs from ${r.sources} sources`, warnings: (r.errors || []).length };
    });
  } catch (err) {
    console.error(err);
  }
  res.redirect('/playlist');
});

app.post('/sources/new', (req, res) => {
  const url = (req.body.url || '').trim();
  if (url) {
    try {
      db.prepare('INSERT OR IGNORE INTO sources (url) VALUES (?)').run(url);
    } catch (err) {
      console.error('[sources] insert error:', err.message);
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
      await runJob('sources_refresh', async () => {
        await refreshSource(source);
        return { detail: source.url };
      });
    } catch (err) {
      console.error('[sources] refresh failed:', err.message);
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
    await runJob('sources_refresh', async () => {
      const n = await refreshAllSources();
      return { detail: `${n} sources refreshed` };
    });
  } catch (err) {
    console.error('[sources] refresh-all failed:', err.message);
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
      console.error('[import] error from URL:', err.message);
    }
  }
  res.redirect('/channels');
});

app.post('/import/m3u-text', (req, res) => {
  const text = req.body.m3u_text || '';
  const rows = parseM3U(text);
  if (rows.length) importChannels(rows, null);
  res.redirect('/channels');
});

app.post('/import/m3u-file', upload.single('file'), (req, res) => {
  if (req.file) {
    const text = req.file.buffer.toString('utf8');
    const rows = parseM3U(text);
    if (rows.length) importChannels(rows, null);
  }
  res.redirect('/channels');
});

// ---------- Ricerca (API AceStream) ----------

// Un ID incollato direttamente nella ricerca: "acestream://<id>" oppure il
// bare 40-hex (content ID o infohash — 40 caratteri esadecimali in entrambi
// i casi, e per il motore la chiamata di riproduzione è la stessa). In quel
// caso niente ricerca catalogo: si mostra la scheda "stream diretto" con
// play/import immediati.
function parseDirectStreamId(raw) {
  const m = String(raw || '').trim().match(/^(?:acestream:\/\/)?([a-fA-F0-9]{40})$/);
  return m ? m[1].toLowerCase() : null;
}

app.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  const directId = parseDirectStreamId(q);
  const resolveFailed = req.query.resolve_failed === '1';
  let results = [];
  let error = null;
  if (directId) {
    // ID esatto: il catalogo non aggiungerebbe nulla di utile.
  } else if (q || category) {
    try {
      const data = await searchAceStream(q, { category });
      results = data.results;
    } catch (err) {
      error = err.message;
    }
  }
  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  render(res, 'search', { titleKey: 'search.title', q, category, results, error, categories: CATEGORIES, acexyBaseUrl, directId, resolveFailed });
});

// Il campo nascosto id_kind distingue la provenienza: i risultati del
// catalogo portano un INFOHASH (da risolvere al content id prima di
// salvare — salvarlo tale e quale era il bug "canali trovati via API
// sempre giù"); la scheda "stream diretto" porta un ID incollato che si
// tratta come content id, com'era nella v3.10.0.
app.post('/search/import', async (req, res) => {
  const { name, infohash, category, logo_url, id_kind } = req.body;
  if (infohash && /^[a-fA-F0-9]{40}$/.test(infohash)) {
    let acestreamId = infohash.toLowerCase();
    if (id_kind === 'infohash') {
      try {
        acestreamId = await resolveContentId(acestreamId);
      } catch (err) {
        // Non salviamo un id non riproducibile: si torna alla ricerca
        // con il banner esplicativo.
        return res.redirect(`/search?q=${encodeURIComponent(infohash)}&resolve_failed=1`);
      }
    }
    importChannels(
      [{ name: name || `Canale ${acestreamId.slice(0, 8)}`, acestream_id: acestreamId, category, logo_url }],
      null
    );
  }
  res.redirect('/channels');
});

app.post('/search/import-selected', async (req, res) => {
  const selected = Array.isArray(req.body.results) ? req.body.results : [];
  const candidates = selected
    .filter((r) => r && /^[a-fA-F0-9]{40}$/.test(r.infohash))
    .map((r) => ({
      name: String(r.name || `Canale ${r.infohash.slice(0, 8)}`).slice(0, 200),
      infohash: r.infohash.toLowerCase(),
      category: r.category || '',
      logo_url: r.logo_url || '',
    }));

  // Risoluzione in parallelo: ogni infohash deve diventare un content id
  // PRIMA di entrare in DB (vedi /search/import). Quelli che il motore
  // non riconosce si scartano e si dichiarano — un canale morto in lista
  // è peggio di un canale mancante.
  const settled = await Promise.allSettled(
    candidates.map((r) => resolveContentId(r.infohash))
  );
  const rows = [];
  let failed = 0;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') rows.push({ ...candidates[i], acestream_id: s.value });
    else failed += 1;
  });
  if (rows.length) importChannels(rows, null);
  res.json({ imported: rows.length, failed });
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
      console.error('[stats] stop error:', err.message);
    }
  }
  res.json({ ok: true });
});

// Scansiona un intervallo CIDR per candidati VLC (porta HTTP configurabile,
// default 8080) — non c'è modo di confermare che sia davvero VLC senza la
// password, quindi questi sono candidati da verificare, non conferme.
app.post('/addons/scan/vlc', async (req, res) => {
  const cidr = (req.body.cidr || '').trim();
  const port = Math.max(1, Math.min(65535, parseInt(req.body.port, 10) || 8080));
  try {
    const found = await scanForPort(cidr, port);
    res.json({ ok: true, candidates: found.map((ip) => ({ ip, port })) });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Scansiona un intervallo CIDR per server Jellyfin (porta HTTP
// configurabile, default 8096) — ogni candidato viene verificato tramite
// l'endpoint pubblico non autenticato, quindi qui i risultati sono
// conferme reali, non solo "qualcosa risponde su questa porta".
app.post('/addons/scan/jellyfin', async (req, res) => {
  const cidr = (req.body.cidr || '').trim();
  const port = Math.max(1, Math.min(65535, parseInt(req.body.port, 10) || 8096));
  try {
    const candidates = await scanForPort(cidr, port);
    const verified = (await Promise.all(candidates.map((ip) => verifyJellyfin(ip, port)))).filter(Boolean);
    res.json({ ok: true, servers: verified });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ---------- Add-Ons (integrazioni: dispositivi VLC remoti) ----------

app.get('/addons', (req, res) => {
  const host = req.get('host');
  render(res, 'addons', {
    titleKey: 'addons.title',
    devices: listVlcDevices(),
    jellyfinTsUrl: `http://${host}/playlist.m3u8`,
    jellyfinEpgUrl: `http://${host}/epg.xml`,
    jellyfinServerUrl: getSetting('jellyfin_server_url', ''),
    jellyfinApiKey: getSetting('jellyfin_api_key', ''),
  });
});

app.post('/addons/jellyfin', (req, res) => {
  setSetting('jellyfin_server_url', normalizeBaseUrl(req.body.jellyfin_server_url, ''));
  setSetting('jellyfin_api_key', (req.body.jellyfin_api_key || '').trim());
  res.redirect('/addons');
});

// Test di connessione reale: chiama /System/Info con la chiave API — se
// risponde, mostriamo nome/versione del server, prova concreta che le
// credenziali funzionano (non solo che l'indirizzo è raggiungibile).
app.post('/addons/jellyfin/test', async (req, res) => {
  const serverUrl = getSetting('jellyfin_server_url', '');
  const apiKey = getSetting('jellyfin_api_key', '');
  if (!serverUrl || !apiKey) return res.json({ ok: false, error: 'not_configured' });
  try {
    const r = await fetch(`${serverUrl}/System/Info`, {
      headers: { 'X-Emby-Token': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    res.json({ ok: true, serverName: data.ServerName, version: data.Version });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Comanda Jellyfin direttamente: forza una scansione libreria (utile
// dopo aver aggiunto/cambiato canali, così il tuner M3U li rilevi subito
// invece di aspettare la prossima scansione automatica).
app.post('/addons/jellyfin/refresh', async (req, res) => {
  const serverUrl = getSetting('jellyfin_server_url', '');
  const apiKey = getSetting('jellyfin_api_key', '');
  if (!serverUrl || !apiKey) return res.json({ ok: false, error: 'not_configured' });
  try {
    const r = await fetch(`${serverUrl}/Library/Refresh`, {
      method: 'POST',
      headers: { 'X-Emby-Token': apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/addons/vlc', (req, res) => {
  const name = (req.body.name || '').trim();
  const host = (req.body.host || '').trim();
  const port = Math.max(1, Math.min(65535, parseInt(req.body.port, 10) || 8080));
  const password = req.body.password || '';
  if (name && host && password) {
    addVlcDevice({ name, host, port, password });
  }
  res.redirect('/addons');
});

app.post('/addons/vlc/:id/delete', (req, res) => {
  deleteVlcDevice(req.params.id);
  res.redirect('/addons');
});

// Verifica connessione/password senza controllare la riproduzione (legge
// solo lo stato attuale) — richiamata via fetch dal JS della pagina.
app.post('/addons/vlc/:id/test', async (req, res) => {
  try {
    const device = getVlcDevice(req.params.id);
    if (!device) return res.json({ ok: false, error: 'not_found' });
    await getVlcStatus(device);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Verifica se il client WARP (servizio opzionale, profilo "warp" nel
// compose) è raggiungibile e realmente connesso — nessun traffico della
// webui viene instradato attraverso di esso, solo questo controllo di
// stato usa il suo proxy SOCKS5.
app.get('/addons/warp/status', async (req, res) => {
  const status = await checkWarpStatus('warp', 1080);
  res.json(status);
});

// ---------- Calendario calcio / trasmittenti ----------

// Cache delle partite della squadra preferita (settings, scritta da qui e
// dal job orario): la Dashboard la legge SENZA toccare la rete — nessuna
// pagina deve aspettare un request a livesoccertv.com per aprirsi.
async function refreshFavoriteMatchesCache() {
  const raw = getSetting('football_favorite_team', '');
  if (!raw) return;
  const team = JSON.parse(raw); // lancia volontariamente se corrotto: gestito dai chiamanti
  const matches = (await getUpcomingTeamMatches(team.country, team.slug, team.name, 5)).map((m) => ({
    ...m,
    ko: formatKickoff(m.koEpoch),
  }));
  setSetting(
    'football_favorite_matches_cache',
    JSON.stringify({ team: team.name, country: team.country, slug: team.slug, matches, updatedAt: Date.now() })
  );
}

function readFavoriteMatchesCache() {
  const raw = getSetting('football_favorite_matches_cache', '');
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw);
    if (cached && cached.team && Array.isArray(cached.matches)) return cached;
  } catch {
    /* cache corrotta: la ricaviamo al prossimo giro */
  }
  return null;
}

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
      // Dati freschi per la scheda qui sotto E cache aggiornata per il
      // widget della Dashboard (che da sola non tocca mai la rete).
      await refreshFavoriteMatchesCache();
      favoriteMatches = (readFavoriteMatchesCache() || { matches: [] }).matches;
    } catch (err) {
      favoriteError = err.message;
    }
  }

  render(res, 'football', {
    titleKey: 'football.title',
    team,
    candidates,
    error,
    favoriteTeam,
    favoriteMatches,
    favoriteError,
    footballStatus: getFootballDiagnostics(),
  });
});

// Ricostruzione manuale dell'indice squadre (bottone sulla pagina Football).
app.post('/football/index/refresh', async (req, res) => {
  try {
    await runJob('football_index', async () => {
      await refreshTeamIndex();
      const d = getFootballDiagnostics();
      return { detail: `${d.teamIndexSize} teams indexed` };
    });
  } catch (err) {
    console.error('[football] manual index refresh failed:', err.message);
  }
  res.redirect('/football');
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
      matches = sortMatchesForDisplay(matches);
    } catch (err) {
      error = err.message;
    }
  }
  render(res, 'football_team', { titleKey: 'football.title', country, slug, name, matches, error, nowMs: Date.now() });
});

// Normalizza un nome canale/trasmittente per il confronto: minuscolo, senza
// accenti, punteggiatura trasformata in spazi, spazi collassati.
function normalizeBroadcastName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Trova i canali della playlist che probabilmente trasmettono un dato
// broadcaster (es. "Sky Sport Arena" → canale "Sky Sport Arena HD"), così
// dalla pagina di una partita si può andare dritti al stream giusto.
// Punteggio: 3 = nome identico dopo normalizzazione; 2 = l'uno contiene
// l'altro per intero come sottostringa di parole; 1 = tutte le parole del
// broadcaster sono presenti nel nome del canale. Con un broadcaster di una
// sola parola il punteggio 1 è escluso ("Sky" non deve combaciare con
// qualunque canale che contiene la parola "sky": troppo rumore).
function matchChannelsToBroadcaster(broadcaster, channels) {
  const target = normalizeBroadcastName(broadcaster);
  if (!target) return [];
  const targetTokens = target.split(' ');
  const scored = [];
  for (const ch of channels) {
    const name = normalizeBroadcastName(ch.name);
    if (!name) continue;
    let score = 0;
    if (name === target) score = 3;
    else if (name.includes(target) || target.includes(name)) score = 2;
    else if (targetTokens.length > 1) {
      const nameTokens = new Set(name.split(' '));
      if (targetTokens.every((tk) => nameTokens.has(tk))) score = 1;
    }
    if (score > 0) scored.push({ channel: ch, score });
  }
  scored.sort((a, b) => b.score - a.score || a.channel.name.localeCompare(b.channel.name));
  return scored.slice(0, 3).map((s) => s.channel);
}

app.get('/football/match', async (req, res) => {
  const matchUrl = (req.query.url || '').trim();
  let coverage = [];
  let matchTitle = '';
  let error = null;
  if (!matchUrl) {
    error = 'URL mancante';
  } else {
    try {
      ({ coverage, matchTitle } = await getBroadcastersByCountry(matchUrl));
    } catch (err) {
      error = err.message;
    }
  }

  // Per ogni paese, quali canali della playlist sembrano trasmettere
  // quelle reti — l'utente può cliccare e guardare subito, senza cercare
  // a mano il canale dopo aver letto l'elenco delle trasmittenti.
  let coverageWithMatches = [];
  if (coverage.length) {
    const allChannels = db
      .prepare('SELECT id, name, logo_url, status FROM channels ORDER BY sort_order, name COLLATE NOCASE')
      .all();
    coverageWithMatches = coverage.map((row) => {
      const byId = new Map();
      for (const ch of row.channels) {
        for (const m of matchChannelsToBroadcaster(ch, allChannels)) {
          if (!byId.has(m.id)) byId.set(m.id, m); // lo stesso canale può matchare più reti: una volta sola
        }
      }
      return { ...row, matches: [...byId.values()] };
    });
  }
  render(res, 'football_match', { titleKey: 'football.broadcasters_title', matchUrl, matchTitle, coverage: coverageWithMatches, error });
});

// Ricerca canali per una partita: usa il titolo ("A vs B") per interrogare
// l'API di ricerca AceStream e proporre i canali da importare — il
// complemento di "In your playlist", che mostra solo ciò che si ha già.
app.get('/football/match/channels', async (req, res) => {
  const matchUrl = (req.query.url || '').trim();
  let title = (req.query.teams || '').trim();
  let error = null;

  // Il titolo arriva normalmente dal link (football.ejs lo conosce);
  // se manca (link condiviso a mano) lo si scrapa dalla pagina match.
  if (!title && matchUrl) {
    try {
      title = await getMatchTitle(matchUrl);
    } catch (err) {
      // Nessun titolo: si può comunque cercare a mano dalla pagina Cerca.
    }
  }

  // Query: "A vs B" per prima, poi le due squadre da sole. Se il titolo
  // non è nel formato atteso si usa tutto come unica query.
  const vsParts = title.split(/\s+vs\.?\s+/i).map((s) => s.trim()).filter(Boolean);
  const queries = [];
  const pushQuery = (q) => {
    q = q.replace(/\s+/g, ' ').trim();
    if (q && q.length >= 3 && !queries.some((x) => x.toLowerCase() === q.toLowerCase())) queries.push(q);
  };
  if (vsParts.length === 2) {
    pushQuery(`${vsParts[0]} ${vsParts[1]}`);
    vsParts.forEach(pushQuery);
  } else {
    pushQuery(title);
  }
  queries.splice(3);

  // Le query partono in parallelo: in sequenza tre ricerche da ~10 s di
  // timeout ciascuna rendevano la pagina lentissima (e il motore cerca
  // già abbastanza piano da solo).
  const settled = await Promise.allSettled(
    queries.map((q) => searchAceStream(q, { pageSize: 20 }))
  );
  let results = [];
  let failedQueries = 0;
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value.results);
    else failedQueries += 1;
  }

  // Dedup per infohash (la stessa stream emerge da più query) e ranking:
  // prima quelle il cui nome cita una delle due squadre, poi le altre.
  const seen = new Map();
  for (const r of results) {
    if (!r.infohash) continue;
    if (!seen.has(r.infohash)) seen.set(r.infohash, r);
  }
  const teamTokens = vsParts.map((t) => t.toLowerCase()).filter(Boolean);
  // Confronto a livello di parola con prefisso bidirezionale (minimo 4
  // caratteri): i nomi completi di livesoccertv ("Internazionale") devono
  // trovare anche gli stream che li abbreviano ("Inter HD") — cosa che il
  // vecchio includes(squadra.slice(0, 6)) mancava, segnando "non
  // pertinente" proprio gli stream giusti.
  const isRelevant = (name) => {
    const words = (name || '').toLowerCase().split(/[^a-z0-9\u00C0-\u024F]+/).filter(Boolean);
    return words.some((w) =>
      teamTokens.some((t) => (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t)))
    );
  };
  const merged = [...seen.values()].map((r) => ({ ...r, relevant: isRelevant(r.name) }));
  merged.sort(
    (a, b) =>
      Number(b.relevant) - Number(a.relevant) ||
      (b.status === 2) - (a.status === 2) ||
      a.name.localeCompare(b.name)
  );

  if (!queries.length) error = 'no-title';
  else if (failedQueries === queries.length) error = 'search-unavailable';

  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  render(res, 'football_match_channels', {
    titleKey: 'football.find_channels_title',
    matchUrl,
    matchTitle: title,
    queries,
    results: merged,
    error,
    acexyBaseUrl,
  });
});

// ---------- Health (cronologia job + affidabilità canali) ----------

app.get('/jobs', (req, res) => {
  // 200 righe: con il box scorrevole la lista lunga non appesantisce più la
  // pagina, e la ritenzione reale è comunque limitata a 7 giorni dal db.js.
  const runs = getJobRuns(200);
  const stats = getStatusStats();
  const channels = db
    .prepare('SELECT id, name, logo_url, status, last_checked_at FROM channels')
    .all()
    .map((ch) => ({ ...ch, ...(stats.get(ch.id) || { checks: 0, onlineCount: 0, uptimePct: null, lastCheckMs: null }) }));
  // Prima i più fragili (offline cronico), poi i mai verificati, poi i sani.
  channels.sort((a, b) => {
    const ua = a.uptimePct === null ? 101 : a.uptimePct;
    const ub = b.uptimePct === null ? 101 : b.uptimePct;
    return ua - ub || a.name.localeCompare(b.name);
  });
  render(res, 'jobs', { titleKey: 'health.title', runs, channels });
});

// ---------- Impostazioni ----------

app.get('/settings', (req, res) => {
  render(res, 'settings', {
    titleKey: 'settings.title',
    acexyBaseUrl: getSetting('acexy_base_url', 'http://acexy:8080'),
    httpPlaybackUrl: getSetting('http_playback_url', ''),
    enginePublicUrl: getSetting('engine_public_url', ''),
    updateCheckEnabled: getSetting('update_check_enabled', '1') === '1',
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
  // Campo facoltativo: vuoto = il player web ricade su acexy_base_url
  // (comportamento di sempre) — vedi streamProxy.js/remux.js.
  setSetting('http_playback_url', normalizeBaseUrl(req.body.http_playback_url, ''));
  setSetting('engine_public_url', normalizeBaseUrl(req.body.engine_public_url, ''));
  // Checkbox HTML: assente dal body = disattivato. Il controllo delle
  // nuove versioni è attivo di default (chi non lo vuole lo spegne qui).
  setSetting('update_check_enabled', req.body.update_check_enabled ? '1' : '0');
  res.redirect('/settings');
});

// Nasconde il badge "nuova versione disponibile" finché non esce una
// release più recente di quella già scartata.
app.post('/settings/update-check/dismiss', (req, res) => {
  setSetting('update_dismissed_version', getSetting('update_latest_version', ''));
  res.redirect(req.get('referer') || '/');
});

// Controllo raggiungibilità/versione per un URL engine qualsiasi (usa lo
// stesso endpoint standard che espone qualunque engine AceStream, il
// nostro o uno esterno) — richiamato via fetch dal JS di settings.ejs per
// ciascuno dei campi URL configurati, così l'utente vede subito se punta
// a qualcosa di davvero raggiungibile senza dover salvare e ricaricare.
//
// Due livelli, perché questi campi possono puntare a due cose diverse:
// un vero engine AceStream (espone /webui/api/service?method=get_version,
// da cui ricaviamo anche la versione) oppure acexy (che secondo la sua
// stessa documentazione ufficiale espone SOLO /ace/getstream, nessun
// endpoint di stato) — se il primo tentativo fallisce, proviamo il
// secondo: qualunque risposta HTTP (anche un errore) prova che qualcosa
// è in ascolto e raggiungibile a quell'indirizzo, a differenza di un
// vero errore di connessione (rifiutata, timeout, DNS).
app.get('/settings/check-engine', async (req, res) => {
  const url = normalizeBaseUrl(req.query.url, '');
  if (!url) return res.json({ ok: false, error: 'empty' });

  try {
    const r = await fetch(`${url}/webui/api/service?method=get_version`, {
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) {
      const data = await r.json();
      if (!data.error && data.result?.version) {
        return res.json({ ok: true, version: data.result.version });
      }
    }
  } catch {
    // Non è un engine "vero" raggiungibile con questo endpoint (o non lo
    // è affatto) — proviamo il fallback sotto prima di dichiarare
    // irraggiungibile.
  }

  try {
    await fetch(`${url}/ace/getstream`, { signal: AbortSignal.timeout(4000) });
    // Qualunque risposta HTTP arrivi (anche un errore tipo 400 per ID
    // mancante) prova che c'è qualcosa di raggiungibile qui — non
    // sappiamo la versione, ma sappiamo che risponde.
    res.json({ ok: true, version: null });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
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
    console.error('[import] error:', err.message);
    return res.status(400).send(`Import fallito: ${err.message}`);
  }

  res.redirect('/channels');
});

// ---------- Playlist / EPG pubblici ----------

app.get('/playlist', async (req, res) => {
  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  const enginePublicUrl = getSetting('engine_public_url', '').replace(/\/$/, '');
  const host = req.get('host');
  const tsUrl = `http://${host}/playlist.m3u8`;
  const hlsUrl = `http://${host}/playlist.m3u8?format=hls`;
  const epgXmlUrl = `http://${host}/epg.xml`;

  // QR code generati qui (non su richiesta separata): sono piccoli,
  // veloci da generare, e così la pagina li ha già pronti al primo
  // caricamento — niente spinner o richiesta aggiuntiva per vederli.
  const tsQr = await QRCode.toDataURL(tsUrl, { margin: 1, width: 160 });
  const hlsQr = enginePublicUrl ? await QRCode.toDataURL(hlsUrl, { margin: 1, width: 160 }) : null;

  // Ogni fonte EPG con le sue statistiche (ultimo tentativo, numero di
  // programmi, eventuale errore) — vedi epg_source_stats in epg.js,
  // aggiornata ad ogni giro di refresh indipendentemente dal fatto che il
  // dataset combinato venga tenuto o scartato.
  const epgUrls = getSetting('epg_urls', '')
    .split(/[\n,]+/)
    .map((u) => u.trim())
    .filter(Boolean)
    .map((url) => ({ url, stats: getSourceStats(url) }));

  render(res, 'playlist', {
    titleKey: 'nav.playlist',
    tsUrl,
    hlsUrl,
    epgXmlUrl,
    tsQr,
    hlsQr,
    acexyBaseUrl,
    enginePublicUrl,
    hlsConfigured: Boolean(enginePublicUrl),
    epgUrls,
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

app.get('/playlist.m3u8', (req, res) => {
  const format = req.query.format === 'hls' ? 'hls' : 'ts';
  // Stessa logica della pagina Playlist (http://<host>/epg.xml): così chi
  // importa l'M3U in TiviMate/Kodi/OTT Navigator riceve anche la guida,
  // senza dover configurare l'URL EPG a mano nel player.
  const epgUrl = `http://${req.get('host')}/epg.xml`;
  res.type('application/vnd.apple.mpegurl').send(buildM3U(req.query.search || '', format, epgUrl));
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
    runJob('epg_refresh', async () => {
      const r = await refreshEpg();
      return { detail: `${r.imported} programs from ${r.sources} sources`, warnings: (r.errors || []).length };
    }).catch((err) => console.error('[epg] refresh failed:', err));
  });
  console.log(`[epg] refresh scheduled every ${hours}h`);
}

scheduleEpgRefresh();
runJob('epg_refresh', async () => {
  const r = await refreshEpg();
  return { detail: `${r.imported} programs from ${r.sources} sources`, warnings: (r.errors || []).length };
}).catch((err) => console.error('[epg] initial refresh failed:', err));

// Controlla ogni ora quali sorgenti con auto-refresh impostato sono "dovute"
// secondo il proprio intervallo individuale (ognuna il suo, non un unico
// intervallo globale). Le sorgenti manuali non vengono mai toccate qui.
// Quando nessuna sorgente è dovuta (n = 0) la corsa NON viene registrata:
// altrimenti la cronologia si riempireebbe di righe identiche e inutili
// "0 sources refreshed" una ogni ora. Gli errori restano sempre registrati.
cron.schedule('7 * * * *', async () => {
  const startedAt = Date.now();
  try {
    const n = await refreshDueSources();
    if (n > 0) recordJobRun('sources_refresh', 'ok', `${n} sources refreshed`, Date.now() - startedAt);
  } catch (err) {
    recordJobRun('sources_refresh', 'error', err.message, Date.now() - startedAt);
    console.error('[sources] auto-refresh failed:', err);
  }
});

// Aggiorna la cache delle partite della squadra preferita (widget della
// Dashboard) una volta all'ora, a :37 — la paginaFootball la aggiorna
// comunque a ogni visita: questo job copre chi non la apre per giorni.
cron.schedule('37 * * * *', () => {
  refreshFavoriteMatchesCache().catch((err) => console.warn('[football] favorite cache refresh failed:', err.message));
});
refreshFavoriteMatchesCache().catch((err) => console.warn('[football] favorite cache refresh failed:', err.message));

// Controllo nuove versioni su GitHub: all'avvio (rimandato di 5 secondi
// per non toccare il boot) e poi ogni 6 ore. Letto dalla cache dalla UI.
setTimeout(() => checkForUpdate(), 5000);
cron.schedule('11 */6 * * *', () => {
  checkForUpdate().catch((err) => console.warn('[update-check] job failed:', err.message));
});

// Controllo schedulato dello stato di tutti i canali (online/offline) —
// due modalità alternative, non per singola fonte ma un'unica
// impostazione globale (a differenza dell'auto-refresh delle fonti sopra):
// "interval" confronta da quanto tempo è passato dall'ultima verifica
// completa rispetto all'intervallo scelto; "time" verifica se siamo
// nell'ora programmata e non abbiamo già girato oggi.
cron.schedule('12 * * * *', async () => {
  const mode = getSetting('channels_check_mode', 'off');
  if (mode === 'off') return;

  const lastAt = parseInt(getSetting('channels_last_check_all_at', '0'), 10) || 0;
  const now = new Date();
  let due = false;

  if (mode === 'interval') {
    const hours = parseInt(getSetting('channels_check_interval_hours', '6'), 10) || 6;
    due = Date.now() - lastAt >= hours * 60 * 60 * 1000;
  } else if (mode === 'time') {
    const scheduledTime = getSetting('channels_check_time', '04:00');
    const scheduledHour = scheduledTime.slice(0, 2);
    const currentHour = String(now.getHours()).padStart(2, '0');
    // Confronto solo sull'ora (il cron gira una volta l'ora, ai minuti
    // :12) — evita di rigirare più volte nella stessa ora confrontando
    // anche la data dell'ultima esecuzione.
    const alreadyRanToday = lastAt && new Date(lastAt).toDateString() === now.toDateString();
    due = scheduledHour === currentHour && !alreadyRanToday;
  }

  if (!due) return;
  try {
    await runJob('channels_check', async () => {
      const out = await checkAllChannels();
      return { detail: `${out.online}/${out.total} online (scheduled)` };
    });
    setSetting('channels_last_check_all_at', String(Date.now()));
  } catch (err) {
    console.error('[status] scheduled check failed:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`AceStream Manager listening on http://0.0.0.0:${PORT}`);
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
