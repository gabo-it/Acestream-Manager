#!/bin/bash
set -e

ARGS=("--client-console")

if [ "${BIND_ALL:-1}" = "1" ]; then
  ARGS+=("--bind-all")
fi

ARGS+=("--http-port" "${HTTP_PORT:-6677}")
ARGS+=("--port" "${PORT:-44556}")
ARGS+=("--live-cache-type" "${LIVE_CACHE_TYPE:-memory}")

if [ -n "${UPLOAD_LIMIT:-}" ]; then
  ARGS+=("--upload-limit" "${UPLOAD_LIMIT}")
fi

if [ -n "${DOWNLOAD_LIMIT:-}" ]; then
  ARGS+=("--download-limit" "${DOWNLOAD_LIMIT}")
fi

if [ -n "${ACCESS_TOKEN:-}" ]; then
  ARGS+=("--access-token" "${ACCESS_TOKEN}")
fi

if [ -n "${EXTRA_ARGS:-}" ]; then
  # EXTRA_ARGS puo' contenere piu' flag separati da spazio, es:
  # "--log-file /tmp/engine.log --debug 1"
  read -r -a EXTRA <<< "${EXTRA_ARGS}"
  ARGS+=("${EXTRA[@]}")
fi

echo "[entrypoint] Avvio AceStream engine con: ${ARGS[*]}"
exec /srv/ace/start-engine "${ARGS[@]}"
