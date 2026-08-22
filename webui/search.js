const { getEngineBaseUrl } = require('./engineConfig');

// Categorie predefinite dall'API AceStream:
// https://docs.acestream.net/developers/knowledge-base/list-of-categories/
const CATEGORIES = [
  'informational',
  'entertaining',
  'educational',
  'movies',
  'documentaries',
  'sport',
  'fashion',
  'music',
  'regional',
  'ethnic',
  'religion',
  'teleshop',
  'erotic_18_plus',
  'other_18_plus',
  'cyber_games',
  'amateur',
  'webcam',
];

// Interroga il modulo di ricerca integrato nell'engine AceStream
// (https://docs.acestream.net/developers/search/) e appiattisce i risultati:
// ogni "gruppo" può contenere più infohash (item) per lo stesso contenuto,
// li trasformiamo in righe separate così l'utente può scegliere quale importare.
async function searchAceStream(query, { page = 0, pageSize = 30, category = '' } = {}) {
  const base = getEngineBaseUrl();
  const params = new URLSearchParams({
    query,
    page: String(page),
    page_size: String(pageSize),
  });
  if (category) params.set('category', category);

  const res = await fetch(`${base}/search?${params.toString()}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const flat = [];
  for (const group of data.result?.results || []) {
    const icon = group.icons?.[0]?.url || '';
    for (const item of group.items || []) {
      flat.push({
        name: item.name || group.name || 'Senza nome',
        infohash: item.infohash,
        categories: (item.categories || []).join(', '),
        status: item.status, // 2 = disponibile, 1 = incerto
        icon,
      });
    }
  }

  return { total: data.result?.total ?? flat.length, results: flat };
}

module.exports = { searchAceStream, CATEGORIES };
