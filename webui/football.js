const cheerio = require('cheerio');
const { fetchHtml, getDiagnostics: getFetcherDiagnostics, clearCache: clearFetcherCache } = require('./fetcher');

const BASE = 'https://www.livesoccertv.com';

// ---------------------------------------------------------------------
// Indice squadre locale, costruito dalle pagine di classifica dei
// principali campionati (es. /competitions/italy/serie-a/), che sono
// STATICHE e affidabili — a differenza della pagina di ricerca del sito
// (/search/?q=...), che carica i risultati via JavaScript lato client e
// quindi non è scrapabile in modo affidabile con una richiesta HTTP
// semplice (verificato più volte contro l'HTML reale).
//
// In più, la tabella classifica usa il nome "corretto/canonico" della
// squadra così come appare in tutto il sito (es. "Internazionale", non
// "Inter Milan"), risolvendo anche il problema per cui cercare il nome
// che il sito stesso usa altrove non trovava corrispondenze.
//
// Il fetch passa da fetcher.js: livesoccertv.com è dietro una challenge
// Cloudflare (403 "Just a moment...") che blocca il fetch semplice di
// Node; il fallback con browser headless la risolve automaticamente.
// ---------------------------------------------------------------------

const COMPETITIONS = [
  ['england', 'premier-league'],
  ['spain', 'primera-division'],
  ['italy', 'serie-a'],
  ['germany', 'bundesliga'],
  ['france', 'ligue-1'],
  ['portugal', 'liga-sagres'],
  ['netherlands', 'eredivisie'],
  ['turkey', 'super-lig'],
  ['united-states', 'major-league-soccer'],
  ['mexico', 'primera-division'],
  ['brazil', 'serie-a-brasileirao'],
  ['international', 'uefa-champions-league'],
];

let teamIndex = [];
let teamIndexBuiltAt = 0;
let teamIndexLastError = null;
let buildingPromise = null;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchCompetitionTeams(country, slug) {
  const url = `${BASE}/competitions/${country}/${slug}/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const teams = [];
  // Nella tabella classifica ogni riga ha un link /teams/<country>/<slug>/
  // col nome della squadra come testo — è la fonte più affidabile che
  // abbiamo verificato contro l'HTML reale del sito.
  $('a[href*="/teams/"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const name = $(el).text().replace(/\s+/g, ' ').trim();
    const m = href.match(/\/teams\/([^/]+)\/([^/?#]+)/);
    if (!m || !name || name.length < 2) return;
    teams.push({ name, country: m[1], slug: m[2] });
  });

  return teams;
}

async function buildTeamIndex() {
  const results = [];
  const seen = new Set();
  let failures = 0;
  let lastFailure = null;

  for (const [country, slug] of COMPETITIONS) {
    try {
      const teams = await fetchCompetitionTeams(country, slug);
      for (const t of teams) {
        const key = `${t.country}/${t.slug}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(t);
        }
      }
    } catch (err) {
      failures++;
      lastFailure = err.message;
      console.error(`[football] indexing failed for ${country}/${slug}:`, err.message);
    }
  }

  teamIndex = results;
  teamIndexBuiltAt = results.length > 0 ? Date.now() : 0;
  teamIndexLastError = failures > 0
    ? `${failures}/${COMPETITIONS.length} competitions failed (last: ${lastFailure})`
    : null;
  console.log(`[football] team index built: ${teamIndex.length} teams from ${COMPETITIONS.length} competitions${failures ? ` (${failures} failed)` : ''}`);
  return teamIndex;
}

async function ensureTeamIndex() {
  const isStale = Date.now() - teamIndexBuiltAt > INDEX_TTL_MS;
  if (teamIndex.length > 0 && !isStale) return teamIndex;
  if (!buildingPromise) {
    buildingPromise = buildTeamIndex().finally(() => {
      buildingPromise = null;
    });
  }
  return buildingPromise;
}

