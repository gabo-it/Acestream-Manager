const fs = require('fs');

const SOCKET_PATH = '/var/run/docker.sock';
const STARTUP_LINE_RE = /\[entrypoint\] Starting AceStream engine with: (.+)/;

function isDockerSocketAvailable() {
  return fs.existsSync(SOCKET_PATH);
}

// Il formato di risposta di /containers/{id}/logs (quando il container non
// ha un TTY allocato, che è il nostro caso) è "multiplexato": ogni frame ha
// un header di 8 byte — [STREAM_TYPE(1)][0,0,0][SIZE come uint32 big-endian]
// — seguito da SIZE byte di payload. Documentato ufficialmente nella
// referenza dell'API Docker Engine. Lo estraiamo a mano invece di tirare in
// ballo un'intera libreria per un solo utilizzo one-shot.
function demuxDockerLogBuffer(buffer) {
  let result = '';
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break; // frame incompleto, ci fermiamo qui
    result += buffer.slice(start, end).toString('utf8');
    offset = end;
  }
  return result;
}

// Interroga direttamente l'API Docker via socket Unix (senza dipendenze
// esterne: usiamo http.request con socketPath, già disponibile in Node).
function dockerApiRequest(path) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: SOCKET_PATH, path, method: 'GET', timeout: 4000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Docker API HTTP ${res.statusCode}`));
          }
          resolve(Buffer.concat(chunks));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Legge le ultime righe di log del container engine e ne estrae la riga di
// avvio scritta dall'entrypoint, che contiene la command line REALE con cui
// l'engine è partito — la fonte più affidabile possibile, dato che riflette
// esattamente cosa sta girando ora, non un file che potrebbe essere
// disallineato. Richiede che /var/run/docker.sock sia montato in questo
// container (opzionale, vedi docker-compose.yml): se non disponibile,
// ritorna null e il chiamante ricade su .env / sui default.
async function readEngineStartupCommand(containerName = 'acestream-engine') {
  if (!isDockerSocketAvailable()) return null;
  try {
    const buffer = await dockerApiRequest(
      `/containers/${encodeURIComponent(containerName)}/logs?stdout=1&stderr=0&tail=200`
    );
    const text = demuxDockerLogBuffer(buffer);
    const match = text.match(STARTUP_LINE_RE);
    return match ? match[1].trim() : null;
  } catch (err) {
    console.error('[dockerLogs] lettura log engine fallita:', err.message);
    return null;
  }
}

module.exports = { readEngineStartupCommand, isDockerSocketAvailable };
