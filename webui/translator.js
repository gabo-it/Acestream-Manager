const { db, getSetting } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS translation_cache (
  original TEXT NOT NULL,
  langpair TEXT NOT NULL,
  translated TEXT NOT NULL,
  PRIMARY KEY (original, langpair)
);
`);

// Rilevamento SOLO dell'alfabeto (range Unicode) — usato da suggestions.js
// per decidere se un confronto carattere-per-carattere tra nomi canale ha
// senso ("stesso alfabeto sì/no"), non per la traduzione vera e propria
// (quella ora la gestisce LibreTranslate stesso, vedi sotto).
function isNonLatinScript(text) {
  if (/[\u0400-\u04FF]/.test(text)) return 'ru';
  if (/[\u0370-\u03FF]/.test(text)) return 'el';
  if (/[\u0600-\u06FF]/.test(text)) return 'ar';
  if (/[\u0590-\u05FF]/.test(text)) return 'he';
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  if (/[\u3040-\u30FF]/.test(text)) return 'ja';
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko';
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th';
  return null;
}

function getLibreTranslateUrl() {
  return (getSetting('libretranslate_url', '') || '').replace(/\/$/, '');
}

// Traduzione via LibreTranslate (self-hosted, URL impostabile in Sorgenti)
// — nessun servizio di terzi coinvolto, nessuna quota, nessun testo che
// lascia il tuo server. Se il campo è vuoto, la traduzione EPG è
// semplicemente disattivata: nessuna chiamata, nessun costo.
//
// source: "auto" delega il rilevamento della lingua sorgente a
// LibreTranslate stesso — funziona con qualunque lingua abbia caricato la
// tua istanza, senza che dobbiamo indovinare/hardcodare quali lingue
// sorgente aspettarci (il problema che avevamo con la traduzione a
// singola stringa lato nostro).
async function translateText(text, targetLang) {
  const baseUrl = getLibreTranslateUrl();
  if (!text || !targetLang || !baseUrl) return text;

  const cached = db.prepare('SELECT translated FROM translation_cache WHERE original = ? AND langpair = ?').get(text, `auto|${targetLang}`);
  if (cached) return cached.translated;

  try {
    const res = await fetch(`${baseUrl}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: 'auto', target: targetLang, format: 'text' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[translator] LibreTranslate HTTP ${res.status} per "${text.slice(0, 60)}": ${errBody.slice(0, 200)}`);
      return text;
    }
    const data = await res.json();
    const translated = data?.translatedText;
    if (typeof translated === 'string' && translated) {
      db.prepare(
        'INSERT OR REPLACE INTO translation_cache (original, langpair, translated) VALUES (?, ?, ?)'
      ).run(text, `auto|${targetLang}`, translated);
      return translated;
    }
    console.error(`[translator] risposta inattesa da LibreTranslate per "${text.slice(0, 60)}":`, JSON.stringify(data).slice(0, 200));
  } catch (err) {
    console.error(`[translator] errore di rete verso LibreTranslate (${baseUrl}) per "${text.slice(0, 60)}":`, err.message);
  }
  return text; // fallback: testo originale se la traduzione fallisce
}

// Traduzione in blocco: LibreTranslate supporta nativamente un array in
// "q", traducendo tutto in un'unica richiesta HTTP invece di una per
// stringa — molto più efficiente della sequenza di chiamate che
// servivano con l'API precedente. I testi già in cache vengono comunque
// esclusi dalla richiesta, per non ritraddurre inutilmente.
async function translateBatch(texts, targetLang) {
  const baseUrl = getLibreTranslateUrl();
  if (!texts.length || !targetLang || !baseUrl) return texts;

  const langpair = `auto|${targetLang}`;
  const getCached = db.prepare('SELECT translated FROM translation_cache WHERE original = ? AND langpair = ?');
  const results = new Array(texts.length);
  const toTranslate = []; // [{ index, text }]

  texts.forEach((t, i) => {
    if (!t) {
      results[i] = t;
      return;
    }
    const cached = getCached.get(t, langpair);
    if (cached) {
      results[i] = cached.translated;
    } else {
      toTranslate.push({ index: i, text: t });
    }
  });

  if (toTranslate.length === 0) return results;

  try {
    const res = await fetch(`${baseUrl}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: toTranslate.map((t) => t.text), source: 'auto', target: targetLang, format: 'text' }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[translator] LibreTranslate HTTP ${res.status} in batch di ${toTranslate.length} testi: ${errBody.slice(0, 200)}`);
      toTranslate.forEach(({ index, text }) => { results[index] = text; });
      return results;
    }
    const data = await res.json();
    const translatedArr = Array.isArray(data?.translatedText) ? data.translatedText : null;
    if (!translatedArr || translatedArr.length !== toTranslate.length) {
      console.error(`[translator] risposta batch inattesa da LibreTranslate (attesi ${toTranslate.length} risultati):`, JSON.stringify(data).slice(0, 200));
      toTranslate.forEach(({ index, text }) => { results[index] = text; });
      return results;
    }
    const insert = db.prepare(
      'INSERT OR REPLACE INTO translation_cache (original, langpair, translated) VALUES (?, ?, ?)'
    );
    toTranslate.forEach(({ index, text }, i) => {
      const translated = translatedArr[i] || text;
      results[index] = translated;
      if (translated !== text) insert.run(text, langpair, translated);
    });
  } catch (err) {
    console.error(`[translator] errore di rete verso LibreTranslate (${baseUrl}) in batch:`, err.message);
    toTranslate.forEach(({ index, text }) => { results[index] = text; });
  }
  return results;
}

module.exports = { isNonLatinScript, translateText, translateBatch, getLibreTranslateUrl };
