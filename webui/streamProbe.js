const { spawn } = require('child_process');
const { getSetting } = require('./db');

// Ispeziona un flusso AceStream con ffprobe per elencare le tracce
// video/audio/sottotitoli che contiene (codec, lingua, canali, bitrate...).
// L'ispezione apre una connessione in più verso acexy, quindi viene
// lanciata solo su richiesta esplicita dell'utente (mai in automatico a
// ogni riproduzione). Il risultato è tenuto in cache per poco tempo e le
// richieste concorrenti per lo stesso canale condividono un unico ffprobe.
const CACHE_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 25 * 1000;
const cache = new Map();
const inflight = new Map();

function parseFps(raw) {
  if (!raw || raw === '0/0') return null;
  const [n, d] = String(raw).split('/').map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 10) / 10;
}

function kbps(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : null;
}

// L'ordine negli array coincide con gli indici "per tipo" di ffmpeg
// (-map 0:v:N / 0:a:N), che è ciò che serve per scegliere la traccia.
function normalize(json) {
  const out = { video: [], audio: [], subtitle: [] };
  for (const s of json.streams || []) {
    const tags = s.tags || {};
    const common = {
      codec: s.codec_name || '',
      profile: s.profile || '',
      language: tags.language && tags.language !== 'und' ? tags.language : '',
      title: tags.title || '',
      bitrate: kbps(s.bit_rate),
    };
    if (s.codec_type === 'video') {
      out.video.push({ ...common, width: s.width || null, height: s.height || null, fps: parseFps(s.avg_frame_rate || s.r_frame_rate) });
    } else if (s.codec_type === 'audio') {
      out.audio.push({
        ...common,
        channels: s.channels || null,
        channelLayout: s.channel_layout || '',
        sampleRate: parseInt(s.sample_rate, 10) || null,
      });
    } else if (s.codec_type === 'subtitle') {
      out.subtitle.push(common);
    }
  }
  return out;
}

function runFfprobe(url) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-analyzeduration', '8000000',
      '-probesize', '8000000',
      '-print_format', 'json',
      '-show_streams',
      '-i', url,
    ]);
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      p.kill('SIGKILL');
      reject(new Error('timeout: the stream did not deliver data in time'));
    }, TIMEOUT_MS);
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const lines = err.trim().split('\n').filter(Boolean);
        return reject(new Error(lines[lines.length - 1] || `ffprobe exited with code ${code}`));
      }
      try {
        resolve(normalize(JSON.parse(out)));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function probeStreams(acestreamId) {
  const hit = cache.get(acestreamId);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
  if (inflight.has(acestreamId)) return inflight.get(acestreamId);

  const base = getSetting('http_playback_url', getSetting('acexy_base_url', 'http://acexy:8080')).replace(/\/$/, '');
  const url = `${base}/ace/getstream?id=${encodeURIComponent(acestreamId)}`;
  const promise = runFfprobe(url)
    .then((data) => {
      cache.set(acestreamId, { at: Date.now(), data });
      return data;
    })
    .finally(() => inflight.delete(acestreamId));
  inflight.set(acestreamId, promise);
  return promise;
}

module.exports = { probeStreams, normalize };