// Ricostruzione manuale dell'indice (bottone sulla pagina Football):
// svuota anche la cache HTML del fetcher, così la prossima ricerca
// riparte dai dati più freschi.
async function refreshTeamIndex() {
  clearFetcherCache();
  teamIndex = [];
  teamIndexBuiltAt = 0;
  teamIndexLastError = null;
  return buildTeamIndex();
}

// Ricerca locale: filtra l'indice per nome squadra (sottostringa,
// case-insensitive) — niente scraping della ricerca del sito, quindi
// niente dipendenza da contenuti caricati via JavaScript lato client.
async function searchTeams(query) {
  const index = await ensureTeamIndex();
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return index
    .filter((t) => t.name.toLowerCase().includes(needle))
    .slice(0, 20);
}

// Tabella "Copertura internazionale" della pagina di una partita:
// paese -> elenco emittenti. È un heading ("International Coverage",
// verificato contro l'HTML reale del sito) seguito da una <table> con
// una riga per paese, prima colonna = nome paese, seconda colonna =
// link alle emittenti.
async function getBroadcastersByCountry(matchUrl) {
  const html = await fetchHtml(matchUrl);
  const $ = cheerio.load(html);

  const results = [];

  let table = null;
  $('h1, h2, h3, h4').each((_, el) => {
    const text = $(el).text().toLowerCase();
    if (text.includes('copertura internazionale') || text.includes('international coverage') || text.includes('international tv')) {
      table = $(el).nextAll('table').first();
      if (!table.length) {
        table = $(el).closest('section, div').find('table').first();
      }
    }
  });

  if (!table || !table.length) {
    const tables = $('table');
    if (tables.length) table = tables.last();
  }

  if (table && table.length) {
    table.find('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const country = $(cells[0]).text().replace(/\s+/g, ' ').trim();
      const channels = [];
      $(cells[1])
        .find('a')
        .each((__, a) => {
          const name = $(a).text().replace(/\s+/g, ' ').trim();
          if (name) channels.push(name);
        });
      if (country && channels.length) {
        results.push({ country, channels });
      }
    });
  }

  return results;
}

