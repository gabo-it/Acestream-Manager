const { db, getSetting } = require('./db');
const { getEngineParams } = require('./engineConfig');
const { translateBatch } = require('./translator');
const { getTranslationWindowBounds } = require('./epg');

// format: 'ts' (default, via acexy — multiplexing multi-client, consigliato
// per la maggior parte dei player) oppure 'hls' (via l'endpoint nativo
// dell'engine /ace/manifest.m3u8 — utile per Smart TV/browser che si
// aspettano un vero manifest HLS; un solo client alla volta per canale,
// perché in questo caso non passa da acexy).
function buildM3U(search = '', format = 'ts') {
  const channels = search
    ? db
        .prepare('SELECT * FROM channels WHERE name LIKE ? OR category LIKE ? ORDER BY sort_order, name COLLATE NOCASE')
        .all(`%${search}%`, `%${search}%`)
    : db.prepare('SELECT * FROM channels ORDER BY sort_order, name COLLATE NOCASE').all();

  let baseUrl;
  let buildStreamUrl;

  if (format === 'hls') {
    baseUrl = getSetting('engine_public_url', '').replace(/\/$/, '');
    const { accessToken } = getEngineParams();
    buildStreamUrl = (id) =>
      `${baseUrl}/ace/manifest.m3u8?id=${encodeURIComponent(id)}${accessToken ? `&token=${encodeURIComponent(accessToken)}` : ''}`;
  } else {
    baseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
    buildStreamUrl = (id) => `${baseUrl}/ace/getstream?id=${encodeURIComponent(id)}`;
  }

  let out = '#EXTM3U\n';
  for (const ch of channels) {
    const attrs = [
      ch.tvg_id ? `tvg-id="${ch.tvg_id}"` : '',
      ch.logo_url ? `tvg-logo="${ch.logo_url}"` : '',
      ch.category ? `group-title="${ch.category}"` : '',
    ]
      .filter(Boolean)
      .join(' ');
    out += `#EXTINF:-1 ${attrs},${ch.name}\n`;
    out += `${buildStreamUrl(ch.acestream_id)}\n`;
  }
  return out;
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toXmltvTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes()
  )}${pad(d.getUTCSeconds())} +0000`;
}

async function buildXmltv() {
  const channels = db.prepare("SELECT * FROM channels WHERE tvg_id != ''").all();
  const tvgIds = channels.map((c) => c.tvg_id);

  let out = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
  for (const ch of channels) {
    out += `  <channel id="${xmlEscape(ch.tvg_id)}"><display-name>${xmlEscape(ch.name)}</display-name></channel>\n`;
  }

  if (tvgIds.length > 0) {
    const placeholders = tvgIds.map(() => '?').join(',');
    const programs = db
      .prepare(`SELECT * FROM programs WHERE tvg_id IN (${placeholders}) ORDER BY start_ts`)
      .all(...tvgIds);

    // Traduce i titoli (non le descrizioni, per contenere il volume) nella
    // lingua guida scelta in Impostazioni, se la checkbox "Traduci
    // /epg.xml" è attiva — separata dalla checkbox usata dalla webui,
    // perché questo export può coprire l'intero archivio EPG (a differenza
    // della lista canali o del pannello Programmazione, sempre naturalmente
    // piccoli), quindi molto più pesante lato CPU per LibreTranslate su
    // guide lunghe.
    //
    // Limitata alla finestra di N giorni ("Giorni da tradurre") — i
    // programmi oltre la finestra restano nella lingua originale (ma
    // compaiono comunque nell'export, non vengono esclusi): tradurli
    // sarebbe carico CPU per contenuto che l'utente vedrà solo tra
    // giorni. La finestra si "rinnova" da sola col passare del tempo, ad
    // ogni richiesta.
    //
    // La maggior parte dei titoli nella finestra è comunque già in cache
    // grazie alla traduzione in blocco eseguita in background ad ogni
    // aggiornamento EPG (vedi epg.js) — qui translateBatch chiama
    // LibreTranslate solo per gli eventuali titoli non ancora coperti, in
    // un'unica richiesta HTTP con tutti insieme (supporto nativo agli
    // array, vedi translator.js).
    const epgLanguage = getSetting('epg_language', '');
    const titles = programs.map((p) => p.title);
    if (epgLanguage && getSetting('epg_translate_xml', '1') === '1') {
      const days = Math.max(1, Math.min(14, parseInt(getSetting('epg_translate_days', '2'), 10) || 2));
      const { start, end } = getTranslationWindowBounds(days);

      const inWindowIndices = [];
      const inWindowTitles = [];
      programs.forEach((p, i) => {
        if (p.stop_ts > start && p.start_ts < end) {
          inWindowIndices.push(i);
          inWindowTitles.push(p.title);
        }
      });

      if (inWindowTitles.length > 0) {
        const translated = await translateBatch(inWindowTitles, epgLanguage);
        inWindowIndices.forEach((idx, j) => {
          titles[idx] = translated[j];
        });
      }
    }

    programs.forEach((p, i) => {
      out += `  <programme start="${toXmltvTime(p.start_ts)}" stop="${toXmltvTime(p.stop_ts)}" channel="${xmlEscape(
        p.tvg_id
      )}">\n`;
      out += `    <title>${xmlEscape(titles[i])}</title>\n`;
      if (p.description) out += `    <desc>${xmlEscape(p.description)}</desc>\n`;
      out += '  </programme>\n';
    });
  }

  out += '</tv>\n';
  return out;
}

module.exports = { buildM3U, buildXmltv };
