const { db, getSetting } = require('./db');
const { getEngineParams } = require('./engineConfig');
const { guessSourceLang, translateText } = require('./translator');

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

    // Traduce i titoli (non le descrizioni, per contenere il volume di
    // chiamate) nella lingua guida scelta in Impostazioni, con un tetto
    // massimo di traduzioni per singola richiesta: un export EPG completo
    // può contenere migliaia di programmi, e tradurli tutti ad ogni
    // richiesta esaurirebbe la quota gratuita dell'API in un colpo solo.
    // Oltre il tetto, i titoli restano nella lingua originale per QUESTA
    // richiesta — la cache (SQLite) fa sì che le richieste successive (i
    // player IPTV ripescano l'EPG spesso) recuperino gradualmente i titoli
    // già tradotti, senza costo aggiuntivo.
    //
    // Se "Lingua sorgente EPG" è impostata esplicitamente, traduce TUTTO
    // (anche testo già in alfabeto latino). Se lasciata su "Auto", resta
    // il comportamento sicuro di sempre: solo alfabeti non latini,
    // rilevati euristicamente — indovinare la lingua sorgente tra le tante
    // varianti europee sarebbe troppo inaffidabile senza una dichiarazione
    // esplicita dell'utente.
    const epgLanguage = getSetting('epg_language', '');
    const epgSourceLanguage = getSetting('epg_source_language', '');
    const MAX_XMLTV_TRANSLATIONS_PER_REQUEST = 150;

    let titles = programs.map((p) => p.title);
    if (epgLanguage) {
      let translationAttempts = 0;
      // Traduzioni in parallelo (Promise.all), non in sequenza: con centinaia
      // di programmi da controllare, farle una alla volta renderebbe questa
      // richiesta troppo lenta per un player IPTV che interroga /epg.xml.
      titles = await Promise.all(
        programs.map(async (p) => {
          const shouldAttempt = epgSourceLanguage || guessSourceLang(p.title);
          if (shouldAttempt && translationAttempts < MAX_XMLTV_TRANSLATIONS_PER_REQUEST) {
            translationAttempts += 1;
            return translateText(p.title, epgLanguage, epgSourceLanguage || undefined);
          }
          return p.title;
        })
      );
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
