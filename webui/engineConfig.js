const fs = require('fs');
const { readEngineStartupCommand, isDockerSocketAvailable } = require('./dockerLogs');

const ENV_PATH = process.env.ENV_FILE_PATH || '/config/.env';

const DEFAULTS = {
  HTTP_PORT: '6677',
  P2P_PORT: '44556',
  ACCESS_TOKEN: '',
  ENGINE_FLAGS: '--client-console --bind-all --live-cache-type memory',
};

// True se ENV_PATH esiste ma è una cartella: succede quando Docker monta
// "./.env:/config/.env" e sull'host il file .env non esiste ancora al primo
// avvio — in quel caso Docker crea una cartella al posto del file.
function isMountedAsDirectory() {
  try {
    return fs.statSync(ENV_PATH).isDirectory();
  } catch {
    return false;
  }
}

function readEnvFile() {
  if (isMountedAsDirectory()) {
    throw new Error(
      `${ENV_PATH} è una cartella, non un file (probabilmente .env non esisteva sull'host al primo avvio: ` +
        `Docker ha creato una cartella al suo posto). Sul server esegui: docker compose down, poi rimuovi ` +
        `quella cartella, "cp .env.example .env", infine "docker compose up -d". Vedi il README.`
    );
  }
  if (!fs.existsSync(ENV_PATH)) return {};
  const content = fs.readFileSync(ENV_PATH, 'utf8');
  const result = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    result[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return result;
}

// Estrae httpPort/p2pPort/accessToken/engineFlags da una command line tipo
// "--http-port 6677 --port 44556 --access-token abc --client-console
// --bind-all --live-cache-type memory" (esattamente quello che l'entrypoint
// scrive nei suoi log all'avvio).
function parseStartupCommand(command) {
  const tokens = command.split(/\s+/);
  const params = { httpPort: DEFAULTS.HTTP_PORT, p2pPort: DEFAULTS.P2P_PORT, accessToken: '' };
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '--http-port' && tokens[i + 1]) {
      params.httpPort = tokens[++i];
    } else if (tokens[i] === '--port' && tokens[i + 1]) {
      params.p2pPort = tokens[++i];
    } else if (tokens[i] === '--access-token' && tokens[i + 1]) {
      params.accessToken = tokens[++i];
    } else if (tokens[i]) {
      rest.push(tokens[i]);
    }
  }
  params.engineFlags = rest.join(' ');
  return params;
}

// Versione per il tab Motore (sola visualizzazione): prova prima a leggere
// la command line REALE dai log del container engine via Docker socket —
// la fonte più affidabile, dato che riflette esattamente cosa sta girando
// ora (funziona anche senza nessun file .env montato, es. deploy
// auto-contenuto su Portainer). Se il socket non è disponibile o la lettura
// fallisce, ricade sul file .env montato, poi sui default. Le funzioni
// usate per scopi funzionali reali (playlist.js, streamProxy.js) restano
// sulla lettura sincrona di getEngineParams() sotto, per non aggiungere una
// chiamata al Docker socket ad ogni richiesta.
async function getEngineParamsForDisplay() {
  try {
    const command = await readEngineStartupCommand();
    if (command) return { ...parseStartupCommand(command), source: 'docker-logs' };
  } catch {
    // ricade sul percorso file/default sotto
  }
  return { ...getEngineParams(), source: isMountedAsDirectory() || !fs.existsSync(ENV_PATH) ? 'defaults' : 'env-file' };
}

function getEngineParams() {
  let fileValues = {};
  try {
    fileValues = readEnvFile();
  } catch {
    // Se il file non è leggibile (es. montato come cartella) usiamo i
    // default: l'errore vero viene comunque mostrato nel tab Motore.
  }
  const env = { ...DEFAULTS, ...fileValues };
  return {
    httpPort: env.HTTP_PORT || DEFAULTS.HTTP_PORT,
    p2pPort: env.P2P_PORT || DEFAULTS.P2P_PORT,
    accessToken: env.ACCESS_TOKEN || '',
    engineFlags: env.ENGINE_FLAGS || DEFAULTS.ENGINE_FLAGS,
  };
}

// URL interno (rete Docker) per raggiungere l'engine dalla webui.
function getEngineBaseUrl() {
  const { httpPort } = getEngineParams();
  return `http://acestream:${httpPort}`;
}

function isEnvFileWritable() {
  if (isMountedAsDirectory()) return false;
  try {
    fs.accessSync(ENV_PATH, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getEngineParams,
  getEngineParamsForDisplay,
  getEngineBaseUrl,
  isEnvFileWritable,
  isMountedAsDirectory,
  isDockerSocketAvailable,
  ENV_PATH,
};
