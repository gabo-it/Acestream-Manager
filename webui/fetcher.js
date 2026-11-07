// ---------------------------------------------------------------------------
// Smart HTML fetcher for livesoccertv.com (Cloudflare-protected).
//
// Problem: since 2026 the site sits behind a Cloudflare managed challenge
// ("Just a moment..."). Node's global fetch (undici) is fingerprinted by its
// TLS handshake and gets a 403 challenge on every request, no matter which
// headers are sent, so every football feature died with "HTTP 403".
//
// Strategy (tiered):
//   1. Plain fetch with a full browser-like header set — cheap path, works
//      when the challenge is not enforced (warm IP reputation, relaxed rules).
//   2. Headless Chromium via Playwright — launched lazily only when the plain
//      path hits a challenge. The real browser passes the JS challenge, then
//      we read the rendered HTML. One shared browser instance is kept warm for
//      a few minutes and reused (the challenge cookie lives inside it), then
//      closed automatically to free RAM.
//
// Successful HTML is cached in memory for a few minutes so that browsing the
// football pages doesn't hammer livesoccertv (which would raise the
// challenge level for everyone).
//
// Everything degrades gracefully: if Playwright/Chromium is not installed the
// module still works against non-protected pages and surfaces a clear,
// actionable error when a challenge blocks the plain path.
// ---------------------------------------------------------------------------

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Google Chrome";v="143", "Chromium";v="143", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

// Cloudflare interstitial markers. NOTE: only the interstitial TITLE is
// reliable — Cloudflare injects a /cdn-cgi/challenge-platform/ script into
// EVERY proxied page (including the site's own 404), so script markers
// cannot be used to classify a page as a challenge.
const CHALLENGE_TITLE_RE = /just a moment|attention required|access denied/i;

function titleLooksLikeChallenge(html) {
  const m = html && html.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i);
  return !!(m && CHALLENGE_TITLE_RE.test(m[1]));
}

class ChallengeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChallengeError';
    this.isChallenge = true;
  }
}

// --- optional Playwright layer --------------------------------------------
let chromium = null;
try {
  ({ chromium } = require('playwright'));
} catch {
  // playwright not installed: browser fallback stays disabled
}

const browserEnabledEnv = process.env.FOOTBALL_BROWSER !== '0';
const browserAvailable = !!(chromium && browserEnabledEnv);

let browser = null;          // shared playwright browser instance
let browserBroken = false;   // launch failed (missing system deps?) — stop retrying
let browserBrokenReason = '';
let browserLastUsedAt = 0;
let browserClosingTimer = null;
let navigationQueue = Promise.resolve(); // serialize navigations on the shared instance
let executablePath = process.env.FOOTBALL_CHROMIUM_PATH || undefined;

const BROWSER_IDLE_CLOSE_MS = 3 * 60 * 1000;
const CF_SOLVE_WAIT_MS = Number(process.env.FOOTBALL_CF_WAIT_MS || 90000);

// --- in-memory HTML cache ---------------------------------------------------
const cache = new Map(); // url -> { html, at }
const DEFAULT_TTL_MS = Number(process.env.FOOTBALL_CACHE_TTL_MS || 10 * 60 * 1000);

// --- diagnostics (surfaced on the football page) -----------------------------
const diagnostics = {
  browserAvailable,
  plainOk: 0,
  browserOk: 0,
  challengesDetected: 0,
  lastSource: null,        // 'http' | 'browser'
  lastChallengeAt: null,
  lastError: null,
};

function looksLikeChallenge(html) {
  if (!html) return true;
  // the interstitial is a small standalone document titled "Just a moment..."
  return titleLooksLikeChallenge(html);
}

// --- tier 1: plain fetch -----------------------------------------------------
async function fetchPlain(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 403 || res.status === 503 || res.status === 429) {
    throw new ChallengeError(`Cloudflare challenge (HTTP ${res.status})`);
  }
  if (!res.ok) {
    if (res.status === 404) throw new Error(`HTTP 404 (page not found — wrong slug?)`);
    throw new Error(`HTTP ${res.status}`);
  }
  const html = await res.text();
  if (looksLikeChallenge(html)) {
    throw new ChallengeError('Cloudflare challenge (HTTP 200 interstitial)');
  }
  return html;
}

// --- tier 2: headless Chromium ----------------------------------------------
function scheduleBrowserClose() {
  if (browserClosingTimer) clearTimeout(browserClosingTimer);
  browserClosingTimer = setTimeout(async () => {
    if (Date.now() - browserLastUsedAt < BROWSER_IDLE_CLOSE_MS) return scheduleBrowserClose();
    try { if (browser) await browser.close(); } catch { /* already gone */ }
    browser = null;
  }, BROWSER_IDLE_CLOSE_MS + 1000);
  browserClosingTimer.unref?.();
}

async function getBrowser() {
  if (browserBroken) throw new Error(`headless browser unavailable: ${browserBrokenReason}`);
  if (browser) return browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
  } catch (err) {
    browserBroken = true;
    browserBrokenReason = err.message;
    browser = null;
    throw new Error(`headless browser launch failed: ${err.message}`);
  }
  return browser;
}

