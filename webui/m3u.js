// Estrae i canali da un contenuto M3U (testo incollato o file caricato),
// riconoscendo sia link acestream:// sia URL http con ?id=<hash>.
function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const results = [];

  let pendingName = null;
  let pendingLogo = '';
  let pendingGroup = '';
  let pendingTvgId = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const nameMatch = line.match(/,(.*)$/);
      pendingName = nameMatch ? nameMatch[1].trim() : null;

      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      pendingLogo = logoMatch ? logoMatch[1] : '';

      const groupMatch = line.match(/group-title="([^"]*)"/i);
      pendingGroup = groupMatch ? groupMatch[1] : '';

      const tvgMatch = line.match(/tvg-id="([^"]*)"/i);
      pendingTvgId = tvgMatch ? tvgMatch[1] : '';
      continue;
    }

    if (line.startsWith('#')) continue;

    let id = null;
    let m = line.match(/^acestream:\/\/([a-fA-F0-9]{40})/);
    if (m) {
      id = m[1];
    } else {
      m = line.match(/[?&]id=([a-fA-F0-9]{40})/);
      if (m) id = m[1];
    }

    if (id) {
      id = id.toLowerCase();
      results.push({
        acestream_id: id,
        name: pendingName || `Canale ${id.slice(0, 8)}`,
        logo_url: pendingLogo,
        category: pendingGroup,
        tvg_id: pendingTvgId,
      });
    }

    pendingName = null;
    pendingLogo = '';
    pendingGroup = '';
    pendingTvgId = '';
  }

  return results;
}

module.exports = { parseM3U };
