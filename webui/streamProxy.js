const { Readable } = require('stream');
const { getSetting } = require('./db');
const { getEngineParams } = require('./engineConfig');

// mpegts.js/hls.js girano nel browser e usano fetch() per leggere lo
// stream: sono soggetti a CORS. acexy e l'engine non mandano header
// Access-Control-Allow-Origin, quindi il browser blocca queste richieste
// anche quando l'URL diretto funziona benissimo se navigato direttamente
// (la navigazione del browser non passa da CORS, fetch() sì). Questo
// modulo fa da proxy same-origin: il browser parla solo con la webui,
// che a sua volta inoltra la richiesta ad acexy/engine lato server
// (le richieste server-to-server non sono soggette a CORS).

function pipeUpstream(upstream, res) {
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  if (!upstream.body) return res.end();

  const nodeStream = Readable.fromWeb(upstream.body);
  // Senza questo handler, un errore sullo stream in pipe (es. connessione
  // interrotta a metà) può propagarsi come eccezione non gestita e mandare
  // in crash l'intero processo Node — non solo questa richiesta. Con retry
  // ravvicinati lato client (player web), più richieste sovrapposte
  // aumentano la probabilità che questo capiti.
  nodeStream.on('error', (err) => {
    console.error('[stream-proxy] errore nello stream in pipe:', err.message);
    if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => {
    console.error('[stream-proxy] errore sulla risposta:', err.message);
    nodeStream.destroy();
  });
  nodeStream.pipe(res);
}

// Proxy per lo stream MPEG-TS (via acexy) — usato dal player web come
// sorgente per mpegts.js al posto dell'URL diretto di acexy.
async function proxyTs(req, res) {
  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  const upstreamUrl = `${acexyBaseUrl}/ace/getstream?id=${encodeURIComponent(req.params.id)}`;

  const controller = new AbortController();
  req.on('close', () => {
    controller.abort();
  });

  try {
    const upstream = await fetch(upstreamUrl, { signal: controller.signal });
    pipeUpstream(upstream, res);
  } catch (err) {
    if (!res.headersSent) res.status(502).send('Errore proxy TS: ' + err.message);
  }
}

// Proxy per il manifest HLS nativo dell'engine: riscrive eventuali URL
// assoluti dei segmenti (che puntano all'engine) perché passino anch'essi
// dal nostro proxy, altrimenti il fetch dei segmenti fallirebbe per lo
// stesso motivo di CORS.
async function proxyHlsManifest(req, res) {
  const enginePublicUrl = getSetting('engine_public_url', '').replace(/\/$/, '');
  if (!enginePublicUrl) return res.status(400).send('engine_public_url non configurato');

  const { accessToken } = getEngineParams();
  const upstreamUrl = `${enginePublicUrl}/ace/manifest.m3u8?id=${encodeURIComponent(req.params.id)}${
    accessToken ? `&token=${encodeURIComponent(accessToken)}` : ''
  }`;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const upstream = await fetch(upstreamUrl, { signal: controller.signal });
    if (!upstream.ok) {
      console.error(`[stream-proxy] manifest HLS ${upstream.status} per ${upstreamUrl}`);
      return res.status(upstream.status).send(`Errore engine (${upstream.status}) su: ${upstreamUrl}`);
    }

    const text = await upstream.text();
    const proxyBase = `${req.protocol}://${req.get('host')}/stream-proxy/hls/${req.params.id}`;
    // Riscrive gli URL assoluti verso l'engine perché passino dal proxy.
    const rewritten = text.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      if (trimmed.startsWith(enginePublicUrl)) {
        return trimmed.replace(enginePublicUrl, proxyBase);
      }
      if (/^https?:\/\//i.test(trimmed)) {
        // URL assoluto verso un altro host: non dovrebbe capitare con
        // l'engine nativo, ma lo lasciamo passare così com'è.
        return line;
      }
      // URL relativo: il browser lo risolverà rispetto a QUESTA pagina
      // (il nostro proxy), quindi arriverà alla rotta catch-all sotto,
      // che lo inoltra all'engine con lo stesso path relativo.
      return line;
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten.join('\n'));
  } catch (err) {
    if (!res.headersSent) res.status(502).send('Errore proxy HLS: ' + err.message);
  }
}

// Catch-all per segmenti/sotto-risorse HLS con path relativo: inoltra
// tutto ciò che arriva dopo /stream-proxy/hls/:id/ allo stesso path
// relativo sull'engine, preservando la query string originale.
async function proxyHlsPassthrough(req, res) {
  const enginePublicUrl = getSetting('engine_public_url', '').replace(/\/$/, '');
  if (!enginePublicUrl) return res.status(400).send('engine_public_url non configurato');

  const relativePath = req.params[0] || '';
  const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstreamUrl = `${enginePublicUrl}/${relativePath}${queryString}`;

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const upstream = await fetch(upstreamUrl, { signal: controller.signal });
    if (!upstream.ok) {
      console.error(`[stream-proxy] passthrough HLS ${upstream.status} per ${upstreamUrl}`);
    }
    pipeUpstream(upstream, res);
  } catch (err) {
    if (!res.headersSent) res.status(502).send('Errore proxy HLS (' + upstreamUrl + '): ' + err.message);
  }
}

module.exports = { proxyTs, proxyHlsManifest, proxyHlsPassthrough };
