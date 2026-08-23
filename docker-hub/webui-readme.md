# AceStream Manager — Web UI

The web interface of [AceStream Manager](https://github.com/gabo-it/Acestream-Manager): a self-hosted, self-maintained Docker stack for AceStream — channel management, EPG, playlists, search, and more, all from your browser.

This image is not meant to be run standalone — it's one of three services (`acestream`, `acexy`, `webui`) that make up the full stack, orchestrated via Docker Compose.

## 🔗 Full project & setup instructions

**GitHub:** [gabo-it/Acestream-Manager](https://github.com/gabo-it/Acestream-Manager)

The main repository has everything you need: `docker-compose.yml`, `.env.example`, and a full README covering quick start, configuration, and troubleshooting.

## ✨ What it does

- Channel CRUD, bulk import, per-source auto-refresh scheduling
- EPG import with cross-alphabet tvg-id/logo matching and optional program-title translation
- AceStream search with bulk import
- Dual playlists (MPEG-TS + HLS), built-in web player, VLC/AcePlayer options
- Read-only Engine dashboard, config export/import, Italian/English interface

## 🏷️ Tags

- `latest` — always the most recent build
- `v1.0`, `v1.1`, ... — pinned to a specific stable release

## 🔄 Auto-rebuilt

Published automatically via GitHub Actions on every push to `main` — see [`.github/workflows/docker-build.yml`](https://github.com/gabo-it/Acestream-Manager/blob/main/.github/workflows/docker-build.yml).
