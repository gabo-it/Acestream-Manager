const { getEngineBaseUrl } = require('./engineConfig');
const { getSetting, setSetting } = require('./db');

// Sessioni attive: channelId -> { statUrl, commandUrl }
// L'engine AceStream non ha un modo "leggero" per leggere le statistiche di
// uno stream senza aprirlo: bisogna avviare una vera sessione di playback
// con format=json, che restituisce stat_url/command_url. Vedi:
// https://wiki.acestream.media/Engine_HTTP_API#Getting_some_stats
const sessions = new Map();

// L'engine usato per le statistiche è normalmente quello di questo stack,
// ma può essere puntato a un engine diverso (es. su un altro host) dalla
// pagina Statistiche stessa.
function getStatsEngineUrl() {
  const override = getSetting('stats_engine_url', '').trim();
  return override || getEngineBaseUrl();
}

function setStatsEngineUrl(url) {
  setSetting('stats_engine_url', (url || '').trim().replace(/\/$/, ''));
  // Le sessioni aperte fanno riferimento al motore precedente: le scartiamo
  // così la prossima richiesta ne apre di nuove verso il motore corretto.
  sessions.clear();
}

function isUsingDefaultEngine() {
  return !getSetting('stats_engine_url', '').trim();
}

async function initSession(channel) {
  const base = getStatsEngineUrl();
  const url = `${base}/ace/getstream?id=${encodeURIComponent(channel.acestream_id)}&format=json&pid=webui-stats-${channel.id}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const session = { statUrl: data.response.stat_url, commandUrl: data.response.command_url };
  sessions.set(channel.id, session);
  return session;
}

async function getStats(channel) {
  let session = sessions.get(channel.id);
  if (!session) session = await initSession(channel);

  try {
    const res = await fetch(session.statUrl, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.response;
  } catch (err) {
    // La sessione potrebbe essere scaduta lato engine: alla prossima
    // richiesta ne apriamo una nuova invece di restare bloccati in errore.
    sessions.delete(channel.id);
    throw err;
  }
}

async function stopSession(channel) {
  const session = sessions.get(channel.id);
  sessions.delete(channel.id);
  if (session?.commandUrl) {
    try {
      await fetch(`${session.commandUrl}?method=stop`, { signal: AbortSignal.timeout(5000) });
    } catch {
      // ignora: se l'engine ha già chiuso la sessione da solo va bene comunque
    }
  }
}

module.exports = { getStats, stopSession, getStatsEngineUrl, setStatsEngineUrl, isUsingDefaultEngine };
