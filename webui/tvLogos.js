// Indice loghi da tv-logo/tv-logos (https://github.com/tv-logo/tv-logos),
// un repository curato e mantenuto attivamente con loghi canale organizzati
// per paese, link diretti esplicitamente supportati dal mantenitore. Molto
// più ampio e pertinente della sola API di ricerca AceStream, specialmente
// per canali sportivi/regionali (es. "Arena Sport 1").
//
// Nota sulle licenze: i loghi restano di proprietà dei rispettivi
// broadcaster/marchi — questo indice si limita a puntare ai file ospitati
// dal repository originale, non li copia né li ridistribuisce.

const REPO_TREE_URL = 'https://api.github.com/repos/tv-logo/tv-logos/git/trees/main?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/tv-logo/tv-logos/main/';
const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

let index = []; // [{ name, path }]
let indexBuiltAt = 0;
let buildingPromise = null;

function pathToName(path) {
  // countries/united-kingdom/sky-sports-1-uk.png -> "sky sports 1 uk"
  const filename = path.split('/').pop().replace(/\.(png|svg)$/i, '');
  return filename.replace(/-/g, ' ').trim();
}

async function buildIndex() {
  const res = await fetch(REPO_TREE_URL, {
    headers: { 'User-Agent': 'AceStreamManager', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const data = await res.json();
  const entries = Array.isArray(data.tree) ? data.tree : [];

  index = entries
    .filter((e) => e.type === 'blob' && /\.(png|svg)$/i.test(e.path) && e.path.startsWith('countries/'))
    .map((e) => ({ name: pathToName(e.path), path: e.path }));

  indexBuiltAt = Date.now();
  console.log(`[tvlogos] indice costruito: ${index.length} loghi`);
  return index;
}

async function ensureIndex() {
  const isStale = Date.now() - indexBuiltAt > INDEX_TTL_MS;
  if (index.length > 0 && !isStale) return index;
  if (!buildingPromise) {
    buildingPromise = buildIndex().finally(() => {
      buildingPromise = null;
    });
  }
  return buildingPromise;
}

// Ricerca locale per sottostringa — confronta le stringhe "compattate"
// (senza spazi) così "arenasport1" (tutto attaccato, come capita spesso nei
// nomi canale) trova comunque "arena-sport-1-uk.png" (che diventa "arena
// sport 1 uk" con gli spazi, dal repository), e viceversa. Rimuove prima
// suffissi generici (HD, .ru, ecc.) che il nome canale spesso ha ma il file
// del logo no, e prova il confronto in entrambe le direzioni per essere più
// tollerante (es. "arenasport1" contenuto in "arenasport1uk", o viceversa).
function compact(text) {
  return String(text)
    .toLowerCase()
    .replace(/\b(hd|fhd|sd|uhd|4k|tv|channel|canale|canal)\b/g, '')
    .replace(/\.[a-z]{2,3}$/, '') // suffisso tipo ".ru", ".uk" a fine stringa
    .replace(/[^a-z0-9]+/g, '');
}

async function searchLogos(query, limit = 5) {
  const idx = await ensureIndex();
  const needle = compact(query);
  if (!needle) return [];

  return idx
    .filter((entry) => {
      const name = entry.name.replace(/\s+/g, '');
      return name.includes(needle) || needle.includes(name);
    })
    .slice(0, limit)
    .map((entry) => ({ name: entry.name, icon: RAW_BASE + entry.path }));
}

module.exports = { searchLogos };
