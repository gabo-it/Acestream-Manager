const { getSetting, db } = require('./db');

// Verifica se un canale è raggiungibile chiedendo i primi byte dello stream
// ad acexy con un timeout breve. Euristico: se risponde entro il timeout
// il canale ha peers disponibili, altrimenti lo consideriamo offline.
async function checkChannelStatus(acestreamId) {
  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`${acexyBaseUrl}/ace/getstream?id=${encodeURIComponent(acestreamId)}`, {
      method: 'GET',
      headers: { Range: 'bytes=0-2048' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.body && typeof res.body.cancel === 'function') {
      try {
        await res.body.cancel();
      } catch {
        /* ignora */
      }
    }
    return res.ok || res.status === 206 ? 'online' : 'offline';
  } catch {
    clearTimeout(timeout);
    return 'offline';
  }
}

async function checkAndStore(channel) {
  const status = await checkChannelStatus(channel.acestream_id);
  db.prepare("UPDATE channels SET status = ?, last_checked_at = datetime('now') WHERE id = ?").run(
    status,
    channel.id
  );
  return status;
}

async function checkAllChannels() {
  const channels = db.prepare('SELECT * FROM channels').all();
  let online = 0;
  for (const ch of channels) {
    const status = await checkAndStore(ch);
    if (status === 'online') online += 1;
  }
  return { total: channels.length, online };
}

module.exports = { checkChannelStatus, checkAndStore, checkAllChannels };
