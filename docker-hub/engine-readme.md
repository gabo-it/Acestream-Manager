# AceStream Manager — Engine

Self-maintained AceStream engine image, part of the [AceStream Manager](https://github.com/gabo-it/Acestream-Manager) stack.

This image is not meant to be run standalone — it's one of three services (`acestream`, `acexy`, `webui`) that make up the full stack, orchestrated via Docker Compose.

## 🚀 Quick start (full stack)

Create a `docker-compose.yml` with the content below, adjust any values directly in it, then run `docker compose up -d`. No separate `.env` file needed.

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

networks:
  acestream-net:
    driver: bridge

volumes:
  webui-data:

```

## 🔗 Full project

**GitHub:** [gabo-it/Acestream-Manager](https://github.com/gabo-it/Acestream-Manager)

See the main repository for:
- Full feature list (channel management, EPG, playlists, search, football schedules, and more)
- Configuration reference and troubleshooting
- Building from source

## 🏷️ Tags

- `latest` — always the most recent build
- `<version>` (e.g. `3.2.11`) — matches the bundled AceStream engine version
- `v1.0`, `v1.1`, ... — pinned to a specific stable release of the whole stack

## 🔄 Auto-rebuilt

This image is automatically rebuilt via GitHub Actions whenever a new AceStream engine version is published upstream — see [`.github/workflows/docker-build.yml`](https://github.com/gabo-it/Acestream-Manager/blob/main/.github/workflows/docker-build.yml).

## 🙏 Credits

Built on top of the official [AceStream](https://acestream.org/) engine.
