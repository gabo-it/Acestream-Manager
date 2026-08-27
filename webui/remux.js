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
  const acexyBaseUrl = getSetting('acexy_base_url', 'http://acexy:8080').replace(/\/$/, '');
  const inputUrl = `${acexyBaseUrl}/ace/getstream?id=${encodeURIComponent(acestreamId)}`;

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

  ffmpeg.stderr.on('data', (chunk) => {
    // ffmpeg scrive il proprio log di progresso su stderr per design —
    // non è un errore. Logghiamo solo se sembra un problema vero, per non
    // intasare i log con l'output di stato normale.
    const text = chunk.toString();
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
