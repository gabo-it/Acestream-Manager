const fs = require('fs');

const ENV_PATH = process.env.ENV_FILE_PATH || '/config/.env';

const DEFAULTS = {
  HTTP_PORT: '6677',
  P2P_PORT: '44556',
  LIVE_CACHE_TYPE: 'memory',
  UPLOAD_LIMIT: '200',
  DOWNLOAD_LIMIT: '',
  ACCESS_TOKEN: '',
  EXTRA_ARGS: '',
  BIND_ALL: '1',
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

// Aggiorna solo le chiavi passate, preservando le altre righe del file
// (incluso GITHUB_OWNER e commenti) il più possibile.
function writeEnvFile(values) {
  if (isMountedAsDirectory()) {
    throw new Error(`${ENV_PATH} è una cartella, non un file. Vedi il messaggio d'errore del tab Motore per la procedura di correzione.`);
  }
  const exists = fs.existsSync(ENV_PATH);
  const lines = exists ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const remaining = { ...values };

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return line;
    const key = trimmed.slice(0, idx).trim();
    if (Object.prototype.hasOwnProperty.call(remaining, key)) {
      const value = remaining[key];
      delete remaining[key];
      return `${key}=${value}`;
    }
    return line;
  });

  const extraLines = Object.entries(remaining).map(([k, v]) => `${k}=${v}`);
  const finalContent = [...updated, ...extraLines].join('\n').replace(/\n+$/, '') + '\n';
  fs.writeFileSync(ENV_PATH, finalContent, 'utf8');
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
    liveCacheType: env.LIVE_CACHE_TYPE || DEFAULTS.LIVE_CACHE_TYPE,
    uploadLimit: env.UPLOAD_LIMIT || '',
    downloadLimit: env.DOWNLOAD_LIMIT || '',
    accessToken: env.ACCESS_TOKEN || '',
    extraArgs: env.EXTRA_ARGS || '',
    bindAll: (env.BIND_ALL ?? DEFAULTS.BIND_ALL) === '1',
  };
}

function saveEngineParams(params) {
  writeEnvFile({
    HTTP_PORT: params.httpPort || DEFAULTS.HTTP_PORT,
    P2P_PORT: params.p2pPort || DEFAULTS.P2P_PORT,
    LIVE_CACHE_TYPE: params.liveCacheType || DEFAULTS.LIVE_CACHE_TYPE,
    UPLOAD_LIMIT: params.uploadLimit || '',
    DOWNLOAD_LIMIT: params.downloadLimit || '',
    ACCESS_TOKEN: params.accessToken || '',
    EXTRA_ARGS: params.extraArgs || '',
    BIND_ALL: params.bindAll ? '1' : '0',
  });
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
  saveEngineParams,
  getEngineBaseUrl,
  isEnvFileWritable,
  isMountedAsDirectory,
  ENV_PATH,
};
