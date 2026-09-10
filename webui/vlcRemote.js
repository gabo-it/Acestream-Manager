const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS vlc_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 8080,
  password TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Non include mai la password — questa funzione alimenta solo le viste
// (lista dispositivi, menu "invia a"), la password serve solo alle
// chiamate server-side sotto.
function listDevices() {
  return db.prepare('SELECT id, name, host, port, created_at FROM vlc_devices ORDER BY name COLLATE NOCASE').all();
}

function getDevice(id) {
  return db.prepare('SELECT * FROM vlc_devices WHERE id = ?').get(id);
}

function addDevice({ name, host, port, password }) {
  db.prepare('INSERT INTO vlc_devices (name, host, port, password, created_at) VALUES (?, ?, ?, ?, ?)').run(
    name,
    host,
    port || 8080,
    password,
    Date.now()
  );
}

function deleteDevice(id) {
  db.prepare('DELETE FROM vlc_devices WHERE id = ?').run(id);
}

// Invia un comando all'interfaccia HTTP nativa di VLC (documentazione
// ufficiale: https://wiki.videolan.org/VLC_HTTP_requests/). L'autenticazione
// richiede uno username VUOTO e solo la password configurata — è una
// particolarità nota e documentata dell'interfaccia VLC stessa, non una
// scelta nostra.
async function sendVlcCommand(device, command, params = {}) {
  const url = new URL(`http://${device.host}:${device.port}/requests/status.json`);
  if (command) url.searchParams.set('command', command);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const auth = Buffer.from(`:${device.password}`).toString('base64');
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`VLC ha risposto HTTP ${res.status} (host/password corretti?)`);
  return res.json();
}

// "Ping" senza effetti collaterali: legge solo lo stato attuale, non
// controlla nulla — usato dal pulsante "Testa connessione" in Add-Ons,
// apposta per non interferire con un'eventuale riproduzione in corso.
async function getStatus(device) {
  return sendVlcCommand(device, null);
}

async function playOnDevice(deviceId, streamUrl) {
  const device = getDevice(deviceId);
  if (!device) throw new Error('Device not found');
  return sendVlcCommand(device, 'in_play', { input: streamUrl });
}

async function stopOnDevice(deviceId) {
  const device = getDevice(deviceId);
  if (!device) throw new Error('Device not found');
  return sendVlcCommand(device, 'pl_stop');
}

module.exports = { listDevices, getDevice, addDevice, deleteDevice, getStatus, playOnDevice, stopOnDevice };
