/* Service worker minimo per l'installazione PWA.
   Strategia deliberatamente conservatrice: i contenuti dell'app (liste
   canali, EPG, palinsesti) cambiano in continuazione e NON vengono mai
   serviti dalla cache:
   - navigazioni (pagine): network-first, con fallback all'ultima copia
     in cache solo se la rete non risponde (es. telefono in area morta);
   - asset statici e CDN (icons, copy.js, Tailwind CDN, font): stale-
     while-revalidate, risposta immediata dalla cache e aggiornamento
     in background.
   Così "Aggiungi alla schermata Home" funziona e l'app si riapre anche
   offline (eventualmente con dati vecchi), senza mai mostrare dati
   stantii come se fossero attuali quando la rete c'è. */

const CACHE = 'asm-static-v1';
const STATIC_ASSETS = [
  '/',
  '/copy.js',
  '/light.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://cdn.tailwindcss.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(STATIC_ASSETS.map((url) => cache.add(url).catch(() => {})))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigazioni: rete prima, cache come rete di sicurezza.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  // Tutto il resto (stesso host + CDN): stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res && (res.ok || req.url.startsWith('https://cdn.tailwindcss.com'))) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
