FROM node:20-slim

# ffmpeg: usato solo per il fallback finale del player web (remux
# server-side MPEG-TS -> MP4 frammentato, vedi remux.js) quando
# MediaSource Extensions/mpegts.js non funziona su un flusso — non è
# richiesto per nient'altro nello stack.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /data
ENV DB_PATH=/data/acestream.db
ENV PORT=4000
VOLUME ["/data"]

EXPOSE 4000
CMD ["node", "server.js"]
