// ---------------------------------------------------------------------------
// Scraping generico dei siti configurati nella pagina "Search sites".
//
// L'idea: i siti che pubblicano stream AceStream (siti di listing, forum,
// pagine ZeroNet, ...) finiscono per contenere, da qualche parte nell'HTML,
// un URI `acestream://<infohash>` o un infohash da 40 caratteri esadecimali
// in un link. Quasi sempre il testo vicino (il testo dell'<a>, il title,
// la riga di testo attorno) dice che cos'è lo stream.
//
// Quindi invece di scrivere un adapter per ogni sito (selettori CSS diversi,
// HTML diversi, manutenzione infinita), si scarica la pagina e si estraggono
// TUTTI i riferimenti AceStream con il nome più sensato trovato attorno.
// Funziona con qualunque sito che pubblichi link acestream:// — compresi i
// zite ZeroNet, che sono pagine HTTP servite dal client ZeroNet locale.
//
// Il download passa da fetcher.js: senza WARP c'è anche il fallback Chromium
// anti-Cloudflare (lo stesso del modulo calcio); con WARP la richiesta esce
// dal proxy SOCKS5 del container warp, senza fallback browser.
// ---------------------------------------------------------------------------

const { fetchHtml, fetchHtmlViaSocks, ChallengeError } = require('./fetcher');

const MAX_RESULTS_PER_SITE = 100;

// --- helper HTML ------------------------------------------------------------

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; }
    })
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// --- estrazione --------------------------------------------------------------

const ACESTREAM_URI_RE = /acestream:\/\/([a-fA-F0-9]{40})/i;
const ACESTREAM_URI_GLOBAL_RE = /acestream:\/\/([a-fA-F0-9]{40})/gi;
const HASH_IN_HREF_RE = /[?&](?:id|infohash|hash)=([a-fA-F0-9]{40})/i;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

// Nome "usa e getta" per gli stream senza testo attorno: i primi 8
// caratteri dell'infohash bastano a riconoscerlo in lista.
function fallbackName(infohash) {
  return `Acestream ${infohash.slice(0, 8)}`;
}

// Testi troppo generici per fare da nome: in quel caso si preferisce
// l'attributo title del link, se c'è (es. <a title="Sky Sport">link</a>).
const GENERIC_TEXT_RE = /^(link|watch|here|play|stream|open|go|visit|click|guarda|apri|hass?|vedi)$/i;

// Trova il primo riferimento AceStream (URI o infohash-in-query) dentro un
// singolo tag <a>, e restituisce il nome dal testo/attributi del link.
function anchorToResult(href, attrs, innerText) {
  let infohash = null;
  let m = ACESTREAM_URI_RE.exec(`${href} ${innerText}`);
  if (m) infohash = m[1];
  if (!infohash) {
    m = HASH_IN_HREF_RE.exec(href);
    if (m) infohash = m[1];
  }
  if (!infohash) return null;

  const titleAttr = (/\btitle\s*=\s*"([^"]*)"/i.exec(attrs) || /\btitle\s*=\s*'([^']*)'/i.exec(attrs) || [])[1];
  const text = stripTags(innerText);
  const title = stripTags(titleAttr);
  const name = (text && !GENERIC_TEXT_RE.test(text) ? text : title) || text || fallbackName(infohash);
  return { name: name.slice(0, 200), infohash: infohash.toLowerCase() };
}

