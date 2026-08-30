const { db } = require('./db');

// Normalizza un nome canale per il confronto: minuscolo, rimuove parole
// generiche ("hd", "tv", "channel"...) e caratteri non alfanumerici.
// Riconosce anche le varianti di spelling più comuni per "calcio/football"
// nelle diverse lingue/traslitterazioni (es. liste IPTV spesso usano
// "futbol" invece di "football"), unificandole a una forma canonica prima
// del confronto — altrimenti una traduzione corretta ("Football") può
// comunque non far scattare il match contro un nome come "Futbol" per una
// manciata di caratteri di differenza.
function normalize(name) {
  return String(name)
    .toLowerCase()
    .replace(/\b(hd|fhd|sd|uhd|4k|tv|channel|canale|canal)\b/g, ' ')
    .replace(/\b(futbol|futebol|fussball|fudbal|voetbal)\b/g, 'football')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Distanza di Levenshtein semplice (senza dipendenze esterne).
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  // Frammenti troppo corti dopo la normalizzazione non sono un'evidenza
  // affidabile di corrispondenza. Capita soprattutto confrontando alfabeti
  // diversi: normalize() rimuove i caratteri non latini (es. cirillico),
  // lasciando residui tipo "1 ru" che risulterebbero "contenuti" in quasi
  // ogni nome canale che finisce con un numero e ".ru" — un falso
  // positivo, non un match reale.
  const shorter = na.length < nb.length ? na : nb;
  if (shorter.length < 5) {
    const dist = levenshtein(na, nb);
    const maxLen = Math.max(na.length, nb.length);
    return Math.max(0, 1 - dist / maxLen) * 0.5;
  }

  // Bonus se una stringa contiene interamente l'altra (es. "Sky Sport" in "Sky Sport 1 HD").
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

// Restituisce i migliori tvg-id (+ logo, se disponibile) candidati dall'EPG
// importato per un nome canale, utile quando un canale non ha tvg-id/logo,
// o quello impostato non produce programmi.
//
// Gestisce anche il caso di alfabeti diversi (es. canale "Match Football
// 1.ru" nella nostra lista, ma "Футбол 1.ru" nell'EPG importato): il
// confronto diretto carattere-per-carattere non può funzionare tra
// alfabeti diversi, quindi per i candidati EPG in un alfabeto non latino
// con punteggio diretto basso proviamo anche a tradurli in inglese e
// confrontare di nuovo. Il nome del canale nella tua lista NON viene mai
// toccato — resta quello che hai scritto tu.
// Tiene solo URL http(s) assoluti: un logo_url malformato (es. solo il nome
// del canale, capita con alcune sorgenti EPG) verrebbe altrimenti caricato
// dal browser come path relativo alla webui stessa (404 e rumore inutile).
function safeLogoUrl(url) {
  return url && /^https?:\/\//i.test(url) ? url : '';
}

async function suggestTvgIds(channelName, limit = 5) {
  const { isNonLatinScript, translateText } = require('./translator');
  const epgChannels = db.prepare('SELECT tvg_id, display_name, logo_url FROM epg_channels').all();

  console.log(`[suggestions] "${channelName}": ${epgChannels.length} canali EPG disponibili in totale`);

  // Limite di sicurezza sulle chiamate di traduzione per singola ricerca,
  // per non rischiare di esaurire la quota gratuita dell'API in un colpo
  // solo su un EPG con moltissimi canali in alfabeti non latini.
  const MAX_TRANSLATION_ATTEMPTS = 40;
  let translationAttempts = 0;
  let nonLatinCount = 0;

  const scored = await Promise.all(
    epgChannels.map(async (c) => {
      const logoUrl = safeLogoUrl(c.logo_url);
      // isNonLatinScript (non guessSourceLang) apposta: qui serve solo
      // sapere "stesso alfabeto o no" per decidere se il confronto
      // carattere-per-carattere ha senso — guessSourceLang rileverebbe
      // (via franc) una lingua anche per nomi canale già in alfabeto
      // latino (es. "Sky Sport Bundesliga.de" → tedesco), facendoli
      // passare inutilmente dalla traduzione anche quando un confronto
      // diretto sarebbe stato gratuito e altrettanto valido.
      const sourceLang = isNonLatinScript(c.display_name);

      if (!sourceLang) {
        // Stesso alfabeto (latino su entrambi i lati): confronto diretto.
        return { tvgId: c.tvg_id, displayName: c.display_name, logoUrl, score: similarity(channelName, c.display_name) };
      }

      nonLatinCount += 1;

      // Alfabeto diverso da quello latino: il confronto diretto
      // carattere-per-carattere non è affidabile (vedi similarity()), quindi
      // ci affidiamo solo alla traduzione in inglese, se disponibile.
      if (translationAttempts >= MAX_TRANSLATION_ATTEMPTS) {
        console.warn(`[suggestions] limite traduzioni raggiunto, salto "${c.display_name}"`);
        return { tvgId: c.tvg_id, displayName: c.display_name, logoUrl, score: 0 };
      }
      translationAttempts += 1;
      const translated = await translateText(c.display_name, 'en');
      if (translated === c.display_name) {
        console.warn(`[suggestions] traduzione non riuscita per "${c.display_name}" (lingua rilevata: ${sourceLang}) — nessun punteggio da questa via`);
        return { tvgId: c.tvg_id, displayName: c.display_name, logoUrl, score: 0 };
      }
      const score = similarity(channelName, translated);
      console.log(`[suggestions] "${c.display_name}" -> tradotto "${translated}" | confronto con "${channelName}" -> punteggio ${score.toFixed(2)}`);
      return {
        tvgId: c.tvg_id,
        displayName: `${translated} (${c.display_name})`,
        logoUrl,
        score,
      };
    })
  );

  console.log(`[suggestions] candidati non-latini esaminati: ${nonLatinCount}, traduzioni tentate: ${translationAttempts}`);

  const results = scored
    .filter((c) => c.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  console.log(`[suggestions] risultati finali sopra soglia (>=0.45): ${results.length}`);

  return results;
}

// Restituisce fino a 5 loghi candidati per un nome canale: prima
// dall'indice tv-logo/tv-logos (repository curato apposta per questo, molto
// più ampio e pertinente — vedi tvLogos.js), poi, se non bastano, completa
// con l'API di ricerca AceStream (utile per contenuti che tv-logos non ha,
// es. eventi/stream meno "da broadcaster ufficiale").
async function suggestLogosFromSearch(channelName, limit = 5) {
  const { searchLogos } = require('./tvLogos');

  const seen = new Set();
  const suggestions = [];

  try {
    const tvLogoResults = await searchLogos(channelName, limit);
    for (const r of tvLogoResults) {
      if (seen.has(r.icon)) continue;
      seen.add(r.icon);
      suggestions.push(r);
    }
  } catch (err) {
    console.error('[suggestions] ricerca tv-logos fallita:', err.message);
  }

  if (suggestions.length < limit) {
    try {
      // Richiesto qui invece che in cima al file per evitare una dipendenza
      // circolare (search.js non dipende da suggestions.js, ma tenendo il
      // require locale il grafo dei moduli resta più semplice da seguire).
      const { searchAceStream } = require('./search');
      const { results } = await searchAceStream(channelName, { pageSize: 10 });
      for (const r of results) {
        const icon = safeLogoUrl(r.icon);
        if (!icon || seen.has(icon)) continue;
        seen.add(icon);
        suggestions.push({ name: r.name || '', icon });
        if (suggestions.length >= limit) break;
      }
    } catch (err) {
      console.error('[suggestions] ricerca AceStream fallita:', err.message);
    }
  }

  return suggestions.slice(0, limit);
}

module.exports = { suggestTvgIds, suggestLogosFromSearch };
