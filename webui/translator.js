const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS translation_cache (
  original TEXT NOT NULL,
  langpair TEXT NOT NULL,
  translated TEXT NOT NULL,
  PRIMARY KEY (original, langpair)
);
`);

// Mappa dai codici ISO 639-3 (3 lettere, usati da franc) ai codici ISO
// 639-1 (2 lettere, quelli che l'API MyMemory si aspetta). Copre le lingue
// europee/globali più comuni nelle guide EPG — non esaustiva, ma un
// riconoscimento mancato si traduce semplicemente in "nessuna traduzione
// per questa stringa", mai in un errore.
const ISO_639_3_TO_1 = {
  ita: 'it',
  eng: 'en',
  fra: 'fr', fre: 'fr',
  spa: 'es',
  deu: 'de', ger: 'de',
  por: 'pt',
  nld: 'nl', dut: 'nl',
  pol: 'pl',
  ron: 'ro', rum: 'ro',
  ces: 'cs', cze: 'cs',
  hun: 'hu',
  swe: 'sv',
  nob: 'no', nno: 'no', nor: 'no',
  dan: 'da',
  fin: 'fi',
  ell: 'el', gre: 'el',
  tur: 'tr',
  bul: 'bg',
  hrv: 'hr',
  srp: 'sr',
  ukr: 'uk',
  rus: 'ru',
  ara: 'ar',
  heb: 'he',
  zho: 'zh', chi: 'zh',
  jpn: 'ja',
  kor: 'ko',
  tha: 'th',
  vie: 'vi',
  ind: 'id',
};

// franc è ESM-only: da un modulo CommonJS come questo va caricato con
// import() dinamico invece del solito require(). Cachiamo la promise per
// non ripetere il caricamento ad ogni chiamata (Node cache comunque i
// moduli ES internamente, ma evitiamo l'overhead della promise ripetuta).
let francPromise = null;
function loadFranc() {
  if (!francPromise) francPromise = import('franc');
  return francPromise;
}

// Rilevamento SOLO dell'alfabeto (range Unicode), sincrono e sempre
// affidabile al 100% quando ritorna una lingua — a differenza di
// guessSourceLang() sotto, non tenta MAI il rilevamento statistico sul
// testo in alfabeto latino, quindi ritorna null anche per lingue latine
// diverse dal target. Usata da chi ha bisogno solo di sapere "stesso
// alfabeto o no" (es. suggestions.js, per decidere se un confronto
// carattere-per-carattere ha senso), non di una lingua specifica per la
// traduzione.
function isNonLatinScript(text) {
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

// MyMemory (https://mymemory.translated.net) non supporta il rilevamento
// automatico della lingua sorgente ("autodetect" viene esplicitamente
// rifiutato dall'API) — serve dichiarare una lingua sorgente esplicita per
// OGNI richiesta di traduzione. Una guida EPG può però contenere fonti in
// lingue diverse mescolate tra loro (es. canali italiani, russi e inglesi
// nello stesso file), quindi non ha senso chiedere "la" lingua sorgente
// come impostazione unica — il rilevamento va fatto per singola stringa:
//
// 1. Alfabeti non latini (cirillico, arabo, ecc.): riconoscimento tramite
//    range Unicode, già affidabile al 100% da solo — se il testo contiene
//    caratteri cirillici è certamente russo/ucraino/ecc., non serve altro.
// 2. Alfabeto latino: i soli caratteri usati non bastano a distinguere le
//    lingue (italiano/inglese/francese/spagnolo usano lo stesso alfabeto),
//    quindi qui usiamo un rilevamento statistico (franc, analisi di
//    n-grammi) pensato apposta per questo.
//
// A differenza di isNonLatinScript() sopra, QUESTA può ritornare una
// lingua anche per testo in alfabeto latino — non va usata per decidere
// "stesso alfabeto o no", solo per la traduzione vera e propria.
async function guessSourceLang(text) {
  const nonLatin = isNonLatinScript(text);
  if (nonLatin) return nonLatin;

  try {
    const { franc } = await loadFranc();
    // minLength basso perché i titoli dei programmi sono spesso brevi —
    // meno affidabile su testo molto corto, ma è un limite intrinseco del
    // rilevamento statistico, non qualcosa che possiamo aggirare: nel
    // dubbio, meglio provare (con cache) che rinunciare del tutto.
    const code3 = franc(text, { minLength: 3 });
    if (code3 === 'und') return null; // franc non è riuscito a determinarla
    return ISO_639_3_TO_1[code3] || null;
  } catch (err) {
    console.error('[translator] rilevamento lingua fallito:', err.message);
    return null;
  }
}

async function translateText(text, targetLang) {
  if (!text || !targetLang) return text;
  const sourceLang = await guessSourceLang(text);
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

module.exports = { guessSourceLang, isNonLatinScript, translateText, translateBatch };
