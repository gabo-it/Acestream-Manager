const cheerio = require('cheerio');

const BASE = 'https://www.livesoccertv.com';

async function fetchHtml(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

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
  ['brazil', 'serie-a'],
  ['international', 'uefa-champions-league'],
];

let teamIndex = [];
let teamIndexBuiltAt = 0;
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
      console.error(`[football] indicizzazione fallita per ${country}/${slug}:`, err.message);
    }
  }

  teamIndex = results;
  teamIndexBuiltAt = Date.now();
  console.log(`[football] indice squadre costruito: ${teamIndex.length} squadre da ${COMPETITIONS.length} campionati`);
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
// paese -> elenco emittenti. Verificato contro l'HTML reale del sito
// (agosto 2026): è un heading seguito da una <table> con una riga per
// paese, prima colonna = nome paese, seconda colonna = link alle emittenti.
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

// Prossime partite di una squadra, dalla sua pagina team. La pagina
// contiene anche una sidebar "Top Matches" generica (non legata alla
// squadra): se conosciamo il nome della squadra (dall'indice locale, o
// dal titolo della pagina come fallback) filtriamo per tenere solo le
// partite che la coinvolgono davvero.
//
// La data di ogni partita si ricava dal link /schedules/YYYY-MM-DD/ che
// precede ogni gruppo di partite nella pagina (verificato contro l'HTML
// reale, agosto 2026) — più affidabile del testo "Saturday, 23 May" da
// solo, che non include l'anno.
async function getTeamMatches(country, slug, teamName) {
  const url = `${BASE}/teams/${country}/${slug}/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const name = (teamName || $('h1').first().text() || '').replace(/\s+/g, ' ').trim();
  const needle = name.toLowerCase();

  const matches = [];
  const seen = new Set();
  let currentDate = null; // 'YYYY-MM-DD' dall'ultimo header data incontrato

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
    });
  });

  const result = matches.slice(0, 30);
  result.resolvedName = name; // utile quando il chiamante non ha già un nome (es. flusso "incolla URL")
  return result;
}

// Come getTeamMatches, ma filtra alle sole partite future (data >= oggi)
// e le ordina cronologicamente — usato per la scheda "Squadra preferita".
async function getUpcomingTeamMatches(country, slug, teamName, limit = 5) {
  const all = await getTeamMatches(country, slug, teamName);
  const today = new Date().toISOString().slice(0, 10);
  return all
    .filter((m) => m.date && m.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, limit);
}

module.exports = { searchTeams, getTeamMatches, getUpcomingTeamMatches, getBroadcastersByCountry, parseTeamUrl };
