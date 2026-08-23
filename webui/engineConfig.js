const fs = require('fs');

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
  getEngineBaseUrl,
  isEnvFileWritable,
  isMountedAsDirectory,
  ENV_PATH,
};
