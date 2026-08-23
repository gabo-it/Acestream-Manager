# AceStream Manager — Engine

Self-maintained AceStream engine image, part of the [AceStream Manager](https://github.com/gabo-it/Acestream-Manager) stack.

This image is not meant to be run standalone — it's one of three services (`acestream`, `acexy`, `webui`) that make up the full stack, orchestrated via Docker Compose.

## 🔗 Full project

**GitHub:** [gabo-it/Acestream-Manager](https://github.com/gabo-it/Acestream-Manager)

See the main repository for:
- Full feature list (channel management, EPG, playlists, search, football schedules, and more)
- Docker Compose setup instructions
- Configuration reference

## 🏷️ Tags

- `latest` — always the most recent build
- `<version>` (e.g. `3.2.11`) — matches the bundled AceStream engine version
- `v1.0`, `v1.1`, ... — pinned to a specific stable release of the whole stack

## 🔄 Auto-rebuilt

This image is automatically rebuilt via GitHub Actions whenever a new AceStream engine version is published upstream — see [`.github/workflows/docker-build.yml`](https://github.com/gabo-it/Acestream-Manager/blob/main/.github/workflows/docker-build.yml).

## 🙏 Credits

Built on top of the official [AceStream](https://acestream.org/) engine.