// Estrae {country, slug} da un URL di pagina squadra livesoccertv.com
// incollato manualmente — fallback sempre affidabile per arrivare
// direttamente alle partite di una squadra non presente nell'indice
// locale (es. squadre fuori dai campionati indicizzati).
function parseTeamUrl(url) {
  const m = String(url).match(/livesoccertv\.com\/(?:[a-z]{2}\/)?teams\/([^/]+)\/([^/?#]+)/i);
  if (!m) return null;
  return { country: m[1], slug: m[2] };
}

// Titolo della partita ("Atalanta vs Internazionale") dalla sua pagina:
// serve alla ricerca canali per partita per costruire le query. Lo si
// prende dall'heading principale della pagina (il <title> del sito porta
// dietro pubblicità/suffissi del tipo "... - Livesoccertv"); se non ha la
// forma attesa si ripiega sul <title>. Restituisce '' se il fetch fallisce:
// il chiamate ha già un suo messaggio d'errore da mostrare.
async function getMatchTitle(matchUrl) {
  const html = await fetchHtml(matchUrl);
  const $ = cheerio.load(html);
  const h1 = ($('h1').first().text() || '').replace(/\s+/g, ' ').trim();
  if (/[a-zA-Z\u00C0-\u024F]{2}\s+vs\.?\s+[a-zA-Z\u00C0-\u024F]{2}/i.test(h1)) return h1;
  const title = ($('title').first().text() || '').replace(/\s+/g, ' ').trim();
  const m = title.match(/([^|\-–—]*?\s+vs\.?\s+[^|\-–—]*?)(?:\s*[|\-–—]|$)/i);
  return m ? m[1].trim() : (h1 || title).slice(0, 120);
}

// --- parsing della lista partite di una squadra ------------------------------
//
// La pagina squadra ha una tabella dei palinsesti con una struttura molto
// stabile e ricca (verificata contro l'HTML reale):
//
//   <tr class="drow">                     <- intestazione di gruppo
//     <a href="/schedules/2026-11-22/">…</a> · <a href="/competitions/…">Serie A</a>
//   </tr>
//   <tr class="matchrow" data-ko="2026-11-22 14:45:00" data-cid="39">
//     <td class="timecol"><span class="ts" dv="1795376700000" df="H:MM">19:45</span>…</td>
//     <td class="matchcol"><a href="/match/…#5653990" title="Atalanta vs Internazionale">…</a>
//       <div id="channels"><a …>beIN Sports…</a> …</div></td>
//   </tr>
//
// Fonti di data/ora, in ordine di affidabilità:
//   1. dv:  epoch milliseconds sullo span dell'orario — assolute, la
//           conversione fuso orario la fa il server che serve la pagina
//           (era il punto debole del parser precedente);
//   2. data-ko: "YYYY-MM-DD HH:MM:SS" in America/New_York (fuso di
//           riferimento del sito, verificato su più partite con DST);
//   3. data del gruppo /schedules/YYYY-MM-DD/ — dipende dal fuso del
//           client, quindi usata solo come ultimo ripiego.
//
// Nella pagina compaiono anche: righe `tr.repeatrow` (repliche TV dentro
// il div #_repeat, da NON confondere con le partite) e una sidebar
// "Top Matches" con partite di altre squadre (fuori da tr.matchrow).

// 'YYYY-MM-DD HH:MM:SS' in America/New_York -> epoch ms
function dataKoToEpoch(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  // trova l'offset del fuso America/New_York in quel giorno (DST-aware)
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, se);
  for (const hoursOff of [5, 4]) {
    const t = utcGuess + hoursOff * 3600 * 1000;
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = {};
    for (const p of fmt.formatToParts(new Date(t))) parts[p.type] = p.value;
    const nyHour = Number(parts.hour === '24' ? '0' : parts.hour);
    if (nyHour === h && Number(parts.minute) === mi && Number(parts.day) === d) {
      return t;
    }
  }
  // ripiego: offset standard
  return utcGuess + 5 * 3600 * 1000;
}

function extractMatchesFromRows($) {
  const matches = [];
  const seen = new Set();

  $('tr.matchrow').each((_, el) => {
    const $row = $(el);
    if ($row.hasClass('repeatrow')) return; // repliche TV, non partite

    const matchLink = $row.find('a[href*="/match/"]').first();
    if (!matchLink.length) return;
    const href = matchLink.attr('href') || '';
    if (!href || seen.has(href)) return;

    const title = (matchLink.attr('title') || matchLink.text() || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 3) return;

    // 1) epoch assoluto dallo span dell'orario
    let koEpoch = null;
    const dv = $row.find('span.ts[dv]').first().attr('dv');
    if (dv) {
      const n = parseInt(dv, 10);
      if (!Number.isNaN(n) && n > 1000000000000) koEpoch = n;
    }
    // 2) data-ko (America/New_York)
    if (!koEpoch) koEpoch = dataKoToEpoch($row.attr('data-ko'));

    // gruppo data/campionato (ultima intestazione drow sopra questa riga)
    const $drow = $row.prevAll('tr.drow').first();
    const dateHref = $drow.find('a[href*="/schedules/"]').attr('href') || '';
    const dm = dateHref.match(/\/schedules\/(\d{4}-\d{2}-\d{2})\/?/);
    const groupDate = dm ? dm[1] : null;
    const competition = $drow.find('a[href*="/competitions/"]').first().text().replace(/\s+/g, ' ').trim() || null;

    // anteprima emittenti della riga (le complete sono sulla pagina match)
    const channels = [];
    $row.find('div#channels a, .channels-col a').each((__, a) => {
      const n = $(a).text().replace(/\s+/g, ' ').trim();
      if (n && channels.length < 6) channels.push(n);
    });
    const hasLiveStream = $row.find('a.ministream').length > 0;

    seen.add(href);
    matches.push({
      title,
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      date: groupDate,
      koEpoch,
      competition,
      channels,
      hasLiveStream,
    });
  });

  return matches;
}

// Parser di riserva (markup cambiato?): cammina tutti i link
// /schedules/ e /match/ come faceva la vecchia versione.
function extractMatchesLegacy($, needle) {
  const matches = [];
  const seen = new Set();
  let currentDate = null;

  $('a[href*="/schedules/"], a[href*="/match/"]').each((_, el) => {
    const href = $(el).attr('href') || '';

    const dateMatch = href.match(/\/schedules\/(\d{4}-\d{2}-\d{2})\/?/);
    if (dateMatch) {
      currentDate = dateMatch[1];
      return;
    }

    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text || seen.has(href) || text.length < 3) return;
    if (needle && !text.toLowerCase().includes(needle)) return;
    seen.add(href);
    matches.push({
      title: text,
      url: href.startsWith('http') ? href : `${BASE}${href}`,
      date: currentDate,
      koEpoch: null,
      competition: null,
      channels: [],
      hasLiveStream: false,
    });
  });

  return matches;
}

// Partite di una squadra, dalla sua pagina team. Se conosciamo il nome
// della squadra (dall'indice locale, o dal titolo della pagina come
// fallback) filtriamo per tenere solo le partite che la coinvolgono
// davvero (esclude la sidebar "Top Matches").
async function getTeamMatches(country, slug, teamName) {
  const url = `${BASE}/teams/${country}/${slug}/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const name = (teamName || $('h1').first().text() || '').replace(/\s+/g, ' ').trim();
  const needle = name.toLowerCase();

  let matches = extractMatchesFromRows($);
  if (matches.length === 0) matches = extractMatchesLegacy($, needle);

  // filtro per nome squadra: sulle righe strutturate il titolo del link
  // è già affidabile, ma la sidebar può iniettare altre partite: meglio
  // ricontrollare quando conosciamo il nome canonico.
  if (needle && matches.length > 0) {
    const filtered = matches.filter((m) => m.title.toLowerCase().includes(needle));
    // non filtrare se il filtro svuoterebbe tutto (nomi abbreviati ecc.)
    if (filtered.length > 0) matches = filtered;
  }

  const result = matches.slice(0, 30);
  result.resolvedName = name; // utile quando il chiamante non ha già un nome (es. flusso "incolla URL")
  return result;
}

// Come getTeamMatches, ma filtra alle sole partite non ancora iniziate
// e le ordina cronologicamente — usato per la scheda "Squadra preferita"
// e per la pagina squadra. Con epoch disponibile il confronto è esatto;
// senza (markup nuovo) si ricade sulla data di gruppo, con un giorno di
// tolleranza per i fusi orari.
async function getUpcomingTeamMatches(country, slug, teamName, limit = 5) {
  const all = await getTeamMatches(country, slug, teamName);
  const now = Date.now();
  const nowDate = new Date(now).toISOString().slice(0, 10);
  const withEpoch = all.filter((m) => m.koEpoch);
  const withoutEpoch = all.filter((m) => !m.koEpoch);

  const upcoming = withEpoch
    .filter((m) => m.koEpoch + 3 * 60 * 60 * 1000 >= now) // include partite in corso (~90'+intervallo)
    .sort((a, b) => a.koEpoch - b.koEpoch);

  const fallbackUpcoming = withoutEpoch
    .filter((m) => !m.date || m.date >= nowDate)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  return upcoming.concat(fallbackUpcoming).slice(0, limit);
}

function getFootballDiagnostics() {
  const d = getFetcherDiagnostics();
  return {
    ...d,
    teamIndexSize: teamIndex.length,
    teamIndexBuiltAt,
    teamIndexLastError,
    competitions: COMPETITIONS.length,
  };
}

module.exports = {
  searchTeams,
  getTeamMatches,
  getUpcomingTeamMatches,
  getBroadcastersByCountry,
  parseTeamUrl,
  getMatchTitle,
  refreshTeamIndex,
  getFootballDiagnostics,
};
