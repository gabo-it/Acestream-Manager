const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');

// Verifica lo stato del client WARP interrogando l'endpoint diagnostico
// ufficiale di Cloudflare (https://www.cloudflare.com/cdn-cgi/trace)
// attraverso il proxy SOCKS5 che il client espone sulla porta 1080
// (comportamento documentato dell'immagine caomingjun/warp) — se la
// risposta contiene "warp=on" o "warp=plus", la connessione è davvero
// attiva, non solo il container acceso.
//
// Nessun traffico della webui passa da qui — questo è solo un controllo
// di stato, la richiesta diagnostica stessa è l'unica cosa che
// attraversa il proxy.
function checkWarpStatus(host = 'warp', port = 1080) {
  return new Promise((resolve) => {
    let agent;
    try {
      agent = new SocksProxyAgent(`socks://${host}:${port}`);
    } catch (err) {
      resolve({ reachable: false, connected: false, error: err.message });
      return;
    }

    const req = https.get(
      'https://www.cloudflare.com/cdn-cgi/trace',
      { agent, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          const match = body.match(/warp=(\w+)/);
          const warpState = match ? match[1] : null;
          resolve({
            reachable: true,
            connected: warpState === 'on' || warpState === 'plus',
            warpState,
          });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, connected: false, error: 'timeout' });
    });
    req.on('error', (err) => {
      resolve({ reachable: false, connected: false, error: err.message });
    });
  });
}

module.exports = { checkWarpStatus };
