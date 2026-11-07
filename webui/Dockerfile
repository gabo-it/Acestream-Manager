FROM node:20-slim

# ffmpeg: usato solo per il fallback finale del player web (remux
# server-side MPEG-TS -> MP4 frammentato, vedi remux.js) quando
# MediaSource Extensions/mpegts.js non funziona su un flusso — non è
# richiesto per nient'altro nello stack.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ffmpeg tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# playwright: scarichiamo solo il pacchetto npm qui (niente browser
# automatici, sarebbe triple-download); Chromium vero si installa sotto.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
RUN npm install --omit=dev

# Chromium headless per il fallback Cloudflare delle pagine football
# (livesoccertv.com è dietro una challenge che blocca il fetch semplice
# di Node, vedi fetcher.js). Se l'installazione fallisce l'immagine viene
# comunque costruita: il fallback resta disattivato e il resto funziona.
RUN npx playwright install --with-deps chromium \
    || echo "WARNING: headless Chromium not installed — the football Cloudflare fallback will be unavailable"

COPY . .

RUN mkdir -p /data
ENV DB_PATH=/data/acestream.db
ENV PORT=4000
VOLUME ["/data"]

EXPOSE 4000
CMD ["node", "server.js"]
