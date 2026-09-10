const net = require('net');

// Analizza una stringa CIDR (es. "192.168.1.0/24") in un elenco di IP host
// da scandire. Limitato a /24-/30 per restare in un numero ragionevole di
// host — un /16 richiederebbe troppo tempo e troppe connessioni.
function parseCidr(cidr) {
  const [base, prefixStr] = (cidr || '').split('/');
  const prefix = parseInt(prefixStr, 10);
  if (!base || Number.isNaN(prefix) || prefix < 24 || prefix > 30) {
    throw new Error('Use a range between /24 and /30 (e.g. 192.168.1.0/24)');
  }
  const parts = base.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error('Invalid IP address');
  }
  const baseInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const hostBits = 32 - prefix;
  const count = 2 ** hostBits;
  const ips = [];
  // Esclude l'indirizzo di rete (i=0) e di broadcast (i=count-1).
  for (let i = 1; i < count - 1; i++) {
    const ipInt = ((baseInt & (~0 << hostBits)) + i) >>> 0;
    ips.push([(ipInt >>> 24) & 255, (ipInt >>> 16) & 255, (ipInt >>> 8) & 255, ipInt & 255].join('.'));
  }
  return ips;
}

// Vero tentativo di connessione TCP, non un ping — è quello che conta
// davvero per sapere se un servizio HTTP è raggiungibile su quella porta.
function checkPort(ip, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip);
  });
}

// Scandisce l'intero intervallo con un tetto di concorrenza (non tutte le
// connessioni in parallelo, per non saturare la rete o il container).
async function scanForPort(cidr, port, concurrency = 40) {
  const ips = parseCidr(cidr);
  const found = [];
  let index = 0;
  async function worker() {
    while (index < ips.length) {
      const ip = ips[index++];
      const open = await checkPort(ip, port);
      if (open) found.push(ip);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, worker));
  return found.sort();
}

// Conferma reale (non solo "qualcosa risponde qui") che un IP:porta è
// davvero un server Jellyfin, tramite il suo endpoint pubblico che non
// richiede autenticazione.
async function verifyJellyfin(ip, port) {
  try {
    const r = await fetch(`http://${ip}:${port}/System/Info/Public`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.ServerName) return null;
    return { ip, port, serverName: data.ServerName, version: data.Version };
  } catch {
    return null;
  }
}

module.exports = { parseCidr, checkPort, scanForPort, verifyJellyfin };
