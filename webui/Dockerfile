FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
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
