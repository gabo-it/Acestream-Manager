const { spawn } = require('child_process');
const { getSetting } = require('./db');

// Remux lato server da MPEG-TS a MP4 frammentato: video copiato as-is
// (nessuna transcodifica reale, costo CPU basso — solo il contenitore
// cambia), audio forzato in AAC (fix per tracce non supportate da
// MediaSource Extensions, es. MP3/AC-3, che erano proprio la causa di
// molti fallimenti Chrome/Edge visti in passato). Il tag <video> del
// browser riproduce l'MP4 frammentato in modo nativo, senza passare da
// MediaSource Extensions/mpegts.js — bypassa del tutto la sensibilità di
// Blink a certi flussi.
//
// Usato SOLO come ultimo fallback dal player web (dopo che mpegts.js, coi
// suoi normali retry e il tentativo senza audio, ha comunque fallito) —
// il percorso principale via mpegts.js resta invariato per tutti,
// Firefox compreso.
function remuxToFmp4(acestreamId, res) {
  const httpPlaybackUrl = getSetting('http_playback_url', getSetting('acexy_base_url', 'http://acexy:8080')).replace(/\/$/, '');
  const inputUrl = `${httpPlaybackUrl}/ace/getstream?id=${encodeURIComponent(acestreamId)}`;

  const ffmpeg = spawn('ffmpeg', [
    // Finestra di analisi iniziale più ampia del default ffmpeg (~5s/5MB):
    // dà più margine per individuare i parametri di configurazione video
    // (SPS/PPS) prima di iniziare a produrre output. Tenuta moderata (5s)
    // invece di più alta: oltre un certo punto non aiuta più su stream con
    // problemi strutturali di codifica, e allunga solo l'attesa su tutti
    // gli altri canali che funzionano bene.
    '-analyzeduration', '5000000',
    '-probesize', '5000000',
    // Più tollerante con eventuali frame realmente malformati residui,
    // invece di bloccarsi al primo problema.
    '-err_detect', 'ignore_err',
    '-fflags', '+genpts+discardcorrupt',
    '-i', inputUrl,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ]);

  res.setHeader('Content-Type', 'video/mp4');
  ffmpeg.stdout.pipe(res);

  // ffmpeg scrive il proprio log di progresso su stderr per design — non
  // è un errore. Logghiamo solo se sembra un problema vero, per non
  // intasare i log con l'output di stato normale.
  //
  // Il pattern "decode_slice_header error / non-existing PPS referenced"
  // è la firma nota di stream con un'irregolarità H.264 già documentata
  // (vedi README, sezione Troubleshooting) — Firefox la tollera,
  // Chrome/ffmpeg no, e non è risolvibile lato nostro. ffmpeg la ripete
  // per ogni frame che non riesce a decodificare, quindi senza questo
  // filtro un singolo stream problematico produce decine di righe quasi
  // identiche nel widget "Recent issues" — segnaliamo il pattern noto
  // una sola volta per sessione, non una volta per riga.
  let knownIssueLogged = false;
  ffmpeg.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (/decode_slice_header error|non-existing PPS/i.test(text)) {
      if (!knownIssueLogged) {
        knownIssueLogged = true;
        console.log('[remux] known H.264 stream irregularity detected (see README troubleshooting) — Chrome/ffmpeg may fail, Firefox/VLC typically still work');
      }
      return;
    }
    if (/error|failed|invalid|No such file/i.test(text)) {
      console.error('[remux]', text.trim());
    }
  });

  ffmpeg.on('error', (err) => {
    console.error('[remux] ffmpeg non avviabile:', err.message);
    if (!res.headersSent) res.status(500).end();
  });

  return ffmpeg;
}

module.exports = { remuxToFmp4 };