// Riferimenti AceStream fuori dai tag <a> (testo piano, <li>, <td>, script
// con liste...): il nome viene dalla riga di testo che contiene l'URI —
// nelle pagine di listing è lì che sta (es. "<li>acestream://… Dazn 1</li>").
// Se la riga somiglia a codice (frammenti JS/HTML) si usa il nome di ripiego.
function bareUriToResult(rawHtml, match) {
  const infohash = match[1];
  const lineStart = rawHtml.lastIndexOf('\n', match.index);
  const lineEnd = rawHtml.indexOf('\n', match.index);
  const line = stripTags(rawHtml.slice(lineStart < 0 ? 0 : lineStart + 1, lineEnd < 0 ? rawHtml.length : lineEnd))
    .replace(/acestream:\/\/[a-fA-F0-9]{40}/gi, ' ')
    .replace(/^[\s\-–—:|,;.#*·>]+|[\s\-–—:|,;.#*·<]+$/g, '');
  const looksLikeCode = /[{};=<>]/.test(line);
  const name = line.length >= 3 && !looksLikeCode ? line.slice(0, 120) : fallbackName(infohash);
  return { name, infohash: infohash.toLowerCase() };
}

// Estrae tutti gli stream da una pagina HTML: prima dagli <a> (nome affidabile),
// poi dagli URI rimasti nel resto del documento. Dedup per infohash, dando
// precedenza al primo nome "vero" (non il fallback) trovato per ogni hash.
function extractAcestreamLinks(html) {
  if (!html) return [];
  const byHash = new Map(); // infohash -> { name, infohash, hasRealName }

  const merge = (r) => {
    if (!r) return;
    const prev = byHash.get(r.infohash);
    if (!prev) {
      byHash.set(r.infohash, { ...r, hasRealName: !/^Acestream [0-9a-f]{8}$/.test(r.name) });
      return;
    }
    if (!prev.hasRealName && r.name && !/^Acestream [0-9a-f]{8}$/.test(r.name)) {
      prev.name = r.name;
      prev.hasRealName = true;
    }
  };

  // 1) anchor: il replace produce anche il documento senza <a>, così uno
  //    stesso URI dentro un link non viene trovato due volte nella fase 2.
  const withoutAnchors = html.replace(ANCHOR_RE, (whole, attrs, inner) => {
    const href = (/\bhref\s*=\s*"([^"]*)"/i.exec(attrs) || /\bhref\s*=\s*'([^']*)'/i.exec(attrs) || [])[1] || '';
    merge(anchorToResult(decodeEntities(href), attrs, inner));
    return ' ';
  });

  // 2) URI rimasti fuori dai link
  let m;
  ACESTREAM_URI_GLOBAL_RE.lastIndex = 0;
  while ((m = ACESTREAM_URI_GLOBAL_RE.exec(withoutAnchors)) !== null) {
    merge(bareUriToResult(withoutAnchors, m));
    if (byHash.size >= MAX_RESULTS_PER_SITE) break;
  }

  return [...byHash.values()].slice(0, MAX_RESULTS_PER_SITE).map(({ name, infohash }) => ({ name, infohash }));
}

// --- URL e download -----------------------------------------------------------

// Segnaposto supportati nel template:
//   {query}       -> squadre URL-encoded (spazi = %20)
//   {query_plus}  -> squadre con spazi come "+" (stile form GET)
// Template senza segnaposto = pagina fissa (listing statico, zite ZeroNet...).
function buildSiteUrl(template, query) {
  let url = String(template || '').trim();
  if (!url) return null;
  if (url.includes('{query}')) url = url.split('{query}').join(encodeURIComponent(query || ''));
  if (url.includes('{query_plus}')) url = url.split('{query_plus}').join((query || '').trim().replace(/\s+/g, '+'));
  return url;
}

// Scarica e estrae per un sito. Ritorna sempre { results, error, url }:
// l'errore (rete, challenge, timeout) viene mostrato sulla card del sito
// senza bloccare le altre fonti.
async function scrapeSite(site, query, { socksProxy } = {}) {
  const url = buildSiteUrl(site.url_template, query);
  if (!url) return { site, results: [], error: 'empty-url', url: '' };
  try {
    const html = site.use_warp
      ? await fetchHtmlViaSocks(url, socksProxy)
      : await fetchHtml(url);
    return { site, results: extractAcestreamLinks(html), error: null, url };
  } catch (err) {
    return {
      site,
      results: [],
      error: err && err.message ? err.message : 'fetch failed',
      url,
      isChallenge: !!(err && err.isChallenge),
    };
  }
}

module.exports = { extractAcestreamLinks, buildSiteUrl, scrapeSite };
