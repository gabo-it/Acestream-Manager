const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS translation_cache (
  original TEXT NOT NULL,
  langpair TEXT NOT NULL,
  translated TEXT NOT NULL,
  PRIMARY KEY (original, langpair)
);
`);

// MyMemory (https://mymemory.translated.net) non supporta il rilevamento
// automatico della lingua sorgente ("autodetect" viene esplicitamente
// rifiutato dall'API) — serve dichiarare una lingua sorgente esplicita.
// Usiamo un'euristica basata sull'alfabeto: copre bene i casi più comuni di
// nomi canale/programma in alfabeti non latini (es. cirillico). Il testo
// già in alfabeto latino non viene toccato: indovinare la lingua sorgente
// tra le tante possibili varianti europee sarebbe troppo inaffidabile e
// rischierebbe di storpiare testo già corretto.
function guessSourceLang(text) {
  if (/[\u0400-\u04FF]/.test(text)) return 'ru'; // Cirillico (russo/ucraino/bulgaro/serbo...)
  if (/[\u0370-\u03FF]/.test(text)) return 'el'; // Greco
  if (/[\u0600-\u06FF]/.test(text)) return 'ar'; // Arabo
  if (/[\u0590-\u05FF]/.test(text)) return 'he'; // Ebraico
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh'; // Cinese
  if (/[\u3040-\u30FF]/.test(text)) return 'ja'; // Giapponese
  if (/[\uAC00-\uD7AF]/.test(text)) return 'ko'; // Coreano
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th'; // Thai
  return null;
}

async function translateText(text, targetLang) {
  if (!text || !targetLang) return text;
  const sourceLang = guessSourceLang(text);
  if (!sourceLang || sourceLang === targetLang) return text;

  const langpair = `${sourceLang}|${targetLang}`;
  const cached = db.prepare('SELECT translated FROM translation_cache WHERE original = ? AND langpair = ?').get(text, langpair);
  if (cached) return cached.translated;

  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${langpair}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (data?.responseStatus === 200 && translated) {
      db.prepare(
        'INSERT OR REPLACE INTO translation_cache (original, langpair, translated) VALUES (?, ?, ?)'
      ).run(text, langpair, translated);
      return translated;
    }
  } catch (err) {
    console.error('[translator] errore:', err.message);
  }
  return text; // fallback: testo originale se la traduzione fallisce
}

// Traduce più stringhe in parallelo (più veloce di farlo in sequenza, utile
// per una lista di programmi o candidati).
async function translateBatch(texts, targetLang) {
  return Promise.all(texts.map((t) => translateText(t, targetLang)));
}

module.exports = { guessSourceLang, translateText, translateBatch };