// Loads `url` in the shared browser, waits out the challenge if needed,
// returns the rendered HTML. Navigations are serialized and paced —
// hammering the site with rapid consecutive loads raises the challenge
// level (observed live: a 12-page index build started failing on the
// last pages without pacing).
async function fetchViaBrowser(url) {
  const run = navigationQueue.then(async () => {
    await new Promise((r) => setTimeout(r, 700)); // pacing between navigations
    browserLastUsedAt = Date.now();
    const b = await getBrowser();
    const context = await b.newContext({
      userAgent: BROWSER_HEADERS['User-Agent'],
      locale: 'en-US',
      viewport: { width: 1366, height: 900 },
    });
    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});");
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

      // wait for the challenge to auto-solve (poll the tab title)
      const t0 = Date.now();
      let reloaded = false;
      while (Date.now() - t0 < CF_SOLVE_WAIT_MS) {
        const title = (await page.title().catch(() => '')) || '';
        if (!CHALLENGE_TITLE_RE.test(title)) break;
        await page.waitForTimeout(2500);
        // a reload sometimes helps if the challenge looped
        if (!reloaded && Date.now() - t0 > 40000) {
          reloaded = true;
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
      }

      const title = (await page.title().catch(() => '')) || '';
      const html = await page.content();
      if (CHALLENGE_TITLE_RE.test(title)) {
        throw new ChallengeError('Cloudflare challenge not solved by headless browser');
      }
      // carry cookies back into the module-level plain fetch? Not needed:
      // cf_clearance is bound to the browser TLS fingerprint. The rendered
      // HTML itself is what we came for.
      return html;
    } finally {
      await context.close().catch(() => {});
      browserLastUsedAt = Date.now();
      scheduleBrowserClose();
    }
  });
  // keep the queue alive even if this navigation fails
  navigationQueue = run.catch(() => {});
  return run;
}

// --- public API ---------------------------------------------------------------
async function fetchHtml(url, { ttlMs = DEFAULT_TTL_MS, force = false } = {}) {
  if (!force) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.html;
  }

  let lastError = null;

  // tier 1 (+ one retry for transient network errors)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fetchPlain(url);
      diagnostics.plainOk++;
      diagnostics.lastSource = 'http';
      cache.set(url, { html, at: Date.now() });
      return html;
    } catch (err) {
      lastError = err;
      if (err instanceof ChallengeError) break; // no point retrying the same fingerprint
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  // tier 2
  if (lastError instanceof ChallengeError) {
    diagnostics.challengesDetected++;
    diagnostics.lastChallengeAt = Date.now();
    if (browserAvailable) {
      // one retry: challenge loops sometimes clear on a fresh attempt
      // (observed live on heavier pages near the end of an index build)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const html = await fetchViaBrowser(url);
          diagnostics.browserOk++;
          diagnostics.lastSource = 'browser';
          cache.set(url, { html, at: Date.now() });
          return html;
        } catch (err) {
          lastError = err;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
    diagnostics.lastError = `Cloudflare challenge: ${lastError ? lastError.message : 'no headless browser available'}`;
    throw new ChallengeError(
      'livesoccertv.com is protecting this page with a Cloudflare challenge' +
      (browserAvailable ? ' and the headless browser could not solve it (retry later or use the Refresh index button)' : ' and the headless-browser fallback is not available. ' +
        'Install Playwright + Chromium in the webui container (see README: "Football schedule") or set FOOTBALL_BROWSER=0 to silence this check.')
    );
  }

  diagnostics.lastError = lastError ? lastError.message : 'unknown error';
  throw lastError || new Error('fetch failed');
}

// --- fetch through SOCKS5 (Cloudflare WARP) ---------------------------------
// Used by the search sites flagged "via WARP": the request goes through the
// SOCKS5 endpoint exposed by the optional warp container (caomingjun/warp,
// port 1080) so the target site sees WARP's IP instead of the server's.
// Node's global fetch can't dial through a SOCKS proxy, so this path uses
// http/https with SocksProxyAgent and follows redirects manually. The
// headless-browser tier does NOT apply here (that shared browser belongs to
// the livesoccertv fetcher); if a WARP-flagged site still challenges, the
// error surfaces on the source card in the UI.
const { SocksProxyAgent } = require('socks-proxy-agent');
const nodeHttp = require('http');
const nodeHttps = require('https');

const socksCache = new Map(); // url -> { html, at }
const SOCKS_TTL_MS = 5 * 60 * 1000;

function socksGet(url, agent, timeoutMs, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? nodeHttps : nodeHttp;
    const req = mod.get(url, { agent, headers: BROWSER_HEADERS, timeout: timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume(); // drain the redirect body
        resolve(socksGet(new URL(res.headers.location, url).toString(), agent, timeoutMs, redirectsLeft - 1));
        return;
      }
      if (res.statusCode === 403 || res.statusCode === 503 || res.statusCode === 429) {
        res.resume();
        reject(new ChallengeError(`Cloudflare challenge (HTTP ${res.statusCode})`));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchHtmlViaSocks(url, socksProxy, { timeoutMs = 20000 } = {}) {
  const hit = socksCache.get(url);
  if (hit && Date.now() - hit.at < SOCKS_TTL_MS) return hit.html;
  const agent = new SocksProxyAgent(socksProxy);
  const html = await socksGet(url, agent, timeoutMs, 4);
  if (looksLikeChallenge(html)) {
    throw new ChallengeError('Cloudflare challenge (HTTP 200 interstitial) — the WARP path has no headless-browser fallback');
  }
  socksCache.set(url, { html, at: Date.now() });
  return html;
}

function getDiagnostics() {
  return {
    ...diagnostics,
    browserAvailable,
    browserEnabledEnv,
    browserBroken,
    browserBrokenReason,
    cacheSize: cache.size,
  };
}

function clearCache() {
  cache.clear();
}

module.exports = { fetchHtml, fetchHtmlViaSocks, getDiagnostics, clearCache, ChallengeError };
