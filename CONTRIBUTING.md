# Contributing

Thanks for considering contributing to AceStream Manager! This is a small,
self-maintained project — contributions of any size are welcome, from typo
fixes to new features.

## Project layout

```
engine/     AceStream engine Dockerfile + entrypoint
webui/      Node.js/Express web app (channels, EPG, search, football, ...)
docker-hub/ README content synced to Docker Hub via CI
images/     Screenshots and diagrams used in this README
```

The web app has no build step — it's plain Node.js with EJS templates
(`webui/views/`) and a SQLite database. See the main [README](README.md) for
the full architecture and feature overview.

## Local development

```bash
git clone https://github.com/<your-username>/<your-repo>.git acestream-stack
cd acestream-stack
cp .env.example .env
docker compose up -d --build
```

There's no live-reload setup — the Dockerfile copies `webui/` code into the
image at build time. After editing code, rebuild that one service:

```bash
docker compose up -d --build webui
```

## Making changes

1. Fork the repo and create a branch for your change.
2. Keep changes focused — a PR that does one thing is much easier to review
   than one that touches ten unrelated files.
3. If you're changing `webui/` code, sanity-check syntax before opening a PR:
   ```bash
   cd webui && for f in *.js; do node --check "$f" || echo "FAIL $f"; done
   ```
4. If you're touching a GitHub Actions workflow (`.github/workflows/`),
   validate the YAML:
   ```bash
   python3 -c "import yaml; yaml.safe_load(open('.github/workflows/docker-build.yml'))"
   ```
5. Open a pull request describing what changed and why. Screenshots are
   appreciated for anything UI-related.

## Reporting bugs / suggesting features

- **Bugs:** [open an issue](https://github.com/gabo-it/Acestream-Manager/issues) with steps to reproduce, and relevant logs (`docker compose logs <service>`) if applicable.
- **Ideas / questions:** [start a discussion](https://github.com/gabo-it/Acestream-Manager/discussions) instead — keeps the issue tracker focused on actionable bugs.

## Security issues

Please don't open a public issue for security vulnerabilities — see
[SECURITY.md](SECURITY.md) for how to report those privately.
