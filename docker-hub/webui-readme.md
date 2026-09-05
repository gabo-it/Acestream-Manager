# AceStream Manager — Web UI

The web interface of [AceStream Manager](https://github.com/gabo-it/Acestream-Manager): a self-hosted, self-maintained Docker stack for AceStream — channel management, EPG, playlists, search, and more, all from your browser.

This image is not meant to be run standalone — it's one of three services (`acestream`, `acexy`, `webui`) that make up the full stack, orchestrated via Docker Compose.

## 🚀 Quick start

Create a `docker-compose.yml` with the content below, adjust any values directly in it (ports, engine limits, acexy tuning), then run `docker compose up -d`. Works whether you clone the GitHub repo or just paste this into a Portainer stack — no separate `.env` file needed.

```yaml
services:
  acestream:
    image: ghcr.io/gabo-it/acestream-engine:latest
    container_name: acestream-engine
    restart: unless-stopped
    environment:
      HTTP_PORT: "6677"
      PORT: "44556"
      ACCESS_TOKEN: ""          # set this if this port is reachable beyond your LAN
      # Everything else the engine supports goes in this one line — add,
      # remove, or change any official flag directly here. Reference:
      # https://docs.acestream.net/developers/engine-command-line-options/
      ENGINE_FLAGS: "--client-console --bind-all --live-cache-type memory"
    expose:
      - "6677"
    ports:
      - "6677:6677"
      - "44556:44556/tcp"
      - "44556:44556/udp"
    networks:
      - acestream-net
    healthcheck:
      test: ["CMD-SHELL", "wget -q -t1 -O- http://127.0.0.1:6677/webui/api/service?method=get_version | grep -q '\"error\": null'"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 25s
    tmpfs:
      - /srv/ace/.ACEStream:size=512m,mode=1777   # keeps all engine caching in RAM

  acexy:
    image: ghcr.io/javinator9889/acexy:0.2.2
    container_name: acexy
    restart: unless-stopped
    depends_on:
      acestream:
        condition: service_healthy
    environment:
      ACEXY_HOST: acestream
      ACEXY_PORT: "6677"
      ACEXY_LISTEN_ADDR: ":8080"
      ACEXY_NO_RESPONSE_TIMEOUT: 30s   # raise if streams fail with "timeout awaiting response headers"
      ACEXY_BUFFER_SIZE: 4.2MiB        # raise if playback is choppy
      ACEXY_CLIENT_EVICTION_TIMEOUT: 10s
    ports:
      - "8080:8080"
    networks:
      - acestream-net

  webui:
    image: ghcr.io/gabo-it/acestream-webui:latest
    container_name: acestream-webui
    restart: unless-stopped
    depends_on:
      - acexy
    environment:
      PORT: "4000"
      DB_PATH: /data/acestream.db
      ACESTREAM_HTTP_PORT: "6677"
    volumes:
      - webui-data:/data
      # Lets the Engine tab read current parameters straight from the
      # engine container's own logs — no .env file needed. Grants read
      # access to the Docker socket (real power over the host); remove
      # this line if you'd rather not, the tab just falls back to showing
      # built-in defaults.
      - /var/run/docker.sock:/var/run/docker.sock:ro
    ports:
      - "4000:4000"
    networks:
      - acestream-net

  # Optional: self-hosted translation engine for EPG program-title
  # translation and cross-alphabet tvg-id/logo matching — no third-party
  # service, everything stays on your own hardware. Disabled by default;
  # start it alongside the rest with: docker compose --profile translate up -d
  # Once running, set Sources → "LibreTranslate URL" to http://libretranslate:5000
  libretranslate:
    image: libretranslate/libretranslate:latest
    container_name: libretranslate
    restart: unless-stopped
    profiles: ["translate"]
    environment:
      # Loads only these languages (~200MB RAM each) instead of all 30+
      # (several GB) — adjust to your EPG sources' actual languages.
      LT_LOAD_ONLY: en,it,ru
    volumes:
      - libretranslate-models:/home/libretranslate/.local
    networks:
      - acestream-net
    # Prevents this from pegging every CPU core / eating all RAM on a
    # shared host (translation is real neural inference) — edit these two
    # values directly to match your hardware, no .env needed.
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G

networks:
  acestream-net:
    driver: bridge

volumes:
  webui-data:
  libretranslate-models:

```

- Web UI: http://localhost:4000
- Playlist (TS, recommended): http://localhost:4000/playlist.m3u8
- EPG XMLTV: http://localhost:4000/epg.xml

`docker compose up -d` alone starts the three core services — `libretranslate` is a separate [profile](https://docs.docker.com/compose/how-tos/profiles/) and stays off unless requested: `docker compose --profile translate up -d`. Only needed for optional EPG translation / cross-alphabet channel matching; self-hosted, no third-party service involved. Its CPU/RAM limits above are deliberate — translation is real neural inference and, uncapped, can peg every core on a shared host.

## 🔗 Full project & setup instructions

**GitHub:** [gabo-it/Acestream-Manager](https://github.com/gabo-it/Acestream-Manager)

The main repository has the full README covering configuration, troubleshooting, building from source, and more advanced deployment options.

## ✨ What it does

- Channel CRUD, bulk import, per-source auto-refresh scheduling
- EPG import with cross-alphabet tvg-id/logo matching and optional program-title translation (via self-hosted LibreTranslate)
- AceStream search with bulk import
- Dual playlists (MPEG-TS + HLS), built-in web player, VLC/AcePlayer options
- Read-only Engine dashboard (reads live parameters straight from the engine's own logs), config export/import, Italian/English interface

## 🏷️ Tags

- `latest` — always the most recent build
- `v1.0`, `v1.1`, ... — pinned to a specific stable release

## 🔄 Auto-rebuilt

Published automatically via GitHub Actions on every push to `main` — see [`.github/workflows/docker-build.yml`](https://github.com/gabo-it/Acestream-Manager/blob/main/.github/workflows/docker-build.yml).
